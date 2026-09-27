import { Quaternion, Vector3 } from 'three'
import { RAD, signedAngleAbout } from '../math'
import type { Rig, RigJoint } from './Rig'
import { LONG_FINGERS, type FingerName, type SemanticSkeleton, type Side } from './semanticMap'

/**
 * Anatomical frames and hinge axes derived from the GLB REST POSE.
 *
 * Conventions shared by source (landmark) measurements and the rig:
 *  - palm forward  f = normalize(middleMCP - wrist)
 *  - palm radial   r = component of (indexMCP - pinkyMCP) orthogonal to f
 *  - palm volar    n = handSign * normalize(across x f), handSign = +1 right, -1 left
 *    (right-handed coordinates; n points out of the palm)
 *  - proper basis  B = (f x n, f, n) used for all orientation alignment
 *  - MCP flexion   = elevation of the proximal phalanx toward n (rad, + = flexion)
 *  - MCP abduction = azimuth of its palm-plane projection toward r (rad, + = radial)
 *  - PIP/DIP/IP    = signed angle about the digit hinge axis (+ = flexion)
 *
 * Every hinge axis is stored in the PARENT bone's local frame so it moves with
 * the parent: applying R(axis, angle) * restLocal can only flex/extend a joint;
 * it can never swing it sideways or twist it.
 */

export interface PalmFrame {
  origin: Vector3
  forward: Vector3
  radial: Vector3
  volar: Vector3
  /** Proper right-handed basis (x = f x n, y = f, z = n) as a quaternion. */
  basis: Quaternion
}

export interface HingeJoint {
  bone: string
  parent: string
  /** Flexion axis in the parent's local frame; + rotation = flexion. */
  axisParent: Vector3
  /** Rest flexion angle (rad) measured with the same convention as sources. */
  restAngle: number
}

export interface MetacarpoPhalangeal {
  bone: string
  parent: string
  /** Flexion axis (hand-local). */
  flexAxisParent: Vector3
  /** Abduction axis (hand-local); + rotation = radial deviation. */
  abductionAxisParent: Vector3
  restFlexion: number
  restAbduction: number
}

export interface LongFingerGeometry {
  name: Exclude<FingerName, 'thumb'>
  mcp: MetacarpoPhalangeal
  pip: HingeJoint
  dip: HingeJoint
  lengths: [number, number, number]
}

export interface ThumbGeometry {
  cmc: MetacarpoPhalangeal & {
    /** Metacarpal long axis (hand-local) for coupled axial (opposition) rotation. */
    axialAxisParent: Vector3
  }
  mcp: HingeJoint
  ip: HingeJoint
  lengths: [number, number, number]
  /** Rest-pose thumb flexion axis in model space. */
  hingeWorld: Vector3
}

export interface HandGeometry {
  side: Side
  handSign: 1 | -1
  hand: string
  forearm: string
  forearmTwist?: string
  palm: PalmFrame
  /** Palm length |middleMCP - wrist| in metres (rig scale). */
  palmLength: number
  /** Rest-pose joint positions (model space) used to build templates. */
  restPositions: { wrist: Vector3; thumbCmc: Vector3; indexMcp: Vector3; middleMcp: Vector3; ringMcp: Vector3; pinkyMcp: Vector3 }
  fingers: Record<Exclude<FingerName, 'thumb'>, LongFingerGeometry>
  thumb: ThumbGeometry
}

export interface ArmGeometry {
  side: Side
  clavicle: string
  upperArm: string
  upperArmTwist?: string
  forearm: string
  forearmTwist?: string
  hand: string
  upperLength: number
  forearmLength: number
  /** Elbow flexion axis in upper-arm local frame (+ = flexion). */
  elbowAxisUpper: Vector3
  restElbowFlexion: number
  /** Unit bone axes in each bone's own local frame (child direction). */
  upperAxisLocal: Vector3
  forearmAxisLocal: Vector3
  clavicleAxisLocal: Vector3
  /** Forearm long axis expressed in the forearm-twist bone's local frame. */
  forearmAxisInTwist?: Vector3
  upperAxisInTwist?: Vector3
}

export interface TorsoGeometry {
  hips: string
  spine: readonly [string, string, string]
  neck: string
  head: string
  shoulderWidth: number
  facing: Vector3
  up: Vector3
  characterLeft: Vector3
  /** Simple collision proxies in model space (rest pose). */
  chest: { center: Vector3; radii: Vector3 }
  head3: { center: Vector3; radii: Vector3 }
}

export interface RigGeometry {
  hands: Record<Side, HandGeometry>
  arms: Record<Side, ArmGeometry>
  torso: TorsoGeometry
}

const worldPos = (rig: Rig, name: string) => rig.get(name).restWorldPosition.clone()
const worldQuatInv = (joint: RigJoint) => joint.restWorldQuaternion.clone().invert()

export function palmFrameFromPoints(
  side: Side,
  wrist: Vector3,
  indexMcp: Vector3,
  middleMcp: Vector3,
  pinkyMcp: Vector3
): PalmFrame | null {
  const handSign = side === 'right' ? 1 : -1
  const forward = middleMcp.clone().sub(wrist)
  if (forward.lengthSq() < 1e-12) return null
  forward.normalize()
  const across = indexMcp.clone().sub(pinkyMcp)
  const radial = across.clone().addScaledVector(forward, -across.dot(forward))
  if (radial.lengthSq() < 1e-12) return null
  radial.normalize()
  const volar = new Vector3().crossVectors(across, forward).multiplyScalar(handSign)
  volar.addScaledVector(forward, -volar.dot(forward))
  if (volar.lengthSq() < 1e-12) return null
  volar.normalize()
  const x = new Vector3().crossVectors(forward, volar).normalize()
  const basis = basisQuaternion(x, forward, volar)
  return { origin: wrist.clone(), forward, radial, volar, basis }
}

export function basisQuaternion(x: Vector3, y: Vector3, z: Vector3) {
  // Rotation matrix with columns x, y, z -> quaternion (Shepperd's method via three).
  const m = [x.x, y.x, z.x, x.y, y.y, z.y, x.z, y.z, z.z]
  const trace = m[0] + m[4] + m[8]
  const q = new Quaternion()
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1)
    q.set((m[7] - m[5]) * s, (m[2] - m[6]) * s, (m[3] - m[1]) * s, 0.25 / s)
  } else if (m[0] > m[4] && m[0] > m[8]) {
    const s = 2 * Math.sqrt(1 + m[0] - m[4] - m[8])
    q.set(0.25 * s, (m[1] + m[3]) / s, (m[2] + m[6]) / s, (m[7] - m[5]) / s)
  } else if (m[4] > m[8]) {
    const s = 2 * Math.sqrt(1 + m[4] - m[0] - m[8])
    q.set((m[1] + m[3]) / s, 0.25 * s, (m[5] + m[7]) / s, (m[2] - m[6]) / s)
  } else {
    const s = 2 * Math.sqrt(1 + m[8] - m[0] - m[4])
    q.set((m[2] + m[6]) / s, (m[5] + m[7]) / s, 0.25 * s, (m[3] - m[1]) / s)
  }
  return q.normalize()
}

/** Elevation of `direction` toward `volar` relative to the palm plane (rad). */
export function elevation(direction: Vector3, palm: PalmFrame) {
  const up = direction.dot(palm.volar)
  const inPlane = Math.hypot(direction.dot(palm.forward), direction.dot(palm.radial))
  return Math.atan2(up, inPlane)
}

/** Azimuth of `direction`'s palm-plane projection toward the radial side (rad). */
export function azimuth(direction: Vector3, palm: PalmFrame) {
  return Math.atan2(direction.dot(palm.radial), direction.dot(palm.forward))
}

function mcpGeometry(rig: Rig, palm: PalmFrame, handSign: 1 | -1, hand: string, chain: readonly string[]) {
  const base = rig.get(chain[0])
  const direction = worldPos(rig, chain[1]).sub(base.restWorldPosition).normalize()
  const volarPerp = palm.volar.clone().addScaledVector(direction, -palm.volar.dot(direction)).normalize()
  const flexWorld = new Vector3().crossVectors(direction, volarPerp).normalize()
  const handInv = worldQuatInv(rig.get(hand))
  // + rotation about (-handSign * volar) moves forward toward radial (see header).
  const abductionWorld = palm.volar.clone().multiplyScalar(-handSign)
  return {
    direction,
    flexWorld,
    mcp: {
      bone: chain[0],
      parent: hand,
      flexAxisParent: flexWorld.clone().applyQuaternion(handInv).normalize(),
      abductionAxisParent: abductionWorld.applyQuaternion(handInv).normalize(),
      restFlexion: elevation(direction, palm),
      restAbduction: azimuth(direction, palm)
    }
  }
}

function hinge(rig: Rig, bone: string, parent: string, axisWorld: Vector3, from: Vector3, to: Vector3): HingeJoint {
  return {
    bone,
    parent,
    axisParent: axisWorld.clone().applyQuaternion(worldQuatInv(rig.get(parent))).normalize(),
    restAngle: signedAngleAbout(from, to, axisWorld)
  }
}

export function buildHandGeometry(rig: Rig, map: SemanticSkeleton, side: Side): HandGeometry {
  const arm = map.arms[side]
  const handSign: 1 | -1 = side === 'right' ? 1 : -1
  const wrist = worldPos(rig, arm.hand)
  const palm = palmFrameFromPoints(
    side,
    wrist,
    worldPos(rig, arm.digits.index[0]),
    worldPos(rig, arm.digits.middle[0]),
    worldPos(rig, arm.digits.pinky[0])
  )
  if (!palm) throw new Error(`Degenerate rest palm on ${side} hand`)

  const fingers = {} as HandGeometry['fingers']
  for (const finger of LONG_FINGERS) {
    const chain = arm.digits[finger]
    const p = chain.map((name) => worldPos(rig, name))
    const d1 = p[1].clone().sub(p[0]).normalize()
    const d2 = p[2].clone().sub(p[1]).normalize()
    const d3 = p[3].clone().sub(p[2]).normalize()
    const { flexWorld, mcp } = mcpGeometry(rig, palm, handSign, arm.hand, chain)
    fingers[finger] = {
      name: finger,
      mcp,
      pip: hinge(rig, chain[1], chain[0], flexWorld, d1, d2),
      dip: hinge(rig, chain[2], chain[1], flexWorld, d2, d3),
      lengths: [p[0].distanceTo(p[1]), p[1].distanceTo(p[2]), p[2].distanceTo(p[3])]
    }
  }

  const chain = arm.digits.thumb
  const t = chain.map((name) => worldPos(rig, name))
  const dm = t[1].clone().sub(t[0]).normalize()
  const dp = t[2].clone().sub(t[1]).normalize()
  const dd = t[3].clone().sub(t[2]).normalize()
  const { mcp: cmcBase } = mcpGeometry(rig, palm, handSign, arm.hand, chain)
  // Thumb MCP/IP flexion plane from the rest curvature of the modelled thumb.
  const mcpAxis = new Vector3().crossVectors(dm, dp)
  const ipAxis = new Vector3().crossVectors(dp, dd)
  const thumbAxis = mcpAxis.lengthSq() > 1e-6 && ipAxis.lengthSq() > 1e-6
    ? mcpAxis.normalize().add(ipAxis.normalize()).normalize()
    : new Vector3().crossVectors(dm, palm.volar).normalize()
  const thumb: ThumbGeometry = {
    cmc: {
      ...cmcBase,
      axialAxisParent: dm.clone().applyQuaternion(worldQuatInv(rig.get(arm.hand))).normalize()
    },
    mcp: hinge(rig, chain[1], chain[0], thumbAxis, dm, dp),
    ip: hinge(rig, chain[2], chain[1], thumbAxis, dp, dd),
    lengths: [t[0].distanceTo(t[1]), t[1].distanceTo(t[2]), t[2].distanceTo(t[3])],
    hingeWorld: thumbAxis.clone()
  }

  return {
    side,
    handSign,
    hand: arm.hand,
    forearm: arm.forearm,
    forearmTwist: arm.forearmTwist && rig.has(arm.forearmTwist) ? arm.forearmTwist : undefined,
    palm,
    palmLength: worldPos(rig, arm.digits.middle[0]).distanceTo(wrist),
    restPositions: {
      wrist: wrist.clone(),
      thumbCmc: worldPos(rig, arm.digits.thumb[0]),
      indexMcp: worldPos(rig, arm.digits.index[0]),
      middleMcp: worldPos(rig, arm.digits.middle[0]),
      ringMcp: worldPos(rig, arm.digits.ring[0]),
      pinkyMcp: worldPos(rig, arm.digits.pinky[0])
    },
    fingers,
    thumb
  }
}

export function buildArmGeometry(rig: Rig, map: SemanticSkeleton, side: Side): ArmGeometry {
  const arm = map.arms[side]
  const shoulder = worldPos(rig, arm.upperArm)
  const elbow = worldPos(rig, arm.forearm)
  const wrist = worldPos(rig, arm.hand)
  const du = elbow.clone().sub(shoulder).normalize()
  const dl = wrist.clone().sub(elbow).normalize()
  const upper = rig.get(arm.upperArm)
  const forearm = rig.get(arm.forearm)
  const clavicle = rig.get(arm.clavicle)

  let axisWorld = new Vector3().crossVectors(du, dl)
  if (axisWorld.lengthSq() < 1e-6) {
    // Straight rest arm: flexion brings the forearm toward the character's front.
    axisWorld = new Vector3().crossVectors(du, new Vector3(0, 0, 1))
  }
  axisWorld.normalize()
  const local = (joint: RigJoint, direction: Vector3) => direction.clone().applyQuaternion(worldQuatInv(joint)).normalize()
  const twistAxis = (twist: string | undefined, direction: Vector3) =>
    twist && rig.has(twist) ? local(rig.get(twist), direction) : undefined

  return {
    side,
    clavicle: arm.clavicle,
    upperArm: arm.upperArm,
    upperArmTwist: arm.upperArmTwist && rig.has(arm.upperArmTwist) ? arm.upperArmTwist : undefined,
    forearm: arm.forearm,
    forearmTwist: arm.forearmTwist && rig.has(arm.forearmTwist) ? arm.forearmTwist : undefined,
    hand: arm.hand,
    upperLength: shoulder.distanceTo(elbow),
    forearmLength: elbow.distanceTo(wrist),
    elbowAxisUpper: local(upper, axisWorld),
    restElbowFlexion: signedAngleAbout(du, dl, axisWorld),
    upperAxisLocal: local(upper, du),
    forearmAxisLocal: local(forearm, dl),
    clavicleAxisLocal: local(clavicle, shoulder.clone().sub(clavicle.restWorldPosition).normalize()),
    forearmAxisInTwist: twistAxis(arm.forearmTwist, dl),
    upperAxisInTwist: twistAxis(arm.upperArmTwist, du)
  }
}

export function buildTorsoGeometry(rig: Rig, map: SemanticSkeleton, facing: Vector3, characterLeft: Vector3): TorsoGeometry {
  const left = worldPos(rig, map.arms.left.upperArm)
  const right = worldPos(rig, map.arms.right.upperArm)
  const spine2 = worldPos(rig, map.spine[1])
  const neck = worldPos(rig, map.neck)
  const head = worldPos(rig, map.head)
  const headTop = map.headEnd && rig.has(map.headEnd) ? worldPos(rig, map.headEnd) : head.clone().add(new Vector3(0, 0.16, 0))
  const shoulderWidth = left.distanceTo(right)
  // Chest proxy: ellipsoid between spine_02 and neck, sized from shoulder
  // width (lateral) and measured mesh depth ratios for this body type.
  const chestCenter = spine2.clone().lerp(neck, 0.45).addScaledVector(facing, 0.012)
  const headCenter = head.clone().lerp(headTop, 0.45).addScaledVector(facing, 0.03)
  return {
    hips: map.hips,
    spine: map.spine,
    neck: map.neck,
    head: map.head,
    shoulderWidth,
    facing: facing.clone(),
    up: new Vector3(0, 1, 0),
    characterLeft: characterLeft.clone(),
    chest: { center: chestCenter, radii: new Vector3(shoulderWidth * 0.44, neck.y - spine2.y, 0.125) },
    head3: { center: headCenter, radii: new Vector3(0.088, 0.118, 0.112) }
  }
}

export function buildRigGeometry(rig: Rig, map: SemanticSkeleton, facing: Vector3, characterLeft: Vector3): RigGeometry {
  return {
    hands: { left: buildHandGeometry(rig, map, 'left'), right: buildHandGeometry(rig, map, 'right') },
    arms: { left: buildArmGeometry(rig, map, 'left'), right: buildArmGeometry(rig, map, 'right') },
    torso: buildTorsoGeometry(rig, map, facing, characterLeft)
  }
}

export function describeAngle(radians: number) {
  return Math.round(radians * RAD * 10) / 10
}
