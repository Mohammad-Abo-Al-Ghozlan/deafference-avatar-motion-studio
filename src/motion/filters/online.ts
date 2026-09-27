import { Quaternion, Vector3 } from 'three'

/**
 * CAUSAL filters for the real-time path (camera / uploaded video). Nothing
 * here looks at future samples; every filter is driven by measurement
 * timestamps (seconds), so an irregular tracker frame rate does not change
 * the filtering behaviour.
 */

function smoothingFactor(dt: number, cutoffHz: number) {
  const tau = 1 / (2 * Math.PI * cutoffHz)
  return 1 / (1 + tau / dt)
}

const MIN_DT = 1 / 240
const DEFAULT_DT = 1 / 30

/**
 * One Euro filter (Casiez et al., CHI 2012): a first-order low-pass whose
 * cutoff rises with speed, so holds are steady and fast motion lags little.
 */
export class OneEuroFilter {
  minCutoff: number
  beta: number
  derivativeCutoff: number
  private value: number | null = null
  private derivative = 0
  private time: number | null = null

  constructor(minCutoff = 1, beta = 0, derivativeCutoff = 1) {
    this.minCutoff = minCutoff
    this.beta = beta
    this.derivativeCutoff = derivativeCutoff
  }

  get current() {
    return this.value
  }

  reset(value: number | null = null, time: number | null = null) {
    this.value = value
    this.derivative = 0
    this.time = time
  }

  filter(measurement: number, time: number): number {
    if (!Number.isFinite(measurement)) return this.value ?? 0
    if (this.value === null || this.time === null) {
      this.value = measurement
      this.derivative = 0
      this.time = time
      return measurement
    }
    let dt = time - this.time
    if (!(dt > 0)) dt = DEFAULT_DT
    dt = Math.max(dt, MIN_DT)
    this.time = time
    const rawDerivative = (measurement - this.value) / dt
    this.derivative += smoothingFactor(dt, this.derivativeCutoff) * (rawDerivative - this.derivative)
    const cutoff = this.minCutoff + this.beta * Math.abs(this.derivative)
    this.value += smoothingFactor(dt, cutoff) * (measurement - this.value)
    return this.value
  }
}

/** One Euro filter for unit quaternions: filtering happens in the tangent space of the last output. */
export class OneEuroQuaternionFilter {
  minCutoff: number
  beta: number
  derivativeCutoff: number
  private value: Quaternion | null = null
  private speed = 0
  private time: number | null = null
  private readonly delta = new Quaternion()
  private readonly axis = new Vector3()

  constructor(minCutoff = 1, beta = 0, derivativeCutoff = 1) {
    this.minCutoff = minCutoff
    this.beta = beta
    this.derivativeCutoff = derivativeCutoff
  }

  get current() {
    return this.value
  }

  reset(value: Quaternion | null = null, time: number | null = null) {
    this.value = value ? value.clone().normalize() : null
    this.speed = 0
    this.time = time
  }

  filter(measurement: Quaternion, time: number): Quaternion {
    if (!this.value || this.time === null) {
      this.value = measurement.clone().normalize()
      this.time = time
      this.speed = 0
      return this.value.clone()
    }
    let dt = time - this.time
    if (!(dt > 0)) dt = DEFAULT_DT
    dt = Math.max(dt, MIN_DT)
    this.time = time
    // delta = value^-1 * measurement, shortest arc.
    this.delta.copy(this.value).invert().multiply(measurement)
    if (this.delta.w < 0) this.delta.set(-this.delta.x, -this.delta.y, -this.delta.z, -this.delta.w)
    const angle = 2 * Math.acos(Math.min(1, this.delta.w))
    this.speed += smoothingFactor(dt, this.derivativeCutoff) * (angle / dt - this.speed)
    const cutoff = this.minCutoff + this.beta * Math.abs(this.speed)
    const alpha = smoothingFactor(dt, cutoff)
    if (angle > 1e-9) {
      this.axis.set(this.delta.x, this.delta.y, this.delta.z).normalize()
      this.delta.setFromAxisAngle(this.axis, angle * alpha)
      this.value.multiply(this.delta).normalize()
    }
    return this.value.clone()
  }
}

/** Limit the change of a scalar per second (causal glitch guard). */
export function limitStep(previous: number | null, next: number, maxRatePerSec: number, dt: number) {
  if (previous === null || !Number.isFinite(previous)) return next
  const maxStep = maxRatePerSec * Math.max(dt, MIN_DT)
  return previous + Math.max(-maxStep, Math.min(maxStep, next - previous))
}

/** Limit the rotation between two quaternions per second (causal glitch guard). */
export function limitQuaternionStep(previous: Quaternion | null, next: Quaternion, maxRadPerSec: number, dt: number) {
  if (!previous) return next.clone()
  const maxStep = maxRadPerSec * Math.max(dt, MIN_DT)
  const dot = Math.min(1, Math.abs(previous.dot(next)))
  const angle = 2 * Math.acos(dot)
  if (angle <= maxStep) return next.clone()
  return previous.clone().slerp(next, maxStep / angle)
}

/**
 * Sliding-window quantiles over the most recent `capacity` samples (a ring
 * buffer, re-sorted lazily). Used for online calibration baselines that the
 * offline path takes from whole-clip percentiles.
 */
export class RollingQuantiles {
  private readonly buffer: Float64Array
  private count = 0
  private head = 0
  private sorted: Float64Array | null = null

  constructor(capacity: number) {
    this.buffer = new Float64Array(capacity)
  }

  get size() {
    return this.count
  }

  clear() {
    this.count = 0
    this.head = 0
    this.sorted = null
  }

  push(value: number) {
    if (!Number.isFinite(value)) return
    this.buffer[this.head] = value
    this.head = (this.head + 1) % this.buffer.length
    this.count = Math.min(this.count + 1, this.buffer.length)
    this.sorted = null
  }

  quantile(p: number, fallback = 0) {
    if (!this.count) return fallback
    if (!this.sorted) this.sorted = this.buffer.slice(0, this.count).sort()
    const position = Math.min(Math.max(p, 0), 1) * (this.count - 1)
    const lower = Math.floor(position)
    const upper = Math.min(lower + 1, this.count - 1)
    return this.sorted[lower] + (this.sorted[upper] - this.sorted[lower]) * (position - lower)
  }
}
