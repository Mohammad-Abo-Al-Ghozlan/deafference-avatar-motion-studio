import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { Object3D } from 'three'
import { validateMotionFile, type AvatarMotionFile } from '../src/motion/clip/format'
import { MotionClip } from '../src/motion/clip/MotionClip'
import { evaluateMotion } from '../src/motion/qa/metrics'
import { readJson, repoPath } from '../tools/lib/cli'
import { buildThreeHierarchy } from '../tools/lib/threeRig'
import { loadGltfRig } from '../tools/lib/gltfRig'
import { GLB, loadAvatar } from './helpers'

const MOTION = 'motion/qassem-story/avatar-motion.json.gz'
const PUBLIC_MOTION = 'public/motion/qassem-story/avatar-motion.json.gz'

test('shipped motion file: schema, full timeline, rig + source linkage', () => {
  const motion = readJson<AvatarMotionFile>(MOTION)
  validateMotionFile(motion)
  assert.equal(motion.fps, 30)
  assert.equal(motion.frameCount, 5794)
  assert.equal(motion.timeline.sourceFrame.length, motion.frameCount)
  const rigSha = createHash('sha256').update(readFileSync(repoPath(GLB))).digest('hex')
  assert.equal(motion.rig.sha256, rigSha, 'motion was solved for exactly this GLB')
  // Every decoded source frame appears exactly once, in order (no dropped frames).
  const frames = motion.timeline.sourceFrame.filter((f): f is number => f !== null)
  assert.equal(new Set(frames).size, frames.length)
  for (let i = 1; i < frames.length; i += 1) assert.equal(frames[i], frames[i - 1] + 1)
  assert.equal(frames.length, 5761)
})

test('public runtime copy is identical to the canonical motion export', () => {
  assert.ok(existsSync(repoPath(PUBLIC_MOTION)))
  assert.ok(readFileSync(repoPath(PUBLIC_MOTION)).equals(readFileSync(repoPath(MOTION))))
})

test('full-clip numerical QA passes (anatomy, continuity, no NaN)', async () => {
  const { rig, map, geometry } = await loadAvatar()
  const motion = readJson<AvatarMotionFile>(MOTION)
  const result = evaluateMotion(motion, rig, map, geometry)
  assert.deepEqual(result.failures, [])
})

test('MotionClip: sampling by media time is exact on frames and binds to the avatar', async () => {
  const motion = readJson<AvatarMotionFile>(MOTION)
  const clip = new MotionClip(motion)
  for (const k of [0, 1, 777, 4869, motion.frameCount - 1]) {
    const s = clip.sampleAt(k / motion.fps)
    assert.equal(s.index0 + (s.alpha > 0.5 ? 1 : 0), k)
  }
  const loaded = await loadGltfRig(repoPath(GLB))
  const { root } = buildThreeHierarchy(loaded)
  const binding = clip.bind(root)
  clip.applyTo(binding, 100 / 30)
  const track = motion.tracks.find((t) => t.bone === 'index_02_r' && t.path === 'rotation')!
  const node = binding.nodes.get('index_02_r') as Object3D
  const q = track.values.slice(400, 404)
  const dot = Math.abs(node.quaternion.x * q[0] + node.quaternion.y * q[1] + node.quaternion.z * q[2] + node.quaternion.w * q[3])
  assert.ok(dot > 1 - 1e-6)
  binding.applyStrength(0)
  binding.reset()
})
