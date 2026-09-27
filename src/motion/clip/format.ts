/** Reusable avatar animation format: timestamped LOCAL bone transforms. */

export type TrackPath = 'rotation' | 'translation'

export interface MotionTrack {
  bone: string
  path: TrackPath
  /** Flat values: 4 per frame for rotations [x,y,z,w], 3 for translations. */
  values: number[]
}

export type HandStateCode = 'T' | 'I' | 'H' | 'F' | 'A'

export interface AvatarMotionFile {
  schema: 'deafference.avatar-motion'
  schemaVersion: 1
  clipId: string
  generator: string
  rig: { file: string; sha256: string; profile: string; joints: number }
  source: { video: string; sha256: string; playbackVideo?: string; playbackSha256?: string }
  clean?: { file: string; sha256: string }
  fps: number
  frameCount: number
  durationSec: number
  space: string
  timeline: { sourceFrame: (number | null)[]; sourceTime: (number | null)[] }
  tracks: MotionTrack[]
  quality: {
    handState: { left: string; right: string }
    legend: Record<HandStateCode, string>
    uncertainIntervals: { side: string; state: string; startSec: number; endSec: number }[]
  }
  notes: string[]
}

export const HAND_STATE_LEGEND: Record<HandStateCode, string> = {
  T: 'tracked (fitted to landmarks)',
  I: 'interpolated across a short detection gap',
  H: 'holding the last reliable pose (long gap)',
  F: 'blending toward a relaxed hand (long gap, uncertain)',
  A: 'absent (hand not observed; relaxed pose)'
}

export function validateMotionFile(value: unknown): asserts value is AvatarMotionFile {
  const file = value as Partial<AvatarMotionFile>
  if (!file || file.schema !== 'deafference.avatar-motion') throw new Error('Not a deafference.avatar-motion file')
  if (file.schemaVersion !== 1) throw new Error(`Unsupported avatar-motion schemaVersion ${String(file.schemaVersion)}`)
  if (!Number.isFinite(file.fps) || !file.fps || file.fps <= 0) throw new Error('Invalid fps')
  if (!Number.isInteger(file.frameCount) || !file.frameCount || file.frameCount < 1) throw new Error('Invalid frameCount')
  if (!Array.isArray(file.tracks) || !file.tracks.length) throw new Error('No tracks')
  for (const track of file.tracks) {
    const stride = track.path === 'rotation' ? 4 : 3
    if (track.values.length !== stride * file.frameCount) throw new Error(`Track ${track.bone}.${track.path} has ${track.values.length} values, expected ${stride * file.frameCount}`)
  }
}
