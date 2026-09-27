import { Quaternion, Vector3 } from 'three'
import type { Side } from '../../src/motion/rig/semanticMap'
import type { HandTemplate, LongFinger } from '../../src/motion/source/handModel'
import { unflattenParams } from '../../src/motion/source/handParams'
import type { SourcePose } from '../../src/motion/retarget/types'
import { readJson } from './cli'

type V3 = [number, number, number]

export interface CleanHandJson {
  state: 'tracked' | 'interpolated' | 'held' | 'fallback' | 'absent'
  observed: boolean
  quality: number
  palmWeight: number
  fingerWeight: number
  rotation: [number, number, number, number]
  scale: number
  wrist: V3
  params: number[]
  landmarks: number[] | null
}

export interface CleanFrameJson {
  k: number
  t: number
  source: number | null
  sourceTime: number | null
  hands: Record<Side, CleanHandJson>
  body: {
    valid: boolean
    leftShoulder: V3
    rightShoulder: V3
    torsoYaw: number
    torsoRoll: number
    wrist: Record<Side, V3>
    wristConfidence: Record<Side, number>
    wristFromHand: Record<Side, number>
    elbow: Record<Side, V3>
    elbowConfidence: Record<Side, number>
    shrug: Record<Side, number>
    faceAnchor: V3
    faceScale: number
    handCenter: Record<Side, V3>
    handCenterWeight: Record<Side, number>
  }
  face: {
    valid: boolean
    rotation: [number, number, number, number]
    jawOpen: number
    smile: number
    mouthStretch: number
    blinkLeft: number
    blinkRight: number
    browLeft: number
    browRight: number
  }
}

export interface CleanFileJson {
  schema: string
  schemaVersion: number
  clipId: string
  raw: { file: string; sha256: string; sourceSha256: string; sourceFile: string }
  image: { width: number; height: number }
  timeline: { fps: number; frameCount: number; durationSec: number }
  calibration: {
    hands: { template: HandTemplate; zScale: Record<Side, number> }
    face: Record<string, unknown>
    body: Record<string, unknown>
  }
  channels: { handParams: string[] }
  stats: Record<string, unknown>
  frames: CleanFrameJson[]
}

export function loadCleanFile(path: string) {
  const json = readJson<CleanFileJson>(path)
  if (json.schema !== 'deafference.clean-landmarks' || json.schemaVersion !== 1) throw new Error(`${path} is not a clean-landmarks v1 file`)
  return json
}

export function neutralAbduction(clean: CleanFileJson): Record<Side, Record<LongFinger, number>> {
  const n = clean.calibration.hands.template.neutralAbduction
  return { left: { ...n }, right: { ...n } }
}

export function sourcePoseFromClean(frame: CleanFrameJson): SourcePose {
  const v = (a: V3) => new Vector3(a[0], a[1], a[2])
  const hand = (side: Side) => {
    const h = frame.hands[side]
    return {
      palmWeight: h.palmWeight,
      rotation: new Quaternion(h.rotation[0], h.rotation[1], h.rotation[2], h.rotation[3]).normalize(),
      params: unflattenParams(h.params)
    }
  }
  const b = frame.body
  return {
    body: {
      torsoYaw: b.torsoYaw,
      torsoRoll: b.torsoRoll,
      wrist: { left: v(b.wrist.left), right: v(b.wrist.right) },
      wristConfidence: { ...b.wristConfidence },
      elbow: { left: v(b.elbow.left), right: v(b.elbow.right) },
      elbowConfidence: { ...b.elbowConfidence },
      shrug: { ...b.shrug },
      faceAnchor: v(b.faceAnchor),
      faceScale: b.faceScale,
      handCenter: { left: v(b.handCenter.left), right: v(b.handCenter.right) },
      handCenterWeight: { ...b.handCenterWeight }
    },
    hands: { left: hand('left'), right: hand('right') },
    // The clean face track is gap-filled (interpolated) on the few frames
    // where the face fit was rejected, so it is always usable.
    face: {
      rotation: new Quaternion(frame.face.rotation[0], frame.face.rotation[1], frame.face.rotation[2], frame.face.rotation[3]).normalize(),
      jawOpen: frame.face.jawOpen,
      smile: frame.face.smile,
      mouthStretch: frame.face.mouthStretch,
      blinkLeft: frame.face.blinkLeft,
      blinkRight: frame.face.blinkRight,
      browLeft: frame.face.browLeft,
      browRight: frame.face.browRight
    }
  }
}
