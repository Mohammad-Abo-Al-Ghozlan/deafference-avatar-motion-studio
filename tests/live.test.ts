import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Quaternion } from 'three'
import type { Landmark } from '../src/types/tracking'
import { angleBetweenQuaternions, swingTwist } from '../src/motion/math'
import { LiveMotionPipeline, type LiveFrame } from '../src/motion/live/LiveMotionPipeline'
import { LONG_FINGERS, SIDES } from '../src/motion/rig/semanticMap'
import { loadRawClip } from '../tools/lib/raw'
import { loadAvatar } from './helpers'

const RAW = 'motion/qassem-story/raw-landmarks.json.gz'

function liveFrames(start: number, count: number): LiveFrame[] {
  const { json, frames, image } = loadRawClip(RAW)
  return frames.slice(start, start + count).map((f) => {
    let face: Landmark[] | undefined
    if (f.face) {
      face = new Array<Landmark>(478)
      for (const index of json.layout.faceIndices) {
        const landmark = f.face.get(index)
        if (landmark) face[index] = landmark
      }
    }
    return { pose: f.pose ?? undefined, poseWorld: f.world ?? undefined, leftHand: f.left ?? undefined, rightHand: f.right ?? undefined, face, timestampMs: f.time * 1000, image }
  })
}

test('live pipeline is causal: output at frame k never depends on frames after k', async () => {
  const { rig } = await loadAvatar()
  const frames = liveFrames(700, 90)
  const a = new LiveMotionPipeline(rig)
  const b = new LiveMotionPipeline(rig)
  const outA = frames.map((f) => a.update(f).pose)
  // Same past, different future (hands removed, pose frozen) for the last 30 frames.
  const altered = frames.map((f, i) => (i < 60 ? f : { ...f, leftHand: undefined, rightHand: undefined, pose: frames[59].pose }))
  const outB = altered.map((f) => b.update(f).pose)
  for (let k = 0; k < 60; k += 1) {
    for (const [bone, q] of outA[k].rotations) {
      const other = outB[k].rotations.get(bone)!
      assert.ok(q.x === other.x && q.y === other.y && q.z === other.z && q.w === other.w, `frame ${k} ${bone}`)
    }
  }
  // ...and the altered future does change later output (the test has teeth).
  let differs = false
  for (const [bone, q] of outA[89].rotations) if (angleBetweenQuaternions(q, outB[89].rotations.get(bone)!) > 1e-3) differs = true
  assert.ok(differs)
})

test('live pipeline output is finite and anatomically constrained (hinges, ranges)', async () => {
  const { rig, geometry } = await loadAvatar()
  const pipeline = new LiveMotionPipeline(rig)
  for (const frame of liveFrames(3000, 150)) {
    const { pose } = pipeline.update(frame)
    for (const q of pose.rotations.values()) assert.ok([q.x, q.y, q.z, q.w].every(Number.isFinite))
    for (const side of SIDES) {
      for (const finger of LONG_FINGERS) {
        const g = geometry.hands[side].fingers[finger]
        for (const joint of [g.pip, g.dip]) {
          const delta = pose.rotations.get(joint.bone)!.clone().multiply(rig.get(joint.bone).restLocalQuaternion.clone().invert())
          const st = swingTwist(delta, joint.axisParent)
          assert.ok(angleBetweenQuaternions(st.swing, new Quaternion()) < 1e-5, `${joint.bone} off-hinge`)
          const angle = (joint.restAngle + st.twistAngle) * 180 / Math.PI
          assert.ok(angle >= -10.5 && angle <= 110.5, `${joint.bone} ${angle}`)
        }
      }
    }
  }
})

test('live pipeline survives missing streams (no pose, no world landmarks, no face)', async () => {
  const { rig } = await loadAvatar()
  const pipeline = new LiveMotionPipeline(rig)
  const frames = liveFrames(1200, 40)
  frames.forEach((f, i) => {
    const degraded: LiveFrame = { ...f, poseWorld: undefined, face: i % 3 ? f.face : undefined, pose: i % 7 === 0 ? undefined : f.pose }
    const result = pipeline.update(degraded)
    for (const q of result.pose.rotations.values()) assert.ok([q.x, q.y, q.z, q.w].every(Number.isFinite))
  })
})
