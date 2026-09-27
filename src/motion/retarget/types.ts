import type { Quaternion, Vector3 } from 'three'
import type { Side } from '../rig/semanticMap'
import type { HandParams } from '../source/handModel'

/** One frame of cleaned, rig-independent source motion. */
export interface SourceHand {
  /** 1 = use the measured palm orientation, 0 = neutral wrist. */
  palmWeight: number
  /** Canonical palm basis -> model-aligned space. */
  rotation: Quaternion
  /** Anatomical joint angles (radians), already constrained and filtered. */
  params: HandParams
}

export interface SourceBody {
  torsoYaw: number
  torsoRoll: number
  /** Wrist targets relative to the shoulder midpoint, in shoulder widths. */
  wrist: Record<Side, Vector3>
  wristConfidence: Record<Side, number>
  /** Elbow hints relative to the shoulder midpoint, in shoulder widths. */
  elbow: Record<Side, Vector3>
  elbowConfidence: Record<Side, number>
  /** Shoulder lift relative to the clip median (shoulder widths). */
  shrug: Record<Side, number>
  /** Eye midpoint (body units) and inter-pupillary distance (body units). */
  faceAnchor?: Vector3
  faceScale?: number
  /** Hand centre (mean of 21 landmarks) in body units, and its availability 0..1. */
  handCenter?: Record<Side, Vector3>
  handCenterWeight?: Record<Side, number>
}

export interface SourceFace {
  /** Head rotation relative to the neutral head pose (model-aligned space). */
  rotation: Quaternion
  jawOpen: number
  smile: number
  mouthStretch: number
  blinkLeft: number
  blinkRight: number
  browLeft: number
  browRight: number
}

export interface SourcePose {
  body: SourceBody | null
  hands: Record<Side, SourceHand | null>
  face: SourceFace | null
}

export interface ArmDiagnostics {
  targetDistance: number
  /** 0 = shoulder-relative placement, 1 = face-relative placement. */
  faceWeight: number
  reachClamped: boolean
  elbowFlexion: number
  ikErrorM: number
  collisionPushM: number
  /** Forward depth added because the target was closer to the shoulder than the folded arm reaches (m). */
  depthCompletedM: number
  wristTwist: number
  wristTwistClamped: boolean
  wristSwingClamped: boolean
  poleConfidence: number
  /** Elbow swivel used / suggested by the hint / natural default (rad). */
  swivel: number
  hintSwivel: number
  defaultSwivel: number
  /** Magnitude of wrist-limit excess the chosen arm pose would require (rad). */
  wristViolation: number
  wristSwing: number
  /** Elbow height relative to the shoulder joint (m, + = above). */
  elbowHeight: number
  /** Required (unwrapped, unclamped) forearm twist (rad). */
  wristTwistRaw: number
}

export interface SolveDiagnostics {
  arms: Record<Side, ArmDiagnostics>
  fingerCrossingCorrections: number
  headAngle: number
}

export interface SolvedPose {
  /** Local rotations for every controlled joint. */
  rotations: Map<string, Quaternion>
  /** Local positions for translation-driven face joints. */
  translations: Map<string, Vector3>
  diagnostics: SolveDiagnostics
}
