import { test } from 'node:test'
import assert from 'node:assert/strict'
import { butterworthLowpass, filtfilt, hampel, limitRate, pchipFill } from '../src/motion/filters/offline'
import { limitStep, OneEuroFilter, RollingQuantiles } from '../src/motion/filters/online'

const fs = 30

test('filtfilt is zero-phase: a slow sinusoid keeps its phase and amplitude', () => {
  const n = 600
  const f = 1.5 // Hz, well below the 7 Hz cutoff used for fingers
  const x = Float64Array.from({ length: n }, (_, k) => Math.sin(2 * Math.PI * f * k / fs))
  const y = filtfilt(butterworthLowpass(7, fs), x)
  // Cross-correlation peak at zero lag, amplitude within 2%.
  let best = { lag: 99, value: -Infinity }
  for (let lag = -5; lag <= 5; lag += 1) {
    let sum = 0
    for (let k = 50; k < n - 50; k += 1) sum += x[k] * y[k + lag]
    if (sum > best.value) best = { lag, value: sum }
  }
  assert.equal(best.lag, 0)
  const peak = Math.max(...Array.from(y.slice(100, 500)))
  assert.ok(Math.abs(peak - 1) < 0.02, `amplitude ${peak}`)
})

test('filtfilt suppresses high-frequency jitter', () => {
  const x = Float64Array.from({ length: 300 }, (_, k) => (k % 2 ? 1 : -1))
  const y = filtfilt(butterworthLowpass(7, fs), x)
  assert.ok(Math.max(...Array.from(y.slice(30, 270)).map(Math.abs)) < 0.05)
})

test('limitRate is symmetric and bounds every step', () => {
  const x = Float64Array.from({ length: 50 }, (_, k) => (k === 25 ? 100 : 0))
  const y = limitRate(x, 10)
  for (let k = 1; k < y.length; k += 1) assert.ok(Math.abs(y[k] - y[k - 1]) <= 10 + 1e-9)
  // Symmetric: the spike's rise and fall are mirror images.
  for (let d = 1; d < 10; d += 1) assert.ok(Math.abs(y[25 - d] - y[25 + d]) < 1e-9)
})

test('hampel flags an isolated outlier but not a genuine step', () => {
  const x = Float64Array.from({ length: 40 }, (_, k) => (k < 20 ? 0 : 1))
  x[10] = 5
  const flags = hampel(x, new Array(40).fill(true), 4, 3.5, 0.1)
  assert.equal(flags[10], true)
  assert.equal(flags.filter(Boolean).length, 1)
})

test('pchipFill interpolates gaps monotonically without overshoot', () => {
  const x = Float64Array.from([0, 1, 2, 0, 0, 0, 6, 7, 8])
  const valid = [true, true, true, false, false, false, true, true, true]
  const y = pchipFill(x, valid, valid.map((v) => !v))
  for (let k = 3; k <= 6; k += 1) assert.ok(y[k] >= y[k - 1] - 1e-12 && y[k] <= 6 + 1e-12)
})

test('One Euro: steady input converges; fast motion lags less than slow smoothing', () => {
  const f = new OneEuroFilter(1, 0.5, 1)
  let out = 0
  for (let k = 0; k < 120; k += 1) out = f.filter(1, k / fs)
  assert.ok(Math.abs(out - 1) < 1e-3)
  const slow = new OneEuroFilter(1, 0, 1)
  const fast = new OneEuroFilter(1, 2, 1)
  let a = 0
  let b = 0
  for (let k = 0; k < 15; k += 1) {
    a = slow.filter(k * 0.1, k / fs)
    b = fast.filter(k * 0.1, k / fs)
  }
  assert.ok(Math.abs(1.4 - b) < Math.abs(1.4 - a), 'speed-adaptive cutoff reduces lag')
})

test('limitStep bounds per-second rate', () => {
  assert.equal(limitStep(0, 10, 30, 1 / 30), 1)
  assert.equal(limitStep(null, 10, 30, 1 / 30), 10)
})

test('RollingQuantiles tracks the window', () => {
  const q = new RollingQuantiles(5)
  for (const v of [5, 1, 4, 2, 3]) q.push(v)
  assert.equal(q.quantile(0.5), 3)
  for (const v of [10, 10, 10]) q.push(v)
  assert.equal(q.quantile(0.5), 10)
  assert.equal(q.size, 5)
})
