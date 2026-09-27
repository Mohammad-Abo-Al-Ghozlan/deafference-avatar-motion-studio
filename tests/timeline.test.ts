import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildTimeline } from '../tools/lib/timeline'
import type { RawFrame } from '../tools/lib/raw'

const frame = (index: number, time: number): RawFrame => ({ index, pts: time, time, pose: null, world: null, left: null, right: null, face: null })

test('VFR -> uniform grid: every source frame is kept, gaps become flagged slots, collisions never drop frames', () => {
  // Phone-style VFR: jittered ~30 fps, a 200 ms stall, and short/long pairs
  // (20 ms then 46 ms) that land two frames on one grid slot.
  const times: number[] = []
  let t = 0
  for (let i = 0; i < 30; i += 1) { times.push(t); t += 1 / 30 + (i % 2 ? 0.004 : -0.004) }
  t += 0.2
  for (let i = 0; i < 10; i += 1) { times.push(t); t += i % 2 ? 0.046 : 0.02 }
  for (let i = 0; i < 20; i += 1) { times.push(t); t += 1 / 30 }
  const timeline = buildTimeline(times.map((time, i) => frame(i, time)), 30)
  const placed = timeline.slots.filter((s) => s.source !== null)
  assert.equal(placed.length, times.length)
  assert.ok(timeline.droppedSlots > 0)
  for (let i = 1; i < placed.length; i += 1) assert.ok(placed[i].source! > placed[i - 1].source! && placed[i].k > placed[i - 1].k)
  for (const slot of placed) assert.ok(Math.abs(slot.sourceTime! - slot.t) < 1 / 30)
})

test('a burst faster than the grid can hold throws instead of silently dropping frames', () => {
  const times = Array.from({ length: 40 }, (_, i) => i / 45)
  assert.throws(() => buildTimeline(times.map((time, i) => frame(i, time)), 30), /could not be placed/)
})

test('non-monotonic timestamps are rejected', () => {
  assert.throws(() => buildTimeline([frame(0, 0), frame(1, 0.1), frame(2, 0.05)], 30))
})
