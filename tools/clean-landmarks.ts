/**
 * Stage 2: raw landmarks -> clean, anatomically constrained source motion.
 *
 *   npm run motion:clean -- --clip qassem-story
 *
 * Reads  motion/<clip>/raw-landmarks.json.gz
 * Writes motion/<clip>/clean-landmarks.json.gz and processing-report.json
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { Landmark } from '../src/types/tracking'
import { roundTo } from '../src/motion/math'
import { claudiaProfile, validateSemanticSkeleton, type Side } from '../src/motion/rig/semanticMap'
import { buildRigGeometry } from '../src/motion/rig/rigGeometry'
import { flattenParams, PARAM_CHANNELS } from '../src/motion/source/handParams'
import { parseArgs, repoPath, writeJson } from './lib/cli'
import { loadGltfRig } from './lib/gltfRig'
import { loadRawClip } from './lib/raw'
import { buildTimeline } from './lib/timeline'
import { calibrateHands, cleanHandTrack, DEFAULT_HAND_CLEAN, resolveIdentities } from './lib/cleanHands'
import { cleanBodyTrack } from './lib/cleanBody'
import { cleanFaceTrack } from './lib/cleanFace'

const args = parseArgs(process.argv.slice(2), {
  clip: 'qassem-story',
  motionDir: 'motion',
  glb: 'public/models/deafference-avatar.glb',
  fps: 30
})

const r5 = (v: number) => roundTo(v, 5)
const arr5 = (values: ArrayLike<number>) => Array.from(values, r5)

async function main() {
  const started = Date.now()
  const rawPath = `${args.motionDir}/${args.clip}/raw-landmarks.json.gz`
  const { json: raw, frames, image } = loadRawClip(rawPath)
  const rawSha = createHash('sha256').update(readFileSync(repoPath(rawPath))).digest('hex')
  console.log(`raw: ${frames.length} frames ${image.width}x${image.height}`)

  const timeline = buildTimeline(frames, args.fps)
  console.log(`timeline: ${timeline.slots.length} slots @ ${timeline.fps} fps, dropped=${timeline.droppedSlots}, collisions=${timeline.collisions}, max offset ${timeline.maxAbsOffsetMs} ms`)

  const { rig } = await loadGltfRig(repoPath(args.glb))
  const map = claudiaProfile()
  const validation = validateSemanticSkeleton(rig, map)
  if (!validation.ok) throw new Error(`Rig validation failed: ${JSON.stringify(validation.issues)}`)
  const geometry = buildRigGeometry(rig, map, validation.facing, validation.characterLeft)

  // Duplicate-frame detection: identical tracker output on consecutive frames.
  let duplicateFrames = 0
  for (let i = 1; i < frames.length; i += 1) {
    const a = frames[i - 1].pose
    const b = frames[i].pose
    if (a && b && a.every((p, j) => p.x === b[j].x && p.y === b[j].y && p.z === b[j].z)) duplicateFrames += 1
  }

  const { resolved, stats: identityStats } = resolveIdentities(frames)
  const calibration = calibrateHands(resolved, image, `${args.clip}:${rawSha.slice(0, 12)}`)
  console.log(`calibration: zScale L=${calibration.zScale.left} R=${calibration.zScale.right} (bone-length CV ${calibration.zScaleCurve.left.find((c) => c.zScale === calibration.zScale.left)?.inconsistency} vs legacy 0.4: ${calibration.legacyDepthScaleInconsistency.left})`)

  const hands = {
    left: cleanHandTrack('left', frames, resolved, timeline, image, geometry, calibration),
    right: cleanHandTrack('right', frames, resolved, timeline, image, geometry, calibration)
  }
  for (const side of ['left', 'right'] as const) console.log(`hand ${side}:`, JSON.stringify(hands[side].stats.states), 'rejected', hands[side].stats.rejectedFits)

  const handWrists: Record<Side, Landmark | null>[] = timeline.slots.map((slot) => ({
    left: hands.left.frames[slot.k].landmarks?.[0] ?? null,
    right: hands.right.frames[slot.k].landmarks?.[0] ?? null
  }))
  const handLandmarkSets: Record<Side, Landmark[] | null>[] = timeline.slots.map((slot) => ({
    left: hands.left.frames[slot.k].landmarks,
    right: hands.right.frames[slot.k].landmarks
  }))
  const body = cleanBodyTrack(frames, timeline, image, handWrists, handLandmarkSets, calibration.zScale)
  const face = cleanFaceTrack(frames, timeline, image)
  console.log(`face: zScale ${face.stats.zScale}, valid ${face.stats.validSlots}/${timeline.slots.length}`)

  const outFrames = timeline.slots.map((slot) => {
    const handOut = (side: Side) => {
      const f = hands[side].frames[slot.k]
      return {
        state: f.state,
        observed: f.observed,
        quality: r5(f.quality),
        palmWeight: r5(f.palmWeight),
        fingerWeight: r5(f.fingerWeight),
        rotation: arr5(f.rotation.toArray()),
        scale: r5(f.scale),
        wrist: arr5(f.wrist.toArray()),
        params: arr5(flattenParams(f.params)),
        landmarks: f.landmarks ? f.landmarks.flatMap((l) => [l.x, l.y, l.z]) : null
      }
    }
    const b = body.frames[slot.k]
    const fc = face.frames[slot.k]
    return {
      k: slot.k,
      t: r5(slot.t),
      source: slot.source,
      sourceTime: slot.sourceTime === null ? null : r5(slot.sourceTime),
      hands: { left: handOut('left'), right: handOut('right') },
      body: {
        valid: b.valid,
        leftShoulder: arr5(b.leftShoulder.toArray()),
        rightShoulder: arr5(b.rightShoulder.toArray()),
        torsoYaw: r5(b.torsoYaw),
        torsoRoll: r5(b.torsoRoll),
        wrist: { left: arr5(b.wrist.left.toArray()), right: arr5(b.wrist.right.toArray()) },
        wristConfidence: { left: r5(b.wristConfidence.left), right: r5(b.wristConfidence.right) },
        wristFromHand: { left: r5(b.wristFromHand.left), right: r5(b.wristFromHand.right) },
        elbow: { left: arr5(b.elbow.left.toArray()), right: arr5(b.elbow.right.toArray()) },
        elbowConfidence: { left: r5(b.elbowConfidence.left), right: r5(b.elbowConfidence.right) },
        shrug: { left: r5(b.shrug.left), right: r5(b.shrug.right) },
        faceAnchor: arr5(b.faceAnchor.toArray()),
        faceScale: r5(b.faceScale),
        handCenter: { left: arr5(b.handCenter.left.toArray()), right: arr5(b.handCenter.right.toArray()) },
        handCenterWeight: { left: r5(b.handCenterWeight.left), right: r5(b.handCenterWeight.right) }
      },
      face: {
        valid: fc.valid,
        rotation: arr5(fc.rotation.toArray()),
        jawOpen: r5(fc.jawOpen),
        smile: r5(fc.smile),
        mouthStretch: r5(fc.mouthStretch),
        blinkLeft: r5(fc.blinkLeft),
        blinkRight: r5(fc.blinkRight),
        browLeft: r5(fc.browLeft),
        browRight: r5(fc.browRight)
      }
    }
  })

  const stats = {
    rawFrames: frames.length,
    duplicateTrackerFrames: duplicateFrames,
    identity: identityStats,
    hands: { left: hands.left.stats, right: hands.right.stats },
    body: body.stats,
    face: face.stats
  }
  const clean = {
    schema: 'deafference.clean-landmarks',
    schemaVersion: 1,
    clipId: args.clip,
    generator: 'tools/clean-landmarks.ts',
    raw: { file: rawPath, sha256: rawSha, sourceSha256: raw.source.sha256, sourceFile: raw.source.file },
    image,
    timeline: {
      fps: timeline.fps,
      frameCount: timeline.slots.length,
      durationSec: r5((timeline.slots.length - 1) / timeline.fps),
      droppedSlots: timeline.droppedSlots,
      collisions: timeline.collisions,
      maxAbsOffsetMs: timeline.maxAbsOffsetMs,
      note: 'Uniform grid t = k / fps. `source` is the decoded source frame index shown at that time (null = dropped frame in the VFR source, interpolated).'
    },
    calibration: {
      note: 'Solver calibration only (physical constants estimated from this clip), not model training.',
      hands: { template: calibration.template, zScale: calibration.zScale, samples: calibration.samples },
      face: { zScale: face.template.zScale, template: face.template, baselines: face.baselines },
      body: body.normalizer
    },
    config: { hands: DEFAULT_HAND_CLEAN },
    channels: { handParams: PARAM_CHANNELS.map((c) => `${c.digit}.${c.key}`), angleUnit: 'radians' },
    stats,
    frames: outFrames
  }
  const cleanPath = `${args.motionDir}/${args.clip}/clean-landmarks.json.gz`
  writeJson(cleanPath, clean)

  const report = {
    schema: 'deafference.processing-report',
    schemaVersion: 1,
    clipId: args.clip,
    source: raw.source,
    extraction: { tracker: raw.tracker, detection: raw.stats },
    timeline: clean.timeline,
    calibration: {
      handZScale: calibration.zScale,
      handZScaleCurve: calibration.zScaleCurve,
      legacySolverDepthScale: {
        value: 0.38,
        boneLengthInconsistencyAtLegacyScale: calibration.legacyDepthScaleInconsistency,
        note: 'The previous finger solver multiplied hand z by 0.38; bone lengths are least consistent there. Calibrated values are ~2.1-2.3.'
      },
      handTemplate: calibration.template,
      face: { zScale: face.template.zScale, zScaleCurve: face.zScaleCurve, baselines: face.baselines },
      body: body.normalizer
    },
    cleaning: stats,
    stages: { clean: { seconds: Math.round((Date.now() - started) / 100) / 10 } }
  }
  writeJson(`${args.motionDir}/${args.clip}/processing-report.json`, report, true)
  console.log(`wrote ${cleanPath} (${outFrames.length} frames) in ${((Date.now() - started) / 1000).toFixed(1)} s`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
