import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { Quaternion } from 'three'
import { MotionClip } from '../src/motion/clip/MotionClip'
import { PlaybackClock } from '../src/motion/clip/PlaybackClock'
import { segmentAt, sequenceMotionFile, wordHandStates, wordMotionFile } from '../src/motion/library/clips'
import { AnatomicalConformer } from '../src/motion/library/conform'
import {
  decodeWord,
  int16View,
  isToleratedQaFinding,
  LIBRARY_VARIANTS,
  validateLibraryIndex,
  type SignLibraryIndex,
  type SignLibraryWord
} from '../src/motion/library/format'
import { decodeLibraryData } from '../src/motion/library/load'
import { buildLookup, GLOSS_PHRASES, glossLabel, lookupText } from '../src/motion/library/lookup'
import { parseReviewRecords, REVIEW_CSV_COLUMNS, reviewCsv, type Decision, type ReviewRecord } from '../src/motion/library/review'
import { RAD } from '../src/motion/math'
import { evaluateMotion } from '../src/motion/qa/metrics'
import { readJson, repoPath } from '../tools/lib/cli'
import { buildThreeHierarchy } from '../tools/lib/threeRig'
import { GLB, loadAvatar } from './helpers'

// The files the app serves, decoded exactly as the app decodes them.
const DATA_DIR = 'public/motion/sign-library'
// The pipeline output they were imported from (npm run library:import).
const BAKED = 'motion/sign-library/source/baked_signs.json.gz'
const LIBRARY = 'motion/sign-library/source/library.json.gz'

const index = readJson<SignLibraryIndex>(`${DATA_DIR}/sign-library.json`)
const served = readFileSync(repoPath(`${DATA_DIR}/${index.data.file}`))
const data = int16View(index, gunzipSync(served))
const byGloss = new Map(index.words.map((w) => [w.gloss, w]))
const B = index.bones.length

type Quat = [number, number, number, number]
interface BakedFile {
  _rest: Record<string, Quat>
  signs: Record<string, { frames: Record<string, Quat>[]; hold_in: number; stroke: number; hold_out: number; hands: string }>
}
let bakedCache: BakedFile | null = null
const baked = () => (bakedCache ??= readJson<BakedFile>(BAKED))

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

function word(gloss: string): SignLibraryWord {
  const found = byGloss.get(gloss)
  assert.ok(found, `"${gloss}" is not in the library`)
  return found
}

function quat(frames: Float32Array | number[], k: number, b: number) {
  const i = (k * B + b) * 4
  return new Quaternion(frames[i], frames[i + 1], frames[i + 2], frames[i + 3])
}

const relative = new Quaternion()
/** Rotation angle between two unit quaternions (deg), via atan2: exact near zero, where acos is not. */
function angleDeg(a: Quaternion, b: Quaternion) {
  relative.copy(a).conjugate().multiply(b)
  return 2 * Math.atan2(Math.hypot(relative.x, relative.y, relative.z), Math.abs(relative.w)) * RAD
}

/** Largest bone rotation difference (deg) between frame ka of a and frame kb of b. */
function poseDiffDeg(a: Float32Array, ka: number, b: Float32Array, kb: number) {
  let worst = 0
  for (let i = 0; i < B; i += 1) worst = Math.max(worst, angleDeg(quat(a, ka, i), quat(b, kb, i)))
  return worst
}

/** Per-frame maps of local rotations, as the conformer takes them. */
function toMaps(frames: Float32Array, frameCount: number) {
  return Array.from({ length: frameCount }, (_, k) => new Map(index.bones.map((bone, i) => [bone, quat(frames, k, i)])))
}

/** The bake's frames exactly as the importer reads them (missing bones at rest, normalised). */
function bakedFrames(gloss: string) {
  const b = baked()
  return b.signs[gloss].frames.map((frame) => new Map(index.bones.map((bone) => {
    const v = frame[bone] ?? b._rest[bone]
    return [bone, new Quaternion(v[0], v[1], v[2], v[3]).normalize()]
  })))
}

class WorstCase {
  deg = 0
  at = ''
  add(deg: number, at: () => string) {
    if (deg > this.deg) {
      this.deg = deg
      this.at = at()
    }
  }
  toString() {
    return `${this.deg.toFixed(4)} deg at ${this.at}`
  }
}

// ---------------------------------------------------------------------------
// Shipped data

test('sign library: index is valid, baked for this exact avatar, and its counts add up', async () => {
  validateLibraryIndex(index)
  assert.equal(index.rig.sha256, sha256(readFileSync(repoPath(GLB))), 'baked for exactly this GLB')
  const { rig } = await loadAvatar()
  for (const bone of index.bones) assert.ok(rig.has(bone), `bone ${bone} is in the avatar rig`)
  assert.deepEqual(index.variants, [...LIBRARY_VARIANTS])
  assert.equal(index.fps, 30)

  const count = (predicate: (w: SignLibraryWord) => boolean) => index.words.filter(predicate).length
  assert.deepEqual(index.counts, {
    words: index.words.length,
    twoHanded: count((w) => w.hands === 'both'),
    pendingDeafReview: count((w) => w.review === 'pending_deaf_review'),
    approved: count((w) => w.review === 'approved'),
    qaPass: { raw: count((w) => w.qa.raw.pass), conformed: count((w) => w.qa.conformed.pass) },
    chosenByRoundtrip: count((w) => w.choice === 'roundtrip'),
    roundtripNotRecognised: count((w) => Boolean(w.roundtrip && !w.roundtrip.recognised))
  })
  for (const w of index.words) {
    assert.equal(w.hands === 'both', w.signClass !== '1', `${w.gloss}: hands agree with the lexicon class`)
    assert.equal(w.passive === 'none', w.hands === 'right', `${w.gloss}: a second hand exactly for two-handed signs`)
    assert.ok(w.holdIn >= 1 && w.stroke >= 1 && w.holdOut >= 1, `${w.gloss}: ease in, sign, ease out`)
    for (const v of index.variants) assert.equal(w.qa[v].pass, w.qa[v].failures.length === 0, `${w.gloss} (${v}): pass flag`)
    // Round-trip: only reorders unreviewed takes, only towards a recognised one, only with a run behind it.
    assert.ok(['deaf_approved', 'roundtrip', 'rank'].includes(w.choice), `${w.gloss}: choice`)
    if (w.choice === 'roundtrip') assert.ok(w.roundtrip?.recognised && w.source.rank > 1 && w.review !== 'approved', `${w.gloss}: round-trip choice`)
    if (w.choice === 'deaf_approved') assert.equal(w.review, 'approved', `${w.gloss}: approval`)
    if (w.roundtrip) assert.ok(index.source.roundtripRun && w.roundtrip.pTrue >= 0 && w.roundtrip.pTrue <= 1 && byGloss.has(w.roundtrip.readAs), `${w.gloss}: verdict`)
  }
})

test('sign library: shipped files are the import of the committed pipeline output', () => {
  for (const path of [BAKED, LIBRARY]) assert.ok(existsSync(repoPath(path)), path)
  assert.equal(index.source.bakedSha256, sha256(gunzipSync(readFileSync(repoPath(BAKED)))))
  assert.equal(index.source.librarySha256, sha256(gunzipSync(readFileSync(repoPath(LIBRARY)))))
  type Entry = { sequence_id: string | number; rank: number; choice?: string; roundtrip?: { recognised: boolean; read_as: string; p_true: number } | null }
  const library = readJson<{ select_run: string; skeleton_sha256: string; roundtrip_run?: string | null; words: Record<string, Entry> }>(LIBRARY)
  assert.equal(library.select_run, index.source.selectRun)
  assert.equal(library.skeleton_sha256, index.rig.sha256, 'the pipeline baked for the same skeleton')
  assert.deepEqual(Object.keys(library.words).sort(), index.words.map((w) => w.gloss).sort())
  assert.equal(index.source.roundtripRun, library.roundtrip_run ?? null)
  for (const w of index.words) {
    const entry = library.words[w.gloss]
    assert.deepEqual([w.source.sequenceId, w.source.rank, w.choice], [String(entry.sequence_id), entry.rank, entry.choice ?? 'rank'], w.gloss)
    const v = entry.roundtrip
    assert.deepEqual(w.roundtrip, v ? { recognised: v.recognised, readAs: v.read_as, pTrue: v.p_true } : null, `${w.gloss}: round-trip verdict`)
  }
  assert.deepEqual(index.bones, Object.keys(baked()._rest))
})

test('sign library: raw frames are the pipeline bake within quantisation error (every word, frame and bone)', () => {
  const b = baked()
  const worst = new WorstCase()
  for (const w of index.words) {
    const source = b.signs[w.gloss]
    assert.deepEqual([source.frames.length, source.hold_in, source.stroke, source.hold_out], [w.frameCount, w.holdIn, w.stroke, w.holdOut], `${w.gloss}: timing`)
    const raw = decodeWord(index, data, 'raw', w)
    bakedFrames(w.gloss).forEach((frame, k) => index.bones.forEach((bone, i) => {
      worst.add(angleDeg(quat(raw, k, i), frame.get(bone)!), () => `${w.gloss} frame ${k} ${bone}`)
    }))
  }
  assert.ok(worst.deg < 0.01, `Int16 quantisation error: ${worst}`)
})

test('sign library: conformed frames are reproducible from the bake (every word)', async () => {
  const { rig, geometry } = await loadAvatar()
  const conformer = new AnatomicalConformer(rig, geometry)
  const worst = new WorstCase()
  for (const w of index.words) {
    const result = conformer.conformWord(bakedFrames(w.gloss))
    const stored = decodeWord(index, data, 'conformed', w)
    result.frames.forEach((frame, k) => index.bones.forEach((bone, i) => {
      worst.add(angleDeg(frame.get(bone)!, quat(stored, k, i)), () => `${w.gloss} frame ${k} ${bone}`)
    }))
  }
  assert.ok(worst.deg < 0.01, `stored conformed vs AnatomicalConformer(bake): ${worst}`)
})

test('sign library: conformance is a projection (conforming the conformed frames again changes < 0.15 deg)', async () => {
  const { rig, geometry } = await loadAvatar()
  const conformer = new AnatomicalConformer(rig, geometry)
  const worst = new WorstCase()
  for (const w of index.words) {
    const stored = decodeWord(index, data, 'conformed', w)
    const again = conformer.conformWord(toMaps(stored, w.frameCount))
    again.frames.forEach((frame, k) => index.bones.forEach((bone, i) => {
      worst.add(angleDeg(frame.get(bone)!, quat(stored, k, i)), () => `${w.gloss} frame ${k} ${bone}`)
    }))
  }
  assert.ok(worst.deg < 0.15, `second conformance pass: ${worst}`)
})

test('sign library: every word starts and ends at the same idle pose in both versions (seamless back-to-back and loop)', () => {
  for (const v of index.variants) {
    const reference = decodeWord(index, data, v, index.words[0])
    const worst = new WorstCase()
    for (const w of index.words) {
      const frames = decodeWord(index, data, v, w)
      worst.add(poseDiffDeg(frames, 0, reference, 0), () => `${w.gloss} first frame`)
      worst.add(poseDiffDeg(frames, w.frameCount - 1, reference, 0), () => `${w.gloss} last frame`)
    }
    assert.ok(worst.deg < 0.1, `${v}: ${worst}`)
  }
  // The index's idle pose is that pose too (the pipeline exports it separately).
  const idle = new Float32Array(B * 4)
  index.bones.forEach((bone, i) => idle.set(index.idlePose[bone], i * 4))
  assert.ok(poseDiffDeg(decodeWord(index, data, 'raw', index.words[0]), 0, idle, 0) < 0.5)
})

test('sign library: stored QA equals the studio QA of the decoded data; conformed words fail only on tolerated findings', async () => {
  const { rig, map, geometry } = await loadAvatar()
  for (const w of index.words) {
    for (const v of index.variants) {
      const qa = evaluateMotion(wordMotionFile(index, data, v, w), rig, map, geometry)
      assert.deepEqual(qa.failures, w.qa[v].failures, `${w.gloss} (${v})`)
    }
  }
  const blocking = index.words.flatMap((w) => w.qa.conformed.failures.filter((f) => !isToleratedQaFinding(f)).map((f) => `${w.gloss}: ${f}`))
  assert.deepEqual(blocking, [])
})

test('decodeLibraryData: accepts the .gz file as served, or already decoded by the host', async () => {
  const same = (a: Int16Array) => Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(Buffer.from(data.buffer, data.byteOffset, data.byteLength))
  assert.ok(same(await decodeLibraryData(index, new Uint8Array(served))), 'gzip as stored')
  assert.ok(same(await decodeLibraryData(index, new Uint8Array(gunzipSync(served)))), 'Content-Encoding: gzip already decoded')
  await assert.rejects(decodeLibraryData(index, new Uint8Array(64)), /not gzip/)
})

// ---------------------------------------------------------------------------
// Playback

test('wordHandStates: the right hand signs during the stroke, the left hand only in two-handed signs', () => {
  assert.deepEqual(wordHandStates({ frameCount: 7, holdIn: 2, stroke: 3, hands: 'right' }), { left: 'AAAAAAA', right: 'AATTTAA' })
  assert.deepEqual(wordHandStates({ frameCount: 7, holdIn: 2, stroke: 3, hands: 'both' }), { left: 'AATTTAA', right: 'AATTTAA' })
})

test('MotionClip plays a library word: the pose at k / fps is decoded frame k', async () => {
  const { root, byName } = buildThreeHierarchy(await loadAvatar())
  const worst = new WorstCase()
  for (const gloss of ['hello', 'TV', 'night', 'thankyou']) {
    const w = word(gloss)
    for (const v of index.variants) {
      const frames = decodeWord(index, data, v, w)
      const clip = new MotionClip(wordMotionFile(index, data, v, w))
      assert.equal(clip.file.clipId, `${gloss}:${v}`)
      assert.equal(clip.duration, (w.frameCount - 1) / index.fps)
      const binding = clip.bind(root)
      for (const k of [0, w.holdIn, w.holdIn + (w.stroke >> 1), w.frameCount - 1]) {
        clip.applyTo(binding, k / index.fps)
        index.bones.forEach((bone, i) => worst.add(angleDeg(byName.get(bone)!.quaternion, quat(frames, k, i)), () => `${gloss} (${v}) frame ${k} ${bone}`))
      }
      binding.reset()
    }
  }
  assert.ok(worst.deg < 0.01, `${worst}`)
})

test('sequenceMotionFile: words back to back, contiguous segments, unchanged frames, seamless joins', () => {
  const words = ['hello', 'thankyou', 'mom'].map(word)
  for (const v of index.variants) {
    const { file, segments } = sequenceMotionFile(index, data, v, words)
    assert.doesNotThrow(() => new MotionClip(file))
    assert.equal(file.clipId, `sequence:hello+thankyou+mom:${v}`)
    assert.equal(file.frameCount, words.reduce((sum, w) => sum + w.frameCount, 0))
    assert.equal(file.quality.handState.right, words.map((w) => wordHandStates(w).right).join(''))
    assert.equal(file.quality.handState.left, words.map((w) => wordHandStates(w).left).join(''))
    assert.deepEqual(file.tracks.map((t) => t.bone), index.bones)

    const flat = new Float32Array(file.frameCount * B * 4)
    file.tracks.forEach((track, i) => {
      for (let k = 0; k < file.frameCount; k += 1) flat.set(track.values.slice(k * 4, k * 4 + 4), (k * B + i) * 4)
    })
    let cursor = 0
    segments.forEach((segment, n) => {
      const w = words[n]
      assert.deepEqual(segment, { gloss: w.gloss, startFrame: cursor, frameCount: w.frameCount, strokeStart: cursor + w.holdIn, strokeEnd: cursor + w.holdIn + w.stroke })
      const frames = decodeWord(index, data, v, w)
      for (let k = 0; k < w.frameCount; k += 1) assert.ok(poseDiffDeg(flat, cursor + k, frames, k) < 1e-3, `${w.gloss} frame ${k}`)
      if (n > 0) assert.ok(poseDiffDeg(flat, cursor - 1, flat, cursor) < 0.1, `join before ${w.gloss}`)
      cursor += w.frameCount
    })

    assert.equal(segmentAt(segments, 0), 0)
    assert.equal(segmentAt(segments, segments[1].startFrame - 1), 0)
    assert.equal(segmentAt(segments, segments[1].startFrame), 1)
    assert.equal(segmentAt(segments, file.frameCount + 10), segments.length - 1)
  }
  assert.throws(() => sequenceMotionFile(index, data, 'raw', []), /No words/)
})

test('PlaybackClock: play, pause, seek, rate, loop and the end of a clip', () => {
  let now = 100
  const clock = new PlaybackClock(() => now)
  const at = (expected: number) => assert.ok(Math.abs(clock.time() - expected) < 1e-9, `time ${clock.time()} != ${expected}`)

  clock.play()
  assert.equal(clock.playing, false, 'nothing to play before load')
  at(0)

  clock.load(2)
  assert.deepEqual([clock.duration, clock.playing, clock.ended], [2, false, false])
  clock.play()
  now += 0.5
  at(0.5)
  clock.pause()
  now += 1
  at(0.5)
  assert.equal(clock.playing, false)

  clock.seek(5)
  at(2)
  clock.seek(-1)
  at(0)

  clock.seek(1)
  clock.setRate(0.5)
  clock.play()
  now += 1
  at(1.5)
  for (const bad of [0, -1, Number.NaN]) clock.setRate(bad)
  assert.equal(clock.rate, 0.5, 'invalid rates are ignored')

  clock.seek(0.25) // while playing: continues from there
  now += 0.5
  at(0.5)

  now += 3.5 // 0.5 + 1.75 = 2.25 -> loops to 0.25
  at(0.25)
  assert.equal(clock.playing, true)

  clock.loop = false
  clock.seek(1.9)
  now += 1 // 1.9 + 0.5 -> stops at the end
  at(2)
  assert.deepEqual([clock.playing, clock.ended], [false, true])
  clock.play()
  assert.equal(clock.ended, false)
  at(0)

  clock.load(3)
  assert.deepEqual([clock.duration, clock.playing, clock.ended], [3, false, false])
  at(0)
})

// ---------------------------------------------------------------------------
// Lookup test and Deaf review export

test('lookup: every gloss matches itself and every compound gloss its English words', () => {
  const glosses = index.words.map((w) => w.gloss)
  const lookup = buildLookup(glosses)
  for (const gloss of Object.keys(GLOSS_PHRASES)) assert.ok(byGloss.has(gloss), `GLOSS_PHRASES.${gloss} is a library word`)
  for (const gloss of glosses) assert.deepEqual(lookupText(gloss, lookup), [{ text: gloss, gloss }])
  for (const [gloss, phrases] of Object.entries(GLOSS_PHRASES)) {
    for (const phrase of phrases) assert.deepEqual(lookupText(phrase, lookup).map((t) => t.gloss), [gloss], `"${phrase}" -> ${gloss} (not shadowed by another gloss)`)
  }
})

test('lookupText: case, punctuation, unknown words, greedy multi-word matches', () => {
  const lookup = buildLookup(index.words.map((w) => w.gloss))
  assert.deepEqual(lookupText('Hello, THANK you mom!', lookup), [
    { text: 'Hello,', gloss: 'hello' },
    { text: 'THANK you', gloss: 'thankyou' },
    { text: 'mom!', gloss: 'mom' }
  ])
  assert.deepEqual(lookupText('I want ice cream', lookup).map((t) => t.gloss), [null, null, 'icecream'])
  assert.deepEqual(lookupText('have to go', lookup).map((t) => t.gloss), ['haveto', 'go'])
  assert.deepEqual(lookupText('have a dog', lookup).map((t) => t.gloss), ['have', null, 'dog'])
  assert.deepEqual(lookupText("don't", lookup), [{ text: "don't", gloss: null }])
  assert.deepEqual(lookupText('Television  tv', lookup).map((t) => t.gloss), ['TV', 'TV'])
  assert.deepEqual(lookupText('  ... ', lookup), [])
  assert.deepEqual(['thankyou', 'TV', 'hesheit', 'hello'].map(glossLabel), ['thank you', 'TV', 'he / she / it', 'hello'])
})

test("review CSV: the pipeline's columns, quoting, CRLF, stale decisions dropped", () => {
  // Columns read by aslv2 eval/library.py read_reviews and written by viewer/clip_viewer.html.
  assert.deepEqual([...REVIEW_CSV_COLUMNS], ['sign', 'rank', 'sequence_id', 'participant_id', 'decision', 'reviewer', 'notes', 'clip_file'])
  const record = (w: SignLibraryWord, decision: Decision, notes = '', reviewer = ''): ReviewRecord => ({ gloss: w.gloss, sequenceId: w.source.sequenceId, decision, notes, reviewer, at: '2026-10-13T00:00:00.000Z' })
  const hello = word('hello')
  const mom = word('mom')
  const book = word('book')
  const csv = reviewCsv(index.words, {
    hello: record(hello, 'approved', 'clear, "good" handshape', 'R. N.'),
    mom: record(mom, 'rejected', 'line 1\nline 2'),
    book: { ...record(book, 'approved'), sequenceId: `${book.source.sequenceId}-older-take` }
  })
  assert.ok(csv.endsWith('\r\n'))
  const lines = csv.split('\r\n')
  assert.deepEqual(lines, [
    REVIEW_CSV_COLUMNS.join(','),
    `hello,${hello.source.rank},${hello.source.sequenceId},${hello.source.participantId},approved,R. N.,"clear, ""good"" handshape",${hello.source.clipFile}`,
    `mom,${mom.source.rank},${mom.source.sequenceId},${mom.source.participantId},rejected,,"line 1\nline 2",${mom.source.clipFile}`,
    ''
  ])
})

test('parseReviewRecords: tolerates anything browser storage may hold', () => {
  for (const text of [null, '', 'not json', '42', 'null', '[]']) assert.deepEqual(parseReviewRecords(text), {}, String(text))
  assert.deepEqual(parseReviewRecords(JSON.stringify({
    hello: { sequenceId: '1', decision: 'approved', notes: 5 },
    mom: { sequenceId: '2', decision: 'maybe' },
    book: { decision: 'rejected' },
    cat: null
  })), { hello: { gloss: 'hello', sequenceId: '1', decision: 'approved', notes: '', reviewer: '', at: '' } })
  const records: Record<string, ReviewRecord> = { mom: { gloss: 'mom', sequenceId: '9', decision: 'rejected', notes: 'n', reviewer: 'r', at: 't' } }
  assert.deepEqual(parseReviewRecords(JSON.stringify(records)), records)
})
