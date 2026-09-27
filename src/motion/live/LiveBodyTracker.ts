import { Vector3 } from 'three'
import type { Landmark } from '../../types/tracking'
import { clamp, smoothstep } from '../math'
import { limitStep, OneEuroFilter, RollingQuantiles } from '../filters/online'
import { computeBodySample, type BodyNormalizer, type BodySample } from '../source/bodyFeatures'
import { POSE, type ImageSpace } from '../source/landmarks'
import { SIDES, type Side } from '../rig/semanticMap'
import type { SourceBody } from '../retarget/types'
import type { LiveBodyConfig } from './defaults'

export interface LiveBodyInput {
  pose?: readonly Landmark[] | null
  /** MediaPipe metric world landmarks; without them depth degrades to flat. */
  world?: readonly Landmark[] | null
  /** Clean hand landmarks (normalized image coords) from the hand trackers. */
  hands: Record<Side, readonly Landmark[] | null>
  irises?: { left: Landmark; right: Landmark } | null
  image: ImageSpace
  handZScale: number
  time: number
}

const ASSUMED_SHOULDER_WIDTH_M = 0.36

/**
 * Causal robust gate for a noisy scalar (monocular depth): a measurement far
 * from the median of the recent window (> max(k * 1.4826 * MAD, floor)) is
 * replaced by that median before filtering.
 */
class MedianGate {
  private readonly window: number[] = []
  constructor(private readonly size: number, private readonly k: number, private readonly floor: number) {}
  reset() {
    this.window.length = 0
  }
  filter(value: number) {
    const sorted = [...this.window].sort((a, b) => a - b)
    this.window.push(value)
    if (this.window.length > this.size) this.window.shift()
    if (sorted.length < 3) return value
    const median = sorted[sorted.length >> 1]
    const deviations = sorted.map((v) => Math.abs(v - median)).sort((a, b) => a - b)
    const mad = deviations[deviations.length >> 1]
    return Math.abs(value - median) > Math.max(this.k * 1.4826 * mad, this.floor) ? median : value
  }
}

class Vec3Filter {
  readonly axes: OneEuroFilter[]
  constructor(minCutoff: number, beta: number) {
    this.axes = [0, 1, 2].map(() => new OneEuroFilter(minCutoff, beta, 1))
  }
  setMinCutoff(value: number) {
    this.axes.forEach((f) => { f.minCutoff = value })
  }
  reset() {
    this.axes.forEach((f) => f.reset())
  }
  filter(v: Vector3, time: number) {
    return new Vector3(this.axes[0].filter(v.x, time), this.axes[1].filter(v.y, time), this.axes[2].filter(v.z, time))
  }
}

/**
 * Causal body stream: online scale calibration (rolling medians of the
 * shoulder width in pixels/metres, shrug baseline, inter-pupillary distance),
 * smooth pose/hand wrist source switching, One Euro smoothing with
 * confidence-dependent cutoffs, and a hold when the pose drops out.
 */
export class LiveBodyTracker {
  private readonly config: LiveBodyConfig
  /** Minimum wrist distance from its shoulder (shoulder widths); 0 disables. */
  private nearReach = 0
  private cutoffScale = 1
  private readonly widthPx: RollingQuantiles
  private readonly widthM: RollingQuantiles
  private readonly ipd: RollingQuantiles
  private readonly lift: Record<Side, RollingQuantiles>
  private readonly yaw: OneEuroFilter
  private readonly roll: OneEuroFilter
  private readonly wrist: Record<Side, Vec3Filter>
  private readonly elbow: Record<Side, Vec3Filter>
  private readonly shrug: Record<Side, OneEuroFilter>
  private readonly center: Record<Side, Vec3Filter>
  private readonly faceAnchor: Vec3Filter
  /** Depth is the least reliable monocular quantity: gated, slower, rate-limited. */
  private readonly depthGate: Record<Side, MedianGate>
  private readonly depth: Record<Side, OneEuroFilter>
  private lastDepth: Record<Side, number | null> = { left: null, right: null }
  private lastPlanar: Record<Side, Vector3 | null> = { left: null, right: null }
  /** Hand-model wrist minus pose wrist (image plane) and hand centre minus hand wrist, kept while the hand is lost. */
  private handOffset: Record<Side, Vector3> = { left: new Vector3(), right: new Vector3() }
  private centerOffset: Record<Side, Vector3 | null> = { left: null, right: null }
  private fromHand: Record<Side, number> = { left: 0, right: 0 }
  private confidence: Record<Side, number> = { left: 0, right: 0 }
  private elbowConfidence: Record<Side, number> = { left: 0, right: 0 }
  private lastFaceAnchor: Vector3 | null = null
  private last: SourceBody | null = null
  private lastTime: number | null = null

  constructor(config: LiveBodyConfig) {
    this.config = config
    this.widthPx = new RollingQuantiles(config.calibrationWindow)
    this.widthM = new RollingQuantiles(config.calibrationWindow)
    this.ipd = new RollingQuantiles(config.calibrationWindow)
    this.lift = { left: new RollingQuantiles(config.calibrationWindow * 2), right: new RollingQuantiles(config.calibrationWindow * 2) }
    this.yaw = new OneEuroFilter(config.torsoMinCutoff, 0.2, 1)
    this.roll = new OneEuroFilter(config.torsoMinCutoff, 0.2, 1)
    this.wrist = { left: new Vec3Filter(config.wristMinCutoff, config.wristBeta), right: new Vec3Filter(config.wristMinCutoff, config.wristBeta) }
    this.elbow = { left: new Vec3Filter(config.elbowMinCutoff, 0.3), right: new Vec3Filter(config.elbowMinCutoff, 0.3) }
    this.shrug = { left: new OneEuroFilter(config.shrugMinCutoff, 0, 1), right: new OneEuroFilter(config.shrugMinCutoff, 0, 1) }
    this.center = { left: new Vec3Filter(config.wristMinCutoff, config.wristBeta), right: new Vec3Filter(config.wristMinCutoff, config.wristBeta) }
    this.faceAnchor = new Vec3Filter(config.faceAnchorMinCutoff, 0.3)
    this.depthGate = { left: new MedianGate(9, 4, config.depthGateFloor), right: new MedianGate(9, 4, config.depthGateFloor) }
    this.depth = { left: new OneEuroFilter(config.depthMinCutoff, config.depthBeta, 1), right: new OneEuroFilter(config.depthMinCutoff, config.depthBeta, 1) }
  }

  /** Set from the avatar's arm geometry (folded-arm reach / shoulder width). */
  setNearReach(value: number) {
    this.nearReach = Math.max(0, value)
  }

  setSmoothing(scale: number) {
    this.cutoffScale = 1 / Math.max(0.25, scale)
    const c = this.config
    this.yaw.minCutoff = c.torsoMinCutoff * this.cutoffScale
    this.roll.minCutoff = c.torsoMinCutoff * this.cutoffScale
    for (const side of SIDES) {
      this.elbow[side].setMinCutoff(c.elbowMinCutoff * this.cutoffScale)
      this.shrug[side].minCutoff = c.shrugMinCutoff * this.cutoffScale
      this.center[side].setMinCutoff(c.wristMinCutoff * this.cutoffScale)
      this.depth[side].minCutoff = c.depthMinCutoff * this.cutoffScale
    }
    this.faceAnchor.setMinCutoff(c.faceAnchorMinCutoff * this.cutoffScale)
  }

  reset() {
    this.widthPx.clear()
    this.widthM.clear()
    this.ipd.clear()
    SIDES.forEach((side) => {
      this.lift[side].clear()
      this.wrist[side].reset()
      this.elbow[side].reset()
      this.shrug[side].reset()
      this.center[side].reset()
      this.depthGate[side].reset()
      this.depth[side].reset()
    })
    this.lastDepth = { left: null, right: null }
    this.lastPlanar = { left: null, right: null }
    this.handOffset = { left: new Vector3(), right: new Vector3() }
    this.centerOffset = { left: null, right: null }
    this.yaw.reset()
    this.roll.reset()
    this.faceAnchor.reset()
    this.fromHand = { left: 0, right: 0 }
    this.confidence = { left: 0, right: 0 }
    this.elbowConfidence = { left: 0, right: 0 }
    this.lastFaceAnchor = null
    this.last = null
    this.lastTime = null
  }

  update(input: LiveBodyInput): SourceBody | null {
    const { pose, image, time } = input
    const dt = this.lastTime === null ? 1 / 30 : Math.max(1e-3, time - this.lastTime)
    this.lastTime = time
    if (!pose || pose.length < 33) return this.last
    const hasDepth = Boolean(input.world && input.world.length >= 33)
    const world = hasDepth ? input.world! : flatWorld(pose, image)

    // Online scale calibration.
    const ls = pose[POSE.leftShoulder]
    const rs = pose[POSE.rightShoulder]
    if ((ls.visibility ?? 0) > 0.5 && (rs.visibility ?? 0) > 0.5) {
      this.widthPx.push(Math.hypot((ls.x - rs.x) * image.width, (ls.y - rs.y) * image.height))
      const wl = world[POSE.leftShoulder]
      const wr = world[POSE.rightShoulder]
      this.widthM.push(Math.hypot(wl.x - wr.x, wl.y - wr.y, wl.z - wr.z))
    }
    if (!this.widthPx.size) return this.last
    const normalizer: BodyNormalizer = { shoulderWidthPx: this.widthPx.quantile(0.5), shoulderWidthM: this.widthM.quantile(0.5, ASSUMED_SHOULDER_WIDTH_M) }

    const handWrist = { left: input.hands.left?.[0] ?? null, right: input.hands.right?.[0] ?? null }
    const withHands = computeBodySample(pose, world, handWrist, image, normalizer, input.irises)
    const poseOnly = computeBodySample(pose, world, { left: null, right: null }, image, normalizer, input.irises)
    if (!withHands || !poseOnly) return this.last
    if (!hasDepth) flattenDepth([withHands, poseOnly])

    const c = this.config
    const ramp = 1 - Math.exp(-dt / c.handAvailabilityTauSec)
    const wrist = {} as Record<Side, Vector3>
    const elbow = {} as Record<Side, Vector3>
    const shrug = {} as Record<Side, number>
    const handCenter = {} as Record<Side, Vector3>
    const handCenterWeight = {} as Record<Side, number>
    for (const side of SIDES) {
      const lm = input.hands[side]
      const available = lm ? 1 : 0
      this.fromHand[side] += (available - this.fromHand[side]) * ramp
      const w = this.fromHand[side]
      const poseWrist = poseOnly.wrist[side]
      // Image-plane wrist: pose wrist plus the hand-model correction. While
      // the hand is tracked the correction is refreshed; when it is lost the
      // last correction fades out, so the wrist never jumps between sources
      // and never freezes while the arm keeps moving.
      if (lm) this.handOffset[side].set(withHands.wrist[side].x - poseWrist.x, withHands.wrist[side].y - poseWrist.y, 0)
      const planar = new Vector3(poseWrist.x + this.handOffset[side].x * w, poseWrist.y + this.handOffset[side].y * w, 0)
      this.confidence[side] += (poseOnly.wristConfidence[side] - this.confidence[side]) * ramp
      // Trust in the image-plane wrist: full while the hand model tracks it,
      // otherwise the pose wrist's own confidence (low when out of frame and
      // extrapolated by the pose model). Low trust = heavier smoothing and a
      // lower speed limit, so extrapolation jumps cannot throw the arm.
      // Near (or past) the image border the pose model extrapolates the
      // wrist, often wildly: trust it much less there.
      const poseWristLm = pose[side === 'left' ? POSE.leftWrist : POSE.rightWrist]
      const borderMargin = Math.min(poseWristLm.x, 1 - poseWristLm.x, poseWristLm.y, 1 - poseWristLm.y)
      const insideFrame = smoothstep(0, 0.08, borderMargin)
      const trust = lm ? 1 : this.confidence[side] * (0.25 + 0.75 * insideFrame)
      this.wrist[side].setMinCutoff(c.wristMinCutoff * this.cutoffScale * (0.35 + 0.65 * trust))
      let filteredPlanar = this.wrist[side].filter(planar, time)
      const previousPlanar = this.lastPlanar[side]
      if (previousPlanar) {
        const step = filteredPlanar.clone().sub(previousPlanar)
        const maxStep = c.maxWristRate * (0.3 + 0.7 * trust) * dt
        if (step.length() > maxStep) filteredPlanar = previousPlanar.clone().addScaledVector(step.normalize(), maxStep)
      }
      this.lastPlanar[side] = filteredPlanar.clone()
      // Depth: robust gate -> near-shoulder completion -> slow One Euro ->
      // rate limit. Monocular wrist depth often collapses toward (or behind)
      // the shoulder plane when the wrist is extrapolated out of frame; keep
      // the image-plane position and push depth forward so the wrist stays at
      // least `nearReach` from its shoulder (in shoulder widths), before the
      // rate limit so the correction itself cannot jump.
      let gated = this.depthGate[side].filter(poseWrist.z)
      if (this.nearReach > 0) {
        const dx = filteredPlanar.x - (side === 'left' ? 0.5 : -0.5)
        const dy = filteredPlanar.y
        const zMin = Math.sqrt(Math.max(0, this.nearReach * this.nearReach - dx * dx - dy * dy))
        gated = Math.max(gated, zMin)
      }
      const depth = limitStep(this.lastDepth[side], this.depth[side].filter(gated, time), c.maxDepthRate, dt)
      this.lastDepth[side] = depth
      wrist[side] = new Vector3(filteredPlanar.x, filteredPlanar.y, depth)
      elbow[side] = this.elbow[side].filter(withHands.elbow[side], time)
      this.elbowConfidence[side] += (withHands.elbowConfidence[side] - this.elbowConfidence[side]) * ramp
      this.lift[side].push(withHands.shoulderLift[side])
      shrug[side] = this.shrug[side].filter(withHands.shoulderLift[side] - this.lift[side].quantile(0.5), time)

      // Hand centre (mean of the 21 clean landmarks) relative to the hand
      // wrist; kept (translated with the wrist) while the hand is lost.
      if (lm) {
        let x = 0
        let y = 0
        let dz = 0
        for (const p of lm) {
          x += p.x
          y += p.y
          dz += -(p.z - lm[0].z) * image.width * input.handZScale
        }
        x /= lm.length
        y /= lm.length
        dz /= lm.length
        const mid = withHands.midpointPx
        const cx = (x * image.width - mid.x) / normalizer.shoulderWidthPx
        const cy = (-y * image.height - mid.y) / normalizer.shoulderWidthPx
        this.centerOffset[side] = new Vector3(cx - withHands.wrist[side].x, cy - withHands.wrist[side].y, dz / normalizer.shoulderWidthPx)
      }
      const offset = this.centerOffset[side]
      const center = offset ? this.center[side].filter(new Vector3(wrist[side].x + offset.x, wrist[side].y + offset.y, offset.z), time) : null
      handCenter[side] = center ? new Vector3(center.x, center.y, wrist[side].z + center.z) : wrist[side].clone()
      handCenterWeight[side] = center ? clamp(w, 0, 1) : 0
    }

    if (withHands.faceAnchor) {
      this.lastFaceAnchor = this.faceAnchor.filter(withHands.faceAnchor, time)
      if (withHands.faceScale > 0) this.ipd.push(withHands.faceScale)
    }

    this.last = {
      torsoYaw: this.yaw.filter(withHands.torsoYaw, time),
      torsoRoll: this.roll.filter(withHands.torsoRoll, time),
      wrist,
      wristConfidence: { left: Math.max(this.confidence.left, this.fromHand.left), right: Math.max(this.confidence.right, this.fromHand.right) },
      elbow,
      elbowConfidence: { ...this.elbowConfidence },
      shrug,
      faceAnchor: this.lastFaceAnchor ?? undefined,
      // IPD / shoulder width is physically constant: rolling median.
      faceScale: this.ipd.size ? this.ipd.quantile(0.5) : undefined,
      handCenter,
      handCenterWeight
    }
    return this.last
  }
}

/** Without metric world landmarks: image geometry scaled to an assumed shoulder width, zero depth. */
function flatWorld(pose: readonly Landmark[], image: ImageSpace): Landmark[] {
  const ls = pose[POSE.leftShoulder]
  const rs = pose[POSE.rightShoulder]
  const px = Math.max(1, Math.hypot((ls.x - rs.x) * image.width, (ls.y - rs.y) * image.height))
  const metresPerPx = ASSUMED_SHOULDER_WIDTH_M / px
  return pose.map((p) => ({ x: p.x * image.width * metresPerPx, y: p.y * image.height * metresPerPx, z: 0, visibility: p.visibility }))
}

function flattenDepth(samples: BodySample[]) {
  for (const sample of samples) {
    for (const side of SIDES) {
      sample.wrist[side].z = 0.35
      sample.elbow[side].z = 0
    }
  }
}
