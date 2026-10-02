import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { validateMotionFile, type AvatarMotionFile } from '../src/motion/clip/format'
import { evaluateMotion } from '../src/motion/qa/metrics'
import { SIGN_CLIPS } from '../src/views/signClips'
import { readJson, repoPath } from '../tools/lib/cli'
import { GLB, loadAvatar } from './helpers'

const sha256 = (path: string) => createHash('sha256').update(readFileSync(repoPath(path))).digest('hex')

interface PlaybackReport {
  clipId: string
  source: { sha256: string; frames: number }
  timeline: { fps: number; slots: number; filledSlots: { slot: number; shows: number }[] }
  output: { file: string; frames: number; maxTimestampErrorMs: number; sha256: string }
}

for (const config of SIGN_CLIPS) {
  const motionPath = `motion/${config.id}/avatar-motion.json.gz`

  test(`${config.id}: app config points at shipped assets`, () => {
    for (const url of [config.video, config.poster, config.motion]) assert.ok(existsSync(repoPath(`public${url}`)), url)
    assert.ok(readFileSync(repoPath(`public${config.motion}`)).equals(readFileSync(repoPath(motionPath))), 'public motion copy == canonical export')
  })

  test(`${config.id}: motion file is complete and linked to the rig, the source video and the playback video`, () => {
    const motion = readJson<AvatarMotionFile>(motionPath)
    validateMotionFile(motion)
    assert.equal(motion.clipId, config.id)
    assert.equal(motion.fps, 30)
    assert.equal(motion.rig.sha256, sha256(GLB), 'solved for exactly this GLB')
    const original = `media/source/${config.id}.original.mp4`
    if (existsSync(repoPath(original))) assert.equal(motion.source.sha256, sha256(original), 'solved from exactly this source video')

    // Every decoded source frame appears exactly once, in order.
    const frames = motion.timeline.sourceFrame.filter((f): f is number => f !== null)
    assert.equal(new Set(frames).size, frames.length)
    for (let i = 1; i < frames.length; i += 1) assert.equal(frames[i], frames[i - 1] + 1)

    // Frame k of the playback video shows the source frame motion frame k was solved from.
    const report = readJson<PlaybackReport>(`motion/${config.id}/playback-report.json`)
    assert.equal(report.source.sha256, motion.source.sha256)
    assert.equal(report.source.frames, frames.length)
    assert.equal(report.timeline.slots, motion.frameCount)
    assert.equal(report.output.frames, motion.frameCount)
    assert.ok(report.output.maxTimestampErrorMs < 1)
    assert.equal(report.output.file, `public${config.video}`)
    assert.equal(sha256(report.output.file), report.output.sha256)
    assert.equal(motion.source.playbackSha256, report.output.sha256, 'motion records the playback file it is synced to')
    const dropped = motion.timeline.sourceFrame.flatMap((f, k) => (f === null ? [k] : []))
    assert.deepEqual(report.timeline.filledSlots.map((s) => s.slot), dropped, 'filled playback slots == dropped source slots')
  })

  test(`${config.id}: full-clip numerical QA passes`, async () => {
    const { rig, map, geometry } = await loadAvatar()
    const result = evaluateMotion(readJson<AvatarMotionFile>(motionPath), rig, map, geometry)
    assert.deepEqual(result.failures, [])
    const onDisk = readJson<{ verdict: string; clipId: string }>(`motion/${config.id}/qa-report.json`)
    assert.equal(onDisk.clipId, config.id)
    assert.equal(onDisk.verdict, 'PASS')
  })
}
