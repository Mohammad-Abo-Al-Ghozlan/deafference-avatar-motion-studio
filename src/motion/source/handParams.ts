import { DEG } from '../math'
import type { FingerName } from '../rig/semanticMap'
import {
  clampLongFinger, clampThumb, LONG, type HandParams, type HandTemplate, type LongFinger, type LongFingerParams, type ThumbParams
} from './handModel'

export interface ParamChannel {
  digit: FingerName
  key: keyof LongFingerParams | keyof ThumbParams
}

/** Stable channel order for per-scalar filtering and serialization. */
export const PARAM_CHANNELS: readonly ParamChannel[] = [
  { digit: 'thumb', key: 'azimuth' },
  { digit: 'thumb', key: 'elevation' },
  { digit: 'thumb', key: 'axial' },
  { digit: 'thumb', key: 'mcp' },
  { digit: 'thumb', key: 'ip' },
  ...LONG.flatMap((digit) => (['abduction', 'mcp', 'pip', 'dip'] as const).map((key) => ({ digit, key })))
]

export function flattenParams(params: HandParams): number[] {
  return PARAM_CHANNELS.map(({ digit, key }) => (params[digit] as unknown as Record<string, number>)[key])
}

export function unflattenParams(values: ArrayLike<number>): HandParams {
  const out = {
    thumb: { azimuth: 0, elevation: 0, axial: 0, mcp: 0, ip: 0 },
    index: { abduction: 0, mcp: 0, pip: 0, dip: 0 },
    middle: { abduction: 0, mcp: 0, pip: 0, dip: 0 },
    ring: { abduction: 0, mcp: 0, pip: 0, dip: 0 },
    pinky: { abduction: 0, mcp: 0, pip: 0, dip: 0 }
  } as HandParams
  PARAM_CHANNELS.forEach(({ digit, key }, c) => {
    ;(out[digit] as unknown as Record<string, number>)[key] = values[c]
  })
  return out
}

export function cloneParams(params: HandParams): HandParams {
  return unflattenParams(flattenParams(params))
}

const PAIRS: [LongFinger, LongFinger][] = [['index', 'middle'], ['middle', 'ring'], ['ring', 'pinky']]

/**
 * Anti-crossing: adjacent fingers keep their radial->ulnar order in the palm
 * plane (index >= middle >= ring >= pinky azimuth, with `overlap` tolerance
 * that grows when the fingers are curled, because curled fingers can converge
 * in azimuth without their paths crossing). Works on absolute azimuths.
 * Returns the number of corrections applied.
 */
export function separateAdjacentFingers(azimuths: Record<LongFinger, number>, mcp: Record<LongFinger, number>, overlap: number) {
  let corrections = 0
  for (let iteration = 0; iteration < 4; iteration += 1) {
    let changed = false
    for (const [radial, ulnar] of PAIRS) {
      const curl = Math.max(0, Math.min(mcp[radial], mcp[ulnar]) - 45 * DEG) / (45 * DEG)
      const tolerance = overlap + 20 * DEG * Math.min(1, curl)
      const gap = azimuths[radial] - azimuths[ulnar]
      if (gap < -tolerance) {
        const shift = (-tolerance - gap) / 2
        azimuths[radial] += shift
        azimuths[ulnar] -= shift
        changed = true
        corrections += 1
      }
    }
    if (!changed) break
  }
  return corrections
}

/**
 * Project a parameter set onto the anatomical feasible set: joint ranges,
 * flexion-dependent abduction range, DIP/PIP coupling envelope, thumb
 * ranges, and finger-order preservation.
 */
export function enforceHandConstraints(template: HandTemplate, params: HandParams, _neutral: Record<LongFinger, number>, overlap: number) {
  const out = cloneParams(params)
  for (const finger of LONG) out[finger] = clampLongFinger(template, finger, out[finger])
  out.thumb = clampThumb(out.thumb)
  const azimuths = { index: out.index.abduction, middle: out.middle.abduction, ring: out.ring.abduction, pinky: out.pinky.abduction }
  const mcp = { index: out.index.mcp, middle: out.middle.mcp, ring: out.ring.mcp, pinky: out.pinky.mcp }
  const crossingCorrections = separateAdjacentFingers(azimuths, mcp, overlap)
  for (const finger of LONG) {
    out[finger].abduction = azimuths[finger]
    out[finger] = clampLongFinger(template, finger, out[finger])
  }
  return { params: out, crossingCorrections }
}
