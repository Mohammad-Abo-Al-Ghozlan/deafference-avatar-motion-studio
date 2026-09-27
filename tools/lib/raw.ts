import type { Landmark } from '../../src/types/tracking'
import { readJson } from './cli'

export interface RawFrameJson {
  i: number
  pts: number
  t: number
  pose: number[] | null
  poseWorld: number[] | null
  leftHand: number[] | null
  rightHand: number[] | null
  face: number[] | null
}

export interface RawClipJson {
  schema: string
  schemaVersion: number
  clipId: string
  source: { file: string; sha256: string; width: number; height: number; durationSec: number; timing: Record<string, unknown>; [key: string]: unknown }
  tracker: Record<string, unknown>
  layout: { faceIndices: number[]; [key: string]: unknown }
  stats: Record<string, unknown>
  frames: RawFrameJson[]
}

export interface RawFrame {
  index: number
  pts: number
  time: number
  pose: Landmark[] | null
  world: Landmark[] | null
  left: Landmark[] | null
  right: Landmark[] | null
  /** Face subset keyed by original mesh index. */
  face: Map<number, Landmark> | null
}

export function unpack(flat: number[] | null, stride: number): Landmark[] | null {
  if (!flat) return null
  const out: Landmark[] = []
  for (let i = 0; i < flat.length; i += stride) {
    out.push({ x: flat[i], y: flat[i + 1], z: flat[i + 2], visibility: stride >= 4 ? flat[i + 3] : undefined })
  }
  return out
}

export function loadRawClip(path: string) {
  const json = readJson<RawClipJson>(path)
  if (json.schema !== 'deafference.raw-landmarks') throw new Error(`${path} is not a raw-landmarks cache (schema=${json.schema})`)
  if (json.schemaVersion !== 1) throw new Error(`Unsupported raw-landmarks schemaVersion ${json.schemaVersion}`)
  const faceIndices = json.layout.faceIndices
  const frames: RawFrame[] = json.frames.map((frame) => {
    const faceList = unpack(frame.face, 3)
    let face: Map<number, Landmark> | null = null
    if (faceList) {
      if (faceList.length !== faceIndices.length) throw new Error(`Frame ${frame.i}: face subset length mismatch`)
      face = new Map(faceIndices.map((meshIndex, k) => [meshIndex, faceList[k]]))
    }
    return {
      index: frame.i,
      pts: frame.pts,
      time: frame.t,
      pose: unpack(frame.pose, 5),
      world: unpack(frame.poseWorld, 3),
      left: unpack(frame.leftHand, 3),
      right: unpack(frame.rightHand, 3),
      face
    }
  })
  return { json, frames, image: { width: json.source.width, height: json.source.height } }
}
