import { Vector3 } from 'three'
import type { Landmark } from '../../types/tracking'

export const POSE = {
  nose: 0,
  leftEyeOuter: 3,
  rightEyeOuter: 6,
  leftEar: 7,
  rightEar: 8,
  leftShoulder: 11,
  rightShoulder: 12,
  leftElbow: 13,
  rightElbow: 14,
  leftWrist: 15,
  rightWrist: 16,
  leftPinky: 17,
  rightPinky: 18,
  leftIndex: 19,
  rightIndex: 20,
  leftThumb: 21,
  rightThumb: 22,
  leftHip: 23,
  rightHip: 24
} as const

export const HAND = {
  wrist: 0,
  thumb: [1, 2, 3, 4],
  index: [5, 6, 7, 8],
  middle: [9, 10, 11, 12],
  ring: [13, 14, 15, 16],
  pinky: [17, 18, 19, 20]
} as const

export const HAND_BONES: readonly (readonly [number, number])[] = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [0, 17], [17, 18], [18, 19], [19, 20]
]

/** Image geometry needed to put normalized landmarks in an isotropic space. */
export interface ImageSpace {
  width: number
  height: number
}

/**
 * Normalized MediaPipe landmark -> "model-aligned pixel space":
 *   +X = image right (the signer's LEFT = avatar's left, avatar faces +Z)
 *   +Y = up, +Z = toward the camera (the signer's forward)
 * This is a proper rotation of image space (no mirroring), so handedness and
 * chirality are preserved. `zScale` rescales MediaPipe's relative depth,
 * which is calibrated per stream from bone-length consistency.
 */
export function toModelSpace(landmark: Landmark, image: ImageSpace, zScale: number, target = new Vector3()) {
  return target.set(landmark.x * image.width, -landmark.y * image.height, -landmark.z * image.width * zScale)
}

export function fromModelSpace(point: Vector3, image: ImageSpace, zScale: number): Landmark {
  return { x: point.x / image.width, y: -point.y / image.height, z: -point.z / (image.width * zScale) }
}

export function landmarkIsFinite(landmark: Landmark | undefined): landmark is Landmark {
  return Boolean(landmark && Number.isFinite(landmark.x) && Number.isFinite(landmark.y) && Number.isFinite(landmark.z))
}

export function handIsFinite(hand: readonly Landmark[] | null | undefined): hand is readonly Landmark[] {
  return Boolean(hand && hand.length >= 21 && hand.every(landmarkIsFinite))
}

/** Fraction of a hand's landmarks that lie outside the image (extrapolated). */
export function outOfFrameRatio(hand: readonly Landmark[], margin = 0) {
  let outside = 0
  for (const point of hand) {
    if (point.x < -margin || point.x > 1 + margin || point.y < -margin || point.y > 1 + margin) outside += 1
  }
  return outside / hand.length
}
