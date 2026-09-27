import { Quaternion, Vector3 } from 'three'
import { clamp, DEG, signedAngleAbout } from '../math'
import { solveBoundedLm } from '../solver/lm'
import { azimuth, elevation, type HandGeometry, palmFrameFromPoints, type PalmFrame } from '../rig/rigGeometry'
import type { FingerName, Side } from '../rig/semanticMap'
import { HAND } from './landmarks'

/**
 * Kinematic hand model used to interpret tracker landmarks.
 *
 * Instead of turning each noisy landmark pair into an unconstrained bone
 * direction, every frame is explained by a constrained articulated hand:
 * a rigid palm (rotation, scale, translation) plus per-digit joint angles
 * with fixed phalanx lengths. PIP/DIP/IP are 1-DOF hinges by construction,
 * MCP is flexion + bounded abduction whose range shrinks with flexion, the
 * thumb has its own CMC model. Fitting minimises 2D reprojection error (the
 * reliable part of monocular landmarks) with a weak depth term, so depth
 * noise cannot bend a finger backwards or sideways.
 *
 * Canonical palm coordinates: x = f x n, y = f (wrist->middle MCP), z = n
 * (volar), unit = palm length. Radial = +x for a right hand, -x for a left.
 */

export type LongFinger = Exclude<FingerName, 'thumb'>
export const LONG: readonly LongFinger[] = ['index', 'middle', 'ring', 'pinky']
export const DIGITS: readonly FingerName[] = ['thumb', 'index', 'middle', 'ring', 'pinky']

type V3 = [number, number, number]

export interface HandTemplate {
  version: 1
  /** Right-hand canonical palm points (left hands mirror x). */
  palm: { thumbCmc: V3; indexMcp: V3; middleMcp: V3; ringMcp: V3; pinkyMcp: V3 }
  /** Segment lengths in palm-length units: thumb = CMC->MCP, MCP->IP, IP->tip. */
  lengths: Record<FingerName, V3>
  /** Relaxed-extension azimuth of each long finger (rad, + = radial). */
  neutralAbduction: Record<LongFinger, number>
  /** MediaPipe hand z rescale for this camera/tracker (bone-length calibrated). */
  zScale: number
  source: string
}

export interface LongFingerParams {
  abduction: number
  mcp: number
  pip: number
  dip: number
}

export interface ThumbParams {
  azimuth: number
  elevation: number
  axial: number
  mcp: number
  ip: number
}

export interface HandParams {
  thumb: ThumbParams
  index: LongFingerParams
  middle: LongFingerParams
  ring: LongFingerParams
  pinky: LongFingerParams
}

export interface PalmPose {
  /** Canonical palm basis -> model-aligned space. */
  rotation: Quaternion
  /** Pixels per palm length. */
  scale: number
  /** Wrist position (model-aligned pixels). */
  wrist: Vector3
}

export interface HandFit {
  side: Side
  palm: PalmPose
  params: HandParams
  /** RMS 2D reprojection error per digit in palm-length units. */
  digitError: Record<FingerName, number>
  palmError: number
  /** Fraction of landmarks down-weighted as extrapolated (outside the image). */
  outOfFrame: number
  /** Total least-squares cost of the final fit (all residuals and priors). */
  cost: number
}

/** Anatomical ranges (radians) for the SOURCE interpretation. */
export const LIMITS = {
  long: {
    mcp: [-25 * DEG, 95 * DEG] as const,
    pip: [-5 * DEG, 110 * DEG] as const,
    dip: [-10 * DEG, 85 * DEG] as const,
    /** Abduction relative to the calibrated relaxed azimuth (+ = radial). */
    abductionRelative: {
      index: [-10 * DEG, 25 * DEG],
      middle: [-14 * DEG, 14 * DEG],
      ring: [-15 * DEG, 10 * DEG],
      pinky: [-28 * DEG, 10 * DEG]
    } as Record<LongFinger, readonly [number, number]>
  },
  thumb: {
    azimuth: [-10 * DEG, 80 * DEG] as const,
    elevation: [-25 * DEG, 75 * DEG] as const,
    axial: [-20 * DEG, 55 * DEG] as const,
    mcp: [-10 * DEG, 75 * DEG] as const,
    ip: [-20 * DEG, 88 * DEG] as const
  }
}

/** DIP is mechanically coupled to PIP (oblique retinacular ligament). */
export const DIP_COUPLING = 0.7

export function dipCouplingBounds(pip: number): [number, number] {
  return [Math.max(LIMITS.long.dip[0], 0.3 * pip - 12 * DEG), Math.min(LIMITS.long.dip[1], 0.95 * pip + 15 * DEG)]
}

/** Full abduction envelope (absolute azimuth) for a finger. */
export function abductionEnvelope(template: HandTemplate, finger: LongFinger): [number, number] {
  const [low, high] = LIMITS.long.abductionRelative[finger]
  const neutral = template.neutralAbduction[finger]
  return [neutral + low, neutral + high]
}

/** Abduction range narrows as the MCP flexes (collateral ligaments tighten). */
export function abductionBounds(template: HandTemplate, finger: LongFinger, mcp: number): [number, number] {
  const [low, high] = LIMITS.long.abductionRelative[finger]
  const neutral = template.neutralAbduction[finger]
  const shrink = 1 - 0.7 * clamp(mcp / (90 * DEG), 0, 1)
  return [neutral + low * shrink, neutral + high * shrink]
}

/** Thumb CMC kinematics borrowed from the rig's modelled thumb. */
export interface ThumbKinematics {
  restAzimuth: number
  restElevation: number
  restMetacarpal: Vector3
  liftAxis: Vector3
  abductionAxis: Vector3
  hingeRest: Vector3
  /** Axial pronation per radian of palmar lift (opposition coupling). */
  axialCoupling: number
}

export interface HandModelContext {
  side: Side
  handSign: 1 | -1
  template: HandTemplate
  thumb: ThumbKinematics
  /** Canonical palm points for this side (mirrored for left): wrist, CMC, 4 MCPs. */
  palmPoints: Vector3[]
  lengths: Record<FingerName, V3>
}

const UP = new Vector3(0, 0, 1)
const FORWARD = new Vector3(0, 1, 0)

function canonical(side: Side, v: V3) {
  return new Vector3(side === 'left' ? -v[0] : v[0], v[1], v[2])
}

function canonicalFrame(handSign: 1 | -1): PalmFrame {
  return { forward: FORWARD.clone(), radial: new Vector3(handSign, 0, 0), volar: UP.clone(), origin: new Vector3(), basis: new Quaternion() }
}

/** Build the per-side model context (template + rig-derived thumb axes). */
export function createHandModel(side: Side, template: HandTemplate, rigHand: HandGeometry): HandModelContext {
  const handSign: 1 | -1 = side === 'right' ? 1 : -1
  const toCanonical = rigHand.palm.basis.clone().invert()
  const radial = new Vector3(handSign, 0, 0)
  const restAz = rigHand.thumb.cmc.restAbduction
  const restEl = rigHand.thumb.cmc.restFlexion
  const metacarpal = new Vector3()
    .addScaledVector(FORWARD, Math.cos(restEl) * Math.cos(restAz))
    .addScaledVector(radial, Math.cos(restEl) * Math.sin(restAz))
    .addScaledVector(UP, Math.sin(restEl))
    .normalize()
  const lift = new Vector3().crossVectors(metacarpal, UP.clone().addScaledVector(metacarpal, -UP.dot(metacarpal)).normalize()).normalize()
  return {
    side,
    handSign,
    template,
    thumb: {
      restAzimuth: restAz,
      restElevation: restEl,
      restMetacarpal: metacarpal,
      liftAxis: lift,
      abductionAxis: new Vector3(0, 0, -handSign),
      hingeRest: rigHand.thumb.hingeWorld.clone().applyQuaternion(toCanonical).normalize(),
      axialCoupling: 0.55
    },
    palmPoints: [
      new Vector3(0, 0, 0),
      canonical(side, template.palm.thumbCmc),
      canonical(side, template.palm.indexMcp),
      canonical(side, template.palm.middleMcp),
      canonical(side, template.palm.ringMcp),
      canonical(side, template.palm.pinkyMcp)
    ],
    lengths: template.lengths
  }
}

const PALM_INDEX = [HAND.wrist, HAND.thumb[0], HAND.index[0], HAND.middle[0], HAND.ring[0], HAND.pinky[0]]
const PALM_WEIGHT = [1, 0.35, 1, 1, 1, 1]
const MCP_OF: Record<LongFinger, number> = { index: 2, middle: 3, ring: 4, pinky: 5 }

function rotate(v: Vector3, axis: Vector3, angle: number) {
  return v.clone().applyAxisAngle(axis, angle)
}

/** Forward kinematics in canonical palm coordinates (palm-length units). */
export function longFingerCanonical(model: HandModelContext, finger: LongFinger, p: LongFingerParams): Vector3[] {
  const radial = new Vector3(model.handSign, 0, 0)
  const u = new Vector3(0, Math.cos(p.abduction), 0).addScaledVector(radial, Math.sin(p.abduction))
  const hinge = new Vector3().crossVectors(u, UP).normalize()
  const d1 = u.clone().multiplyScalar(Math.cos(p.mcp)).addScaledVector(UP, Math.sin(p.mcp))
  const d2 = rotate(d1, hinge, p.pip)
  const d3 = rotate(d2, hinge, p.dip)
  const [l1, l2, l3] = model.lengths[finger]
  const mcp = model.palmPoints[MCP_OF[finger]].clone()
  const pip = mcp.clone().addScaledVector(d1, l1)
  const dip = pip.clone().addScaledVector(d2, l2)
  const tip = dip.clone().addScaledVector(d3, l3)
  return [mcp, pip, dip, tip]
}

export function thumbFrame(model: HandModelContext, p: Pick<ThumbParams, 'azimuth' | 'elevation' | 'axial'>) {
  const t = model.thumb
  const rotation = new Quaternion().setFromAxisAngle(t.abductionAxis, p.azimuth - t.restAzimuth)
    .multiply(new Quaternion().setFromAxisAngle(t.liftAxis, p.elevation - t.restElevation))
    .multiply(new Quaternion().setFromAxisAngle(t.restMetacarpal, p.axial))
  return {
    rotation,
    metacarpal: t.restMetacarpal.clone().applyQuaternion(rotation),
    hinge: t.hingeRest.clone().applyQuaternion(rotation)
  }
}

export function thumbCanonical(model: HandModelContext, p: ThumbParams): Vector3[] {
  const { metacarpal, hinge } = thumbFrame(model, p)
  const dp = rotate(metacarpal, hinge, p.mcp)
  const dd = rotate(dp, hinge, p.ip)
  const [l1, l2, l3] = model.lengths.thumb
  const cmc = model.palmPoints[1].clone()
  const mcp = cmc.clone().addScaledVector(metacarpal, l1)
  const ip = mcp.clone().addScaledVector(dp, l2)
  const tip = ip.clone().addScaledVector(dd, l3)
  return [cmc, mcp, ip, tip]
}

/** All 21 landmarks in canonical palm coordinates. */
export function handCanonical(model: HandModelContext, params: HandParams): Vector3[] {
  const out: Vector3[] = new Array(21)
  out[0] = new Vector3()
  const thumb = thumbCanonical(model, params.thumb)
  HAND.thumb.forEach((index, k) => { out[index] = thumb[k] })
  for (const finger of LONG) {
    const points = longFingerCanonical(model, finger, params[finger])
    HAND[finger].forEach((index, k) => { out[index] = points[k] })
  }
  return out
}

/** All 21 landmarks in model-aligned pixel space for a fitted hand. */
export function handLandmarksFromFit(model: HandModelContext, palm: PalmPose, params: HandParams): Vector3[] {
  return handCanonical(model, params).map((c) => c.clone().applyQuaternion(palm.rotation).multiplyScalar(palm.scale).add(palm.wrist))
}

export interface FitOptions {
  /** Reprojection sigma in palm lengths (2D) and depth sigma. */
  sigma2d?: number
  sigmaZ?: number
  /** Alternating palm/digit refinement passes (0 = palm points only). */
  refinePasses?: number
  /** Optional warm start (live mode). */
  previous?: HandParams
  /**
   * Live mode: with `previous`, start each digit's solve only from the
   * previous pose and the direct geometric reading (instead of the full
   * multi-start set). ~2.5x faster; relies on temporal continuity.
   */
  fastWarmStart?: boolean
  /** Initial palm rotation (e.g. the alternative palm/back hypothesis). */
  initialRotation?: Quaternion
}

/**
 * Fit the articulated model to one frame of landmarks (model-aligned pixels,
 * depth already rescaled). `weights` down-weights extrapolated points.
 *
 * Alternating optimisation: (1) similarity transform of the palm, (2) each
 * digit's joint angles in palm coordinates, (3) re-estimate the similarity
 * using the whole articulated shape (finger points at reduced weight), so an
 * extended finger can correct a foreshortened palm's scale estimate.
 */
export function fitHand(model: HandModelContext, observed: Vector3[], weights: number[], options: FitOptions = {}): HandFit | null {
  const sigma2d = options.sigma2d ?? 0.045
  const sigmaZ = options.sigmaZ ?? 0.22
  const passes = options.refinePasses ?? 2
  const initialFrame = palmFrameFromPoints(model.side, observed[0], observed[5], observed[9], observed[17])
  if (!initialFrame) return null

  // Initial scale from palm distances (robust to depth noise).
  let scaleSum = 0
  let scaleWeight = 0
  for (let k = 1; k < PALM_INDEX.length; k += 1) {
    const templateLength = model.palmPoints[k].length()
    if (templateLength < 1e-6) continue
    scaleSum += observed[PALM_INDEX[k]].distanceTo(observed[0]) / templateLength * PALM_WEIGHT[k]
    scaleWeight += PALM_WEIGHT[k]
  }
  const scale0 = scaleSum / Math.max(scaleWeight, 1e-6)
  if (!(scale0 > 1e-3)) return null

  const palmTemplate = new Array<Vector3 | null>(21).fill(null)
  const palmWeights = new Array<number>(21).fill(0)
  PALM_INDEX.forEach((index, k) => {
    palmTemplate[index] = model.palmPoints[k]
    palmWeights[index] = PALM_WEIGHT[k]
  })
  let similarity = fitSimilarityWithCost(palmTemplate, palmWeights, observed, weights, { rotation: (options.initialRotation ?? initialFrame.basis).clone(), scale: scale0, wrist: observed[0].clone() }, sigma2d, sigmaZ)
  let pose = similarity.pose
  const fast = Boolean(options.fastWarmStart && options.previous)
  let fit = fitDigits(model, observed, weights, pose, sigma2d, sigmaZ, options.previous, fast)
  for (let pass = 0; pass < passes; pass += 1) {
    const shape = handCanonical(model, fit.params)
    const shapeWeights = shape.map((_, index) => palmWeights[index] || 0.3)
    similarity = fitSimilarityWithCost(shape, shapeWeights, observed, weights, pose, sigma2d, sigmaZ)
    pose = similarity.pose
    fit = fitDigits(model, observed, weights, pose, sigma2d, sigmaZ, fit.params, fast || Boolean(options.fastWarmStart))
  }

  let outside = 0
  weights.forEach((w) => { if (w < 0.5) outside += 1 })
  return {
    side: model.side,
    palm: pose,
    params: fit.params,
    digitError: fit.errors,
    palmError: palmError(model, pose, observed),
    outOfFrame: outside / 21,
    cost: similarity.cost + fit.cost
  }
}

function palmError(model: HandModelContext, pose: PalmPose, observed: Vector3[]) {
  let sum = 0
  let count = 0
  const point = new Vector3()
  for (let k = 0; k < PALM_INDEX.length; k += 1) {
    point.copy(model.palmPoints[k]).applyQuaternion(pose.rotation).multiplyScalar(pose.scale).add(pose.wrist)
    const target = observed[PALM_INDEX[k]]
    sum += ((point.x - target.x) ** 2 + (point.y - target.y) ** 2) * PALM_WEIGHT[k]
    count += PALM_WEIGHT[k]
  }
  return Math.sqrt(sum / count) / pose.scale
}

function fitSimilarityWithCost(
  shape: (Vector3 | null)[],
  shapeWeights: number[],
  observed: Vector3[],
  observedWeights: number[],
  init: PalmPose,
  sigma2d: number,
  sigmaZ: number
): { pose: PalmPose; cost: number } {
  const used: number[] = []
  shape.forEach((point, index) => { if (point && shapeWeights[index] > 0) used.push(index) })
  const rotation0 = init.rotation.clone()
  const scale0 = init.scale
  const wrist0 = init.wrist.clone()
  const trial = new Quaternion()
  const axis = new Vector3()
  const point = new Vector3()
  const make = (p: Float64Array) => {
    const angle = Math.hypot(p[0], p[1], p[2])
    if (angle > 1e-12) axis.set(p[0] / angle, p[1] / angle, p[2] / angle)
    else axis.set(1, 0, 0)
    trial.setFromAxisAngle(axis, angle).multiply(rotation0)
    return { scale: scale0 * Math.exp(p[3]), x: wrist0.x + p[4], y: wrist0.y + p[5], z: wrist0.z + p[6] }
  }
  const residuals = (p: Float64Array, out: Float64Array) => {
    const current = make(p)
    for (let k = 0; k < used.length; k += 1) {
      const index = used[k]
      point.copy(shape[index] as Vector3).applyQuaternion(trial).multiplyScalar(current.scale)
      const target = observed[index]
      const w = shapeWeights[index] * observedWeights[index] / scale0
      out[k * 3] = (point.x + current.x - target.x) * w / sigma2d
      out[k * 3 + 1] = (point.y + current.y - target.y) * w / sigma2d
      out[k * 3 + 2] = (point.z + current.z - target.z) * w / sigmaZ
    }
  }
  const big = scale0 * 3
  const result = solveBoundedLm(residuals, used.length * 3, [0, 0, 0, 0, 0, 0, 0],
    [-Math.PI, -Math.PI, -Math.PI, -0.7, -big, -big, -big], [Math.PI, Math.PI, Math.PI, 0.7, big, big, big], { maxIterations: 25 })
  const best = make(result.params)
  return { pose: { rotation: trial.clone().normalize(), scale: best.scale, wrist: new Vector3(best.x, best.y, best.z) }, cost: result.cost }
}

function fitDigits(
  model: HandModelContext,
  observed: Vector3[],
  weights: number[],
  pose: PalmPose,
  sigma2d: number,
  sigmaZ: number,
  previous?: HandParams,
  fast = false
) {
  const inverse = pose.rotation.clone().invert()
  const local = observed.map((v) => v.clone().sub(pose.wrist).applyQuaternion(inverse).divideScalar(pose.scale))
  const params = {} as HandParams
  const errors = {} as Record<FingerName, number>
  let cost = 0
  for (const finger of LONG) {
    const result = fitLongFinger(model, finger, local, weights, sigma2d, sigmaZ, previous?.[finger], fast)
    params[finger] = result.params
    errors[finger] = result.error
    cost += result.cost
  }
  const thumb = fitThumb(model, local, weights, sigma2d, sigmaZ, previous?.thumb, fast)
  params.thumb = thumb.params
  errors.thumb = thumb.error
  cost += thumb.cost
  return { params, errors, cost }
}

/** Direct geometric reading of a long finger in canonical coordinates. */
export function directLongFinger(model: HandModelContext, finger: LongFinger, local: Vector3[]): LongFingerParams {
  const idx = HAND[finger]
  const d1 = local[idx[1]].clone().sub(local[idx[0]]).normalize()
  const d2 = local[idx[2]].clone().sub(local[idx[1]]).normalize()
  const d3 = local[idx[3]].clone().sub(local[idx[2]]).normalize()
  const frame = canonicalFrame(model.handSign)
  const mcp = elevation(d1, frame)
  const abduction = azimuth(d1, frame)
  const u = new Vector3(0, Math.cos(abduction), 0).addScaledVector(frame.radial, Math.sin(abduction))
  const hinge = new Vector3().crossVectors(u, UP).normalize()
  return { abduction, mcp, pip: signedAngleAbout(d1, d2, hinge), dip: signedAngleAbout(d2, d3, hinge) }
}

export function clampLongFinger(template: HandTemplate, finger: LongFinger, p: LongFingerParams): LongFingerParams {
  const mcp = clamp(p.mcp, LIMITS.long.mcp[0], LIMITS.long.mcp[1])
  const [abLow, abHigh] = abductionBounds(template, finger, mcp)
  const pip = clamp(p.pip, LIMITS.long.pip[0], LIMITS.long.pip[1])
  const [dipLow, dipHigh] = dipCouplingBounds(pip)
  return { abduction: clamp(p.abduction, abLow, abHigh), mcp, pip, dip: clamp(p.dip, dipLow, dipHigh) }
}

function fitLongFinger(
  model: HandModelContext,
  finger: LongFinger,
  local: Vector3[],
  weights: number[],
  sigma2d: number,
  sigmaZ: number,
  previous?: LongFingerParams,
  fast = false
) {
  const idx = HAND[finger]
  const targets = [local[idx[1]], local[idx[2]], local[idx[3]]]
  const w = [weights[idx[1]], weights[idx[2]], weights[idx[3]]]
  const [abLow, abHigh] = abductionEnvelope(model.template, finger)
  const lower = [abLow, LIMITS.long.mcp[0], LIMITS.long.pip[0], LIMITS.long.dip[0]]
  const upper = [abHigh, LIMITS.long.mcp[1], LIMITS.long.pip[1], LIMITS.long.dip[1]]
  const residualCount = 9 + 4
  const residuals = (p: Float64Array, out: Float64Array) => {
    const points = longFingerCanonical(model, finger, { abduction: p[0], mcp: p[1], pip: p[2], dip: p[3] })
    for (let k = 0; k < 3; k += 1) {
      const point = points[k + 1]
      const target = targets[k]
      out[k * 3] = (point.x - target.x) * w[k] / sigma2d
      out[k * 3 + 1] = (point.y - target.y) * w[k] / sigma2d
      out[k * 3 + 2] = (point.z - target.z) * w[k] / sigmaZ
    }
    // Priors: DIP-PIP coupling, discourage MCP hyperextension, abduction
    // range that narrows with flexion, DIP coupling envelope.
    out[9] = (p[3] - DIP_COUPLING * p[2]) / (22 * DEG)
    out[10] = p[1] < 0 ? p[1] / (18 * DEG) : 0
    const [bLow, bHigh] = abductionBounds(model.template, finger, p[1])
    out[11] = p[0] < bLow ? (p[0] - bLow) / (3 * DEG) : p[0] > bHigh ? (p[0] - bHigh) / (3 * DEG) : 0
    const [dLow, dHigh] = dipCouplingBounds(p[2])
    out[12] = p[3] < dLow ? (p[3] - dLow) / (3 * DEG) : p[3] > dHigh ? (p[3] - dHigh) / (3 * DEG) : 0
  }
  const direct = clampLongFinger(model.template, finger, directLongFinger(model, finger, local))
  const inits: LongFingerParams[] = fast && previous
    ? [clampLongFinger(model.template, finger, previous), direct]
    : [
        direct,
        clampLongFinger(model.template, finger, { ...direct, mcp: -direct.mcp * 0.5 }),
        clampLongFinger(model.template, finger, { abduction: direct.abduction, mcp: 30 * DEG, pip: 40 * DEG, dip: 28 * DEG }),
        clampLongFinger(model.template, finger, { abduction: direct.abduction, mcp: 70 * DEG, pip: 95 * DEG, dip: 60 * DEG })
      ]
  if (previous && !fast) inits.unshift(clampLongFinger(model.template, finger, previous))
  let best: { params: Float64Array; cost: number } | null = null
  for (const init of inits) {
    const result = solveBoundedLm(residuals, residualCount, [init.abduction, init.mcp, init.pip, init.dip], lower, upper, { maxIterations: 30 })
    if (!best || result.cost < best.cost - 1e-9) best = result
  }
  const solved = clampLongFinger(model.template, finger, { abduction: best!.params[0], mcp: best!.params[1], pip: best!.params[2], dip: best!.params[3] })
  const points = longFingerCanonical(model, finger, solved)
  let sum = 0
  for (let k = 0; k < 3; k += 1) sum += (points[k + 1].x - targets[k].x) ** 2 + (points[k + 1].y - targets[k].y) ** 2
  return { params: solved, error: Math.sqrt(sum / 3), cost: best!.cost }
}

export function coupledAxial(model: HandModelContext, elevationValue: number) {
  return clamp(model.thumb.axialCoupling * Math.max(0, elevationValue - model.thumb.restElevation), LIMITS.thumb.axial[0], LIMITS.thumb.axial[1])
}

export function clampThumb(p: ThumbParams): ThumbParams {
  return {
    azimuth: clamp(p.azimuth, LIMITS.thumb.azimuth[0], LIMITS.thumb.azimuth[1]),
    elevation: clamp(p.elevation, LIMITS.thumb.elevation[0], LIMITS.thumb.elevation[1]),
    axial: clamp(p.axial, LIMITS.thumb.axial[0], LIMITS.thumb.axial[1]),
    mcp: clamp(p.mcp, LIMITS.thumb.mcp[0], LIMITS.thumb.mcp[1]),
    ip: clamp(p.ip, LIMITS.thumb.ip[0], LIMITS.thumb.ip[1])
  }
}

export function directThumb(model: HandModelContext, local: Vector3[]): ThumbParams {
  const idx = HAND.thumb
  const dm = local[idx[1]].clone().sub(local[idx[0]]).normalize()
  const dp = local[idx[2]].clone().sub(local[idx[1]]).normalize()
  const dd = local[idx[3]].clone().sub(local[idx[2]]).normalize()
  const frame = canonicalFrame(model.handSign)
  const az = azimuth(dm, frame)
  const el = elevation(dm, frame)
  const axial = coupledAxial(model, el)
  const { hinge } = thumbFrame(model, { azimuth: az, elevation: el, axial })
  return { azimuth: az, elevation: el, axial, mcp: signedAngleAbout(dm, dp, hinge), ip: signedAngleAbout(dp, dd, hinge) }
}

function fitThumb(model: HandModelContext, local: Vector3[], weights: number[], sigma2d: number, sigmaZ: number, previous?: ThumbParams, fast = false) {
  const idx = HAND.thumb
  const targets = [local[idx[1]], local[idx[2]], local[idx[3]]]
  const w = [weights[idx[1]], weights[idx[2]], weights[idx[3]]]
  const t = LIMITS.thumb
  const lower = [t.azimuth[0], t.elevation[0], t.axial[0], t.mcp[0], t.ip[0]]
  const upper = [t.azimuth[1], t.elevation[1], t.axial[1], t.mcp[1], t.ip[1]]
  const residualCount = 9 + 2
  const residuals = (p: Float64Array, out: Float64Array) => {
    const points = thumbCanonical(model, { azimuth: p[0], elevation: p[1], axial: p[2], mcp: p[3], ip: p[4] })
    for (let k = 0; k < 3; k += 1) {
      const point = points[k + 1]
      const target = targets[k]
      out[k * 3] = (point.x - target.x) * w[k] / sigma2d
      out[k * 3 + 1] = (point.y - target.y) * w[k] / sigma2d
      out[k * 3 + 2] = (point.z - target.z) * w[k] / sigmaZ
    }
    // Opposition coupling prior (axial pronation follows palmar lift) and a
    // mild preference against IP hyperextension.
    out[9] = (p[2] - coupledAxial(model, p[1])) / (14 * DEG)
    out[10] = p[4] < 0 ? p[4] / (20 * DEG) : 0
  }
  const direct = clampThumb(directThumb(model, local))
  const inits: ThumbParams[] = fast && previous
    ? [clampThumb(previous), direct]
    : [
        direct,
        clampThumb({ ...direct, mcp: 20 * DEG, ip: 25 * DEG }),
        clampThumb({ ...direct, elevation: direct.elevation + 20 * DEG, axial: coupledAxial(model, direct.elevation + 20 * DEG) })
      ]
  if (previous && !fast) inits.unshift(clampThumb(previous))
  let best: { params: Float64Array; cost: number } | null = null
  for (const init of inits) {
    const result = solveBoundedLm(residuals, residualCount, [init.azimuth, init.elevation, init.axial, init.mcp, init.ip], lower, upper, { maxIterations: 30 })
    if (!best || result.cost < best.cost - 1e-9) best = result
  }
  const p = best!.params
  const solved = clampThumb({ azimuth: p[0], elevation: p[1], axial: p[2], mcp: p[3], ip: p[4] })
  const points = thumbCanonical(model, solved)
  let sum = 0
  for (let k = 0; k < 3; k += 1) sum += (points[k + 1].x - targets[k].x) ** 2 + (points[k + 1].y - targets[k].y) ** 2
  return { params: solved, error: Math.sqrt(sum / 3), cost: best!.cost }
}

/** A relaxed, slightly curled hand used as the long-occlusion fallback. */
export function relaxedHandParams(model: HandModelContext): HandParams {
  const n = model.template.neutralAbduction
  const finger = (abduction: number): LongFingerParams => ({ abduction, mcp: 25 * DEG, pip: 30 * DEG, dip: 20 * DEG })
  return {
    thumb: { azimuth: model.thumb.restAzimuth, elevation: model.thumb.restElevation, axial: 0, mcp: 12 * DEG, ip: 12 * DEG },
    index: finger(n.index),
    middle: finger(n.middle),
    ring: finger(n.ring),
    pinky: finger(n.pinky)
  }
}

/** Template from the rig's own proportions (fallback when uncalibrated). */
export function templateFromRig(rigHand: HandGeometry, zScale = 2): HandTemplate {
  const inv = rigHand.palm.basis.clone().invert()
  const origin = rigHand.palm.origin
  const len = rigHand.palmLength
  const toV3 = (p: Vector3): V3 => {
    const c = p.clone().sub(origin).applyQuaternion(inv).divideScalar(len)
    return [rigHand.side === 'left' ? -c.x : c.x, c.y, c.z]
  }
  const pos = rigHand.restPositions
  const lengths = {} as Record<FingerName, V3>
  for (const digit of DIGITS) {
    const l = digit === 'thumb' ? rigHand.thumb.lengths : rigHand.fingers[digit].lengths
    lengths[digit] = [l[0] / len, l[1] / len, l[2] / len]
  }
  return {
    version: 1,
    palm: {
      thumbCmc: toV3(pos.thumbCmc),
      indexMcp: toV3(pos.indexMcp),
      middleMcp: toV3(pos.middleMcp),
      ringMcp: toV3(pos.ringMcp),
      pinkyMcp: toV3(pos.pinkyMcp)
    },
    lengths,
    neutralAbduction: {
      index: rigHand.fingers.index.mcp.restAbduction,
      middle: rigHand.fingers.middle.mcp.restAbduction,
      ring: rigHand.fingers.ring.mcp.restAbduction,
      pinky: rigHand.fingers.pinky.mcp.restAbduction
    },
    zScale,
    source: `rig:${rigHand.side}`
  }
}

/** Rotation by 180 deg about the canonical forward (finger) axis: the palm/back alternative. */
export const PALM_FLIP = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI)

/**
 * Fit both interpretations of the palm/back ambiguity. Returns the default
 * fit and, when the flipped initialisation converges to a genuinely
 * different pose (> 90 deg apart), the alternative with its cost.
 */
export function fitHandHypotheses(model: HandModelContext, observed: Vector3[], weights: number[], options: FitOptions = {}) {
  const primary = fitHand(model, observed, weights, options)
  if (!primary) return []
  const alternative = fitHand(model, observed, weights, { ...options, initialRotation: primary.palm.rotation.clone().multiply(PALM_FLIP) })
  const out = [primary]
  if (alternative) {
    const angle = 2 * Math.acos(Math.min(1, Math.abs(primary.palm.rotation.dot(alternative.palm.rotation))))
    if (angle > Math.PI / 2) out.push(alternative)
  }
  return out
}
