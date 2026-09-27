export interface Landmark {
  x: number
  y: number
  z: number
  visibility?: number
}

export interface TrackingFrame {
  readonly poseLandmarks?: readonly Landmark[]
  /** Metric pose landmarks (metres, hip-centred) when the tracker provides them. */
  readonly poseWorldLandmarks?: readonly Landmark[]
  readonly leftHandLandmarks?: readonly Landmark[]
  readonly rightHandLandmarks?: readonly Landmark[]
  readonly faceLandmarks?: readonly Landmark[]
  readonly timestamp: number
  /** Source frame size in pixels (landmarks are normalized to it). */
  readonly imageWidth?: number
  readonly imageHeight?: number
}

export type SourceMode = 'sample' | 'upload' | 'camera'

/** How the avatar is driven: a precomputed offline clip, or the causal live solver. */
export type MotionEngine = 'offline' | 'live'

export interface TrackingStats {
  fps: number
  inferenceMs: number
  body: boolean
  leftHand: boolean
  rightHand: boolean
  face: boolean
}
