import type { Landmark } from '../../types/tracking'
import { DEG } from '../math'
import { limitStep, OneEuroFilter } from '../filters/online'
import type { HandStateCode } from '../clip/format'
import type { Rig } from '../rig/Rig'
import { SIDES, type Side } from '../rig/semanticMap'
import { AvatarSolver } from '../retarget/AvatarSolver'
import type { SolvedPose, SourcePose } from '../retarget/types'
import { createHandModel, type HandTemplate } from '../source/handModel'
import { resolveHandIdentity } from '../source/handIdentity'
import type { ImageSpace } from '../source/landmarks'
import type { FaceFeatureBaselines } from '../source/faceFeatures'
import {
  DEFAULT_FACE_BASELINES, DEFAULT_FACE_Z_SCALE, DEFAULT_HAND_TEMPLATE, DEFAULT_HAND_Z_SCALE, DEFAULT_LIVE_CONFIG, LIVE_SOLVER_CONFIG, type LiveConfig
} from './defaults'
import { LiveBodyTracker } from './LiveBodyTracker'
import { LiveFaceTracker } from './LiveFaceTracker'
import { LiveHandTracker } from './LiveHandTracker'

export interface LiveFrame {
  pose?: readonly Landmark[]
  poseWorld?: readonly Landmark[]
  leftHand?: readonly Landmark[]
  rightHand?: readonly Landmark[]
  face?: readonly Landmark[]
  /** Measurement time in milliseconds (monotonic). */
  timestampMs: number
  image: ImageSpace
}

export interface LiveResult {
  pose: SolvedPose
  handState: Record<Side, HandStateCode>
  bodyTracked: boolean
  faceCalibrated: boolean
  /** Main-thread cost of this update (ms), excluding landmark inference. */
  solveMs: number
}

export interface LiveOptions {
  template?: HandTemplate
  handZScale?: number
  faceZScale?: number
  faceBaselines?: FaceFeatureBaselines
}

/**
 * Real-time (causal) motion pipeline for the camera and uploaded videos.
 * Uses the SAME anatomical solver as the offline path; only the source
 * conditioning differs (online filters instead of zero-phase smoothing,
 * greedy temporal choices instead of Viterbi, no future frames).
 */
export class LiveMotionPipeline {
  readonly solver: AvatarSolver
  private readonly config: LiveConfig
  private readonly handZScale: number
  private readonly hands: Record<Side, LiveHandTracker>
  private readonly body: LiveBodyTracker
  private readonly face: LiveFaceTracker
  private readonly candidates: number[]
  private readonly swivelFilters: Record<Side, OneEuroFilter>
  private swivel: Record<Side, number | null> = { left: null, right: null }
  private previousTwist: Partial<Record<Side, number>> = {}
  private appliedTwist: Record<Side, number | null> = { left: null, right: null }
  private lastUpdateTime: number | null = null
  private previousWrists: Record<Side, { x: number; y: number } | null> = { left: null, right: null }
  private lastSolveTime: number | null = null

  constructor(rig: Rig, config: LiveConfig = DEFAULT_LIVE_CONFIG, options: LiveOptions = {}) {
    const template = options.template ?? DEFAULT_HAND_TEMPLATE
    this.config = config
    this.handZScale = options.handZScale ?? DEFAULT_HAND_Z_SCALE
    this.solver = new AvatarSolver(rig, { left: { ...template.neutralAbduction }, right: { ...template.neutralAbduction } }, LIVE_SOLVER_CONFIG)
    this.hands = {
      left: new LiveHandTracker('left', createHandModel('left', template, this.solver.geometry.hands.left), this.handZScale, config.hand),
      right: new LiveHandTracker('right', createHandModel('right', template, this.solver.geometry.hands.right), this.handZScale, config.hand)
    }
    this.body = new LiveBodyTracker(config.body)
    // Keep live wrist targets outside the avatar's folded-arm reach (in the
    // source's shoulder-width units), so depth glitches cannot fold the arm.
    const g = this.solver.geometry
    const folded = Math.min(...SIDES.map((side) => {
      const a = g.arms[side]
      return Math.sqrt(a.upperLength ** 2 + a.forearmLength ** 2 + 2 * a.upperLength * a.forearmLength * Math.cos(this.solver.config.arm.maxFlexion))
    }))
    this.body.setNearReach((folded * this.solver.config.arm.nearReach * 1.1) / g.torso.shoulderWidth)
    this.face = new LiveFaceTracker(config.face, options.faceZScale ?? DEFAULT_FACE_Z_SCALE, options.faceBaselines ?? DEFAULT_FACE_BASELINES)
    this.candidates = Array.from({ length: config.swivel.candidates }, (_, i) => -Math.PI + (i * 2 * Math.PI) / config.swivel.candidates)
    this.swivelFilters = {
      left: new OneEuroFilter(config.swivel.minCutoff, config.swivel.beta, 1),
      right: new OneEuroFilter(config.swivel.minCutoff, config.swivel.beta, 1)
    }
  }

  /** 1 = default; larger = smoother / more lag, smaller = more responsive. */
  setSmoothing(scale: number) {
    SIDES.forEach((side) => this.hands[side].setSmoothing(scale))
    this.body.setSmoothing(scale)
    this.face.setSmoothing(scale)
    const cutoff = this.config.swivel.minCutoff / Math.max(0.25, scale)
    SIDES.forEach((side) => { this.swivelFilters[side].minCutoff = cutoff })
  }

  /** Forget all temporal state and calibration (e.g. new source or explicit restart). */
  reset() {
    SIDES.forEach((side) => {
      this.hands[side].reset()
      this.swivelFilters[side].reset()
    })
    this.body.reset()
    this.face.reset()
    this.swivel = { left: null, right: null }
    this.previousTwist = {}
    this.appliedTwist = { left: null, right: null }
    this.lastUpdateTime = null
    this.previousWrists = { left: null, right: null }
    this.lastSolveTime = null
  }

  update(frame: LiveFrame): LiveResult {
    const started = typeof performance !== 'undefined' ? performance.now() : Date.now()
    const time = frame.timestampMs / 1000
    const image = frame.image

    const identity = resolveHandIdentity({
      pose: frame.pose,
      left: frame.leftHand,
      right: frame.rightHand,
      previous: this.previousWrists,
      aspect: image.width / Math.max(1, image.height)
    })
    const handOut = {
      left: this.hands.left.update(identity.left, image, time),
      right: this.hands.right.update(identity.right, image, time)
    }
    for (const side of SIDES) {
      const accepted = handOut[side].state === 'T' ? identity[side] : null
      if (accepted) this.previousWrists[side] = { x: accepted[0].x, y: accepted[0].y }
    }

    const irises = frame.face && frame.face.length >= 478 ? { left: frame.face[473], right: frame.face[468] } : null
    const body = this.body.update({
      pose: frame.pose,
      world: frame.poseWorld,
      hands: { left: handOut.left.landmarks, right: handOut.right.landmarks },
      irises,
      image,
      handZScale: this.handZScale,
      time
    })
    const face = this.face.update(frame.face, image, time)
    const source: SourcePose = { body, hands: { left: handOut.left.hand, right: handOut.right.hand }, face }

    // Elbow swivel: per-frame cost over candidate angles plus a continuity
    // penalty to the previous choice (greedy forward step of the offline
    // Viterbi), then causal smoothing of the unwrapped angle.
    const swivel: Partial<Record<Side, number>> = {}
    if (body) {
      const costs = this.solver.swivelCosts(source, this.candidates, this.previousTwist)
      const frames = this.lastSolveTime === null ? 1 : Math.max(1, (time - this.lastSolveTime) * 30)
      const sigma = this.config.swivel.sigmaDeg * DEG * Math.sqrt(frames)
      for (const side of SIDES) {
        const previous = this.swivel[side]
        let best = 0
        let bestCost = Infinity
        this.candidates.forEach((candidate, i) => {
          const jump = previous === null ? 0 : Math.atan2(Math.sin(candidate - previous), Math.cos(candidate - previous))
          const cost = costs[side][i] + (jump / sigma) ** 2
          if (cost < bestCost) {
            bestCost = cost
            best = i
          }
        })
        const chosen = this.candidates[best]
        const unwrapped = previous === null ? chosen : previous + Math.atan2(Math.sin(chosen - previous), Math.cos(chosen - previous))
        this.swivel[side] = this.swivelFilters[side].filter(unwrapped, time)
        swivel[side] = this.swivel[side]!
      }
      this.lastSolveTime = time
    }

    let pose = this.solver.solve(source, { swivel, previousTwist: this.previousTwist })
    // Forearm twist continuity: when the required pronation passes through
    // the anatomically impossible +-180 deg zone, the clamped twist changes
    // side. Offline this is replaced by a smooth transition; causally the
    // applied twist is rate-limited (it swings through neutral instead of
    // snapping to the other limit).
    const dt = this.lastUpdateTime === null ? 1 / 30 : Math.max(1e-3, time - this.lastUpdateTime)
    this.lastUpdateTime = time
    const override: Partial<Record<Side, number>> = {}
    let limited = false
    for (const side of SIDES) {
      const previous = this.appliedTwist[side]
      const desired = pose.diagnostics.arms[side].wristTwist
      if (previous === null) continue
      const next = limitStep(previous, desired, this.config.maxTwistRateDegS * DEG, dt)
      if (Math.abs(next - desired) > 1e-6) {
        override[side] = next
        limited = true
      }
    }
    const rawTwist = { left: pose.diagnostics.arms.left.wristTwistRaw, right: pose.diagnostics.arms.right.wristTwistRaw }
    if (limited) pose = this.solver.solve(source, { swivel, previousTwist: this.previousTwist, twistOverride: override })
    for (const side of SIDES) {
      this.previousTwist[side] = rawTwist[side]
      this.appliedTwist[side] = body ? pose.diagnostics.arms[side].wristTwist : null
    }
    const finished = typeof performance !== 'undefined' ? performance.now() : Date.now()
    return {
      pose,
      handState: { left: handOut.left.state, right: handOut.right.state },
      bodyTracked: Boolean(frame.pose?.length),
      faceCalibrated: this.face.calibrated,
      solveMs: finished - started
    }
  }
}
