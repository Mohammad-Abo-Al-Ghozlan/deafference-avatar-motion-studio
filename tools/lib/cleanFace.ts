import { Quaternion } from 'three'
import { angleBetweenQuaternions, DEG } from '../../src/motion/math'
import {
  alignQuaternionSequence, butterworthLowpass, filtfilt, filtfiltQuaternions, hampel, pchipFill, percentile, runs
} from '../../src/motion/filters/offline'
import {
  buildFaceTemplate, measureFace, normalizeFaceSignals, recenterTemplate, rigidShape,
  type FaceFeatureBaselines, type FaceMeasurements, type FaceTemplate
} from '../../src/motion/source/faceFeatures'
import { toModelSpace, type ImageSpace } from '../../src/motion/source/landmarks'
import type { RawFrame } from './raw'
import type { Timeline } from './timeline'

export type { FaceFeatureBaselines }

export interface FaceTrackFrame {
  valid: boolean
  rotation: Quaternion
  /** Normalised non-manual signals. */
  jawOpen: number
  smile: number
  mouthStretch: number
  blinkLeft: number
  blinkRight: number
  browLeft: number
  browRight: number
  residual: number
}

export interface FaceTrack {
  template: FaceTemplate
  baselines: FaceFeatureBaselines
  zScaleCurve: { zScale: number; residual: number }[]
  frames: FaceTrackFrame[]
  stats: Record<string, unknown>
}

function lookupFor(frame: RawFrame, image: ImageSpace, zScale: number) {
  return (meshIndex: number) => {
    const landmark = frame.face?.get(meshIndex)
    return landmark ? toModelSpace(landmark, image, zScale) : null
  }
}

export function cleanFaceTrack(frames: RawFrame[], timeline: Timeline, image: ImageSpace): FaceTrack {
  const withFace = frames.filter((frame) => frame.face)
  if (withFace.length < 30) throw new Error('Too few face detections for calibration')

  // Calibrate face depth scale: rigid points should move rigidly.
  const subsample = withFace.filter((_, i) => i % 6 === 0)
  const curve: { zScale: number; residual: number }[] = []
  let bestZ = 1
  let bestResidual = Infinity
  for (let z = 0.4; z <= 3.01; z += 0.2) {
    const shapes = subsample.map((frame) => rigidShape(lookupFor(frame, image, z))).filter(Boolean).map((s) => s!.points)
    const template = buildFaceTemplate(shapes, z, 2)
    let sum = 0
    let count = 0
    for (const frame of subsample) {
      const m = measureFace(lookupFor(frame, image, z), template)
      if (m) {
        sum += m.residual
        count += 1
      }
    }
    const residual = sum / Math.max(count, 1)
    curve.push({ zScale: Math.round(z * 100) / 100, residual: Math.round(residual * 1e5) / 1e5 })
    if (residual < bestResidual) {
      bestResidual = residual
      bestZ = Math.round(z * 100) / 100
    }
  }

  const shapes = withFace.filter((_, i) => i % 2 === 0).map((frame) => rigidShape(lookupFor(frame, image, bestZ))).filter(Boolean).map((s) => s!.points)
  let template = buildFaceTemplate(shapes, bestZ, 4)
  const initial = withFace.map((frame) => measureFace(lookupFor(frame, image, bestZ), template)).filter(Boolean).map((m) => m!.rotation)
  template = recenterTemplate(template, initial)

  const n = timeline.slots.length
  const measurements: (FaceMeasurements | null)[] = new Array(n).fill(null)
  for (const slot of timeline.slots) {
    if (slot.source === null) continue
    const frame = frames[slot.source]
    if (!frame.face) continue
    measurements[slot.k] = measureFace(lookupFor(frame, image, bestZ), template)
  }
  const residuals = measurements.filter(Boolean).map((m) => m!.residual)
  const residualGate = percentile(residuals, 0.99) * 1.5
  const valid = measurements.map((m) => Boolean(m && m.residual <= residualGate && Object.values(m).every((v) => typeof v !== 'number' || Number.isFinite(v))))

  const rotations = measurements.map((m) => (m ? m.rotation.clone() : new Quaternion()))
  alignQuaternionSequence(rotations)
  // Head rotation spikes (one-frame flips).
  let spikes = 0
  for (let k = 1; k < n - 1; k += 1) {
    if (!valid[k] || !valid[k - 1] || !valid[k + 1]) continue
    if (angleBetweenQuaternions(rotations[k], rotations[k - 1]) > 20 * DEG && angleBetweenQuaternions(rotations[k], rotations[k + 1]) > 20 * DEG && angleBetweenQuaternions(rotations[k - 1], rotations[k + 1]) < 10 * DEG) {
      valid[k] = false
      spikes += 1
    }
  }

  const featureKeys = ['mouthOpen', 'mouthWidth', 'cornerLiftLeft', 'cornerLiftRight', 'eyeOpenLeft', 'eyeOpenRight', 'browLeft', 'browRight'] as const
  const raw: Record<(typeof featureKeys)[number], Float64Array> = Object.fromEntries(featureKeys.map((key) => [key, Float64Array.from(measurements.map((m) => (m ? m[key] : 0)))])) as never
  let featureOutliers = 0
  const featureValid: Record<string, boolean[]> = {}
  for (const key of featureKeys) {
    const floor = key.startsWith('eye') ? 0.08 : 0.02
    const mask = hampel(raw[key], valid, 3, 4, floor)
    // Blinks are genuine fast events; never treat eye closure as an outlier.
    featureValid[key] = valid.map((v, k) => v && (key.startsWith('eye') ? true : !mask[k]))
    featureOutliers += featureValid[key].filter((v, k) => valid[k] && !v).length
  }

  const everywhere = new Array<boolean>(n).fill(true)
  const filledRotations = fillQuaternions(rotations, valid)
  const cutoff = { rotation: 5, eye: 9, mouth: 7, brow: 5 }
  const fs = timeline.fps
  const smoothRotations = filtfiltQuaternions(butterworthLowpass(cutoff.rotation, fs), filledRotations)
  const smooth = (key: (typeof featureKeys)[number], hz: number) => filtfilt(butterworthLowpass(hz, fs), pchipFill(raw[key], featureValid[key], everywhere))
  const s = {
    mouthOpen: smooth('mouthOpen', cutoff.mouth),
    mouthWidth: smooth('mouthWidth', cutoff.mouth),
    cornerLiftLeft: smooth('cornerLiftLeft', cutoff.mouth),
    cornerLiftRight: smooth('cornerLiftRight', cutoff.mouth),
    eyeOpenLeft: smooth('eyeOpenLeft', cutoff.eye),
    eyeOpenRight: smooth('eyeOpenRight', cutoff.eye),
    browLeft: smooth('browLeft', cutoff.brow),
    browRight: smooth('browRight', cutoff.brow)
  }

  const validValues = (arr: Float64Array) => Array.from(arr).filter((_, k) => valid[k])
  const baselines: FaceFeatureBaselines = {
    mouthOpen: { closed: percentile(validValues(s.mouthOpen), 0.1), open: percentile(validValues(s.mouthOpen), 0.97) },
    mouthWidth: {
      neutral: percentile(validValues(s.mouthWidth), 0.5),
      wide: percentile(validValues(s.mouthWidth), 0.97),
      narrow: percentile(validValues(s.mouthWidth), 0.03)
    },
    cornerLift: {
      neutral: percentile([...validValues(s.cornerLiftLeft), ...validValues(s.cornerLiftRight)], 0.5),
      range: Math.max(1e-3, percentile([...validValues(s.cornerLiftLeft), ...validValues(s.cornerLiftRight)], 0.97) - percentile([...validValues(s.cornerLiftLeft), ...validValues(s.cornerLiftRight)], 0.5))
    },
    eyeOpen: {
      left: { open: percentile(validValues(s.eyeOpenLeft), 0.7), closed: percentile(validValues(s.eyeOpenLeft), 0.005) },
      right: { open: percentile(validValues(s.eyeOpenRight), 0.7), closed: percentile(validValues(s.eyeOpenRight), 0.005) }
    },
    brow: {
      left: { neutral: percentile(validValues(s.browLeft), 0.5), up: percentile(validValues(s.browLeft), 0.97), down: percentile(validValues(s.browLeft), 0.03) },
      right: { neutral: percentile(validValues(s.browRight), 0.5), up: percentile(validValues(s.browRight), 0.97), down: percentile(validValues(s.browRight), 0.03) }
    }
  }

  const out: FaceTrackFrame[] = []
  for (let k = 0; k < n; k += 1) {
    const signals = normalizeFaceSignals({
      mouthOpen: s.mouthOpen[k],
      mouthWidth: s.mouthWidth[k],
      cornerLiftLeft: s.cornerLiftLeft[k],
      cornerLiftRight: s.cornerLiftRight[k],
      eyeOpenLeft: s.eyeOpenLeft[k],
      eyeOpenRight: s.eyeOpenRight[k],
      browLeft: s.browLeft[k],
      browRight: s.browRight[k]
    }, baselines)
    out.push({ valid: valid[k], rotation: smoothRotations[k], ...signals, residual: measurements[k]?.residual ?? NaN })
  }

  return {
    template,
    baselines,
    zScaleCurve: curve,
    frames: out,
    stats: {
      zScale: bestZ,
      measuredSlots: measurements.filter(Boolean).length,
      validSlots: valid.filter(Boolean).length,
      residualGate,
      headSpikesRejected: spikes,
      featureOutliersRejected: featureOutliers,
      invalidIntervals: runs(valid, false).map(([a, e]) => ({ start: a, end: e - 1 }))
    }
  }
}

function fillQuaternions(sequence: Quaternion[], valid: boolean[]) {
  const out = sequence.map((q) => q.clone())
  const n = sequence.length
  const firstValid = valid.indexOf(true)
  if (firstValid < 0) return out.map(() => new Quaternion())
  for (const [start, end] of runs(valid, false)) {
    const a = start > 0 ? start - 1 : -1
    const b = end < n ? end : -1
    for (let k = start; k < end; k += 1) {
      if (a >= 0 && b >= 0) out[k] = sequence[a].clone().slerp(sequence[b], (k - start + 1) / (end - start + 1))
      else out[k] = sequence[a >= 0 ? a : b].clone()
    }
  }
  return out
}
