import { Quaternion, type Vector3 } from 'three'
import type { Landmark } from '../../types/tracking'
import { angleBetweenQuaternions, DEG, smoothstep } from '../math'
import { limitQuaternionStep, limitStep, OneEuroFilter, OneEuroQuaternionFilter } from '../filters/online'
import type { HandStateCode } from '../clip/format'
import type { Side } from '../rig/semanticMap'
import {
  DIGITS, fitHand, fitHandHypotheses, handLandmarksFromFit, relaxedHandParams, type HandFit, type HandModelContext, type HandParams
} from '../source/handModel'
import { enforceHandConstraints, flattenParams, PARAM_CHANNELS, unflattenParams } from '../source/handParams'
import { fromModelSpace, handIsFinite, toModelSpace, type ImageSpace } from '../source/landmarks'
import type { SourceHand } from '../retarget/types'
import type { LiveHandConfig } from './defaults'

export interface LiveHandOutput {
  state: HandStateCode
  /** Source hand for the solver, or null when the hand has fully faded out. */
  hand: SourceHand | null
  /** Clean (model-fitted, filtered) landmarks in normalized image coords; null unless tracked/held. */
  landmarks: Landmark[] | null
  /** Fit quality 0..1 of the last accepted measurement (0 when not measured this frame). */
  quality: number
}

interface PalmState {
  rotation: Quaternion
  scale: number
  wrist: Vector3
}

/**
 * Causal per-hand tracker: articulated fit (warm-started), palm/back
 * disambiguation against the recent orientation, fit gates, One Euro
 * smoothing + rate limits, and occlusion handling (hold -> relaxed fallback
 * -> cross-faded re-acquisition). Never uses future frames.
 */
export class LiveHandTracker {
  readonly side: Side
  private readonly model: HandModelContext
  private readonly zScale: number
  private config: LiveHandConfig
  private minCutoffScale = 1
  private readonly relaxed: number[]
  private readonly paramFilters: OneEuroFilter[]
  private readonly palmFilter: OneEuroQuaternionFilter
  private readonly scaleFilter: OneEuroFilter
  private readonly wristFilters: OneEuroFilter[]

  private lastAcceptedTime = -Infinity
  private lastAcceptedRotation: Quaternion | null = null
  private lastParams: HandParams | null = null
  private output: number[] | null = null
  private outputRotation: Quaternion | null = null
  private outputPalm: PalmState | null = null
  private palmWeight = 0
  private lastTime: number | null = null
  private reacquireFrom: { params: number[]; rotation: Quaternion | null; palmWeight: number; time: number } | null = null
  private wasTracking = false

  constructor(side: Side, model: HandModelContext, zScale: number, config: LiveHandConfig) {
    this.side = side
    this.model = model
    this.zScale = zScale
    this.config = config
    this.relaxed = flattenParams(relaxedHandParams(model))
    this.paramFilters = PARAM_CHANNELS.map(() => new OneEuroFilter(config.fingerMinCutoff, config.fingerBeta, 1))
    this.palmFilter = new OneEuroQuaternionFilter(config.palmMinCutoff, config.palmBeta, 1)
    this.scaleFilter = new OneEuroFilter(config.palmMinCutoff, 0, 1)
    this.wristFilters = [0, 1, 2].map(() => new OneEuroFilter(config.palmMinCutoff * 1.5, 0.02, 1))
  }

  /** Smoothing control: >1 = smoother (lower cutoffs), <1 = more responsive. */
  setSmoothing(scale: number) {
    this.minCutoffScale = 1 / Math.max(0.25, scale)
    const c = this.config
    this.paramFilters.forEach((f) => { f.minCutoff = c.fingerMinCutoff * this.minCutoffScale })
    this.palmFilter.minCutoff = c.palmMinCutoff * this.minCutoffScale
    this.scaleFilter.minCutoff = c.palmMinCutoff * this.minCutoffScale
    this.wristFilters.forEach((f) => { f.minCutoff = c.palmMinCutoff * 1.5 * this.minCutoffScale })
  }

  reset() {
    this.lastAcceptedTime = -Infinity
    this.lastAcceptedRotation = null
    this.lastParams = null
    this.output = null
    this.outputRotation = null
    this.outputPalm = null
    this.palmWeight = 0
    this.lastTime = null
    this.reacquireFrom = null
    this.wasTracking = false
    this.paramFilters.forEach((f) => f.reset())
    this.palmFilter.reset()
    this.scaleFilter.reset()
    this.wristFilters.forEach((f) => f.reset())
  }

  update(landmarks: readonly Landmark[] | null | undefined, image: ImageSpace, time: number): LiveHandOutput {
    const dt = this.lastTime === null ? 1 / 30 : Math.max(1e-3, time - this.lastTime)
    this.lastTime = time
    const fit = handIsFinite(landmarks) ? this.measure(landmarks, image, time) : null
    if (fit) return this.track(fit, image, time, dt)
    return this.coast(time)
  }

  private measure(landmarks: readonly Landmark[], image: ImageSpace, time: number): HandFit | null {
    const c = this.config
    const points = landmarks.map((landmark) => toModelSpace(landmark, image, this.zScale))
    const weights = landmarks.map((landmark) => (landmark.x < 0 || landmark.x > 1 || landmark.y < 0 || landmark.y > 1 ? 0.25 : 1))
    const fresh = this.lastAcceptedRotation !== null && time - this.lastAcceptedTime < c.flipMemorySec
    const options = { refinePasses: c.refinePasses, previous: this.lastParams ?? undefined, fastWarmStart: true }

    let best: HandFit | null = null
    if (fresh) {
      // Fast path: start from the recent palm orientation and pose. Accept
      // when the result stays continuous with it (the common case).
      const warm = fitHand(this.model, points, weights, { ...options, initialRotation: this.lastAcceptedRotation!.clone() })
      if (warm && angleBetweenQuaternions(warm.palm.rotation, this.lastAcceptedRotation!) < c.continuousDeg * DEG) best = warm
    }
    if (!best) {
      // Palm/back choice between both mirror interpretations: fit cost +
      // orientation continuity with the recent accepted palm. A hypothesis
      // implying a flip (> flipRejectDeg in one step) is rejected while the
      // memory is fresh; after flipMemorySec without an accepted fit, any
      // orientation is accepted.
      const hypotheses = fitHandHypotheses(this.model, points, weights, options)
      let bestCost = Infinity
      for (const fit of hypotheses) {
        let cost = Math.min(fit.cost / c.palmCostScale, 30)
        if (fresh) {
          const frames = Math.max(1, (time - this.lastAcceptedTime) * 30)
          const angle = angleBetweenQuaternions(fit.palm.rotation, this.lastAcceptedRotation!)
          cost += (angle / (c.palmSigmaDeg * DEG * Math.sqrt(frames))) ** 2
        }
        if (cost < bestCost) {
          bestCost = cost
          best = fit
        }
      }
      if (!best) return null
      if (fresh && angleBetweenQuaternions(best.palm.rotation, this.lastAcceptedRotation!) > c.flipRejectDeg * DEG) return null
    }
    const meanDigit = DIGITS.reduce((sum, digit) => sum + best!.digitError[digit], 0) / DIGITS.length
    if (best.palmError > c.maxPalmError || meanDigit > c.maxMeanDigitError || best.outOfFrame > c.maxOutOfFrame) return null
    return best
  }

  private track(fit: HandFit, image: ImageSpace, time: number, dt: number): LiveHandOutput {
    const c = this.config
    const measured = flattenParams(fit.params)
    const reacquiring = !this.wasTracking
    if (reacquiring) {
      // Start the filters at the measurement (no stale velocity) and
      // cross-fade the OUTPUT from whatever the avatar currently shows.
      this.paramFilters.forEach((f, i) => f.reset(measured[i], time))
      this.palmFilter.reset(fit.palm.rotation, time)
      this.scaleFilter.reset(Math.log(fit.palm.scale), time)
      this.wristFilters.forEach((f, axis) => f.reset(fit.palm.wrist.getComponent(axis), time))
      this.reacquireFrom = { params: (this.output ?? this.relaxed).slice(), rotation: this.outputRotation?.clone() ?? null, palmWeight: this.output ? this.palmWeight : 0, time }
    }
    this.wasTracking = true
    this.lastAcceptedTime = time
    this.lastAcceptedRotation = fit.palm.rotation.clone()
    this.lastParams = fit.params

    const maxFinger = c.maxFingerRateDegS * DEG
    let filtered = measured.map((value, i) => this.paramFilters[i].filter(value, time))
    if (this.output && !reacquiring) filtered = filtered.map((value, i) => limitStep(this.output![i], value, maxFinger, dt))
    let rotation = this.palmFilter.filter(fit.palm.rotation, time)
    if (this.outputRotation && !reacquiring) rotation = limitQuaternionStep(this.outputRotation, rotation, c.maxPalmRateDegS * DEG, dt)
    const scale = Math.exp(this.scaleFilter.filter(Math.log(fit.palm.scale), time))
    const wrist = fit.palm.wrist.clone().set(
      this.wristFilters[0].filter(fit.palm.wrist.x, time),
      this.wristFilters[1].filter(fit.palm.wrist.y, time),
      this.wristFilters[2].filter(fit.palm.wrist.z, time)
    )

    let palmWeight = 1
    if (this.reacquireFrom) {
      const w = smoothstep(0, c.reacquireSec, time - this.reacquireFrom.time)
      filtered = filtered.map((value, i) => this.reacquireFrom!.params[i] * (1 - w) + value * w)
      if (this.reacquireFrom.rotation) {
        const from = this.reacquireFrom.rotation.clone()
        if (from.dot(rotation) < 0) from.set(-from.x, -from.y, -from.z, -from.w)
        rotation = from.slerp(rotation, w)
      }
      palmWeight = this.reacquireFrom.palmWeight * (1 - w) + w
      if (w >= 1) this.reacquireFrom = null
    }

    const constrained = enforceHandConstraints(this.model.template, unflattenParams(filtered), this.model.template.neutralAbduction, 10 * DEG).params
    this.output = flattenParams(constrained)
    this.outputRotation = rotation.clone()
    this.outputPalm = { rotation: rotation.clone(), scale, wrist }
    this.palmWeight = palmWeight
    const meanDigit = DIGITS.reduce((sum, digit) => sum + fit.digitError[digit], 0) / DIGITS.length
    return {
      state: 'T',
      hand: { palmWeight, rotation: rotation.clone(), params: constrained },
      landmarks: this.cleanLandmarks(constrained, image),
      quality: Math.max(0, Math.min(1, 1 - meanDigit / c.maxMeanDigitError))
    }
  }

  /** No accepted measurement this frame: hold, then fade to a relaxed hand. */
  private coast(time: number): LiveHandOutput {
    const c = this.config
    this.wasTracking = false
    this.reacquireFrom = null
    if (!this.output || !this.outputRotation) {
      // Never seen: show a relaxed hand (neutral wrist), so the first
      // acquisition cross-fades from it instead of popping from the bind pose.
      this.output = this.relaxed.slice()
      this.palmWeight = 0
      const params = unflattenParams(this.relaxed)
      return { state: 'A', hand: { palmWeight: 0, rotation: new Quaternion(), params }, landmarks: null, quality: 0 }
    }
    const elapsed = time - this.lastAcceptedTime
    const fade = smoothstep(c.holdSec, c.holdSec + c.fallbackSec, elapsed)
    const params = this.output.map((value, i) => value * (1 - fade) + this.relaxed[i] * fade)
    const constrained = enforceHandConstraints(this.model.template, unflattenParams(params), this.model.template.neutralAbduction, 10 * DEG).params
    this.output = flattenParams(constrained)
    this.palmWeight = Math.min(this.palmWeight, 1 - fade)
    if (fade >= 1) {
      // Fully faded: keep the relaxed output so a later re-acquisition fades in from it.
      return { state: 'A', hand: { palmWeight: 0, rotation: this.outputRotation.clone(), params: constrained }, landmarks: null, quality: 0 }
    }
    const state: HandStateCode = fade > 0 ? 'F' : 'H'
    // No landmarks while coasting: the body stream then follows the pose
    // wrist (with a fading hand offset) instead of a frozen hand position.
    return { state, hand: { palmWeight: this.palmWeight, rotation: this.outputRotation.clone(), params: constrained }, landmarks: null, quality: 0 }
  }

  private cleanLandmarks(params: HandParams, image: ImageSpace) {
    if (!this.outputPalm) return null
    const palm = this.outputPalm
    return handLandmarksFromFit(this.model, palm, params).map((p) => fromModelSpace(p, image, this.zScale))
  }
}
