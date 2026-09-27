/**
 * Small bounded Levenberg-Marquardt solver for the per-digit hand fits
 * (4-7 parameters, <30 residuals). Numeric forward-difference Jacobian,
 * projection onto box bounds after each step. Deterministic.
 */
export interface LmOptions {
  maxIterations?: number
  tolerance?: number
  initialLambda?: number
  step?: number
}

export interface LmResult {
  params: Float64Array
  cost: number
  iterations: number
}

export type ResidualFn = (params: Float64Array, out: Float64Array) => void

export function solveBoundedLm(
  residuals: ResidualFn,
  residualCount: number,
  initial: ArrayLike<number>,
  lower: ArrayLike<number>,
  upper: ArrayLike<number>,
  options: LmOptions = {}
): LmResult {
  const n = initial.length
  const m = residualCount
  const maxIterations = options.maxIterations ?? 30
  const tolerance = options.tolerance ?? 1e-9
  const step = options.step ?? 1e-4
  let lambda = options.initialLambda ?? 1e-2

  const p = new Float64Array(n)
  for (let i = 0; i < n; i += 1) p[i] = Math.min(upper[i], Math.max(lower[i], initial[i]))
  const r = new Float64Array(m)
  const rTrial = new Float64Array(m)
  const rStep = new Float64Array(m)
  const jac = new Float64Array(m * n)
  const jtj = new Float64Array(n * n)
  const jtr = new Float64Array(n)
  const delta = new Float64Array(n)
  const trial = new Float64Array(n)
  const probe = new Float64Array(n)

  residuals(p, r)
  let cost = sumSquares(r)
  let iterations = 0

  for (; iterations < maxIterations; iterations += 1) {
    // Jacobian (forward differences, stepping inward at an upper bound).
    for (let j = 0; j < n; j += 1) {
      probe.set(p)
      const h = p[j] + step > upper[j] ? -step : step
      probe[j] = p[j] + h
      residuals(probe, rStep)
      for (let i = 0; i < m; i += 1) jac[i * n + j] = (rStep[i] - r[i]) / h
    }
    jtj.fill(0)
    jtr.fill(0)
    for (let i = 0; i < m; i += 1) {
      const ri = r[i]
      for (let a = 0; a < n; a += 1) {
        const ja = jac[i * n + a]
        if (ja === 0) continue
        jtr[a] += ja * ri
        for (let b = a; b < n; b += 1) jtj[a * n + b] += ja * jac[i * n + b]
      }
    }
    for (let a = 0; a < n; a += 1) for (let b = 0; b < a; b += 1) jtj[a * n + b] = jtj[b * n + a]

    let improved = false
    for (let attempt = 0; attempt < 8; attempt += 1) {
      if (!solveDamped(jtj, jtr, lambda, n, delta)) {
        lambda *= 10
        continue
      }
      for (let j = 0; j < n; j += 1) trial[j] = Math.min(upper[j], Math.max(lower[j], p[j] - delta[j]))
      residuals(trial, rTrial)
      const trialCost = sumSquares(rTrial)
      if (Number.isFinite(trialCost) && trialCost < cost) {
        const gain = cost - trialCost
        p.set(trial)
        r.set(rTrial)
        cost = trialCost
        lambda = Math.max(lambda * 0.3, 1e-7)
        improved = true
        if (gain < tolerance * (1 + cost)) iterations = maxIterations
        break
      }
      lambda *= 10
    }
    if (!improved) break
  }
  return { params: p, cost, iterations }
}

function sumSquares(values: Float64Array) {
  let sum = 0
  for (let i = 0; i < values.length; i += 1) sum += values[i] * values[i]
  return sum
}

/** Solve (A + lambda*diag(A)) x = b by Cholesky; returns false if not SPD. */
function solveDamped(a: Float64Array, b: Float64Array, lambda: number, n: number, out: Float64Array) {
  const l = new Float64Array(n * n)
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j <= i; j += 1) {
      let sum = a[i * n + j]
      if (i === j) sum += lambda * Math.max(a[i * n + i], 1e-6)
      for (let k = 0; k < j; k += 1) sum -= l[i * n + k] * l[j * n + k]
      if (i === j) {
        if (sum <= 0 || !Number.isFinite(sum)) return false
        l[i * n + i] = Math.sqrt(sum)
      } else {
        l[i * n + j] = sum / l[j * n + j]
      }
    }
  }
  const y = new Float64Array(n)
  for (let i = 0; i < n; i += 1) {
    let sum = b[i]
    for (let k = 0; k < i; k += 1) sum -= l[i * n + k] * y[k]
    y[i] = sum / l[i * n + i]
  }
  for (let i = n - 1; i >= 0; i -= 1) {
    let sum = y[i]
    for (let k = i + 1; k < n; k += 1) sum -= l[k * n + i] * out[k]
    out[i] = sum / l[i * n + i]
  }
  return true
}
