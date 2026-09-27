import { Quaternion, Vector3 } from 'three'
import { clamp, DEG, quaternionAngle, signedAngleAbout, smoothstep, swingTwist } from '../math'
import type { Rig } from '../rig/Rig'
import { buildRigGeometry, basisQuaternion, type RigGeometry } from '../rig/rigGeometry'
import { claudiaProfile, LONG_FINGERS, SIDES, validateSemanticSkeleton, type SemanticSkeleton, type Side } from '../rig/semanticMap'
import { separateAdjacentFingers } from '../source/handParams'
import { LIMITS, type HandParams, type LongFinger } from '../source/handModel'
import { PoseState } from './PoseState'
import type { ArmDiagnostics, SolvedPose, SourcePose } from './types'

export interface SolveOptions {
  /** Elbow swivel per arm (rad), from the offline swivel optimisation. */
  swivel?: Partial<Record<Side, number>>
  /** Previous frame's unwrapped forearm twist per arm (rad), for continuity. */
  previousTwist?: Partial<Record<Side, number>>
  /** Force the applied forearm twist (rad), e.g. to smooth a limit-side change offline. */
  twistOverride?: Partial<Record<Side, number>>
}

export interface SolverConfig {
  torso: { yawGain: number; rollGain: number; maxYaw: number; maxRoll: number; distribution: [number, number, number] }
  head: { neckShare: number; maxAngle: number }
  shrug: { gain: number; maxUp: number; maxDown: number }
  arm: { minFlexion: number; maxFlexion: number; reach: number; nearReach: number; depthGain: number; faceNear: number; faceFar: number; faceDepthGain: number }
  wrist: { flexion: number; extension: number; radial: number; ulnar: number; twist: number; forearmTwistShare: number; upperTwistCounter: number }
  fingers: { overlap: number }
  face: { jawMax: number; blinkMax: number; browUp: number; browDown: number; cornerUp: number; cornerOut: number }
  collision: { enabled: boolean; margin: number }
}

export const DEFAULT_SOLVER_CONFIG: SolverConfig = {
  torso: { yawGain: 0.75, rollGain: 0.75, maxYaw: 28 * DEG, maxRoll: 14 * DEG, distribution: [0.25, 0.35, 0.4] },
  head: { neckShare: 0.35, maxAngle: 65 * DEG },
  shrug: { gain: 1.1, maxUp: 10 * DEG, maxDown: 4 * DEG },
  arm: { minFlexion: 3 * DEG, maxFlexion: 148 * DEG, reach: 0.995, nearReach: 1.2, depthGain: 1, faceNear: 3.2, faceFar: 6, faceDepthGain: 0.4 },
  wrist: { flexion: 80 * DEG, extension: 70 * DEG, radial: 28 * DEG, ulnar: 40 * DEG, twist: 100 * DEG, forearmTwistShare: 0.7, upperTwistCounter: 0.5 },
  fingers: { overlap: 8 * DEG },
  face: { jawMax: 14 * DEG, blinkMax: 30 * DEG, browUp: 0.004, browDown: 0.0025, cornerUp: 0.0025, cornerOut: 0.002 },
  collision: { enabled: true, margin: 0.03 }
}

interface ArmRuntime {
  side: Side
  handSign: 1 | -1
  /** Rest palm basis (model space) and the rotation aligning source->rig palm conventions. */
  restPalmBasis: Quaternion
  /** Wrist flexion / radial-deviation axes and forearm axis in forearm-local space. */
  flexAxisForearm: Vector3
  devAxisForearm: Vector3
  twistAxisForearm: Vector3
  /** Default elbow pole direction (model space) when the hint is weak. */
  defaultPole: Vector3
}

/**
 * Rig-specific retargeting of cleaned source motion onto the supplied GLB.
 * All rotations are written in LOCAL space, parents before children, against
 * the parent's desired transform. Joint behaviour:
 *   - spine: restrained yaw/roll distributed over three vertebrae
 *   - arm: analytic two-bone IK; elbow is a pure hinge about the rig's own
 *     elbow axis (no hyperextension, flexion limited to 148 deg); the upper
 *     arm roll is fully determined by the elbow plane (no shoulder twist)
 *   - wrist: swing limited per axis; pronation/supination moved into the
 *     forearm and distributed onto the twist bone (no candy-wrapper wrist)
 *   - fingers: MCP flexion + bounded abduction; PIP/DIP/IP pure hinges
 *   - face: jaw, eyelids, brows, mouth corners, restrained
 */
export class AvatarSolver {
  readonly rig: Rig
  readonly map: SemanticSkeleton
  readonly geometry: RigGeometry
  readonly config: SolverConfig
  readonly controlled: string[]
  readonly translated: string[]
  private readonly pose: PoseState
  private readonly arms: Record<Side, ArmRuntime>
  private readonly sourceNeutral: Record<Side, Record<LongFinger, number>>
  private readonly palmConventionTwist: Record<Side, Quaternion>
  private readonly faceAxes: { jaw?: Vector3; eyelid: Partial<Record<Side, Vector3>>; up?: Vector3; left?: Vector3 }
  /** Avatar eye joints used as the face anchor, and their rest separation (m). */
  private readonly faceAnchorInfo: { left: string; right: string; ipd: number } | null
  /** Character forward direction (model space). */
  private readonly facing: Vector3

  constructor(rig: Rig, sourceNeutralAbduction: Record<Side, Record<LongFinger, number>>, config: SolverConfig = DEFAULT_SOLVER_CONFIG, map: SemanticSkeleton = claudiaProfile()) {
    const validation = validateSemanticSkeleton(rig, map)
    if (!validation.ok) throw new Error(`Rig does not match the semantic profile: ${validation.issues.filter((i) => i.level === 'error').map((i) => i.message).join('; ')}`)
    this.rig = rig
    this.map = map
    this.config = config
    this.geometry = buildRigGeometry(rig, map, validation.facing, validation.characterLeft)
    this.facing = validation.facing.clone().normalize()
    this.pose = new PoseState(rig)
    this.sourceNeutral = sourceNeutralAbduction

    const controlled = new Set<string>([...map.spine, map.neck, map.head])
    for (const side of SIDES) {
      const arm = map.arms[side]
      ;[arm.clavicle, arm.upperArm, arm.forearm, arm.hand].forEach((name) => controlled.add(name))
      if (this.geometry.arms[side].upperArmTwist) controlled.add(this.geometry.arms[side].upperArmTwist!)
      if (this.geometry.arms[side].forearmTwist) controlled.add(this.geometry.arms[side].forearmTwist!)
      for (const chain of Object.values(arm.digits)) chain.slice(0, 3).forEach((name) => controlled.add(name))
    }
    if (map.jaw && rig.has(map.jaw)) controlled.add(map.jaw)
    for (const side of SIDES) if (map.eyelids && rig.has(map.eyelids[side])) controlled.add(map.eyelids[side])
    this.controlled = [...controlled].sort((a, b) => rig.get(a).index - rig.get(b).index)
    const translated: string[] = []
    for (const side of SIDES) {
      if (map.eyebrows && rig.has(map.eyebrows[side])) translated.push(map.eyebrows[side])
      if (map.mouthCorners && rig.has(map.mouthCorners[side])) translated.push(map.mouthCorners[side])
    }
    this.translated = translated

    const arms = {} as Record<Side, ArmRuntime>
    const palmConventionTwist = {} as Record<Side, Quaternion>
    for (const side of SIDES) {
      const hand = this.geometry.hands[side]
      const armGeo = this.geometry.arms[side]
      const forearmRestInv = rig.get(armGeo.forearm).restWorldQuaternion.clone().invert()
      const flexWorld = new Vector3().crossVectors(hand.palm.forward, hand.palm.volar).normalize()
      const devWorld = hand.palm.volar.clone().multiplyScalar(-hand.handSign)
      const lateral = validation.characterLeft.clone().multiplyScalar(side === 'left' ? 1 : -1)
      // Wrist flexion / deviation axes, made exactly orthogonal to the forearm
      // axis so swing and pronation twist never leak into each other.
      const twistAxis = armGeo.forearmAxisLocal.clone().normalize()
      const flexLocal = flexWorld.applyQuaternion(forearmRestInv)
      flexLocal.addScaledVector(twistAxis, -flexLocal.dot(twistAxis)).normalize()
      const devLocal = new Vector3().crossVectors(twistAxis, flexLocal).normalize()
      if (devLocal.dot(devWorld.clone().applyQuaternion(forearmRestInv)) < 0) devLocal.negate()
      arms[side] = {
        side,
        handSign: hand.handSign,
        restPalmBasis: hand.palm.basis.clone(),
        flexAxisForearm: flexLocal,
        devAxisForearm: devLocal,
        twistAxisForearm: twistAxis,
        defaultPole: new Vector3(0, -1, 0).addScaledVector(lateral, 0.35).addScaledVector(validation.facing, -0.25).normalize()
      }
      // Align the source's functional hand axis (mean relaxed finger azimuth)
      // with the rig's, about the palm normal (see rigGeometry header).
      const rigMean = LONG_FINGERS.reduce((sum, f) => sum + hand.fingers[f].mcp.restAbduction, 0) / 4
      const srcMean = LONG_FINGERS.reduce((sum, f) => sum + sourceNeutralAbduction[side][f], 0) / 4
      palmConventionTwist[side] = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), hand.handSign * (rigMean - srcMean))
    }
    this.arms = arms
    this.palmConventionTwist = palmConventionTwist

    const headInv = rig.get(map.head).restWorldQuaternion.clone().invert()
    const eyelid: Partial<Record<Side, Vector3>> = {}
    for (const side of SIDES) {
      if (map.eyelids && rig.has(map.eyelids[side])) {
        eyelid[side] = validation.characterLeft.clone().applyQuaternion(rig.get(map.eyelids[side]).restWorldQuaternion.clone().invert()).normalize()
      }
    }
    this.faceAnchorInfo = map.eyes && rig.has(map.eyes.left) && rig.has(map.eyes.right)
      ? { left: map.eyes.left, right: map.eyes.right, ipd: rig.get(map.eyes.left).restWorldPosition.distanceTo(rig.get(map.eyes.right).restWorldPosition) }
      : null
    this.faceAxes = {
      jaw: map.jaw && rig.has(map.jaw) ? validation.characterLeft.clone().applyQuaternion(rig.get(map.jaw).restWorldQuaternion.clone().invert()).normalize() : undefined,
      eyelid,
      up: new Vector3(0, 1, 0).applyQuaternion(headInv).normalize(),
      left: validation.characterLeft.clone().applyQuaternion(headInv).normalize()
    }
  }

  /**
   * Solve one frame. Missing streams leave their joints at rest.
   * `options.swivel` fixes the elbow swivel angle per arm (from the offline
   * swivel optimisation); otherwise it is derived from the elbow hint.
   */
  solve(source: SourcePose, options: SolveOptions = {}): SolvedPose {
    const pose = this.pose
    const diagnostics = {
      arms: {} as Record<Side, ArmDiagnostics>,
      fingerCrossingCorrections: 0,
      headAngle: this.solveTrunk(source)
    }

    // 4. Fingers first (local, arm-independent; the hand centre used for
    //    placement depends on them), then arms and wrists.
    for (const side of SIDES) {
      const hand = source.hands[side]
      if (hand) diagnostics.fingerCrossingCorrections += this.solveFingers(side, hand.params)
    }
    for (const side of SIDES) diagnostics.arms[side] = this.solveArm(side, source, options.swivel?.[side], options.previousTwist?.[side], options.twistOverride?.[side])

    // 5. Face.
    const translations = new Map<string, Vector3>()
    if (source.face) this.solveFace(source.face, translations)

    const rotations = new Map<string, Quaternion>()
    for (const name of this.controlled) rotations.set(name, pose.getLocal(name))
    for (const name of this.translated) if (!translations.has(name)) translations.set(name, this.rig.get(name).restLocalPosition.clone())
    return { rotations, translations, diagnostics }
  }

  /**
   * Cost of each candidate elbow swivel angle per arm: wrist-limit violation
   * (the palm orientation measured from the hand is trusted more than the
   * pose model's out-of-frame elbow), wrist comfort, agreement with the
   * elbow hint (weighted by its confidence), and a weak natural-pose prior.
   */
  swivelCosts(source: SourcePose, candidates: readonly number[], previousTwist: Partial<Record<Side, number>> = {}): Record<Side, Float64Array> {
    this.solveTrunk(source)
    for (const side of SIDES) {
      const hand = source.hands[side]
      if (hand) this.solveFingers(side, hand.params)
    }
    const out = {} as Record<Side, Float64Array>
    for (const side of SIDES) {
      const costs = new Float64Array(candidates.length)
      candidates.forEach((swivel, i) => {
        costs[i] = this.swivelCost(this.solveArm(side, source, swivel, previousTwist[side]))
      })
      out[side] = costs
    }
    return out
  }

  swivelCost(d: ArmDiagnostics) {
    const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a))
    const hintTerm = Number.isFinite(d.hintSwivel) ? d.poleConfidence * (wrap(d.swivel - d.hintSwivel) / (30 * DEG)) ** 2 : 0
    // Elbows above shoulder height are rare in signing and read as "chicken
    // wings"; penalise them unless nothing else works.
    const elbowHigh = Math.max(0, d.elbowHeight + 0.04) / 0.05
    return (d.wristViolation / (12 * DEG)) ** 2 + 0.1 * (d.wristSwing / (60 * DEG)) ** 2 + hintTerm +
      (wrap(d.swivel - d.defaultSwivel) / (70 * DEG)) ** 2 + elbowHigh ** 2
  }

  /** Torso, clavicles, neck and head (everything the arms hang from). Returns head angle. */
  private solveTrunk(source: SourcePose) {
    const pose = this.pose
    pose.reset()
    const g = this.geometry
    const c = this.config
    let headAngle = 0

    // 1. Torso: restrained yaw/roll distributed along the spine.
    let torsoWorld = new Quaternion()
    if (source.body) {
      const yaw = clamp(source.body.torsoYaw * c.torso.yawGain, -c.torso.maxYaw, c.torso.maxYaw)
      const roll = clamp(source.body.torsoRoll * c.torso.rollGain, -c.torso.maxRoll, c.torso.maxRoll)
      const total = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), yaw).multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), roll))
      let cumulative = 0
      g.torso.spine.forEach((name, i) => {
        cumulative += c.torso.distribution[i]
        const partial = new Quaternion().slerp(total, cumulative)
        pose.setWorld(name, partial.multiply(this.rig.get(name).restWorldQuaternion))
      })
      torsoWorld = total
    }

    // 2. Clavicle elevation from shoulder lift (shrug).
    if (source.body) {
      for (const side of SIDES) {
        const arm = g.arms[side]
        const lift = clamp(source.body.shrug[side] * c.shrug.gain, -c.shrug.maxDown, c.shrug.maxUp)
        const axisWorld = new Vector3(0, 0, side === 'left' ? 1 : -1)
        const current = pose.worldQuaternion(arm.clavicle)
        pose.setWorld(arm.clavicle, new Quaternion().setFromAxisAngle(axisWorld, lift).multiply(current))
      }
    }

    // 3. Neck and head.
    if (source.face) {
      let rotation = source.face.rotation.clone()
      const angle = quaternionAngle(rotation)
      if (angle > c.head.maxAngle) rotation = new Quaternion().slerp(rotation, c.head.maxAngle / angle)
      headAngle = Math.min(angle, c.head.maxAngle)
      const relative = rotation.clone().multiply(torsoWorld.clone().invert())
      const neckRest = this.rig.get(g.torso.neck).restWorldQuaternion
      const headRest = this.rig.get(g.torso.head).restWorldQuaternion
      pose.setWorld(g.torso.neck, new Quaternion().slerp(relative, c.head.neckShare).multiply(torsoWorld).multiply(neckRest))
      pose.setWorld(g.torso.head, rotation.clone().multiply(headRest))
    }
    return headAngle
  }

  private solveArm(side: Side, source: SourcePose, swivel?: number, previousTwist?: number, twistOverride?: number): ArmDiagnostics {
    const pose = this.pose
    const g = this.geometry
    const c = this.config
    const armGeo = g.arms[side]
    const runtime = this.arms[side]
    const result: ArmDiagnostics = {
      targetDistance: 0, faceWeight: 0, reachClamped: false, elbowFlexion: armGeo.restElbowFlexion, ikErrorM: 0,
      collisionPushM: 0, depthCompletedM: 0, wristTwist: 0, wristTwistClamped: false, wristSwingClamped: false, poleConfidence: 0,
      swivel: 0, hintSwivel: NaN, defaultSwivel: 0, wristViolation: 0, wristSwing: 0, elbowHeight: 0, wristTwistRaw: 0
    }
    const body = source.body
    if (!body) return result

    const leftShoulder = pose.worldPosition(g.arms.left.upperArm)
    const rightShoulder = pose.worldPosition(g.arms.right.upperArm)
    const mid = leftShoulder.clone().add(rightShoulder).multiplyScalar(0.5)
    const unit = g.torso.shoulderWidth
    const offset = body.wrist[side].clone()
    offset.z *= c.arm.depthGain
    let target = mid.clone().addScaledVector(offset, unit)

    // Place the HAND where the viewer sees it: map the source hand centre
    // (mean of its 21 landmarks) and derive the wrist target through the
    // measured hand orientation and the avatar's own hand geometry. Near the
    // face the centre is mapped face-relative (signer and avatar neck/head
    // proportions differ; contact location is linguistic).
    const hand = source.hands[side]
    const centerWeight = clamp((body.handCenterWeight?.[side] ?? 0) * (hand?.palmWeight ?? 0), 0, 1)
    if (hand && centerWeight > 0 && body.handCenter) {
      const center = body.handCenter[side].clone()
      center.z = body.wrist[side].z * c.arm.depthGain + (center.z - body.wrist[side].z)
      const centerTarget = mid.clone().addScaledVector(center, unit)
      if (body.faceAnchor && body.faceScale && body.faceScale > 1e-3 && this.faceAnchorInfo) {
        // Face-relative correction of the image-plane (x, y) placement only.
        // Depth keeps the shoulder-relative world-landmark estimate: hand
        // depth relative to the face is the least reliable monocular quantity,
        // and the head collision proxy prevents interpenetration.
        const dx = body.handCenter[side].x - body.faceAnchor.x
        const dy = body.handCenter[side].y - body.faceAnchor.y
        const weight = 1 - smoothstep(c.arm.faceNear, c.arm.faceFar, Math.hypot(dx, dy) / body.faceScale)
        if (weight > 0) {
          const anchor = pose.worldPosition(this.faceAnchorInfo.left).add(pose.worldPosition(this.faceAnchorInfo.right)).multiplyScalar(0.5)
          const scale = this.faceAnchorInfo.ipd / body.faceScale
          centerTarget.x += (anchor.x + dx * scale - centerTarget.x) * weight
          centerTarget.y += (anchor.y + dy * scale - centerTarget.y) * weight
        }
        result.faceWeight = weight
      }
      const handWorld = this.measuredHandWorld(side, hand)
      const wristFromCenter = centerTarget.sub(this.handCentroidLocal(side).applyQuaternion(handWorld))
      target = target.lerp(wristFromCenter, centerWeight)
    }
    if (c.collision.enabled) {
      const pushed = this.pushOutOfBody(target)
      result.collisionPushM = pushed.distanceTo(target)
      target = pushed
    }

    const shoulder = pose.worldPosition(armGeo.upperArm)
    const l1 = armGeo.upperLength
    const l2 = armGeo.forearmLength
    // Depth completion: a target closer to the shoulder than the folded arm
    // can reach (monocular depth collapsing toward the shoulder plane) makes
    // the IK direction degenerate. Keep the image-plane position the viewer
    // sees and move the target forward in depth instead.
    {
      const nearest = Math.sqrt(l1 * l1 + l2 * l2 + 2 * l1 * l2 * Math.cos(c.arm.maxFlexion)) * c.arm.nearReach
      const v = target.clone().sub(shoulder)
      const lengthSq = v.lengthSq()
      if (lengthSq < nearest * nearest) {
        const forward = this.facing
        const b = v.dot(forward)
        const push = -b + Math.sqrt(Math.max(0, b * b - (lengthSq - nearest * nearest)))
        target.addScaledVector(forward, push)
        result.depthCompletedM = push
      }
    }
    const toTarget = target.clone().sub(shoulder)
    let distance = toTarget.length()
    result.targetDistance = distance
    const maxDistance = Math.sqrt(l1 * l1 + l2 * l2 + 2 * l1 * l2 * Math.cos(c.arm.minFlexion)) * c.arm.reach
    const minDistance = Math.sqrt(l1 * l1 + l2 * l2 + 2 * l1 * l2 * Math.cos(c.arm.maxFlexion))
    if (distance > maxDistance || distance < minDistance) result.reachClamped = true
    distance = clamp(distance, minDistance, maxDistance)
    const direction = toTarget.lengthSq() > 1e-10 ? toTarget.clone().normalize() : new Vector3(0, -1, 0)

    // Elbow pole from the tracker's (smoothed) elbow hint, blended with a
    // natural default when the hint is weak or degenerate.
    const perpendicular = (v: Vector3) => {
      const p = v.clone().addScaledVector(direction, -v.dot(direction))
      return p.lengthSq() > 1e-8 ? p.normalize() : null
    }
    const hintWorld = mid.clone().addScaledVector(body.elbow[side], unit).sub(shoulder)
    const hint = perpendicular(hintWorld)
    const fallback = perpendicular(runtime.defaultPole) ?? perpendicular(new Vector3(0, 0, -1))!
    const confidence = hint ? clamp((body.elbowConfidence[side] - 0.2) / 0.6, 0, 1) * 0.85 : 0
    result.poleConfidence = confidence
    const reference = swivelReference(direction)
    const angleOf = (v: Vector3) => signedAngleAbout(reference, v, direction)
    let poleUnit: Vector3
    if (swivel !== undefined && Number.isFinite(swivel)) {
      poleUnit = reference.clone().applyAxisAngle(direction, swivel)
    } else {
      const pole = hint ? fallback.clone().multiplyScalar(1 - confidence).addScaledVector(hint, confidence) : fallback.clone()
      poleUnit = perpendicular(pole) ?? fallback
    }
    result.swivel = angleOf(poleUnit)
    result.hintSwivel = hint ? angleOf(hint) : NaN
    result.defaultSwivel = angleOf(fallback)

    const cosShoulder = clamp((l1 * l1 + distance * distance - l2 * l2) / (2 * l1 * distance), -1, 1)
    const shoulderAngle = Math.acos(cosShoulder)
    const elbow = shoulder.clone()
      .addScaledVector(direction, l1 * Math.cos(shoulderAngle))
      .addScaledVector(poleUnit, l1 * Math.sin(shoulderAngle))
    const cosInterior = clamp((l1 * l1 + l2 * l2 - distance * distance) / (2 * l1 * l2), -1, 1)
    const flexion = Math.PI - Math.acos(cosInterior)
    result.elbowFlexion = flexion
    result.elbowHeight = elbow.y - shoulder.y

    // Upper arm: align (bone axis, elbow hinge axis) frames. Fully determines
    // roll, so the shoulder can never corkscrew.
    const upperRestUnderParent = pose.worldQuaternion(this.rig.joints[this.rig.get(armGeo.upperArm).parent].name).multiply(this.rig.get(armGeo.upperArm).restLocalQuaternion)
    const a0 = armGeo.upperAxisLocal.clone().applyQuaternion(upperRestUnderParent)
    const h0 = armGeo.elbowAxisUpper.clone().applyQuaternion(upperRestUnderParent)
    const a1 = elbow.clone().sub(shoulder).normalize()
    let h1 = new Vector3().crossVectors(poleUnit, direction)
    h1.addScaledVector(a1, -h1.dot(a1))
    if (h1.lengthSq() < 1e-10) h1 = h0.clone().addScaledVector(a1, -h0.dot(a1))
    h1.normalize()
    const frame0 = basisQuaternion(a0, h0, new Vector3().crossVectors(a0, h0).normalize())
    const frame1 = basisQuaternion(a1, h1, new Vector3().crossVectors(a1, h1).normalize())
    const align = frame1.multiply(frame0.invert())
    pose.setWorld(armGeo.upperArm, align.multiply(upperRestUnderParent))

    // Elbow: pure hinge about the rig's own elbow axis.
    const forearmLocal = new Quaternion().setFromAxisAngle(armGeo.elbowAxisUpper, flexion - armGeo.restElbowFlexion)
      .multiply(this.rig.get(armGeo.forearm).restLocalQuaternion)
    pose.setLocal(armGeo.forearm, forearmLocal)
    result.ikErrorM = pose.worldPosition(armGeo.hand).distanceTo(shoulder.clone().addScaledVector(direction, distance))

    // Upper-arm twist bone counter-rotates part of the humeral roll so the
    // deltoid region does not twist with the arm.
    if (armGeo.upperArmTwist && armGeo.upperAxisInTwist) {
      const delta = this.rig.get(armGeo.upperArm).restLocalQuaternion.clone().invert().multiply(pose.getLocal(armGeo.upperArm))
      const { twistAngle } = swingTwist(delta, armGeo.upperAxisLocal)
      pose.setLocal(armGeo.upperArmTwist, this.rig.get(armGeo.upperArmTwist).restLocalQuaternion.clone()
        .multiply(new Quaternion().setFromAxisAngle(armGeo.upperAxisInTwist, -c.wrist.upperTwistCounter * twistAngle)))
    }

    // Wrist: measured palm orientation (blended to neutral by palmWeight),
    // swing limited per anatomical axis, twist moved to the forearm.
    const forearmWorld = pose.worldQuaternion(armGeo.forearm)
    const handRestLocal = this.rig.get(armGeo.hand).restLocalQuaternion
    const neutralWorld = forearmWorld.clone().multiply(handRestLocal)
    let handWorld = neutralWorld.clone()
    if (hand && hand.palmWeight > 0) {
      const measured = this.measuredHandWorld(side, hand)
      if (measured.dot(neutralWorld) < 0) measured.set(-measured.x, -measured.y, -measured.z, -measured.w)
      handWorld = neutralWorld.clone().slerp(measured, clamp(hand.palmWeight, 0, 1))
    }
    const localDesired = forearmWorld.clone().invert().multiply(handWorld)
    const delta = localDesired.multiply(handRestLocal.clone().invert())
    const decomposition = swingTwist(delta, runtime.twistAxisForearm)
    const swing = decomposition.swing
    // Required pronation near +-180 deg is anatomically impossible and its
    // sign is arbitrary; inside that zone keep the side chosen on the previous
    // frame so the clamped forearm never jumps between +limit and -limit.
    let twistAngle = decomposition.twistAngle
    if (previousTwist !== undefined && Number.isFinite(previousTwist) && Math.abs(twistAngle) > 150 * DEG && Math.sign(twistAngle) !== Math.sign(previousTwist)) {
      twistAngle += 2 * Math.PI * Math.sign(previousTwist)
    }
    result.wristTwistRaw = twistAngle
    const twist = twistOverride !== undefined && Number.isFinite(twistOverride)
      ? clamp(twistOverride, -c.wrist.twist, c.wrist.twist)
      : softClamp(twistAngle, -c.wrist.twist, c.wrist.twist, 0.85)
    result.wristTwist = twist
    result.wristTwistClamped = Math.abs(twistAngle) > c.wrist.twist
    // Swing rotation vector decomposed on the wrist's flexion / deviation
    // axes. Delta = swing * twist applies pronation first, so the wrist's
    // anatomical axes are the rest axes carried along by the twist.
    const twistQuat = new Quaternion().setFromAxisAngle(runtime.twistAxisForearm, twist)
    const flexAxis = runtime.flexAxisForearm.clone().applyQuaternion(twistQuat)
    const devAxis = runtime.devAxisForearm.clone().applyQuaternion(twistQuat)
    const swingAngle = quaternionAngle(swing)
    const swingAxis = new Vector3(swing.x, swing.y, swing.z)
    if (swing.w < 0) swingAxis.negate()
    const rotationVector = swingAxis.lengthSq() > 1e-12 ? swingAxis.normalize().multiplyScalar(swingAngle) : new Vector3()
    const flexComponent = rotationVector.dot(flexAxis)
    const devComponent = rotationVector.dot(devAxis)
    const flexLimited = softClamp(flexComponent, -c.wrist.extension, c.wrist.flexion)
    const devLimited = softClamp(devComponent, -c.wrist.ulnar, c.wrist.radial)
    result.wristSwingClamped = flexComponent > c.wrist.flexion || flexComponent < -c.wrist.extension || devComponent > c.wrist.radial || devComponent < -c.wrist.ulnar
    result.wristSwing = swingAngle
    result.wristViolation = Math.hypot(
      Math.max(0, flexComponent - c.wrist.flexion, -c.wrist.extension - flexComponent),
      Math.max(0, devComponent - c.wrist.radial, -c.wrist.ulnar - devComponent),
      Math.max(0, Math.abs(twistAngle) - c.wrist.twist)
    )
    const limitedVector = flexAxis.clone().multiplyScalar(flexLimited).addScaledVector(devAxis, devLimited)
    const limitedAngle = limitedVector.length()
    const limitedSwing = limitedAngle > 1e-9 ? new Quaternion().setFromAxisAngle(limitedVector.divideScalar(limitedAngle), limitedAngle) : new Quaternion()
    pose.setLocal(armGeo.hand, limitedSwing.multiply(twistQuat).multiply(handRestLocal))
    if (armGeo.forearmTwist && armGeo.forearmAxisInTwist) {
      pose.setLocal(armGeo.forearmTwist, this.rig.get(armGeo.forearmTwist).restLocalQuaternion.clone()
        .multiply(new Quaternion().setFromAxisAngle(armGeo.forearmAxisInTwist, c.wrist.forearmTwistShare * twist)))
    }
    return result
  }

  /** World orientation of the hand bone implied by the measured palm frame. */
  private measuredHandWorld(side: Side, hand: NonNullable<SourcePose['hands'][Side]>) {
    const armGeo = this.geometry.arms[side]
    return hand.rotation.clone().multiply(this.palmConventionTwist[side])
      .multiply(this.arms[side].restPalmBasis.clone().invert())
      .multiply(this.rig.get(armGeo.hand).restWorldQuaternion)
  }

  /** Mean of the 21 landmark-equivalent hand joints, in hand-bone local space (current finger pose). */
  private handCentroidLocal(side: Side) {
    const pose = this.pose
    const arm = this.map.arms[side]
    const handPosition = pose.worldPosition(arm.hand)
    const inverse = pose.worldQuaternion(arm.hand).invert()
    const sum = new Vector3()
    let count = 1
    for (const chain of Object.values(arm.digits)) {
      for (const name of chain) {
        sum.add(pose.worldPosition(name).sub(handPosition))
        count += 1
      }
    }
    return sum.divideScalar(count).applyQuaternion(inverse)
  }

  /** Map source anatomical angles to rig local rotations (fingers + thumb). */
  private solveFingers(side: Side, params: HandParams) {
    const pose = this.pose
    const hand = this.geometry.hands[side]
    const neutral = this.sourceNeutral[side]
    // Abduction transfers as deviation from each side's relaxed azimuth.
    const azimuths = {} as Record<LongFinger, number>
    const mcp = {} as Record<LongFinger, number>
    for (const finger of LONG_FINGERS) {
      const [low, high] = LIMITS.long.abductionRelative[finger]
      const deviation = clamp(params[finger].abduction - neutral[finger], low, high)
      azimuths[finger] = hand.fingers[finger].mcp.restAbduction + deviation
      mcp[finger] = params[finger].mcp
    }
    const corrections = separateAdjacentFingers(azimuths, mcp, this.config.fingers.overlap)
    for (const finger of LONG_FINGERS) {
      const geo = hand.fingers[finger]
      const p = params[finger]
      const mcpFlex = clamp(p.mcp, LIMITS.long.mcp[0], LIMITS.long.mcp[1])
      const pip = clamp(p.pip, LIMITS.long.pip[0], LIMITS.long.pip[1])
      const dip = clamp(p.dip, LIMITS.long.dip[0], LIMITS.long.dip[1])
      pose.setLocal(geo.mcp.bone, new Quaternion().setFromAxisAngle(geo.mcp.abductionAxisParent, azimuths[finger] - geo.mcp.restAbduction)
        .multiply(new Quaternion().setFromAxisAngle(geo.mcp.flexAxisParent, mcpFlex - geo.mcp.restFlexion))
        .multiply(this.rig.get(geo.mcp.bone).restLocalQuaternion))
      pose.setLocal(geo.pip.bone, new Quaternion().setFromAxisAngle(geo.pip.axisParent, pip - geo.pip.restAngle).multiply(this.rig.get(geo.pip.bone).restLocalQuaternion))
      pose.setLocal(geo.dip.bone, new Quaternion().setFromAxisAngle(geo.dip.axisParent, dip - geo.dip.restAngle).multiply(this.rig.get(geo.dip.bone).restLocalQuaternion))
    }
    const t = hand.thumb
    const tp = params.thumb
    const az = clamp(tp.azimuth, LIMITS.thumb.azimuth[0], LIMITS.thumb.azimuth[1])
    const el = clamp(tp.elevation, LIMITS.thumb.elevation[0], LIMITS.thumb.elevation[1])
    const axial = clamp(tp.axial, LIMITS.thumb.axial[0], LIMITS.thumb.axial[1])
    pose.setLocal(t.cmc.bone, new Quaternion().setFromAxisAngle(t.cmc.abductionAxisParent, az - t.cmc.restAbduction)
      .multiply(new Quaternion().setFromAxisAngle(t.cmc.flexAxisParent, el - t.cmc.restFlexion))
      .multiply(new Quaternion().setFromAxisAngle(t.cmc.axialAxisParent, axial))
      .multiply(this.rig.get(t.cmc.bone).restLocalQuaternion))
    pose.setLocal(t.mcp.bone, new Quaternion().setFromAxisAngle(t.mcp.axisParent, clamp(tp.mcp, LIMITS.thumb.mcp[0], LIMITS.thumb.mcp[1]) - t.mcp.restAngle).multiply(this.rig.get(t.mcp.bone).restLocalQuaternion))
    pose.setLocal(t.ip.bone, new Quaternion().setFromAxisAngle(t.ip.axisParent, clamp(tp.ip, LIMITS.thumb.ip[0], LIMITS.thumb.ip[1]) - t.ip.restAngle).multiply(this.rig.get(t.ip.bone).restLocalQuaternion))
    return corrections
  }

  private solveFace(face: NonNullable<SourcePose['face']>, translations: Map<string, Vector3>) {
    const pose = this.pose
    const c = this.config.face
    const map = this.map
    if (map.jaw && this.faceAxes.jaw && this.rig.has(map.jaw)) {
      pose.setLocal(map.jaw, this.rig.get(map.jaw).restLocalQuaternion.clone().multiply(new Quaternion().setFromAxisAngle(this.faceAxes.jaw, clamp(face.jawOpen, 0, 1) * c.jawMax)))
    }
    for (const side of SIDES) {
      const eyelid = map.eyelids?.[side]
      const axis = this.faceAxes.eyelid[side]
      if (eyelid && axis && this.rig.has(eyelid)) {
        const blink = side === 'left' ? face.blinkLeft : face.blinkRight
        pose.setLocal(eyelid, this.rig.get(eyelid).restLocalQuaternion.clone().multiply(new Quaternion().setFromAxisAngle(axis, clamp(blink, 0, 1) * c.blinkMax)))
      }
      const up = this.faceAxes.up!
      const left = this.faceAxes.left!
      const brow = map.eyebrows?.[side]
      if (brow && this.rig.has(brow)) {
        const value = side === 'left' ? face.browLeft : face.browRight
        const offset = value >= 0 ? value * c.browUp : value * c.browDown
        translations.set(brow, this.rig.get(brow).restLocalPosition.clone().addScaledVector(up, offset))
      }
      const corner = map.mouthCorners?.[side]
      if (corner && this.rig.has(corner)) {
        const outward = left.clone().multiplyScalar(side === 'left' ? 1 : -1)
        const smile = clamp(face.smile, -1, 1)
        const stretch = clamp(face.mouthStretch, -1, 1)
        translations.set(corner, this.rig.get(corner).restLocalPosition.clone()
          .addScaledVector(up, smile * c.cornerUp - clamp(face.jawOpen, 0, 1) * 0.0015)
          .addScaledVector(outward, Math.max(0, smile) * c.cornerOut * 0.5 + stretch * c.cornerOut))
      }
    }
  }

  /** Push a wrist target out of inflated chest/head ellipsoids (model space). */
  private pushOutOfBody(point: Vector3) {
    const torso = this.geometry.torso
    let result = point.clone()
    for (const proxy of [torso.chest, torso.head3]) {
      const radii = proxy.radii.clone().addScalar(this.config.collision.margin)
      const local = result.clone().sub(proxy.center)
      const scaled = new Vector3(local.x / radii.x, local.y / radii.y, local.z / radii.z)
      const r = scaled.length()
      if (r < 1 && r > 1e-6) {
        // Move along the scaled radial direction to the surface; bias forward
        // so hands end up in front of the body, never inside or behind it.
        scaled.divideScalar(r)
        if (scaled.z < 0.2) {
          scaled.z = 0.2
          scaled.normalize()
        }
        result = proxy.center.clone().add(new Vector3(scaled.x * radii.x, scaled.y * radii.y, scaled.z * radii.z))
      }
    }
    return result
  }
}

/**
 * Continuous reference direction orthogonal to the shoulder->wrist axis used
 * to measure elbow swivel: "down", blended toward "back" as the arm itself
 * points down (where "down" degenerates).
 */
export function swivelReference(direction: Vector3) {
  const down = new Vector3(0, -1, 0).addScaledVector(direction, direction.y)
  const back = new Vector3(0, 0, -1).addScaledVector(direction, direction.z)
  const w = clamp((down.length() - 0.25) / 0.35, 0, 1)
  const ref = down.lengthSq() > 1e-12 ? down.normalize().multiplyScalar(w) : new Vector3()
  if (back.lengthSq() > 1e-12) ref.addScaledVector(back.normalize(), 1 - w)
  ref.addScaledVector(direction, -ref.dot(direction))
  return ref.lengthSq() > 1e-12 ? ref.normalize() : new Vector3(1, 0, 0).addScaledVector(direction, -direction.x).normalize()
}

/**
 * Joint-limit saturation without a hard stop: identity inside 80% of the
 * range, then a tanh roll-off that approaches (never exceeds) the limit, so a
 * joint decelerates into its limit instead of visibly sticking to it.
 */
export function softClamp(value: number, low: number, high: number, knee = 0.8) {
  const hi = high * knee
  const lo = low * knee
  if (value > hi) return hi + (high - hi) * Math.tanh((value - hi) / Math.max(1e-9, high - hi))
  if (value < lo) return lo + (low - lo) * Math.tanh((value - lo) / Math.min(-1e-9, low - lo))
  return value
}
