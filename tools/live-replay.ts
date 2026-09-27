/**
 * Replay recorded tracker output through the REAL-TIME (causal) pipeline in
 * Node, frame by frame, exactly as the browser would receive it, and export
 * what the avatar would show. This is how the live mode is numerically QA'd
 * over the whole clip (the browser path itself is smoke-tested with
 * Playwright; see tools/e2e/app-smoke.ts).
 *
 *   npm run motion:live-replay -- --raw evidence/inputs/raw-landmarks.live-smoothed.json.gz
 *   npm run motion:qa -- --motion evidence/live-motion.json.gz --out evidence/live-qa-report.json
 *
 * `--stride 2` simulates a tracker that only keeps up with every 2nd frame.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { Quaternion, Vector3 } from 'three'
import type { Landmark } from '../src/types/tracking'
import { roundTo } from '../src/motion/math'
import { HAND_STATE_LEGEND, type AvatarMotionFile, type MotionTrack } from '../src/motion/clip/format'
import { LiveMotionPipeline } from '../src/motion/live/LiveMotionPipeline'
import type { SolvedPose } from '../src/motion/retarget/types'
import { parseArgs, repoPath, writeJson } from './lib/cli'
import { loadGltfRig } from './lib/gltfRig'
import { loadRawClip } from './lib/raw'
import { buildTimeline } from './lib/timeline'

const args = parseArgs(process.argv.slice(2), {
  raw: 'evidence/inputs/raw-landmarks.live-smoothed.json.gz',
  glb: 'public/models/deafference-avatar.glb',
  out: 'evidence/live-motion.json.gz',
  stride: 1,
  fps: 30,
  smoothing: 1,
  /** Emulate the app's render-rate easing (PoseApplier, 60 Hz, tau 35 ms); false = raw sample-and-hold. */
  easing: true
})

function percentile(values: number[], p: number) {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))]
}

async function main() {
  const { json: raw, frames, image } = loadRawClip(args.raw)
  const timeline = buildTimeline(frames, args.fps)
  const { rig, jointNames } = await loadGltfRig(repoPath(args.glb))
  const pipeline = new LiveMotionPipeline(rig)
  pipeline.setSmoothing(args.smoothing)
  const n = timeline.slots.length

  const rotationBones = pipeline.solver.controlled
  const translationBones = pipeline.solver.translated
  const rotations = new Map(rotationBones.map((bone) => [bone, new Float64Array(n * 4)]))
  const translations = new Map(translationBones.map((bone) => [bone, new Float64Array(n * 3)]))
  const handState = { left: new Array<string>(n).fill('A'), right: new Array<string>(n).fill('A') }
  const solveMs: number[] = []

  // What the viewer sees: the app eases toward each new solve at render rate
  // (PoseApplier: 60 Hz ticks, tau 35 ms); rest pose until the first solve.
  const eased = new Map(rotationBones.map((bone) => [bone, rig.get(bone).restLocalQuaternion.clone()]))
  const easedT = new Map(translationBones.map((bone) => [bone, rig.get(bone).restLocalPosition.clone()]))
  const tickAlpha = 1 - Math.exp(-(1 / 60) / 0.035)
  let current: SolvedPose | null = null
  let currentState = { left: 'A', right: 'A' }
  const target = new Quaternion()
  const writeSlot = (k: number) => {
    for (const bone of rotationBones) {
      const goal: Quaternion = current?.rotations.get(bone) ?? rig.get(bone).restLocalQuaternion
      const q = eased.get(bone)!
      if (args.easing) {
        target.copy(goal)
        if (target.dot(q) < 0) target.set(-target.x, -target.y, -target.z, -target.w)
        q.slerp(target, tickAlpha).slerp(target, tickAlpha)
      } else {
        q.copy(goal)
      }
      rotations.get(bone)!.set([q.x, q.y, q.z, q.w], k * 4)
    }
    for (const bone of translationBones) {
      const goal: Vector3 = current?.translations.get(bone) ?? rig.get(bone).restLocalPosition
      const p = easedT.get(bone)!
      if (args.easing) p.lerp(goal, tickAlpha).lerp(goal, tickAlpha)
      else p.copy(goal)
      translations.get(bone)!.set([p.x, p.y, p.z], k * 3)
    }
    handState.left[k] = currentState.left
    handState.right[k] = currentState.right
  }

  const faceIndices = raw.layout.faceIndices
  let processed = 0
  for (const slot of timeline.slots) {
    if (slot.source !== null && processed % args.stride === 0) {
      const frame = frames[slot.source]
      let face: Landmark[] | undefined
      if (frame.face) {
        face = new Array<Landmark>(478)
        for (const index of faceIndices) {
          const landmark = frame.face.get(index)
          if (landmark) face[index] = landmark
        }
      }
      const result = pipeline.update({
        pose: frame.pose ?? undefined,
        poseWorld: frame.world ?? undefined,
        leftHand: frame.left ?? undefined,
        rightHand: frame.right ?? undefined,
        face,
        timestampMs: frame.time * 1000,
        image
      })
      current = result.pose
      currentState = result.handState
      solveMs.push(result.solveMs)
    }
    if (slot.source !== null) processed += 1
    writeSlot(slot.k)
  }

  const tracks: MotionTrack[] = []
  for (const bone of rotationBones) {
    const v = rotations.get(bone)!
    for (let k = 1; k < n; k += 1) {
      const dot = v[k * 4] * v[k * 4 - 4] + v[k * 4 + 1] * v[k * 4 - 3] + v[k * 4 + 2] * v[k * 4 - 2] + v[k * 4 + 3] * v[k * 4 - 1]
      if (dot < 0) for (let c = 0; c < 4; c += 1) v[k * 4 + c] = -v[k * 4 + c]
    }
    tracks.push({ bone, path: 'rotation', values: Array.from(v, (x) => roundTo(x, 6)) })
  }
  for (const bone of translationBones) tracks.push({ bone, path: 'translation', values: Array.from(translations.get(bone)!, (x) => roundTo(x, 6)) })

  const motion: AvatarMotionFile = {
    schema: 'deafference.avatar-motion',
    schemaVersion: 1,
    clipId: raw.clipId,
    generator: `tools/live-replay.ts (causal live pipeline, stride ${args.stride}, easing ${args.easing})`,
    rig: { file: args.glb, sha256: createHash('sha256').update(readFileSync(repoPath(args.glb))).digest('hex'), profile: pipeline.solver.map.profile, joints: jointNames.size },
    source: { video: raw.source.file, sha256: raw.source.sha256 },
    fps: args.fps,
    frameCount: n,
    durationSec: roundTo((n - 1) / args.fps, 5),
    space: args.easing
      ? 'glTF node LOCAL transforms; causal solve with the app\'s render-rate easing emulated (what the live app shows).'
      : 'glTF node LOCAL transforms; raw sample-and-hold of the causal solve at each grid slot.',
    timeline: { sourceFrame: timeline.slots.map((s) => s.source), sourceTime: timeline.slots.map((s) => s.sourceTime) },
    tracks,
    quality: { handState: { left: handState.left.join(''), right: handState.right.join('') }, legend: HAND_STATE_LEGEND, uncertainIntervals: [] },
    notes: ['Evidence for the real-time path only; the deliverable motion is motion/<clip>/avatar-motion.json.gz (offline).']
  }
  writeJson(args.out, motion)
  const timing = {
    frames: solveMs.length,
    meanMs: roundTo(solveMs.reduce((a, b) => a + b, 0) / Math.max(1, solveMs.length), 2),
    p95Ms: roundTo(percentile(solveMs, 0.95), 2),
    maxMs: roundTo(Math.max(...solveMs), 2)
  }
  writeJson(args.out.replace(/\.json\.gz$/, '.timing.json'), { raw: args.raw, stride: args.stride, smoothing: args.smoothing, easing: args.easing, solve: timing }, true)
  console.log(`live replay: ${n} slots, ${solveMs.length} causal solves, solve ms mean ${timing.meanMs} p95 ${timing.p95Ms} max ${timing.maxMs} -> ${args.out}`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
