import { test } from 'node:test'
import assert from 'node:assert/strict'
import { butterworthLowpass, filtfilt } from '../src/motion/filters/offline'
import { fillHoldEdges } from '../tools/lib/cleanBody'

test('fillHoldEdges: PCHIP inside the observed range, nearest observed value outside it', () => {
  const raw = [0, 0, 5, 0, 7, 9, 0, 0]
  const valid = [false, false, true, false, true, true, false, false]
  const out = fillHoldEdges(raw, valid)
  assert.deepEqual([out[0], out[1]], [5, 5], 'leading gap holds the first observation')
  assert.deepEqual([out[6], out[7]], [9, 9], 'trailing gap holds the last observation')
  assert.ok(out[3] > 5 && out[3] < 7, 'interior gap is interpolated between its neighbours')
  assert.deepEqual([out[2], out[4], out[5]], [5, 7, 9], 'observed samples are untouched')
  assert.deepEqual(Array.from(fillHoldEdges([1, 2], [false, false])), [1, 2], 'nothing observed: input passes through')
})

test('body cleaning regression: a hand last seen just before the clip ends is not pulled toward zero', () => {
  // A hand observed at a steady position (x = -0.8, shoulder-width units)
  // until 3 frames before the end of the clip, as in sign-clip-1. The old
  // fill left the unobserved tail at 0 and the zero-phase filter smeared that
  // fake step into the observed frames (and the solver then jumped 0.28 m on
  // the final frame).
  const n = 120
  const valid = Array.from({ length: n }, (_, k) => k < n - 3)
  const raw = Array.from({ length: n }, (_, k) => (valid[k] ? -0.8 : 0))
  const filtered = filtfilt(butterworthLowpass(6, 30), fillHoldEdges(raw, valid))
  for (let k = 0; k < n; k += 1) assert.ok(Math.abs(filtered[k] + 0.8) < 1e-9, `frame ${k}: ${filtered[k]}`)
})
