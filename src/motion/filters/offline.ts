import { Quaternion } from 'three'

/**
 * Offline (non-causal) signal processing for prerecorded motion.
 * Everything here may look at future samples; nothing here may be used in the
 * live camera path (see ./causal.ts for that).
 */

export interface Biquad {
  b: [number, number, number]
  a: [number, number] // a1, a2 (a0 normalised to 1)
}

/** 2nd-order Butterworth low-pass via bilinear transform with pre-warping. */
export function butterworthLowpass(cutoffHz: number, sampleRateHz: number): Biquad {
  const nyquist = sampleRateHz / 2
  const fc = Math.min(Math.max(cutoffHz, 1e-3), nyquist * 0.98)
  const k = Math.tan((Math.PI * fc) / sampleRateHz)
  const q = Math.SQRT1_2
  const norm = 1 / (1 + k / q + k * k)
  const b0 = k * k * norm
  return {
    b: [b0, 2 * b0, b0],
    a: [2 * (k * k - 1) * norm, (1 - k / q + k * k) * norm]
  }
}

function lfilter(coeffs: Biquad, x: Float64Array, zi: [number, number]): Float64Array {
  const [b0, b1, b2] = coeffs.b
  const [a1, a2] = coeffs.a
  const y = new Float64Array(x.length)
  let z1 = zi[0]
  let z2 = zi[1]
  for (let i = 0; i < x.length; i += 1) {
    const xi = x[i]
    const yi = b0 * xi + z1
    z1 = b1 * xi - a1 * yi + z2
    z2 = b2 * xi - a2 * yi
    y[i] = yi
  }
  return y
}

/** Steady-state initial conditions for a unit step (scipy.signal.lfilter_zi). */
function lfilterZi(coeffs: Biquad): [number, number] {
  const [b0, b1, b2] = coeffs.b
  const [a1, a2] = coeffs.a
  // Transposed direct form II steady state for a constant unit input:
  // y = G, z2 = b2 - a2*G, z1 = b1 - a1*G + z2.
  const gain = (b0 + b1 + b2) / (1 + a1 + a2)
  const z2 = b2 - a2 * gain
  return [b1 - a1 * gain + z2, z2]
}

/**
 * Zero-phase forward-backward filtering with odd reflection padding (like
 * scipy.signal.filtfilt). Output has no group delay, so sign timing and
 * handshape transitions are not shifted.
 */
export function filtfilt(coeffs: Biquad, input: ArrayLike<number>, padLength = 18): Float64Array {
  const n = input.length
  if (n === 0) return new Float64Array(0)
  if (n < 3) return Float64Array.from(input)
  const pad = Math.min(padLength, n - 1)
  const ext = new Float64Array(n + 2 * pad)
  const first = input[0]
  const last = input[n - 1]
  for (let i = 0; i < pad; i += 1) ext[i] = 2 * first - input[pad - i]
  for (let i = 0; i < n; i += 1) ext[pad + i] = input[i]
  for (let i = 0; i < pad; i += 1) ext[pad + n + i] = 2 * last - input[n - 2 - i]
  const zi = lfilterZi(coeffs)
  const forward = lfilter(coeffs, ext, [zi[0] * ext[0], zi[1] * ext[0]])
  forward.reverse()
  const backward = lfilter(coeffs, forward, [zi[0] * forward[0], zi[1] * forward[0]])
  backward.reverse()
  return backward.slice(pad, pad + n)
}

/** Contiguous runs of `true` as [start, endExclusive). */
export function runs(mask: ArrayLike<boolean>, value = true): [number, number][] {
  const result: [number, number][] = []
  let start = -1
  for (let i = 0; i < mask.length; i += 1) {
    if (Boolean(mask[i]) === value) {
      if (start < 0) start = i
    } else if (start >= 0) {
      result.push([start, i])
      start = -1
    }
  }
  if (start >= 0) result.push([start, mask.length])
  return result
}

/**
 * Hampel identifier on valid samples: flags x[i] when it deviates from the
 * local median by more than `sigmas` robust standard deviations. `floor`
 * prevents flagging tiny deviations inside perfectly still holds.
 */
export function hampel(x: ArrayLike<number>, valid: ArrayLike<boolean>, halfWindow: number, sigmas: number, floor: number): boolean[] {
  const n = x.length
  const outlier = new Array<boolean>(n).fill(false)
  const window: number[] = []
  for (let i = 0; i < n; i += 1) {
    if (!valid[i]) continue
    window.length = 0
    for (let j = Math.max(0, i - halfWindow); j <= Math.min(n - 1, i + halfWindow); j += 1) if (valid[j]) window.push(x[j])
    if (window.length < 4) continue
    const median = medianOf(window)
    const deviations = window.map((v) => Math.abs(v - median))
    const mad = 1.4826 * medianOf(deviations)
    if (Math.abs(x[i] - median) > Math.max(sigmas * mad, floor)) outlier[i] = true
  }
  return outlier
}

export function medianOf(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid] : 0.5 * (sorted[mid - 1] + sorted[mid])
}

export function percentile(values: ArrayLike<number>, p: number) {
  const sorted = Array.from(values).filter(Number.isFinite).sort((a, b) => a - b)
  if (!sorted.length) return NaN
  const position = (sorted.length - 1) * p
  const low = Math.floor(position)
  const high = Math.ceil(position)
  return sorted[low] + (sorted[high] - sorted[low]) * (position - low)
}

/**
 * Monotone cubic (Fritsch-Carlson / PCHIP) interpolation through the valid
 * samples at integer positions. Never overshoots, so interpolated finger
 * angles stay within the range of their neighbours.
 */
export function pchipFill(x: ArrayLike<number>, valid: ArrayLike<boolean>, fillMask: ArrayLike<boolean>): Float64Array {
  const n = x.length
  const out = Float64Array.from(x)
  const knots: number[] = []
  for (let i = 0; i < n; i += 1) if (valid[i]) knots.push(i)
  if (knots.length < 2) return out
  const values = knots.map((i) => x[i])
  const slopes = new Array<number>(knots.length).fill(0)
  const secants = new Array<number>(knots.length - 1)
  for (let k = 0; k < knots.length - 1; k += 1) secants[k] = (values[k + 1] - values[k]) / (knots[k + 1] - knots[k])
  slopes[0] = secants[0]
  slopes[knots.length - 1] = secants[knots.length - 2]
  for (let k = 1; k < knots.length - 1; k += 1) {
    if (secants[k - 1] * secants[k] <= 0) slopes[k] = 0
    else {
      const h0 = knots[k] - knots[k - 1]
      const h1 = knots[k + 1] - knots[k]
      const w1 = 2 * h1 + h0
      const w2 = h1 + 2 * h0
      slopes[k] = (w1 + w2) / (w1 / secants[k - 1] + w2 / secants[k])
    }
  }
  let k = 0
  for (let i = 0; i < n; i += 1) {
    if (!fillMask[i] || valid[i]) continue
    while (k < knots.length - 2 && knots[k + 1] < i) k += 1
    if (i < knots[0] || i > knots[knots.length - 1]) continue
    const x0 = knots[k]
    const x1 = knots[k + 1]
    const h = x1 - x0
    const t = (i - x0) / h
    const t2 = t * t
    const t3 = t2 * t
    out[i] = (2 * t3 - 3 * t2 + 1) * values[k] + (t3 - 2 * t2 + t) * h * slopes[k] + (-2 * t3 + 3 * t2) * values[k + 1] + (t3 - t2) * h * slopes[k + 1]
  }
  return out
}

/**
 * Symmetric rate limiter: forward and backward clamped passes averaged so the
 * limiter does not introduce a one-sided lag. Only affects samples whose step
 * exceeds `maxStep` (tracker glitches), not ordinary motion.
 */
export function limitRate(x: ArrayLike<number>, maxStep: number): Float64Array {
  const n = x.length
  const forward = Float64Array.from(x)
  for (let i = 1; i < n; i += 1) {
    const d = forward[i] - forward[i - 1]
    if (d > maxStep) forward[i] = forward[i - 1] + maxStep
    else if (d < -maxStep) forward[i] = forward[i - 1] - maxStep
  }
  const backward = Float64Array.from(x)
  for (let i = n - 2; i >= 0; i -= 1) {
    const d = backward[i] - backward[i + 1]
    if (d > maxStep) backward[i] = backward[i + 1] + maxStep
    else if (d < -maxStep) backward[i] = backward[i + 1] - maxStep
  }
  const out = new Float64Array(n)
  for (let i = 0; i < n; i += 1) out[i] = 0.5 * (forward[i] + backward[i])
  return out
}

/** Make consecutive quaternions share a hemisphere (no sign flips). */
export function alignQuaternionSequence(sequence: Quaternion[]) {
  for (let i = 1; i < sequence.length; i += 1) {
    const q = sequence[i]
    if (q.dot(sequence[i - 1]) < 0) q.set(-q.x, -q.y, -q.z, -q.w)
  }
  return sequence
}

/** Zero-phase smoothing of a hemisphere-aligned quaternion track. */
export function filtfiltQuaternions(coeffs: Biquad, sequence: Quaternion[]): Quaternion[] {
  if (sequence.length < 3) return sequence.map((q) => q.clone())
  const aligned = alignQuaternionSequence(sequence.map((q) => q.clone()))
  const channels = [0, 1, 2, 3].map((c) => filtfilt(coeffs, aligned.map((q) => q.toArray()[c])))
  return aligned.map((_, i) => new Quaternion(channels[0][i], channels[1][i], channels[2][i], channels[3][i]).normalize())
}

/** SLERP-fill quaternion gaps between valid neighbours inside `fillMask`. */
export function slerpFill(sequence: Quaternion[], valid: ArrayLike<boolean>, fillMask: ArrayLike<boolean>) {
  const out = sequence.map((q) => q.clone())
  for (const [start, end] of runs(valid, false)) {
    if (start === 0 || end >= sequence.length) continue
    const a = sequence[start - 1]
    const b = sequence[end]
    for (let i = start; i < end; i += 1) {
      if (!fillMask[i]) continue
      const t = (i - start + 1) / (end - start + 1)
      out[i] = a.clone().slerp(b, t)
    }
  }
  return out
}
