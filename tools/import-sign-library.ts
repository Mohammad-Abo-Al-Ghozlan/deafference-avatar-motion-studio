/**
 * Import the asl-v2 pipeline's sign library into the app.
 *
 *   npm run library:import [-- --baked <baked_signs.json[.gz]> --library <library.json[.gz]>]
 *
 * Input: the pipeline's library folder (s3://<bucket>/v2/05_library/<avatar>/<run>/):
 *   baked_signs.json  LOCAL quaternions per word, the rig's own bone names
 *   library.json      provenance, review status and selection per word
 * By default both are read from motion/sign-library/source/ (gzip or plain).
 *
 * Output:
 *   public/motion/sign-library/sign-library.json     index (words, timing, provenance, QA)
 *   public/motion/sign-library/sign-library.bin.gz   Int16 quaternions, variants raw + conformed
 *   motion/sign-library/qa-report.md                 summary of the QA of both variants
 *   motion/sign-library/qa-report.json.gz            per-word QA metrics of both variants
 *
 * Every word is checked against the supplied GLB (same sha256 as the
 * pipeline's skeleton), conformed to the studio's anatomical joint model
 * (src/motion/library/conform.ts) and run through the studio's full-clip
 * QA (src/motion/qa/metrics.ts) on the exact decoded data the app plays.
 * Exits non-zero (with --fail, the default) when a conformed word fails QA
 * for any reason other than TOLERATED_QA_FINDINGS (src/motion/library/format.ts).
 */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'
import { Quaternion } from 'three'
import { angleBetweenQuaternions, RAD } from '../src/motion/math'
import { AnatomicalConformer } from '../src/motion/library/conform'
import { wordMotionFile } from '../src/motion/library/clips'
import {
  isToleratedQaFinding,
  LIBRARY_VARIANTS,
  quantize,
  SIGN_LIBRARY_SCHEMA,
  SIGN_LIBRARY_SCHEMA_VERSION,
  validateLibraryIndex,
  type LibraryVariant,
  type ReviewStatus,
  type RoundtripVerdict,
  type SignLibraryIndex,
  type TakeChoice,
  type SignLibraryWord,
  type WordConformance
} from '../src/motion/library/format'
import { evaluateMotion } from '../src/motion/qa/metrics'
import { PoseState } from '../src/motion/retarget/PoseState'
import { buildRigGeometry } from '../src/motion/rig/rigGeometry'
import { claudiaProfile, SIDES, validateSemanticSkeleton, FINGERS } from '../src/motion/rig/semanticMap'
import { parseArgs, repoPath, writeJson } from './lib/cli'
import { loadGltfRig } from './lib/gltfRig'

const args = parseArgs(process.argv.slice(2), {
  baked: 'motion/sign-library/source/baked_signs.json.gz',
  library: 'motion/sign-library/source/library.json.gz',
  glb: 'public/models/deafference-avatar.glb',
  out: 'public/motion/sign-library',
  report: 'motion/sign-library',
  fail: true
})

type Quat = [number, number, number, number]

interface BakedWord {
  fps: number
  gloss: string
  frames: Record<string, Quat>[]
  hold_in: number
  stroke: number
  hold_out: number
  hands: string
  class: string
  synth: string | null
  source: { sequence_id: string; participant_id: string; rank: number; selection: string; review_status: string }
}

interface BakedFile {
  _note: string
  _rest: Record<string, Quat>
  _source: { select_run: string; skeleton_sha256: string; created_utc: string }
  signs: Record<string, BakedWord>
}

interface LibraryFile {
  format: string
  avatar_id: string
  skeleton_sha256: string
  select_run: string
  /** Absent before the pipeline's round-trip tie-breaker. */
  roundtrip_run?: string | null
  created_utc: string
  fps: number
  review_policy: string
  two_handed_note: string
  idle_pose: Record<string, Quat>
  words: Record<string, {
    clip: string
    rank: number
    sequence_id: string
    participant_id: string
    quality: number | null
    selection: string
    class: string
    passive: string
    review_status: string
    alternatives: string[]
    choice?: string
    roundtrip?: { recognised: boolean; read_as: string; p_true: number } | null
  }>
  missing: Record<string, unknown>
}

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

function readMaybeGzip(path: string) {
  const buffer = readFileSync(repoPath(path))
  const bytes = buffer[0] === 0x1f && buffer[1] === 0x8b ? gunzipSync(buffer) : buffer
  return { bytes, json: JSON.parse(bytes.toString('utf8')) as unknown }
}

function fail(message: string): never {
  console.error(`[library] ${message}`)
  process.exit(1)
}

async function main() {
  const baked = readMaybeGzip(args.baked)
  const library = readMaybeGzip(args.library)
  const b = baked.json as BakedFile
  const l = library.json as LibraryFile
  if (l.format !== 'deafference-library-v2') fail(`library.json format is "${l.format}", expected deafference-library-v2`)
  if (!b.signs || !b._rest) fail('baked_signs.json has no signs/_rest')

  const glbBytes = readFileSync(repoPath(args.glb))
  const glbSha = sha256(glbBytes)
  if (l.skeleton_sha256 !== glbSha || b._source.skeleton_sha256 !== glbSha) {
    fail(`the library was baked for skeleton ${l.skeleton_sha256.slice(0, 12)}…, this app's avatar is ${glbSha.slice(0, 12)}… (${args.glb}). Re-run the pipeline for this GLB.`)
  }
  if (b._source.select_run !== l.select_run) fail(`baked_signs.json is from select run ${b._source.select_run}, library.json from ${l.select_run}`)
  const bakedWords = Object.keys(b.signs).sort()
  const libraryWords = Object.keys(l.words).sort()
  if (bakedWords.join('\n') !== libraryWords.join('\n')) fail('baked_signs.json and library.json list different words')

  const loaded = await loadGltfRig(repoPath(args.glb))
  const rig = loaded.rig
  const map = claudiaProfile()
  const validation = validateSemanticSkeleton(rig, map)
  if (!validation.ok) fail('the GLB does not match the Claudia semantic profile')
  const geometry = buildRigGeometry(rig, map, validation.facing, validation.characterLeft)
  const conformer = new AnatomicalConformer(rig, geometry)

  const bones = Object.keys(b._rest)
  const unknown = bones.filter((bone) => !rig.has(bone))
  if (unknown.length) fail(`bones not in the avatar rig: ${unknown.join(', ')}`)
  const fps = l.fps
  const glosses = [...bakedWords].sort((x, y) => x.localeCompare(y, 'en', { sensitivity: 'base' }))

  // ---- Frames (float) per variant, hemisphere-continuous per bone.
  const stride = bones.length * 4
  const totalFrames = glosses.reduce((sum, gloss) => sum + b.signs[gloss].frames.length, 0)
  const floats: Record<LibraryVariant, Float64Array> = { raw: new Float64Array(totalFrames * stride), conformed: new Float64Array(totalFrames * stride) }
  const conformance: Record<string, WordConformance> = {}
  const tips = SIDES.flatMap((side) => FINGERS.map((finger) => map.arms[side].digits[finger][3]))
  const rawPose = new PoseState(rig)
  const fitPose = new PoseState(rig)
  let cursor = 0
  const offsets: Record<string, number> = {}
  for (const gloss of glosses) {
    const word = b.signs[gloss]
    if (word.frames.length !== word.hold_in + word.stroke + word.hold_out) fail(`"${gloss}": ${word.frames.length} frames != hold_in + stroke + hold_out`)
    if (word.fps !== fps) fail(`"${gloss}": fps ${word.fps} != library fps ${fps}`)
    offsets[gloss] = cursor
    const raw = word.frames.map((frame, k) => {
      const pose = new Map<string, Quaternion>()
      for (const bone of bones) {
        const value = frame[bone] ?? b._rest[bone]
        const q = new Quaternion(value[0], value[1], value[2], value[3])
        if (!Number.isFinite(q.x + q.y + q.z + q.w) || q.lengthSq() < 0.5) fail(`"${gloss}" frame ${k}: invalid quaternion for ${bone}`)
        pose.set(bone, q.normalize())
      }
      return pose
    })
    const result = conformer.conformWord(raw)
    const stats: WordConformance = {
      changedFrames: 0,
      maxSwivelDeg: Math.max(...SIDES.flatMap((side) => result.swivel[side].map((v) => Math.abs(v) * RAD))),
      maxHandOrientationChangeDeg: 0,
      maxHandPositionShiftMm: 0,
      maxFingertipShiftMm: 0,
      maxElbowChangeDeg: 0,
      crossingCorrections: result.crossingCorrections
    }
    const previous: Record<LibraryVariant, Quaternion[]> = { raw: [], conformed: [] }
    raw.forEach((rawFrame, k) => {
      const fitted = result.frames[k]
      let changed = false
      for (const bone of bones) {
        const angle = angleBetweenQuaternions(rawFrame.get(bone)!, fitted.get(bone)!) * RAD
        if (angle > 0.01) changed = true
        if (/^lowerarm_(l|r)$/.test(bone)) stats.maxElbowChangeDeg = Math.max(stats.maxElbowChangeDeg, angle)
        rawPose.setLocal(bone, rawFrame.get(bone)!)
        fitPose.setLocal(bone, fitted.get(bone)!)
      }
      if (changed) stats.changedFrames += 1
      for (const side of SIDES) {
        const hand = map.arms[side].hand
        stats.maxHandOrientationChangeDeg = Math.max(stats.maxHandOrientationChangeDeg, angleBetweenQuaternions(rawPose.worldQuaternion(hand), fitPose.worldQuaternion(hand)) * RAD)
        stats.maxHandPositionShiftMm = Math.max(stats.maxHandPositionShiftMm, rawPose.worldPosition(hand).distanceTo(fitPose.worldPosition(hand)) * 1000)
      }
      for (const tip of tips) stats.maxFingertipShiftMm = Math.max(stats.maxFingertipShiftMm, rawPose.worldPosition(tip).distanceTo(fitPose.worldPosition(tip)) * 1000)

      for (const [variant, pose] of [['raw', rawFrame], ['conformed', fitted]] as const) {
        const base = (cursor + k) * stride
        bones.forEach((bone, i) => {
          const q = pose.get(bone)!.clone()
          const prev = previous[variant][i]
          if (prev && q.dot(prev) < 0) q.set(-q.x, -q.y, -q.z, -q.w)
          previous[variant][i] = q
          floats[variant].set([q.x, q.y, q.z, q.w], base + i * 4)
        })
      }
    })
    const round = (v: number) => Math.round(v * 10) / 10
    conformance[gloss] = {
      ...stats,
      maxSwivelDeg: round(stats.maxSwivelDeg),
      maxHandOrientationChangeDeg: round(stats.maxHandOrientationChangeDeg),
      maxHandPositionShiftMm: round(stats.maxHandPositionShiftMm),
      maxFingertipShiftMm: round(stats.maxFingertipShiftMm),
      maxElbowChangeDeg: round(stats.maxElbowChangeDeg)
    }
    cursor += word.frames.length
  }

  // ---- Quantise: one block per variant.
  const data = new Int16Array(LIBRARY_VARIANTS.length * totalFrames * stride)
  LIBRARY_VARIANTS.forEach((variant, v) => {
    const block = floats[variant]
    for (let i = 0; i < block.length; i += 1) data[v * totalFrames * stride + i] = quantize(block[i])
  })

  const status = (value: string): ReviewStatus => (value === 'approved' || value === 'rejected' ? value : 'pending_deaf_review')
  const words: SignLibraryWord[] = glosses.map((gloss) => {
    const word = b.signs[gloss]
    const entry = l.words[gloss]
    if (String(entry.sequence_id) !== String(word.source.sequence_id)) fail(`"${gloss}": library.json chose take ${entry.sequence_id}, baked_signs.json holds ${word.source.sequence_id}`)
    const choice: TakeChoice = entry.choice === 'deaf_approved' || entry.choice === 'roundtrip' ? entry.choice : 'rank'
    const roundtrip: RoundtripVerdict | null = entry.roundtrip
      ? { recognised: entry.roundtrip.recognised === true, readAs: String(entry.roundtrip.read_as ?? ''), pTrue: Number(entry.roundtrip.p_true) }
      : null
    if (roundtrip && !Number.isFinite(roundtrip.pTrue)) fail(`"${gloss}": round-trip p_true is not a number`)
    if (choice === 'roundtrip' && !roundtrip?.recognised) fail(`"${gloss}": chosen by round-trip but its take is not recognised`)
    return {
      gloss,
      frameOffset: offsets[gloss],
      frameCount: word.frames.length,
      holdIn: word.hold_in,
      stroke: word.stroke,
      holdOut: word.hold_out,
      hands: word.hands === 'both' ? 'both' : 'right',
      signClass: entry.class,
      passive: entry.passive,
      review: status(entry.review_status),
      choice,
      roundtrip,
      source: {
        sequenceId: String(entry.sequence_id),
        participantId: String(entry.participant_id),
        rank: entry.rank,
        selection: entry.selection,
        quality: entry.quality,
        clipFile: entry.clip.split('/').pop() ?? '',
        alternatives: entry.alternatives.length
      },
      qa: { raw: { pass: false, failures: [] }, conformed: { pass: false, failures: [] } },
      conformance: conformance[gloss]
    }
  })

  const index: SignLibraryIndex = {
    schema: SIGN_LIBRARY_SCHEMA,
    schemaVersion: SIGN_LIBRARY_SCHEMA_VERSION,
    generator: 'tools/import-sign-library.ts',
    rig: { file: args.glb.split('/').pop()!, sha256: glbSha, profile: map.profile, joints: rig.joints.filter((j) => j.isJoint).length },
    source: {
      pipeline: 'asl-v2-pipeline (aslv2 library stage)',
      libraryFormat: l.format,
      avatarId: l.avatar_id,
      selectRun: l.select_run,
      createdUtc: l.created_utc,
      bakedSha256: sha256(baked.bytes),
      librarySha256: sha256(library.bytes),
      reviewPolicy: l.review_policy,
      twoHandedNote: l.two_handed_note,
      roundtripRun: l.roundtrip_run ?? null
    },
    fps,
    bones,
    variants: [...LIBRARY_VARIANTS],
    data: { file: 'sign-library.bin.gz', encoding: 'int16-quaternion', scale: 32767, totalFrames, values: data.length },
    idlePose: Object.fromEntries(bones.map((bone) => [bone, (l.idle_pose[bone] ?? b._rest[bone]).map((v) => Math.round(v * 1e6) / 1e6) as Quat])),
    words,
    counts: {
      words: words.length,
      twoHanded: words.filter((w) => w.hands === 'both').length,
      pendingDeafReview: words.filter((w) => w.review === 'pending_deaf_review').length,
      approved: words.filter((w) => w.review === 'approved').length,
      qaPass: { raw: 0, conformed: 0 },
      chosenByRoundtrip: words.filter((w) => w.choice === 'roundtrip').length,
      roundtripNotRecognised: words.filter((w) => w.roundtrip && !w.roundtrip.recognised).length
    },
    qaConvention: 'Studio QA (src/motion/qa/metrics.ts, DEFAULT_QA) on the decoded Int16 data. Hand state: the right hand, and the left hand of two-handed signs, count as tracked during the stroke; everything else as not observed.',
    notes: [
      'Isolated GISLR signs (one take per word) retargeted onto this avatar by the asl-v2 pipeline. Not translation, not sentence-level signing.',
      'Every word is pending Deaf review: do not present these clips to users as correct signing before a fluent Deaf signer approves them.',
      'The pipeline normalises every signer to right-hand dominance; left-handed takes were mirrored.',
      'raw = the pipeline bake as delivered. conformed = projected onto the studio joint model (elbow hinge and range, wrist limits, MCP flexion + abduction without axial roll, PIP/DIP/thumb hinges and ranges, finger order).'
    ]
  }
  validateLibraryIndex(index)

  // ---- QA on exactly what the app will play.
  const report: Record<string, unknown> = {}
  const tally: Record<LibraryVariant, Map<string, number>> = { raw: new Map(), conformed: new Map() }
  const blocking: string[] = []
  for (const word of words) {
    const perVariant: Record<string, unknown> = {}
    for (const variant of LIBRARY_VARIANTS) {
      const qa = evaluateMotion(wordMotionFile(index, data, variant, word), rig, map, geometry)
      word.qa[variant] = { pass: qa.failures.length === 0, failures: qa.failures }
      perVariant[variant] = { failures: qa.failures, anatomical: qa.anatomical, temporal: qa.temporal, numeric: qa.numeric }
      for (const failure of qa.failures) {
        const key = failure.replace(/\d+(\.\d+)?(e-?\d+)?/g, '#')
        tally[variant].set(key, (tally[variant].get(key) ?? 0) + 1)
      }
      if (variant === 'conformed') {
        const hard = qa.failures.filter((f) => !isToleratedQaFinding(f))
        if (hard.length) blocking.push(`${word.gloss}: ${hard.join('; ')}`)
      }
    }
    report[word.gloss] = { conformance: word.conformance, ...perVariant }
  }
  index.counts.qaPass = { raw: words.filter((w) => w.qa.raw.pass).length, conformed: words.filter((w) => w.qa.conformed.pass).length }

  // ---- Write.
  const outDir = repoPath(args.out)
  mkdirSync(outDir, { recursive: true })
  const gz = gzipSync(Buffer.from(data.buffer, data.byteOffset, data.byteLength), { level: 9 })
  gz[9] = 0xff // OS byte: platform independent output
  writeFileSync(`${outDir}/${index.data.file}`, gz)
  writeJson(`${args.out}/sign-library.json`, index)

  const summary = {
    generatedBy: index.generator,
    selectRun: index.source.selectRun,
    words: words.length,
    qaPass: index.counts.qaPass,
    failureTally: Object.fromEntries(LIBRARY_VARIANTS.map((v) => [v, Object.fromEntries([...tally[v]].sort((x, y) => y[1] - x[1]))])),
    conformance: {
      wordsWithSwivel: words.filter((w) => w.conformance.maxSwivelDeg > 0).length,
      maxSwivelDeg: Math.max(...words.map((w) => w.conformance.maxSwivelDeg)),
      medianHandOrientationChangeDeg: median(words.map((w) => w.conformance.maxHandOrientationChangeDeg)),
      maxHandOrientationChangeDeg: Math.max(...words.map((w) => w.conformance.maxHandOrientationChangeDeg)),
      maxHandPositionShiftMm: Math.max(...words.map((w) => w.conformance.maxHandPositionShiftMm)),
      medianFingertipShiftMm: median(words.map((w) => w.conformance.maxFingertipShiftMm)),
      maxFingertipShiftMm: Math.max(...words.map((w) => w.conformance.maxFingertipShiftMm)),
      maxElbowChangeDeg: Math.max(...words.map((w) => w.conformance.maxElbowChangeDeg))
    },
    blocking
  }
  // Per-word metrics of both variants (~2 MB as JSON): gzip, read with readJson / zcat.
  writeJson(`${args.report}/qa-report.json.gz`, { summary, words: report })
  writeFileSync(repoPath(`${args.report}/qa-report.md`), markdown(index, summary))
  const binBytes = gz.byteLength
  console.log(`[library] ${words.length} words, ${totalFrames} frames x ${bones.length} bones, ${(binBytes / 1e6).toFixed(2)} MB -> ${args.out}/`)
  console.log(`[library] studio QA pass: raw ${index.counts.qaPass.raw}/${words.length}, conformed ${index.counts.qaPass.conformed}/${words.length}`)
  for (const variant of LIBRARY_VARIANTS) for (const [key, n] of [...tally[variant]].sort((x, y) => y[1] - x[1])) console.log(`[library]   ${variant}: ${n} x ${key}`)
  if (blocking.length) {
    console.error(`[library] ${blocking.length} conformed words fail QA beyond the tolerated findings:\n  ${blocking.slice(0, 20).join('\n  ')}`)
    if (args.fail) process.exit(2)
  }
}

function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor((sorted.length - 1) / 2)]
}

function markdown(index: SignLibraryIndex, summary: { qaPass: Record<string, number>; failureTally: Record<string, Record<string, number>>; conformance: Record<string, number>; blocking: string[] }) {
  const lines = [
    '# Sign library: import and QA report',
    '',
    `Generated by \`${index.generator}\` from aslv2 select run \`${index.source.selectRun}\` (baked_signs.json sha256 \`${index.source.bakedSha256.slice(0, 12)}…\`).`,
    `Rig: \`${index.rig.file}\` sha256 \`${index.rig.sha256.slice(0, 12)}…\` (same GLB the pipeline baked for).`,
    '',
    '| | Words | Studio QA pass |',
    '|---|---|---|',
    `| raw (pipeline bake as delivered) | ${index.counts.words} | ${summary.qaPass.raw} |`,
    `| conformed (studio joint model) | ${index.counts.words} | ${summary.qaPass.conformed} |`,
    '',
    `Two-handed: ${index.counts.twoHanded}. Pending Deaf review: ${index.counts.pendingDeafReview}. Approved: ${index.counts.approved}.`,
    '',
    index.source.roundtripRun
      ? `Take choice: ${index.counts.chosenByRoundtrip} words switched to a take the avatar recognizer recognises (round-trip \`${index.source.roundtripRun}\`); ${index.counts.roundtripNotRecognised} chosen takes are not recognised: ${index.words.filter((w) => w.roundtrip && !w.roundtrip.recognised).map((w) => w.gloss).join(', ')}.`
      : 'Take choice: best-ranked take per word (no avatar recognizer round-trip for this select run).',
    '',
    '## QA findings (number of words)',
    ''
  ]
  for (const [variant, tally] of Object.entries(summary.failureTally)) {
    lines.push(`**${variant}**`, '')
    const entries = Object.entries(tally)
    if (!entries.length) lines.push('- none')
    for (const [key, n] of entries) lines.push(`- ${n} × ${key}`)
    lines.push('')
  }
  lines.push(
    '## What the conformance changed',
    '',
    `- Elbow swivel (hand kept in place): ${summary.conformance.wordsWithSwivel} words, max ${summary.conformance.maxSwivelDeg} deg`,
    `- Hand orientation in space, worst frame per word: median ${summary.conformance.medianHandOrientationChangeDeg} deg, max ${summary.conformance.maxHandOrientationChangeDeg} deg (wrist limits the swivel could not absorb)`,
    `- Wrist position in space: max ${summary.conformance.maxHandPositionShiftMm} mm (elbow range clamp only)`,
    `- Fingertip displacement, worst frame per word: median ${summary.conformance.medianFingertipShiftMm} mm, max ${summary.conformance.maxFingertipShiftMm} mm (finger roll, hinges, ranges, plus any orientation change)`,
    `- Elbow (forearm bone) rotation change: max ${summary.conformance.maxElbowChangeDeg} deg`,
    '',
    'Tolerated findings (reported, not blocking): a dominant hand at the exact rest pose during the stroke (the take had no finger data), and isolated one-frame finger spikes.',
    '',
    summary.blocking.length ? `**${summary.blocking.length} conformed words fail beyond the tolerated findings.**` : 'No conformed word fails beyond the tolerated findings.',
    '',
    ...index.notes.map((note) => `- ${note}`),
    ''
  )
  return lines.join('\n')
}

void main().catch((error) => {
  console.error(error)
  process.exit(1)
})
