import type { AvatarMotionFile, MotionTrack } from '../clip/format'
import { decodeWord, type LibraryVariant, type SignLibraryIndex, type SignLibraryWord } from './format'

/**
 * Library words as ordinary avatar-motion files, so the studio's MotionClip
 * player and its numerical QA (src/motion/qa/metrics.ts) run on them
 * unchanged.
 *
 * Hand-state convention for library clips (they have no tracker): a hand is
 * "T" (signing) during the stroke when it takes part in the sign (the
 * dominant right hand always, the left hand only for two-handed signs) and
 * "A" (not part of the sign, idle pose) otherwise.
 */
export function wordHandStates(word: Pick<SignLibraryWord, 'frameCount' | 'holdIn' | 'stroke' | 'hands'>) {
  const state = (active: boolean) => Array.from({ length: word.frameCount }, (_, k) => (active && k >= word.holdIn && k < word.holdIn + word.stroke ? 'T' : 'A')).join('')
  return { left: state(word.hands === 'both'), right: state(true) }
}

function tracksFromFrames(bones: string[], frames: Float32Array, frameCount: number): MotionTrack[] {
  const stride = bones.length * 4
  return bones.map((bone, b) => {
    const values = new Array<number>(frameCount * 4)
    for (let k = 0; k < frameCount; k += 1) {
      const src = k * stride + b * 4
      // Keep consecutive frames in one 4D hemisphere (q and -q are the same rotation).
      let sign = 1
      if (k > 0) {
        const dot = frames[src] * values[k * 4 - 4] + frames[src + 1] * values[k * 4 - 3] + frames[src + 2] * values[k * 4 - 2] + frames[src + 3] * values[k * 4 - 1]
        if (dot < 0) sign = -1
      }
      values[k * 4] = sign * frames[src]
      values[k * 4 + 1] = sign * frames[src + 1]
      values[k * 4 + 2] = sign * frames[src + 2]
      values[k * 4 + 3] = sign * frames[src + 3]
    }
    return { bone, path: 'rotation' as const, values }
  })
}

function baseFile(index: SignLibraryIndex, clipId: string, frameCount: number, tracks: MotionTrack[], handState: { left: string; right: string }, notes: string[]): AvatarMotionFile {
  return {
    schema: 'deafference.avatar-motion',
    schemaVersion: 1,
    clipId,
    generator: index.generator,
    rig: index.rig,
    source: { video: `aslv2 select run ${index.source.selectRun}`, sha256: index.source.bakedSha256 },
    fps: index.fps,
    frameCount,
    durationSec: (frameCount - 1) / index.fps,
    space: 'local',
    timeline: {
      sourceFrame: Array.from({ length: frameCount }, (_, k) => k),
      sourceTime: Array.from({ length: frameCount }, (_, k) => k / index.fps)
    },
    tracks,
    quality: {
      handState,
      legend: {
        T: 'part of the sign (stroke)',
        I: 'interpolated',
        H: 'holding',
        F: 'easing',
        A: 'not part of the sign (idle pose / ease)'
      },
      uncertainIntervals: []
    },
    notes
  }
}

export function wordMotionFile(index: SignLibraryIndex, data: Int16Array, variant: LibraryVariant, word: SignLibraryWord): AvatarMotionFile {
  const frames = decodeWord(index, data, variant, word)
  return baseFile(index, `${word.gloss}:${variant}`, word.frameCount, tracksFromFrames(index.bones, frames, word.frameCount), wordHandStates(word), [
    `Isolated sign "${word.gloss}" (${variant}), dataset take ${word.source.sequenceId} by participant ${word.source.participantId}.`,
    `Review status: ${word.review}.`
  ])
}

export interface SequenceSegment {
  gloss: string
  startFrame: number
  frameCount: number
  /** Stroke (the sign itself) within the sequence, in frames. */
  strokeStart: number
  strokeEnd: number
}

export interface SequenceMotion {
  file: AvatarMotionFile
  segments: SequenceSegment[]
}

/**
 * Words played back to back. Every word starts and ends at the same idle
 * pose, so the concatenation is continuous; this is word-by-word playback of
 * isolated signs (lookup), not sentence-level signing.
 */
export function sequenceMotionFile(index: SignLibraryIndex, data: Int16Array, variant: LibraryVariant, words: SignLibraryWord[]): SequenceMotion {
  if (!words.length) throw new Error('No words to play')
  const stride = index.bones.length * 4
  const total = words.reduce((sum, word) => sum + word.frameCount, 0)
  const frames = new Float32Array(total * stride)
  const segments: SequenceSegment[] = []
  const left: string[] = []
  const right: string[] = []
  let cursor = 0
  for (const word of words) {
    frames.set(decodeWord(index, data, variant, word), cursor * stride)
    const states = wordHandStates(word)
    left.push(states.left)
    right.push(states.right)
    segments.push({ gloss: word.gloss, startFrame: cursor, frameCount: word.frameCount, strokeStart: cursor + word.holdIn, strokeEnd: cursor + word.holdIn + word.stroke })
    cursor += word.frameCount
  }
  const file = baseFile(index, `sequence:${words.map((w) => w.gloss).join('+')}:${variant}`, total, tracksFromFrames(index.bones, frames, total), { left: left.join(''), right: right.join('') }, [
    'Isolated library signs played back to back (word lookup). Not ASL sentence grammar.'
  ])
  return { file, segments }
}

/** Index of the segment containing `frame` (segments are contiguous). */
export function segmentAt(segments: readonly SequenceSegment[], frame: number) {
  for (let i = 0; i < segments.length; i += 1) {
    if (frame < segments[i].startFrame + segments[i].frameCount) return i
  }
  return segments.length - 1
}
