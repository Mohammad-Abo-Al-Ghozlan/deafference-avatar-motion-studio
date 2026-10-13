import { Quaternion, Vector3 } from 'three'
import { clamp, DEG, swingTwist } from '../math'
import { DEFAULT_SOLVER_CONFIG, type SolverConfig } from '../retarget/AvatarSolver'
import { PoseState } from '../retarget/PoseState'
import type { Rig } from '../rig/Rig'
import { azimuth, elevation, type PalmFrame, type RigGeometry } from '../rig/rigGeometry'
import { LONG_FINGERS, SIDES, type Side } from '../rig/semanticMap'
import { clampLongFinger, LIMITS, templateFromRig, type HandTemplate, type LongFinger, type LongFingerParams } from '../source/handModel'
import { separateAdjacentFingers } from '../source/handParams'

/**
 * Anatomical conformance of an existing animation to the studio's joint
 * model, i.e. the constraints AvatarSolver builds poses with:
 *
 *   1. Elbow swivel (per word, Viterbi over time): the whole arm may rotate
 *      about the shoulder->wrist axis. That keeps the hand's position AND
 *      orientation in space exactly as given (what the viewer reads: location
 *      and palm orientation) while choosing the elbow position that keeps the
 *      wrist inside its anatomical range. This is how the studio solver
 *      resolves wrist limits too (swivel optimisation).
 *   2. Elbow: pure hinge about the rig's elbow axis, flexion in [3, 148] deg.
 *   3. Wrist: what swivel could not absorb is limited per anatomical axis
 *      (flexion / extension, radial / ulnar deviation, pronation twist).
 *   4. Long fingers: MCP = flexion + abduction only (no axial roll, so a
 *      finger cannot corkscrew), flexion-dependent abduction range, adjacent
 *      fingers keep their order; PIP/DIP pure hinges, DIP coupled to PIP.
 *   5. Thumb: MCP and IP pure hinges within LIMITS (the CMC is kept).
 *
 * A pose that is already inside the model keeps its hand placement; the
 * long-finger MCP loses only its axial roll.
 */
export interface ConformOptions {
  /** Elbow swivel search range and step (rad). */
  swivelRange: number
  swivelStep: number
  /** Viterbi weights: wrist-limit excess (per rad), distance from the given swivel (per rad), change per frame (per rad^2), elbow inside the chest proxy (per unit penetration). */
  weights: { violation: number; prior: number; smooth: number; collision: number }
  /** Clearance kept between the elbow and the chest proxy (m). */
  chestMargin: number
  /**
   * Keep the first and last frame's swivel at 0. Library words start and end
   * at the shared idle pose; without the anchor the smoothness term pulls the
   * end frames toward the stroke's swivel and words no longer join (jumps
   * between back-to-back words and at the loop point).
   */
  anchorEnds: boolean
}

export const DEFAULT_CONFORM_OPTIONS: ConformOptions = {
  swivelRange: 60 * DEG,
  swivelStep: 2 * DEG,
  weights: { violation: 10, prior: 0.3, smooth: 30, collision: 50 },
  chestMargin: 0.03,
  anchorEnds: true
}

export interface WordConformResult {
  /** Conformed local rotations, one map per input frame (inputs are not modified). */
  frames: Map<string, Quaternion>[]
  /** Chosen elbow swivel per frame (rad, 0 = as given). */
  swivel: Record<Side, number[]>
  crossingCorrections: number
}

interface WristAxes {
  twist: Vector3
  flex: Vector3
  dev: Vector3
}

interface ArmFrame {
  shoulder: Vector3
  elbow: Vector3
  axis: Vector3 | null
  parentWorld: Quaternion
  upperWorld: Quaternion
  forearmWorld: Quaternion
  handWorld: Quaternion
}

export class AnatomicalConformer {
  private readonly rig: Rig
  private readonly geometry: RigGeometry
  private readonly config: SolverConfig
  private readonly options: ConformOptions
  private readonly wrist: Record<Side, WristAxes>
  private readonly palmHand: Record<Side, PalmFrame>
  private readonly restDirHand: Record<Side, Record<LongFinger, Vector3>>
  private readonly template: Record<Side, HandTemplate>
  private readonly pose: PoseState

  constructor(rig: Rig, geometry: RigGeometry, config: SolverConfig = DEFAULT_SOLVER_CONFIG, options: ConformOptions = DEFAULT_CONFORM_OPTIONS) {
    this.rig = rig
    this.geometry = geometry
    this.config = config
    this.options = options
    this.pose = new PoseState(rig)
    this.wrist = {} as Record<Side, WristAxes>
    this.palmHand = {} as Record<Side, PalmFrame>
    this.restDirHand = {} as Record<Side, Record<LongFinger, Vector3>>
    this.template = {} as Record<Side, HandTemplate>
    for (const side of SIDES) {
      const hand = geometry.hands[side]
      const arm = geometry.arms[side]
      // Wrist axes exactly as AvatarSolver builds them (forearm-local, orthonormal).
      const forearmRestInv = rig.get(arm.forearm).restWorldQuaternion.clone().invert()
      const twist = arm.forearmAxisLocal.clone().normalize()
      const flex = new Vector3().crossVectors(hand.palm.forward, hand.palm.volar).normalize().applyQuaternion(forearmRestInv)
      flex.addScaledVector(twist, -flex.dot(twist)).normalize()
      const dev = new Vector3().crossVectors(twist, flex).normalize()
      if (dev.dot(hand.palm.volar.clone().multiplyScalar(-hand.handSign).applyQuaternion(forearmRestInv)) < 0) dev.negate()
      this.wrist[side] = { twist, flex, dev }

      // Palm frame and finger rest directions in the hand bone's local frame.
      const handRestInv = rig.get(hand.hand).restWorldQuaternion.clone().invert()
      const toHand = (v: Vector3) => v.clone().applyQuaternion(handRestInv)
      this.palmHand[side] = { origin: new Vector3(), forward: toHand(hand.palm.forward), radial: toHand(hand.palm.radial), volar: toHand(hand.palm.volar), basis: new Quaternion() }
      const dirs = {} as Record<LongFinger, Vector3>
      for (const finger of LONG_FINGERS) {
        const g = hand.fingers[finger]
        dirs[finger] = toHand(rig.get(g.pip.bone).restWorldPosition.clone().sub(rig.get(g.mcp.bone).restWorldPosition).normalize())
      }
      this.restDirHand[side] = dirs
      // The animation is already in rig space: the rig itself is the neutral hand.
      this.template[side] = templateFromRig(hand)
    }
  }

  /** Conform every frame of one word (or any contiguous clip). */
  conformWord(input: readonly Map<string, Quaternion>[]): WordConformResult {
    const frames = input.map((frame) => new Map([...frame].map(([bone, q]) => [bone, q.clone()])))
    const swivel = {} as Record<Side, number[]>
    for (const side of SIDES) swivel[side] = this.chooseSwivel(side, frames)
    let crossingCorrections = 0
    frames.forEach((frame, k) => {
      for (const side of SIDES) {
        this.applyArm(side, frame, swivel[side][k])
        crossingCorrections += this.conformFingers(side, frame)
        this.conformThumb(side, frame)
      }
    })
    return { frames, swivel, crossingCorrections }
  }

  private rest(bone: string) {
    return this.rig.get(bone).restLocalQuaternion
  }

  /** Forward kinematics of the arm chain for one frame (model space). */
  private armFrame(side: Side, frame: Map<string, Quaternion>): ArmFrame | null {
    const arm = this.geometry.arms[side]
    if (!frame.has(arm.upperArm) || !frame.has(arm.forearm) || !frame.has(arm.hand)) return null
    const pose = this.pose
    pose.reset()
    for (const [bone, q] of frame) if (this.rig.has(bone)) pose.setLocal(bone, q)
    const shoulder = pose.worldPosition(arm.upperArm)
    const wristPos = pose.worldPosition(arm.hand)
    const toWrist = wristPos.clone().sub(shoulder)
    return {
      shoulder,
      elbow: pose.worldPosition(arm.forearm),
      axis: toWrist.lengthSq() > 1e-8 ? toWrist.normalize() : null,
      parentWorld: pose.worldQuaternion(this.rig.joints[this.rig.get(arm.upperArm).parent].name),
      upperWorld: pose.worldQuaternion(arm.upperArm),
      forearmWorld: pose.worldQuaternion(arm.forearm),
      handWorld: pose.worldQuaternion(arm.hand)
    }
  }

  /** Wrist-limit excess (rad) of a hand local rotation, as in AvatarSolver's wristViolation. */
  wristViolation(side: Side, handLocal: Quaternion) {
    const c = this.config.wrist
    const { flex, dev, twist } = this.wristComponents(side, handLocal)
    return Math.hypot(
      Math.max(0, flex - c.flexion, -c.extension - flex),
      Math.max(0, dev - c.radial, -c.ulnar - dev),
      Math.max(0, Math.abs(twist) - c.twist)
    )
  }

  private wristComponents(side: Side, handLocal: Quaternion) {
    const axes = this.wrist[side]
    const delta = handLocal.clone().multiply(this.rest(this.geometry.arms[side].hand).clone().invert())
    const { swing, twistAngle } = swingTwist(delta, axes.twist)
    const twistQ = new Quaternion().setFromAxisAngle(axes.twist, twistAngle)
    const flexAxis = axes.flex.clone().applyQuaternion(twistQ)
    const devAxis = axes.dev.clone().applyQuaternion(twistQ)
    const angle = 2 * Math.acos(clamp(Math.abs(swing.w), 0, 1))
    const axis = new Vector3(swing.x, swing.y, swing.z)
    if (swing.w < 0) axis.negate()
    const vector = axis.lengthSq() > 1e-12 ? axis.normalize().multiplyScalar(angle) : new Vector3()
    return { flex: vector.dot(flexAxis), dev: vector.dot(devAxis), twist: twistAngle, flexAxis, devAxis, twistQ }
  }

  /** Penetration depth (in ellipsoid units) of a point into the inflated chest proxy. */
  private chestPenetration(point: Vector3) {
    const chest = this.geometry.torso.chest
    const m = this.options.chestMargin
    const d = Math.hypot((point.x - chest.center.x) / (chest.radii.x + m), (point.y - chest.center.y) / (chest.radii.y + m), (point.z - chest.center.z) / (chest.radii.z + m))
    return Math.max(0, 1 - d)
  }

  /** Viterbi over swivel angles: wrist inside its limits, elbow clear of the chest, close to the given arm, smooth in time. */
  private chooseSwivel(side: Side, frames: Map<string, Quaternion>[]): number[] {
    const { swivelRange, swivelStep, weights, anchorEnds } = this.options
    const n = frames.length
    const zero = new Array<number>(n).fill(0)
    const arm = frames.map((frame) => this.armFrame(side, frame))
    // Nothing to do when every frame already respects the wrist limits.
    const needs = arm.some((a, k) => a && this.wristViolation(side, frames[k].get(this.geometry.arms[side].hand)!) > 0.25 * DEG)
    if (!needs) return zero
    const steps = Math.round(swivelRange / swivelStep)
    const grid = Array.from({ length: 2 * steps + 1 }, (_, j) => (j - steps) * swivelStep)
    const m = grid.length
    const unary = new Float64Array(n * m)
    const r = new Quaternion()
    for (let k = 0; k < n; k += 1) {
      const a = arm[k]
      for (let j = 0; j < m; j += 1) {
        const phi = grid[j]
        if (!a || !a.axis || (anchorEnds && (k === 0 || k === n - 1))) {
          unary[k * m + j] = phi === 0 ? 0 : 1e6
          continue
        }
        r.setFromAxisAngle(a.axis, phi)
        const handLocal = r.clone().multiply(a.forearmWorld).invert().multiply(a.handWorld)
        const elbow = a.elbow.clone().sub(a.shoulder).applyQuaternion(r).add(a.shoulder)
        unary[k * m + j] = weights.violation * this.wristViolation(side, handLocal) + weights.prior * Math.abs(phi) + weights.collision * this.chestPenetration(elbow)
      }
    }
    // Forward pass.
    const cost = new Float64Array(n * m)
    const back = new Int32Array(n * m)
    for (let j = 0; j < m; j += 1) cost[j] = unary[j]
    for (let k = 1; k < n; k += 1) {
      for (let j = 0; j < m; j += 1) {
        let best = Infinity
        let arg = 0
        for (let i = 0; i < m; i += 1) {
          const d = grid[j] - grid[i]
          const value = cost[(k - 1) * m + i] + weights.smooth * d * d
          if (value < best) {
            best = value
            arg = i
          }
        }
        cost[k * m + j] = best + unary[k * m + j]
        back[k * m + j] = arg
      }
    }
    let j = 0
    for (let i = 1; i < m; i += 1) if (cost[(n - 1) * m + i] < cost[(n - 1) * m + j]) j = i
    const out = new Array<number>(n)
    for (let k = n - 1; k >= 0; k -= 1) {
      out[k] = grid[j]
      j = back[k * m + j]
    }
    return out
  }

  /** Swivel, elbow hinge/range, then the wrist with the hand's world orientation preserved where the limits allow. */
  private applyArm(side: Side, frame: Map<string, Quaternion>, phi: number) {
    const arm = this.geometry.arms[side]
    const a = this.armFrame(side, frame)
    if (!a) return
    let upperWorld = a.upperWorld
    if (phi !== 0 && a.axis) {
      upperWorld = new Quaternion().setFromAxisAngle(a.axis, phi).multiply(a.upperWorld)
      frame.set(arm.upperArm, a.parentWorld.clone().invert().multiply(upperWorld))
    }
    // Elbow: pure hinge, flexion within the solver's range.
    const forearmLocal = frame.get(arm.forearm)!
    const flexion = arm.restElbowFlexion + swingTwist(forearmLocal.clone().multiply(this.rest(arm.forearm).clone().invert()), arm.elbowAxisUpper).twistAngle
    const limited = clamp(flexion, this.config.arm.minFlexion, this.config.arm.maxFlexion)
    const newForearm = new Quaternion().setFromAxisAngle(arm.elbowAxisUpper, limited - arm.restElbowFlexion).multiply(this.rest(arm.forearm))
    frame.set(arm.forearm, newForearm)
    // Hand: keep its world orientation, then limit what the wrist cannot do.
    const forearmWorld = upperWorld.clone().multiply(newForearm)
    const handLocal = forearmWorld.invert().multiply(a.handWorld)
    frame.set(arm.hand, this.limitWrist(side, handLocal))
  }

  private limitWrist(side: Side, handLocal: Quaternion) {
    const c = this.config.wrist
    const axes = this.wrist[side]
    const handRest = this.rest(this.geometry.arms[side].hand)
    const parts = this.wristComponents(side, handLocal)
    const twist = clamp(parts.twist, -c.twist, c.twist)
    if (twist === parts.twist && parts.flex <= c.flexion && parts.flex >= -c.extension && parts.dev <= c.radial && parts.dev >= -c.ulnar) return handLocal
    const twistQ = new Quaternion().setFromAxisAngle(axes.twist, twist)
    const flexAxis = axes.flex.clone().applyQuaternion(twistQ)
    const devAxis = axes.dev.clone().applyQuaternion(twistQ)
    const flex = clamp(parts.flex, -c.extension, c.flexion)
    const dev = clamp(parts.dev, -c.ulnar, c.radial)
    const limited = flexAxis.multiplyScalar(flex).addScaledVector(devAxis, dev)
    const angle = limited.length()
    const swing = angle > 1e-12 ? new Quaternion().setFromAxisAngle(limited.divideScalar(angle), angle) : new Quaternion()
    return swing.multiply(twistQ).multiply(handRest)
  }

  /** Signed angle of `local` about a hinge axis, relative to the rest pose. */
  private hingeTwist(local: Quaternion, bone: string, axis: Vector3) {
    return swingTwist(local.clone().multiply(this.rest(bone).clone().invert()), axis).twistAngle
  }

  private hinge(bone: string, axis: Vector3, angleFromRest: number) {
    return new Quaternion().setFromAxisAngle(axis, angleFromRest).multiply(this.rest(bone))
  }

  private conformFingers(side: Side, frame: Map<string, Quaternion>) {
    const hand = this.geometry.hands[side]
    const palm = this.palmHand[side]
    const template = this.template[side]
    if (!LONG_FINGERS.every((f) => frame.has(hand.fingers[f].mcp.bone))) return 0
    const params = {} as Record<LongFinger, LongFingerParams>
    for (const finger of LONG_FINGERS) {
      const g = hand.fingers[finger]
      const mcp = frame.get(g.mcp.bone)!
      const pip = frame.get(g.pip.bone) ?? this.rest(g.pip.bone)
      const dip = frame.get(g.dip.bone) ?? this.rest(g.dip.bone)
      const direction = this.restDirHand[side][finger].clone().applyQuaternion(mcp.clone().multiply(this.rest(g.mcp.bone).clone().invert()))
      params[finger] = clampLongFinger(template, finger, {
        abduction: azimuth(direction, palm),
        mcp: elevation(direction, palm),
        pip: g.pip.restAngle + this.hingeTwist(pip, g.pip.bone, g.pip.axisParent),
        dip: g.dip.restAngle + this.hingeTwist(dip, g.dip.bone, g.dip.axisParent)
      })
    }
    // Finger order (anti-crossing) as in the solver, then the ranges again.
    const azimuths = {} as Record<LongFinger, number>
    const flexions = {} as Record<LongFinger, number>
    for (const finger of LONG_FINGERS) {
      azimuths[finger] = params[finger].abduction
      flexions[finger] = params[finger].mcp
    }
    const corrections = separateAdjacentFingers(azimuths, flexions, this.config.fingers.overlap)
    for (const finger of LONG_FINGERS) {
      const g = hand.fingers[finger]
      const p = clampLongFinger(template, finger, { ...params[finger], abduction: azimuths[finger] })
      frame.set(g.mcp.bone, new Quaternion().setFromAxisAngle(g.mcp.abductionAxisParent, p.abduction - g.mcp.restAbduction)
        .multiply(new Quaternion().setFromAxisAngle(g.mcp.flexAxisParent, p.mcp - g.mcp.restFlexion))
        .multiply(this.rest(g.mcp.bone)))
      frame.set(g.pip.bone, this.hinge(g.pip.bone, g.pip.axisParent, p.pip - g.pip.restAngle))
      frame.set(g.dip.bone, this.hinge(g.dip.bone, g.dip.axisParent, p.dip - g.dip.restAngle))
    }
    return corrections
  }

  private conformThumb(side: Side, frame: Map<string, Quaternion>) {
    const thumb = this.geometry.hands[side].thumb
    for (const [joint, limits] of [[thumb.mcp, LIMITS.thumb.mcp], [thumb.ip, LIMITS.thumb.ip]] as const) {
      const local = frame.get(joint.bone)
      if (!local) continue
      const angle = clamp(joint.restAngle + this.hingeTwist(local, joint.bone, joint.axisParent), limits[0], limits[1])
      frame.set(joint.bone, this.hinge(joint.bone, joint.axisParent, angle - joint.restAngle))
    }
  }
}
