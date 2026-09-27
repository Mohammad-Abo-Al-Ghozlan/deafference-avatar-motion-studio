import { Vector3 } from 'three'
import type { Rig } from './Rig'

export type Side = 'left' | 'right'
export type FingerName = 'thumb' | 'index' | 'middle' | 'ring' | 'pinky'

export const SIDES: readonly Side[] = ['left', 'right']
export const FINGERS: readonly FingerName[] = ['thumb', 'index', 'middle', 'ring', 'pinky']
export const LONG_FINGERS: readonly Exclude<FingerName, 'thumb'>[] = ['index', 'middle', 'ring', 'pinky']

/** Four joints per digit: base joint, two distal joints, and the tip end node. */
export type DigitChain = readonly [string, string, string, string]

export interface ArmChain {
  clavicle: string
  upperArm: string
  upperArmTwist?: string
  forearm: string
  forearmTwist?: string
  hand: string
  digits: Record<FingerName, DigitChain>
}

export interface SemanticSkeleton {
  profile: string
  root: string
  hips: string
  spine: readonly [string, string, string]
  neck: string
  head: string
  headEnd?: string
  jaw?: string
  eyes?: Record<Side, string>
  eyelids?: Record<Side, string>
  eyebrows?: Record<Side, string>
  mouthCorners?: Record<Side, string>
  arms: Record<Side, ArmChain>
}

/**
 * Explicit profile for the supplied Deafference GLB (Renderpeople "Claudia",
 * custom Blender skeleton, 88 joints, `_l` / `_r` suffixes = the character's
 * anatomical left / right). Semantic "left" always means the CHARACTER's left.
 * No Mixamo / VRM / humanoid naming is assumed; `validateSemanticSkeleton`
 * proves the mapping against the loaded rig before any solving happens.
 */
export function claudiaProfile(): SemanticSkeleton {
  const suffix = (side: Side) => (side === 'left' ? 'l' : 'r')
  const digit = (finger: FingerName, side: Side): DigitChain => [
    `${finger}_01_${suffix(side)}`,
    `${finger}_02_${suffix(side)}`,
    `${finger}_03_${suffix(side)}`,
    `${finger}_end_${suffix(side)}`
  ]
  const arm = (side: Side): ArmChain => ({
    clavicle: `shoulder_${suffix(side)}`,
    upperArm: `upperarm_${suffix(side)}`,
    upperArmTwist: `upperarm_twist_${suffix(side)}`,
    forearm: `lowerarm_${suffix(side)}`,
    forearmTwist: `lowerarm_twist_${suffix(side)}`,
    hand: `hand_${suffix(side)}`,
    digits: {
      thumb: digit('thumb', side),
      index: digit('index', side),
      middle: digit('middle', side),
      ring: digit('ring', side),
      pinky: digit('pinky', side)
    }
  })
  return {
    profile: 'renderpeople-claudia-blender',
    root: 'root',
    hips: 'hip',
    spine: ['spine_01', 'spine_02', 'spine_03'],
    neck: 'neck',
    head: 'head',
    headEnd: 'head_end',
    jaw: 'jaw',
    eyes: { left: 'eye_l', right: 'eye_r' },
    eyelids: { left: 'eyelid_l', right: 'eyelid_r' },
    eyebrows: { left: 'eyebrow_l', right: 'eyebrow_r' },
    mouthCorners: { left: 'mouth_l', right: 'mouth_r' },
    arms: { left: arm('left'), right: arm('right') }
  }
}

export interface ValidationIssue {
  level: 'error' | 'warning'
  message: string
}

export interface SkeletonValidation {
  ok: boolean
  issues: ValidationIssue[]
  facing: Vector3
  characterLeft: Vector3
}

/**
 * Structural proof that the semantic mapping matches the actual rig:
 * existence, parent chains, left/right placement relative to the facing
 * direction, mirror symmetry, and plausible proportions.
 */
export function validateSemanticSkeleton(rig: Rig, map: SemanticSkeleton): SkeletonValidation {
  const issues: ValidationIssue[] = []
  const error = (message: string) => issues.push({ level: 'error', message })
  const warn = (message: string) => issues.push({ level: 'warning', message })
  const exists = (name: string | undefined, label: string, optional = false) => {
    if (!name) return false
    if (!rig.has(name)) {
      if (optional) warn(`optional ${label} "${name}" not found`)
      else error(`required ${label} "${name}" not found`)
      return false
    }
    return true
  }
  const parentIs = (child: string, parent: string) => {
    if (!rig.has(child) || !rig.has(parent)) return
    const actual = rig.get(child).parent
    if (actual < 0 || rig.joints[actual].name !== parent) {
      error(`"${child}" should be a direct child of "${parent}" (found "${actual >= 0 ? rig.joints[actual].name : 'none'}")`)
    }
  }

  ;[map.root, map.hips, ...map.spine, map.neck, map.head].forEach((name) => exists(name, 'torso joint'))
  parentIs(map.spine[0], map.hips)
  parentIs(map.spine[1], map.spine[0])
  parentIs(map.spine[2], map.spine[1])
  parentIs(map.neck, map.spine[2])
  parentIs(map.head, map.neck)

  const optionalFace: [string | undefined, string][] = [
    [map.jaw, 'jaw'],
    [map.eyelids?.left, 'eyelid'],
    [map.eyelids?.right, 'eyelid'],
    [map.eyebrows?.left, 'eyebrow'],
    [map.eyebrows?.right, 'eyebrow'],
    [map.mouthCorners?.left, 'mouth corner'],
    [map.mouthCorners?.right, 'mouth corner'],
    [map.eyes?.left, 'eye'],
    [map.eyes?.right, 'eye']
  ]
  optionalFace.forEach(([name, label]) => {
    if (exists(name, label, true) && name && !rig.isAncestor(map.head, name)) {
      error(`face joint "${name}" is not under the head`)
    }
  })

  for (const side of ['left', 'right'] as const) {
    const arm = map.arms[side]
    ;[arm.clavicle, arm.upperArm, arm.forearm, arm.hand].forEach((name) => exists(name, `${side} arm joint`))
    exists(arm.upperArmTwist, `${side} upper-arm twist`, true)
    exists(arm.forearmTwist, `${side} forearm twist`, true)
    parentIs(arm.clavicle, map.spine[2])
    parentIs(arm.upperArm, arm.clavicle)
    parentIs(arm.forearm, arm.upperArm)
    parentIs(arm.hand, arm.forearm)
    if (arm.forearmTwist) parentIs(arm.forearmTwist, arm.forearm)
    if (arm.upperArmTwist) parentIs(arm.upperArmTwist, arm.upperArm)
    for (const finger of FINGERS) {
      const chain = arm.digits[finger]
      chain.forEach((name) => exists(name, `${side} ${finger} joint`))
      parentIs(chain[0], arm.hand)
      parentIs(chain[1], chain[0])
      parentIs(chain[2], chain[1])
      parentIs(chain[3], chain[2])
    }
  }

  const facing = new Vector3(0, 0, 1)
  const characterLeft = new Vector3(1, 0, 0)
  if (issues.some((issue) => issue.level === 'error')) {
    return { ok: false, issues, facing, characterLeft }
  }

  // Facing direction from the eyes (in front of the head) when available,
  // otherwise from the jaw. Character-left must then be facing x up.
  const head = rig.get(map.head).restWorldPosition
  const faceProbe = map.eyes && rig.has(map.eyes.left) && rig.has(map.eyes.right)
    ? rig.get(map.eyes.left).restWorldPosition.clone().add(rig.get(map.eyes.right).restWorldPosition).multiplyScalar(0.5)
    : map.jaw && rig.has(map.jaw) ? rig.get(map.jaw).restWorldPosition.clone() : null
  if (faceProbe) {
    const forward = faceProbe.sub(head).setY(0)
    if (forward.lengthSq() > 1e-8) facing.copy(forward.normalize())
    else warn('could not infer facing direction from face joints; assuming +Z')
  } else {
    warn('no face joints to infer facing direction; assuming +Z')
  }
  characterLeft.crossVectors(new Vector3(0, 1, 0), facing).normalize()

  const leftShoulder = rig.get(map.arms.left.upperArm).restWorldPosition
  const rightShoulder = rig.get(map.arms.right.upperArm).restWorldPosition
  const across = leftShoulder.clone().sub(rightShoulder)
  if (across.dot(characterLeft) <= 0) {
    error('"left" arm joints are not on the character\'s left side; the side mapping is inverted')
  }

  // Mirror symmetry about the sagittal plane through the hips.
  const hips = rig.get(map.hips).restWorldPosition
  const mirror = (p: Vector3) => {
    const offset = p.clone().sub(hips)
    const lateral = offset.dot(characterLeft)
    return p.clone().addScaledVector(characterLeft, -2 * lateral)
  }
  const pairs: [string, string][] = [
    [map.arms.left.upperArm, map.arms.right.upperArm],
    [map.arms.left.forearm, map.arms.right.forearm],
    [map.arms.left.hand, map.arms.right.hand]
  ]
  for (const finger of FINGERS) pairs.push([map.arms.left.digits[finger][0], map.arms.right.digits[finger][0]])
  for (const [left, right] of pairs) {
    const distance = mirror(rig.get(left).restWorldPosition).distanceTo(rig.get(right).restWorldPosition)
    if (distance > 0.03) warn(`"${left}" / "${right}" are ${(distance * 100).toFixed(1)} cm from mirror symmetry`)
  }

  // Proportions: finger segments must be positive and shorter than the forearm.
  for (const side of ['left', 'right'] as const) {
    const arm = map.arms[side]
    const forearmLength = rig.get(arm.hand).restLocalPosition.length()
    for (const finger of FINGERS) {
      const chain = arm.digits[finger]
      for (let k = 1; k < 4; k += 1) {
        const length = rig.get(chain[k]).restLocalPosition.length()
        if (!(length > 0.002 && length < forearmLength * 0.5)) {
          error(`${side} ${finger} segment ${k} length ${length.toFixed(4)} m is implausible`)
        }
      }
    }
  }

  return { ok: !issues.some((issue) => issue.level === 'error'), issues, facing, characterLeft }
}
