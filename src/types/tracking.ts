export interface Landmark {
  x: number
  y: number
  z: number
  visibility?: number
}

export interface TrackingFrame {
  readonly poseLandmarks?: readonly Landmark[]
  readonly leftHandLandmarks?: readonly Landmark[]
  readonly rightHandLandmarks?: readonly Landmark[]
  readonly faceLandmarks?: readonly Landmark[]
  readonly timestamp: number
}

export type SourceMode = 'sample' | 'upload' | 'camera'

export interface TrackingStats {
  fps: number
  inferenceMs: number
  body: boolean
  leftHand: boolean
  rightHand: boolean
  face: boolean
}
