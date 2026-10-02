import { Vector3 } from 'three'
import type { Landmark } from '../../src/types/tracking'
import { clamp } from '../../src/motion/math'
import { butterworthLowpass, filtfilt, hampel, pchipFill } from '../../src/motion/filters/offline'
import { computeBodySample, estimateNormalizer, type BodyNormalizer, type BodySample } from '../../src/motion/source/bodyFeatures'
import type { ImageSpace } from '../../src/motion/source/landmarks'
import type { Side } from '../../src/motion/rig/semanticMap'
import type { RawFrame } from './raw'
import type { Timeline } from './timeline'

export interface BodyTrackFrame {
  valid: boolean
  leftShoulder: Vector3
  rightShoulder: Vector3
  torsoYaw: number
  torsoRoll: number
  wrist: Record<Side, Vector3>
  wristConfidence: Record<Side, number>
  /** 1 when the wrist comes from the tracked hand model, 0 from pose. */
  wristFromHand: Record<Side, number>
  elbow: Record<Side, Vector3>
  elbowConfidence: Record<Side, number>
  shrug: Record<Side, number>
  faceAnchor: Vector3
  faceScale: number
  handCenter: Record<Side, Vector3>
  handCenterWeight: Record<Side, number>
}

export interface BodyTrack {
  normalizer: BodyNormalizer
  frames: BodyTrackFrame[]
  stats: Record<string, unknown>
}

/**
 * PCHIP between observed samples, nearest observed value before the first and
 * after the last one. `pchipFill` leaves those edge samples untouched, and
 * here they hold placeholder zeros: zero-phase filtering would smear that
 * fake step into the observed frames next to it (a hand that is last seen
 * just before the clip ends was pulled toward the shoulder midpoint and then
 * jumped back on the final frame).
 */
export function fillHoldEdges(raw: ArrayLike<number>, valid: ArrayLike<boolean>): Float64Array {
  const n = raw.length
  const out = pchipFill(raw, valid, new Array<boolean>(n).fill(true))
  let first = -1
  let last = -1
  for (let k = 0; k < n; k += 1) {
    if (!valid[k]) continue
    if (first < 0) first = k
    last = k
  }
  if (first < 0) return out
  for (let k = 0; k < first; k += 1) out[k] = out[first]
  for (let k = last + 1; k < n; k += 1) out[k] = out[last]
  return out
}

/**
 * Body stream cleaning. `handWrists[k][side]` is the clean hand-model wrist
 * (normalized image coords) when the hand is tracked/interpolated at slot k.
 */
export function cleanBodyTrack(
  frames: RawFrame[],
  timeline: Timeline,
  image: ImageSpace,
  handWrists: Record<Side, Landmark | null>[],
  handLandmarks: Record<Side, Landmark[] | null>[] = [],
  handZScale: Record<Side, number> = { left: 2, right: 2 }
): BodyTrack {
  const normalizer = estimateNormalizer(frames.filter((f) => f.pose && f.world).map((f) => ({ pose: f.pose!, world: f.world! })), image)
  const n = timeline.slots.length
  const samples: (BodySample | null)[] = new Array(n).fill(null)
  const poseOnly: (BodySample | null)[] = new Array(n).fill(null)
  for (const slot of timeline.slots) {
    if (slot.source === null) continue
    const frame = frames[slot.source]
    const irises = frame.face?.get(468) && frame.face?.get(473) ? { left: frame.face.get(473)!, right: frame.face.get(468)! } : null
    samples[slot.k] = computeBodySample(frame.pose, frame.world, handWrists[slot.k], image, normalizer, irises)
    poseOnly[slot.k] = computeBodySample(frame.pose, frame.world, { left: null, right: null }, image, normalizer, irises)
  }
  const valid = samples.map((s) => Boolean(s?.valid))
  const fs = timeline.fps
  let outliers = 0
  const series = (get: (s: BodySample) => number, hz: number, floor: number, mask = valid) => {
    const raw = Float64Array.from(samples.map((s) => (s ? get(s) : 0)))
    const bad = hampel(raw, mask, 4, 4, floor)
    const ok = mask.map((v, k) => v && !bad[k])
    outliers += mask.filter((v, k) => v && bad[k]).length
    return filtfilt(butterworthLowpass(hz, fs), fillHoldEdges(raw, ok))
  }
  const seriesFrom = (source: (BodySample | null)[], get: (s: BodySample) => number, hz: number, floor: number) => {
    const raw = Float64Array.from(source.map((s) => (s ? get(s) : 0)))
    const ok = source.map((s) => Boolean(s?.valid))
    const bad = hampel(raw, ok, 4, 4, floor)
    const good = ok.map((v, k) => v && !bad[k])
    return filtfilt(butterworthLowpass(hz, fs), fillHoldEdges(raw, good))
  }

  const shoulder = (side: Side) => [0, 1, 2].map((axis) =>
    series((s) => (side === 'left' ? s.leftShoulder : s.rightShoulder).getComponent(axis), 3, 0.03))
  const ls = shoulder('left')
  const rs = shoulder('right')
  const yaw = series((s) => s.torsoYaw, 2, 0.08)
  const roll = series((s) => s.torsoRoll, 2, 0.05)

  const wristTracks: Record<Side, { xyz: Float64Array[]; confidence: Float64Array; fromHand: Float64Array }> = {} as never
  const elbowTracks: Record<Side, { xyz: Float64Array[]; confidence: Float64Array }> = {} as never
  const shrugTracks: Record<Side, Float64Array> = {} as never
  for (const side of ['left', 'right'] as const) {
    // Blend hand-model wrist and pose wrist with a smooth weight so source
    // switches (hand entering/leaving detection) never cause a jump.
    const handAvailable = timeline.slots.map((slot) => Boolean(handWrists[slot.k][side]))
    const fromHand = filtfilt(butterworthLowpass(3, fs), Float64Array.from(handAvailable.map((v) => (v ? 1 : 0)))).map((v) => clamp(v, 0, 1))
    const poseXYZ = [0, 1, 2].map((axis) => seriesFrom(poseOnly, (s) => s.wrist[side].getComponent(axis), axis === 2 ? 2.5 : 6, 0.05))
    const handRawXY = [0, 1].map((axis) => Float64Array.from(samples.map((s, k) => (s && handAvailable[k] ? s.wrist[side].getComponent(axis) : 0))))
    const handXY = handRawXY.map((raw) => filtfilt(butterworthLowpass(6, fs), fillHoldEdges(raw, handAvailable)))
    const confidenceRaw = Float64Array.from(samples.map((s) => (s ? s.wristConfidence[side] : 0)))
    const confidence = filtfilt(butterworthLowpass(1.5, fs), confidenceRaw).map((v) => clamp(v, 0, 1))
    // Low-confidence (out-of-frame, extrapolated) wrists get extra smoothing.
    const slowXYZ = poseXYZ.map((axis) => filtfilt(butterworthLowpass(1.2, fs), axis))
    const xyz = [0, 1, 2].map((axis) => {
      const out = new Float64Array(n)
      for (let k = 0; k < n; k += 1) {
        const poseValue = poseXYZ[axis][k] * confidence[k] + slowXYZ[axis][k] * (1 - confidence[k])
        const handValue = axis < 2 ? handXY[axis][k] : poseValue
        out[k] = handValue * fromHand[k] + poseValue * (1 - fromHand[k])
      }
      return out
    })
    wristTracks[side] = { xyz, confidence: Float64Array.from(confidence.map((c, k) => Math.max(c, fromHand[k]))), fromHand }
    elbowTracks[side] = {
      xyz: [0, 1, 2].map((axis) => series((s) => s.elbow[side].getComponent(axis), 2, 0.05)),
      confidence: filtfilt(butterworthLowpass(1, fs), Float64Array.from(samples.map((s) => (s ? s.elbowConfidence[side] : 0)))).map((v) => clamp(v, 0, 1))
    }
    const lift = series((s) => s.shoulderLift[side], 3, 0.02)
    const sorted = Array.from(lift).sort((a, b) => a - b)
    const median = sorted[sorted.length >> 1]
    shrugTracks[side] = lift.map((v) => v - median)
  }

  // Hand centre (mean of the 21 cleaned hand landmarks) in body units, used
  // to place the HAND (not just the wrist) where the viewer sees it. Depth =
  // wrist depth + the hand model's own depth offsets.
  const handCenter = {} as Record<Side, { xyz: Float64Array[]; weight: Float64Array }>
  for (const side of ['left', 'right'] as const) {
    const available = timeline.slots.map((slot) => Boolean(handLandmarks[slot.k]?.[side]))
    const raw = [0, 1, 2].map(() => new Float64Array(n))
    for (let k = 0; k < n; k += 1) {
      const lm = handLandmarks[k]?.[side]
      if (!lm) continue
      let x = 0, y = 0, dz = 0
      for (const p of lm) {
        x += p.x
        y += p.y
        dz += -(p.z - lm[0].z) * image.width * handZScale[side]
      }
      x /= lm.length
      y /= lm.length
      dz /= lm.length
      const s = samples[k]
      const mid = s ? s.midpointPx : null
      if (!mid) continue
      raw[0][k] = (x * image.width - mid.x) / normalizer.shoulderWidthPx
      raw[1][k] = (-y * image.height - mid.y) / normalizer.shoulderWidthPx
      raw[2][k] = dz / normalizer.shoulderWidthPx
    }
    const valid = available.map((v, k) => v && Boolean(samples[k]))
    const xyz = raw.map((axis) => filtfilt(butterworthLowpass(6, fs), fillHoldEdges(axis, valid)))
    handCenter[side] = { xyz, weight: Float64Array.from(wristTracks[side].fromHand) }
  }

  // Face anchor (eye midpoint) and inter-pupillary distance for face-relative
  // hand placement near the face.
  const faceValid = samples.map((s) => Boolean(s?.valid && s.faceAnchor))
  const faceAxis = [0, 1, 2].map((axis) => series((s) => s.faceAnchor?.getComponent(axis) ?? 0, 4, 0.03, faceValid))
  // Inter-pupillary distance is physically constant and scales with camera
  // distance exactly like the shoulder width, so its ratio to the shoulder
  // width is constant: use the clip median (robust to head-yaw foreshortening).
  const ipdValues = samples.filter((s, k) => faceValid[k] && s).map((s) => s!.faceScale).sort((a, b) => a - b)
  const ipdMedian = ipdValues.length ? ipdValues[ipdValues.length >> 1] : 0
  const faceScale = new Float64Array(n).fill(ipdMedian)

  const out: BodyTrackFrame[] = []
  for (let k = 0; k < n; k += 1) {
    const v3 = (arr: Float64Array[]) => new Vector3(arr[0][k], arr[1][k], arr[2][k])
    out.push({
      valid: valid[k],
      leftShoulder: v3(ls),
      rightShoulder: v3(rs),
      torsoYaw: yaw[k],
      torsoRoll: roll[k],
      wrist: { left: v3(wristTracks.left.xyz), right: v3(wristTracks.right.xyz) },
      wristConfidence: { left: wristTracks.left.confidence[k], right: wristTracks.right.confidence[k] },
      wristFromHand: { left: wristTracks.left.fromHand[k], right: wristTracks.right.fromHand[k] },
      elbow: { left: v3(elbowTracks.left.xyz), right: v3(elbowTracks.right.xyz) },
      elbowConfidence: { left: elbowTracks.left.confidence[k], right: elbowTracks.right.confidence[k] },
      shrug: { left: shrugTracks.left[k], right: shrugTracks.right[k] },
      faceAnchor: v3(faceAxis),
      faceScale: faceScale[k],
      // XY = mean of the hand landmarks; Z = wrist depth + hand-model depth offset.
      handCenter: {
        left: new Vector3(handCenter.left.xyz[0][k], handCenter.left.xyz[1][k], wristTracks.left.xyz[2][k] + handCenter.left.xyz[2][k]),
        right: new Vector3(handCenter.right.xyz[0][k], handCenter.right.xyz[1][k], wristTracks.right.xyz[2][k] + handCenter.right.xyz[2][k])
      },
      handCenterWeight: { left: handCenter.left.weight[k], right: handCenter.right.weight[k] }
    })
  }
  return {
    normalizer,
    frames: out,
    stats: {
      normalizer,
      validSlots: valid.filter(Boolean).length,
      outliersRejected: outliers
    }
  }
}
