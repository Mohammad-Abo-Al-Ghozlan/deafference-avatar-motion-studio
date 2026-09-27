import type { Landmark } from '../../types/tracking'
import { POSE } from './landmarks'

export type HandLabel = 'left' | 'right'

export interface IdentityInput {
  pose?: readonly Landmark[] | null
  left?: readonly Landmark[] | null
  right?: readonly Landmark[] | null
  /** Last accepted wrist positions (normalized image coords), if any. */
  previous?: Partial<Record<HandLabel, { x: number; y: number } | null>>
  aspect?: number
}

export interface IdentityResult {
  left: readonly Landmark[] | null
  right: readonly Landmark[] | null
  swapped: boolean
  droppedDuplicate: HandLabel | null
  relabelled: HandLabel | null
}

function planar(a: { x: number; y: number }, b: { x: number; y: number }, aspect: number) {
  return Math.hypot((a.x - b.x) * aspect, a.y - b.y)
}

function palmSize(hand: readonly Landmark[], aspect: number) {
  return Math.max(1e-4, planar(hand[0], hand[9], aspect))
}

/**
 * Resolve left/right hand identity. Holistic derives each hand ROI from the
 * pose wrist of the same side, so identity is usually right; it fails when
 * hands cross or one hand is occluded (both ROIs lock onto one hand). This
 * checks each hand against both pose wrists (visibility-weighted) and the
 * previous accepted wrist, then swaps, relabels, or drops duplicates.
 */
export function resolveHandIdentity(input: IdentityInput): IdentityResult {
  const aspect = input.aspect ?? 1
  let left = input.left ?? null
  let right = input.right ?? null
  const result: IdentityResult = { left, right, swapped: false, droppedDuplicate: null, relabelled: null }
  const pose = input.pose
  const anchor = (label: HandLabel) => {
    const wrist = pose?.[label === 'left' ? POSE.leftWrist : POSE.rightWrist]
    const visibility = wrist?.visibility ?? 0
    const inFrame = wrist ? wrist.x > -0.05 && wrist.x < 1.05 && wrist.y > -0.05 && wrist.y < 1.05 : false
    return wrist && visibility > 0.35 && inFrame ? wrist : null
  }
  const anchors = { left: anchor('left'), right: anchor('right') }
  const previous = input.previous ?? {}

  // Cost of attributing `hand` to `label`: pose wrist distance, with the
  // previous accepted wrist as a secondary cue.
  const cost = (hand: readonly Landmark[], label: HandLabel) => {
    const scale = palmSize(hand, aspect)
    let total = 0
    let weight = 0
    const poseWrist = anchors[label]
    if (poseWrist) {
      total += planar(hand[0], poseWrist, aspect) / scale
      weight += 1
    }
    const last = previous[label]
    if (last) {
      total += 0.5 * planar(hand[0], last, aspect) / scale
      weight += 0.5
    }
    return weight > 0 ? total / weight : null
  }

  if (left && right) {
    const separation = planar(left[0], right[0], aspect) / Math.min(palmSize(left, aspect), palmSize(right, aspect))
    const meanTip = (hand: readonly Landmark[]) => ({
      x: (hand[8].x + hand[12].x + hand[16].x) / 3,
      y: (hand[8].y + hand[12].y + hand[16].y) / 3
    })
    const tipSeparation = planar(meanTip(left), meanTip(right), aspect) / Math.min(palmSize(left, aspect), palmSize(right, aspect))
    if (separation < 0.35 && tipSeparation < 0.5) {
      // Both ROIs locked onto the same physical hand.
      const leftCost = cost(left, 'left') ?? 1
      const rightCost = cost(right, 'right') ?? 1
      if (leftCost <= rightCost) {
        result.droppedDuplicate = 'right'
        right = null
      } else {
        result.droppedDuplicate = 'left'
        left = null
      }
    } else {
      const keepL = cost(left, 'left')
      const keepR = cost(right, 'right')
      const swapL = cost(left, 'right')
      const swapR = cost(right, 'left')
      if (keepL !== null && keepR !== null && swapL !== null && swapR !== null) {
        const keep = keepL + keepR
        const swap = swapL + swapR
        if (swap < keep * 0.5 && keep - swap > 1.2) {
          ;[left, right] = [right, left]
          result.swapped = true
        }
      }
    }
  } else if (left || right) {
    const label: HandLabel = left ? 'left' : 'right'
    const other: HandLabel = label === 'left' ? 'right' : 'left'
    const hand = (left ?? right) as readonly Landmark[]
    const same = cost(hand, label)
    const cross = cost(hand, other)
    if (same !== null && cross !== null && cross < same * 0.4 && same - cross > 1.5) {
      if (label === 'left') {
        right = left
        left = null
      } else {
        left = right
        right = null
      }
      result.relabelled = other
    }
  }
  result.left = left
  result.right = right
  return result
}
