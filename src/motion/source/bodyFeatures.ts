import { Vector3 } from 'three'
import type { Landmark } from '../../types/tracking'
import { POSE, type ImageSpace } from './landmarks'

/**
 * Body-relative measurements used to drive the torso and the arm IK.
 *
 * Source body frame: origin = shoulder midpoint, axes model-aligned
 * (+X signer's left / image right, +Y up, +Z toward camera), unit = the
 * signer's shoulder width. Lateral/vertical placement comes from the image
 * landmarks (what a viewer sees, hand wrist when available); depth comes from
 * MediaPipe's metric world landmarks, because normalized pose z is unusable
 * when the hips (its origin) are out of frame, as in this clip.
 */

export interface BodyNormalizer {
  /** Image shoulder width in pixels used as the XY unit. */
  shoulderWidthPx: number
  /** World shoulder width in metres used as the Z unit. */
  shoulderWidthM: number
}

export interface BodySample {
  valid: boolean
  /** Shoulder positions in body units relative to their midpoint. */
  leftShoulder: Vector3
  rightShoulder: Vector3
  /** Shoulder midpoint in image pixels (model-aligned, y up). */
  midpointPx: Vector3
  /** Wrist targets in body units. */
  wrist: { left: Vector3; right: Vector3 }
  wristConfidence: { left: number; right: number }
  wristSource: { left: 'hand' | 'pose'; right: 'hand' | 'pose' }
  /** Elbow hints in body units (world-landmark geometry). */
  elbow: { left: Vector3; right: Vector3 }
  elbowConfidence: { left: number; right: number }
  /** Shoulder height above the eye line (body units), for shrug detection. */
  shoulderLift: { left: number; right: number }
  /** Torso orientation cues from the 3D shoulder line. */
  torsoYaw: number
  torsoRoll: number
  /** Eye midpoint (iris centres) in body units, depth from the world eye landmarks; null without a face. */
  faceAnchor: Vector3 | null
  /** Inter-pupillary distance in body units (face scale for face-relative placement). */
  faceScale: number
}

function imagePoint(landmark: Landmark, image: ImageSpace) {
  return new Vector3(landmark.x * image.width, -landmark.y * image.height, 0)
}

/** World landmark (MediaPipe: y down, z away from camera) -> model-aligned metres. */
function worldPoint(landmark: Landmark) {
  return new Vector3(landmark.x, -landmark.y, -landmark.z)
}

export function estimateNormalizer(samples: { pose: readonly Landmark[]; world: readonly Landmark[] }[], image: ImageSpace): BodyNormalizer {
  const px: number[] = []
  const m: number[] = []
  for (const sample of samples) {
    const l = sample.pose[POSE.leftShoulder]
    const r = sample.pose[POSE.rightShoulder]
    if ((l.visibility ?? 0) < 0.5 || (r.visibility ?? 0) < 0.5) continue
    px.push(imagePoint(l, image).distanceTo(imagePoint(r, image)))
    m.push(worldPoint(sample.world[POSE.leftShoulder]).distanceTo(worldPoint(sample.world[POSE.rightShoulder])))
  }
  const median = (list: number[]) => {
    const sorted = [...list].sort((a, b) => a - b)
    return sorted[sorted.length >> 1]
  }
  if (!px.length) throw new Error('No frames with both shoulders visible; cannot normalise body scale')
  return { shoulderWidthPx: median(px), shoulderWidthM: median(m) }
}

export function computeBodySample(
  pose: readonly Landmark[] | null | undefined,
  world: readonly Landmark[] | null | undefined,
  handWrist: { left: Landmark | null; right: Landmark | null },
  image: ImageSpace,
  normalizer: BodyNormalizer,
  irises?: { left: Landmark; right: Landmark } | null
): BodySample | null {
  if (!pose || pose.length < 33 || !world || world.length < 33) return null
  const lsImg = imagePoint(pose[POSE.leftShoulder], image)
  const rsImg = imagePoint(pose[POSE.rightShoulder], image)
  const mid = lsImg.clone().add(rsImg).multiplyScalar(0.5)
  const lsW = worldPoint(world[POSE.leftShoulder])
  const rsW = worldPoint(world[POSE.rightShoulder])
  const midW = lsW.clone().add(rsW).multiplyScalar(0.5)
  const px = normalizer.shoulderWidthPx
  const m = normalizer.shoulderWidthM

  const toBody = (imageLandmark: Landmark, worldLandmark: Landmark) => {
    const p = imagePoint(imageLandmark, image).sub(mid).divideScalar(px)
    p.z = (worldPoint(worldLandmark).z - midW.z) / m
    return p
  }

  const side = (label: 'left' | 'right') => {
    const wristIndex = label === 'left' ? POSE.leftWrist : POSE.rightWrist
    const elbowIndex = label === 'left' ? POSE.leftElbow : POSE.rightElbow
    const poseWrist = pose[wristIndex]
    const hand = handWrist[label]
    // Image-plane placement from the hand model's wrist when present (more
    // precise than the pose wrist); depth always from world landmarks.
    const wrist = toBody(hand ?? poseWrist, world[wristIndex])
    const inFrame = poseWrist.x > 0 && poseWrist.x < 1 && poseWrist.y > 0 && poseWrist.y < 1
    const confidence = hand ? 1 : (poseWrist.visibility ?? 0) * (inFrame ? 1 : 0.4)
    const elbow = worldPoint(world[elbowIndex]).sub(midW).divideScalar(m)
    const elbowConfidence = (pose[elbowIndex].visibility ?? 0)
    return { wrist, confidence, source: (hand ? 'hand' : 'pose') as 'hand' | 'pose', elbow, elbowConfidence }
  }
  const left = side('left')
  const right = side('right')

  // Shrug cue: shoulder height relative to the eye line, in body units.
  const eyeY = (imagePoint(pose[POSE.leftEyeOuter], image).y + imagePoint(pose[POSE.rightEyeOuter], image).y) / 2
  const across = lsW.clone().sub(rsW)
  const valid = (pose[POSE.leftShoulder].visibility ?? 0) > 0.5 && (pose[POSE.rightShoulder].visibility ?? 0) > 0.5

  let faceAnchor: Vector3 | null = null
  let faceScale = 0
  if (irises) {
    const a = imagePoint(irises.left, image)
    const b = imagePoint(irises.right, image)
    faceAnchor = a.clone().add(b).multiplyScalar(0.5).sub(mid).divideScalar(px)
    // Depth of the eyes (pose world landmarks 2 and 5), matching the
    // avatar's eye joints used as the face anchor.
    faceAnchor.z = ((worldPoint(world[2]).z + worldPoint(world[5]).z) / 2 - midW.z) / m
    faceScale = a.distanceTo(b) / px
  }

  return {
    valid,
    faceAnchor,
    faceScale,
    leftShoulder: lsImg.clone().sub(mid).divideScalar(px).setZ((lsW.z - midW.z) / m),
    rightShoulder: rsImg.clone().sub(mid).divideScalar(px).setZ((rsW.z - midW.z) / m),
    midpointPx: mid,
    wrist: { left: left.wrist, right: right.wrist },
    wristConfidence: { left: left.confidence, right: right.confidence },
    wristSource: { left: left.source, right: right.source },
    elbow: { left: left.elbow, right: right.elbow },
    elbowConfidence: { left: left.elbowConfidence, right: right.elbowConfidence },
    shoulderLift: { left: (lsImg.y - eyeY) / px, right: (rsImg.y - eyeY) / px },
    // Yaw about +Y: the signer's left shoulder moving toward the camera (+Z)
    // turns the torso toward the signer's right (negative yaw about +Y).
    torsoYaw: Math.atan2(-across.z, across.x),
    torsoRoll: Math.atan2(lsImg.y - rsImg.y, lsImg.x - rsImg.x)
  }
}
