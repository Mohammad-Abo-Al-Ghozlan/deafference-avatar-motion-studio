import { Vector3 } from 'three'
import type { Landmark } from '../../types/tracking'
import { azimuth, elevation, palmFrameFromPoints } from '../rig/rigGeometry'
import type { Side } from '../rig/semanticMap'
import { medianOf } from '../filters/offline'
import { signedAngleAbout } from '../math'
import { DIGITS, LONG, type HandTemplate, type LongFinger } from './handModel'
import { HAND, type ImageSpace, toModelSpace } from './landmarks'

/**
 * Solver calibration (NOT model training): estimates a small set of physical
 * constants for this camera/signer from the clip itself:
 *   - zScale: MediaPipe relative-depth rescale that makes phalanx lengths
 *     most constant over time (real bones do not change length);
 *   - the signer's palm geometry and phalanx proportions.
 * Nothing is learned that could memorise signs; these are 25 geometric
 * numbers with physical meaning, reported in processing-report.json.
 */

export interface CalibrationSample {
  side: Side
  landmarks: readonly Landmark[]
}

const FINGER_SEGMENTS: [number, number][] = [
  [1, 2], [2, 3], [3, 4],
  [5, 6], [6, 7], [7, 8],
  [9, 10], [10, 11], [11, 12],
  [13, 14], [14, 15], [15, 16],
  [17, 18], [18, 19], [19, 20]
]
const PALM_SEGMENTS: [number, number][] = [[0, 5], [0, 17], [5, 9], [9, 13], [13, 17], [0, 9]]

function points(sample: CalibrationSample, image: ImageSpace, zScale: number) {
  return sample.landmarks.map((landmark) => toModelSpace(landmark, image, zScale))
}

/** Mean coefficient of variation of finger-segment / palm-size ratios. */
export function boneLengthInconsistency(samples: CalibrationSample[], image: ImageSpace, zScale: number) {
  if (!samples.length) return Infinity
  const ratios: number[][] = FINGER_SEGMENTS.map(() => [])
  for (const sample of samples) {
    const p = points(sample, image, zScale)
    let palm = 0
    for (const [a, b] of PALM_SEGMENTS) palm += p[a].distanceTo(p[b])
    palm /= PALM_SEGMENTS.length
    if (!(palm > 1e-6)) continue
    FINGER_SEGMENTS.forEach(([a, b], k) => ratios[k].push(p[a].distanceTo(p[b]) / palm))
  }
  let total = 0
  for (const list of ratios) {
    const mean = list.reduce((s, v) => s + v, 0) / list.length
    const variance = list.reduce((s, v) => s + (v - mean) ** 2, 0) / list.length
    total += Math.sqrt(variance) / mean
  }
  return total / ratios.length
}

export function calibrateZScale(samples: CalibrationSample[], image: ImageSpace, range: [number, number] = [0.5, 3.5], step = 0.05) {
  const curve: { zScale: number; inconsistency: number }[] = []
  let best = { zScale: 1, inconsistency: Infinity }
  for (let k = range[0]; k <= range[1] + 1e-9; k += step) {
    const value = boneLengthInconsistency(samples, image, k)
    const rounded = Math.round(k * 1000) / 1000
    curve.push({ zScale: rounded, inconsistency: Math.round(value * 1e5) / 1e5 })
    if (value < best.inconsistency) best = { zScale: rounded, inconsistency: value }
  }
  return { ...best, curve }
}

/**
 * Median palm geometry and phalanx proportions. Left hands are mirrored into
 * right-hand canonical coordinates so both hands of the signer are pooled.
 * Segment lengths use only frames where the segment lies near the image
 * plane (|dz| < 35% of its length), where monocular depth error is smallest.
 */
export function calibrateTemplate(samples: CalibrationSample[], image: ImageSpace, zScaleBySide: Record<Side, number>, label: string): HandTemplate {
  const palmKeys = ['thumbCmc', 'indexMcp', 'middleMcp', 'ringMcp', 'pinkyMcp'] as const
  const palmIndex = { thumbCmc: HAND.thumb[0], indexMcp: HAND.index[0], middleMcp: HAND.middle[0], ringMcp: HAND.ring[0], pinkyMcp: HAND.pinky[0] }
  const palmCoords: Record<(typeof palmKeys)[number], number[][]> = { thumbCmc: [], indexMcp: [], middleMcp: [], ringMcp: [], pinkyMcp: [] }
  const lengthSamples: Record<string, number[]> = {}
  const neutralSamples: Record<LongFinger, number[]> = { index: [], middle: [], ring: [], pinky: [] }
  for (const sample of samples) {
    const p = points(sample, image, zScaleBySide[sample.side])
    const frame = palmFrameFromPoints(sample.side, p[0], p[5], p[9], p[17])
    if (!frame) continue
    const palmLength = p[9].distanceTo(p[0])
    if (!(palmLength > 1e-6)) continue
    // Prefer palms facing the camera for palm-shape estimation.
    const facing = Math.abs(frame.volar.z)
    const inverse = frame.basis.clone().invert()
    const canonical = (v: Vector3) => {
      const c = v.clone().sub(p[0]).applyQuaternion(inverse).divideScalar(palmLength)
      return [sample.side === 'left' ? -c.x : c.x, c.y, c.z]
    }
    if (facing > 0.55) {
      for (const key of palmKeys) palmCoords[key].push(canonical(p[palmIndex[key]]))
    }
    // Relaxed azimuth of each long finger, from frames where it is extended.
    for (const finger of LONG) {
      const chain = HAND[finger]
      const d1 = p[chain[1]].clone().sub(p[chain[0]]).normalize()
      const d2 = p[chain[2]].clone().sub(p[chain[1]]).normalize()
      const flex = elevation(d1, frame)
      const az = azimuth(d1, frame)
      const u = frame.forward.clone().multiplyScalar(Math.cos(az)).addScaledVector(frame.radial, Math.sin(az))
      const hinge = new Vector3().crossVectors(u, frame.volar).normalize()
      const pip = signedAngleAbout(d1, d2, hinge)
      if (Math.abs(flex) < 0.44 && Math.abs(pip) < 0.44) neutralSamples[finger].push(az)
    }
    for (const digit of DIGITS) {
      const chain = HAND[digit]
      for (let s = 0; s < 3; s += 1) {
        const a = p[chain[s]]
        const b = p[chain[s + 1]]
        const length = a.distanceTo(b)
        if (!(length > 1e-6)) continue
        if (Math.abs(b.z - a.z) / length > 0.35) continue
        ;(lengthSamples[`${digit}${s}`] ??= []).push(length / palmLength)
      }
    }
  }
  const median3 = (list: number[][]): [number, number, number] => {
    if (!list.length) throw new Error('Calibration has no usable palm samples')
    return [0, 1, 2].map((axis) => medianOf(list.map((v) => v[axis]))) as [number, number, number]
  }
  const palm = Object.fromEntries(palmKeys.map((key) => [key, median3(palmCoords[key])])) as HandTemplate['palm']
  palm.middleMcp = [0, 1, 0]
  const lengths = {} as HandTemplate['lengths']
  for (const digit of DIGITS) {
    lengths[digit] = [0, 1, 2].map((s) => {
      const list = lengthSamples[`${digit}${s}`]
      if (!list || list.length < 20) throw new Error(`Calibration has too few samples for ${digit} segment ${s}`)
      return Math.round(medianOf(list) * 1e4) / 1e4
    }) as [number, number, number]
  }
  const round3 = (v: [number, number, number]) => v.map((x) => Math.round(x * 1e4) / 1e4) as [number, number, number]
  const neutralAbduction = {} as Record<LongFinger, number>
  for (const finger of LONG) {
    const list = neutralSamples[finger]
    if (list.length < 20) throw new Error(`Calibration has too few extended-finger samples for ${finger}`)
    neutralAbduction[finger] = Math.round(medianOf(list) * 1e5) / 1e5
  }
  return {
    version: 1,
    palm: {
      thumbCmc: round3(palm.thumbCmc),
      indexMcp: round3(palm.indexMcp),
      middleMcp: palm.middleMcp,
      ringMcp: round3(palm.ringMcp),
      pinkyMcp: round3(palm.pinkyMcp)
    },
    lengths,
    neutralAbduction,
    zScale: Math.round(((zScaleBySide.left + zScaleBySide.right) / 2) * 1000) / 1000,
    source: label
  }
}
