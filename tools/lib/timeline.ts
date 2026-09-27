import type { RawFrame } from './raw'

export interface TimelineSlot {
  /** Uniform grid index. */
  k: number
  /** Grid time in seconds (k / fps). */
  t: number
  /** Index of the decoded source frame shown at this slot, or null (dropped frame). */
  source: number | null
  /** Source presentation timestamp (seconds) when `source` is set. */
  sourceTime: number | null
}

export interface Timeline {
  fps: number
  slots: TimelineSlot[]
  droppedSlots: number
  collisions: number
  maxAbsOffsetMs: number
}

/**
 * Map variable-frame-rate source frames onto a uniform grid (default 30 fps)
 * starting at t = 0. Every source frame lands on the nearest slot; slots with
 * no source frame are dropped frames (filled downstream by interpolation, and
 * flagged). The grid matches a constant-frame-rate re-encode of the same
 * video (the bundled playback MP4 has exactly this slot count), so motion can
 * be sampled by the player's media time without drift.
 */
export function buildTimeline(frames: RawFrame[], fps = 30): Timeline {
  if (!frames.length) throw new Error('No frames')
  const last = frames[frames.length - 1].time
  const count = Math.round(last * fps) + 1
  const slots: TimelineSlot[] = Array.from({ length: count }, (_, k) => ({ k, t: k / fps, source: null, sourceTime: null }))
  let collisions = 0
  let maxOffset = 0
  let previous = -Infinity
  let lastSlot = -1
  for (const frame of frames) {
    if (!(frame.time > previous)) throw new Error(`Non-monotonic source timestamp at frame ${frame.index}`)
    previous = frame.time
    let k = Math.round(frame.time * fps)
    if (k <= lastSlot) {
      // Two frames rounded to one slot (source spacing slightly < 1/fps at a
      // half-frame phase). Never drop a frame: push it to the next free slot,
      // which is still less than one frame period away.
      k = lastSlot + 1
      collisions += 1
    }
    if (k < 0) throw new Error(`Frame ${frame.index} maps before the grid`)
    if (k >= slots.length) slots.push({ k, t: k / fps, source: null, sourceTime: null })
    slots[k].source = frame.index
    slots[k].sourceTime = frame.time
    lastSlot = k
    maxOffset = Math.max(maxOffset, Math.abs(frame.time - k / fps))
    if (Math.abs(frame.time - k / fps) >= 1 / fps) throw new Error(`Frame ${frame.index} could not be placed within one frame period`)
  }
  return {
    fps,
    slots,
    droppedSlots: slots.filter((slot) => slot.source === null).length,
    collisions,
    maxAbsOffsetMs: Math.round(maxOffset * 1e5) / 100
  }
}
