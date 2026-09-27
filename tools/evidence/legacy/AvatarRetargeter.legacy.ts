// LEGACY REFERENCE (unchanged copy of src/lib/AvatarRetargeter.ts from the uploaded project).
// Used only by tools/evidence to render the "before" recordings. Not used by the app.

import {
  Bone,
  Matrix4,
  Object3D,
  Quaternion,
  SkinnedMesh,
  Vector3
} from 'three'
import type { Landmark, TrackingFrame } from '../../../src/types/tracking'

interface RestTransform {
  local: Quaternion
  world: Quaternion
  localPosition: Vector3
  position: Vector3
}

interface MorphBinding {
  mesh: SkinnedMesh
  index: number
}

type HandSide = 'Left' | 'Right'
type FingerName = keyof typeof FINGER_LANDMARKS

interface HandFrame {
  delta: Quaternion
  palmNormal: Vector3
}

interface ScalarSample {
  value: number
  timestamp: number
}

interface FingerRig {
  flexAxis: Vector3
  spreadAxis: Vector3
}

interface BendState {
  score: number
  sign?: number
}

const POSE = {
  nose: 0,
  leftShoulder: 11,
  rightShoulder: 12,
  leftElbow: 13,
  rightElbow: 14,
  leftWrist: 15,
  rightWrist: 16,
  leftHip: 23,
  rightHip: 24
} as const

const FINGER_LANDMARKS = {
  Thumb: [1, 2, 3, 4],
  Index: [5, 6, 7, 8],
  Middle: [9, 10, 11, 12],
  Ring: [13, 14, 15, 16],
  Pinky: [17, 18, 19, 20]
} as const

const FINGER_NAMES = Object.keys(FINGER_LANDMARKS) as FingerName[]
const FINGER_BONE_PATTERN = /^(Left|Right)Hand(Thumb|Index|Middle|Ring|Pinky)([1-3])$/

const MCP_FLEX_LIMITS: Record<FingerName, number> = {
  Thumb: 58,
  Index: 88,
  Middle: 90,
  Ring: 92,
  Pinky: 94
}

const MCP_SPREAD_LIMITS: Record<FingerName, number> = {
  Thumb: 48,
  Index: 18,
  Middle: 8,
  Ring: 13,
  Pinky: 20
}

const HINGE_BEND_LIMITS: Record<FingerName, readonly [number, number]> = {
  Thumb: [68, 62],
  Index: [104, 78],
  Middle: [108, 82],
  Ring: [108, 82],
  Pinky: [104, 78]
}

const CONTROLLED_BONES = [
  'Spine2',
  'Head',
  'LeftArm',
  'LeftForeArm',
  'LeftHand',
  'RightArm',
  'RightForeArm',
  'RightHand',
  ...(['Left', 'Right'] as const).flatMap((side) =>
    (['Thumb', 'Index', 'Middle', 'Ring', 'Pinky'] as const).flatMap((finger) =>
      [1, 2, 3].map((joint) => `${side}Hand${finger}${joint}`)
    )
  ),
  'Jaw',
  'LeftEyelid',
  'RightEyelid',
  'LeftEyebrow',
  'RightEyebrow',
  'LeftMouth',
  'RightMouth'
]

const POSITION_CONTROLLED_BONES = [
  'LeftEyebrow',
  'RightEyebrow',
  'LeftMouth',
  'RightMouth'
] as const

/**
 * The supplied Claudia GLB uses a Blender-style custom skeleton. Keeping the
 * solver on semantic names makes the retargeting math readable while this map
 * resolves those names to the actual nodes in the asset.
 */
const BONE_ALIASES: Record<string, string[]> = {
  Hips: ['Hips', 'hip'],
  Spine: ['Spine', 'spine_01'],
  Spine1: ['Spine1', 'spine_02'],
  Spine2: ['Spine2', 'spine_03'],
  Neck: ['Neck', 'neck'],
  Head: ['Head', 'head'],
  LeftShoulder: ['LeftShoulder', 'shoulder_l'],
  LeftArm: ['LeftArm', 'upperarm_l'],
  LeftForeArm: ['LeftForeArm', 'lowerarm_l'],
  LeftHand: ['LeftHand', 'hand_l'],
  RightShoulder: ['RightShoulder', 'shoulder_r'],
  RightArm: ['RightArm', 'upperarm_r'],
  RightForeArm: ['RightForeArm', 'lowerarm_r'],
  RightHand: ['RightHand', 'hand_r'],
  Jaw: ['Jaw', 'jaw'],
  LeftEyelid: ['LeftEyelid', 'eyelid_l'],
  RightEyelid: ['RightEyelid', 'eyelid_r'],
  LeftEyebrow: ['LeftEyebrow', 'eyebrow_l'],
  RightEyebrow: ['RightEyebrow', 'eyebrow_r'],
  LeftMouth: ['LeftMouth', 'mouth_l'],
  RightMouth: ['RightMouth', 'mouth_r']
}

for (const side of ['Left', 'Right'] as const) {
  const suffix = side === 'Left' ? 'l' : 'r'
  for (const finger of ['Thumb', 'Index', 'Middle', 'Ring', 'Pinky'] as const) {
    const stem = finger.toLowerCase()
    for (let joint = 1; joint <= 4; joint += 1) {
      const actual = joint === 4 ? `${stem}_end_${suffix}` : `${stem}_0${joint}_${suffix}`
      BONE_ALIASES[`${side}Hand${finger}${joint}`] = [
        `${side}Hand${finger}${joint}`,
        actual
      ]
    }
  }
}

const tmpQuaternionA = new Quaternion()
const tmpQuaternionB = new Quaternion()
const tmpQuaternionC = new Quaternion()
const identityQuaternion = new Quaternion()

function usable(a?: Landmark, b?: Landmark) {
  if (!a || !b) return false
  const av = a.visibility ?? 1
  const bv = b.visibility ?? 1
  return av > 0.2 && bv > 0.2
}

function mappedPoint(landmark: Landmark) {
  return new Vector3(landmark.x, -landmark.y, -landmark.z * 0.72)
}

function mappedDirection(a: Landmark, b: Landmark) {
  return mappedPoint(b).sub(mappedPoint(a)).normalize()
}

// MediaPipe's monocular hand depth is substantially noisier than x/y. Using
// the full reported z makes fingers punch through the palm during blur or
// self-occlusion, so the finger solver deliberately attenuates depth.
function mappedHandPoint(landmark: Landmark) {
  return new Vector3(landmark.x, -landmark.y, -landmark.z * 0.38)
}

function mappedHandDirection(a: Landmark, b: Landmark) {
  return mappedHandPoint(b).sub(mappedHandPoint(a)).normalize()
}

function midpoint(a: Landmark, b: Landmark) {
  return mappedPoint(a).add(mappedPoint(b)).multiplyScalar(0.5)
}

function basisQuaternion(across: Vector3, up: Vector3) {
  const x = across.clone().normalize()
  const ySeed = up.clone().normalize()
  const z = new Vector3().crossVectors(x, ySeed).normalize()
  const y = new Vector3().crossVectors(z, x).normalize()
  return new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(x, y, z))
}

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value))
}

function radians(degrees: number) {
  return degrees * Math.PI / 180
}

function finiteLandmark(landmark?: Landmark) {
  return Boolean(
    landmark &&
    Number.isFinite(landmark.x) &&
    Number.isFinite(landmark.y) &&
    Number.isFinite(landmark.z)
  )
}

function fingerDescriptor(name: string) {
  const match = FINGER_BONE_PATTERN.exec(name)
  if (!match) return null
  return {
    side: match[1] as HandSide,
    finger: match[2] as FingerName,
    joint: Number(match[3])
  }
}

/**
 * Geometry-based retargeting for the supplied Deafference character rig.
 *
 * This intentionally does not claim linguistic translation. It transfers the
 * motion already present in a video or camera feed onto the avatar skeleton.
 */
export class AvatarRetargeter {
  private readonly root: Object3D
  private readonly bones = new Map<string, Bone>()
  private readonly rest = new Map<Object3D, RestTransform>()
  private readonly targets = new Map<string, Quaternion>()
  private readonly positionTargets = new Map<string, Vector3>()
  private readonly desiredWorld = new Map<Object3D, Quaternion>()
  private readonly lastSeen = new Map<string, number>()
  private readonly morphs = new Map<string, MorphBinding[]>()
  private readonly morphTargets = new Map<string, number>()
  private readonly scalarHistory = new Map<string, ScalarSample>()
  private readonly fingerRig = new Map<string, FingerRig>()
  private readonly handBendState = new Map<HandSide, BendState>()
  private faceBaseline: Quaternion | null = null
  private faceCalibrationFrames = 0
  private smoothing = 15
  private trackingStrength = 1

  constructor(root: Object3D) {
    this.root = root
    root.updateMatrixWorld(true)

    const actualBones = new Map<string, Bone>()

    root.traverse((node) => {
      this.rest.set(node, {
        local: node.quaternion.clone(),
        world: node.getWorldQuaternion(new Quaternion()),
        localPosition: node.position.clone(),
        position: node.getWorldPosition(new Vector3())
      })

      if ((node as Bone).isBone) actualBones.set(node.name, node as Bone)

      const mesh = node as SkinnedMesh
      if (mesh.morphTargetDictionary && mesh.morphTargetInfluences) {
        Object.entries(mesh.morphTargetDictionary).forEach(([name, index]) => {
          const bindings = this.morphs.get(name) ?? []
          bindings.push({ mesh, index })
          this.morphs.set(name, bindings)
        })
      }
    })

    for (const [semanticName, aliases] of Object.entries(BONE_ALIASES)) {
      const match = aliases.map((name) => actualBones.get(name)).find(Boolean)
      if (match) this.bones.set(semanticName, match)
    }

    this.prepareFingerRig()

    CONTROLLED_BONES.forEach((name) => {
      const transform = this.rest.get(this.bones.get(name) as Object3D)
      if (!transform) return
      this.targets.set(name, transform.local.clone())
      this.positionTargets.set(name, transform.localPosition.clone())
    })
  }

  setSmoothing(value: number) {
    this.smoothing = Math.max(4, Math.min(28, value))
  }

  setStrength(value: number) {
    this.trackingStrength = clamp01(value)
  }

  resetCalibration() {
    this.faceBaseline = null
    this.faceCalibrationFrames = 0
    this.scalarHistory.clear()
    this.handBendState.clear()
  }

  reset() {
    this.resetCalibration()
    this.desiredWorld.clear()
    CONTROLLED_BONES.forEach((name) => {
      const bone = this.bones.get(name)
      const transform = bone && this.rest.get(bone)
      if (!transform) return
      this.targets.set(name, transform.local.clone())
      this.positionTargets.set(name, transform.localPosition.clone())
    })
    this.morphTargets.clear()
  }

  update(frame: TrackingFrame) {
    this.desiredWorld.clear()
    const pose = frame.poseLandmarks

    if (pose?.length) {
      this.driveTorso(pose, frame.timestamp)
      this.driveArm('Left', pose, frame.leftHandLandmarks, frame.timestamp)
      this.driveArm('Right', pose, frame.rightHandLandmarks, frame.timestamp)
    }

    if (frame.faceLandmarks?.length) {
      this.driveHead(frame.faceLandmarks, frame.timestamp)
      this.driveFace(frame.faceLandmarks, frame.timestamp)
    }
  }

  tick(deltaSeconds: number, now = performance.now(), allowStaleReset = true) {
    const alpha = 1 - Math.exp(-this.smoothing * Math.min(0.05, deltaSeconds))

    for (const name of CONTROLLED_BONES) {
      const bone = this.bones.get(name)
      const rest = bone && this.rest.get(bone)
      if (!bone || !rest) continue

      // Holistic can briefly miss a hand during contact or motion blur. Keep
      // the last plausible pose long enough to bridge that gap instead of
      // visibly pumping the rig back toward its rest pose between frames.
      const staleAfter = fingerDescriptor(name) ? 1400 : 900
      const stale = allowStaleReset && now - (this.lastSeen.get(name) ?? 0) > staleAfter
      const requested = stale ? rest.local : this.targets.get(name) ?? rest.local
      const target = rest.local
        .clone()
        .slerp(requested, this.trackingStrength)

      if (bone.quaternion.dot(target) < 0) {
        target.set(-target.x, -target.y, -target.z, -target.w)
      }
      bone.quaternion.slerp(target, alpha)
    }

    for (const name of POSITION_CONTROLLED_BONES) {
      const bone = this.bones.get(name)
      const rest = bone && this.rest.get(bone)
      if (!bone || !rest) continue

      const stale = allowStaleReset && now - (this.lastSeen.get(name) ?? 0) > 900
      const requested = stale
        ? rest.localPosition
        : this.positionTargets.get(name) ?? rest.localPosition
      const target = rest.localPosition
        .clone()
        .lerp(requested, this.trackingStrength)
      bone.position.lerp(target, alpha)
    }

    for (const [name, bindings] of this.morphs) {
      const target = this.morphTargets.get(name) ?? 0
      bindings.forEach(({ mesh, index }) => {
        if (!mesh.morphTargetInfluences) return
        const current = mesh.morphTargetInfluences[index] ?? 0
        mesh.morphTargetInfluences[index] = current + (target - current) * alpha
      })
    }
  }

  private prepareFingerRig() {
    for (const side of ['Left', 'Right'] as const) {
      const handPosition = this.worldPosition(`${side}Hand`)
      const indexPosition = this.worldPosition(`${side}HandIndex1`)
      const middlePosition = this.worldPosition(`${side}HandMiddle1`)
      const pinkyPosition = this.worldPosition(`${side}HandPinky1`)
      if (!handPosition || !indexPosition || !middlePosition || !pinkyPosition) continue

      const across = indexPosition.clone().sub(pinkyPosition)
      const forward = middlePosition.clone().sub(handPosition)
      const palmNormal = new Vector3().crossVectors(across, forward)
      if (palmNormal.lengthSq() < 1e-8) continue
      palmNormal.normalize()

      for (const finger of FINGER_NAMES) {
        for (let joint = 1; joint <= 3; joint += 1) {
          const boneName = `${side}Hand${finger}${joint}`
          const childName = `${side}Hand${finger}${joint + 1}`
          const bone = this.bones.get(boneName)
          const rest = bone && this.rest.get(bone)
          const direction = this.restDirection(boneName, childName)
          if (!bone || !rest || !direction) continue

          // Each phalanx has one fixed anatomical flexion axis. Converting the
          // rest-pose palm axes into the bone's local space prevents parent
          // rotation from adding twist to PIP and DIP joints.
          const flexAxis = new Vector3().crossVectors(direction, palmNormal)
          if (flexAxis.lengthSq() < 1e-8) continue
          flexAxis
            .normalize()
            .applyQuaternion(rest.world.clone().invert())
            .normalize()
          const spreadAxis = palmNormal
            .clone()
            .applyQuaternion(rest.world.clone().invert())
            .normalize()
          this.fingerRig.set(boneName, { flexAxis, spreadAxis })
        }
      }
    }
  }

  private driveTorso(pose: readonly Landmark[], timestamp: number) {
    const ls = pose[POSE.leftShoulder]
    const rs = pose[POSE.rightShoulder]
    const lh = pose[POSE.leftHip]
    const rh = pose[POSE.rightHip]
    if (!usable(ls, rs) || !usable(lh, rh)) return

    const restLeft = this.worldPosition('LeftShoulder')
    const restRight = this.worldPosition('RightShoulder')
    const restHips = this.worldPosition('Hips')
    const restNeck = this.worldPosition('Neck')
    if (!restLeft || !restRight || !restHips || !restNeck) return

    const sourceAcross = mappedPoint(rs).sub(mappedPoint(ls))
    const sourceUp = midpoint(ls, rs).sub(midpoint(lh, rh))
    const restAcross = restRight.clone().sub(restLeft)
    const restUp = restNeck.clone().sub(restHips)

    const sourceBasis = basisQuaternion(sourceAcross, sourceUp)
    const restBasis = basisQuaternion(restAcross, restUp)
    const delta = sourceBasis.multiply(restBasis.invert())

    // Torso tracking is deliberately restrained; noisy torso rotation ruins
    // hand placement more than it helps a front-facing signing clip.
    delta.slerp(identityQuaternion, 0.42)
    this.setFromWorld('Spine2', delta.multiply(this.worldQuaternion('Spine2')), timestamp)
  }

  private driveArm(
    side: HandSide,
    pose: readonly Landmark[],
    hand: readonly Landmark[] | undefined,
    timestamp: number
  ) {
    const shoulderIndex = side === 'Left' ? POSE.leftShoulder : POSE.rightShoulder
    const elbowIndex = side === 'Left' ? POSE.leftElbow : POSE.rightElbow
    const wristIndex = side === 'Left' ? POSE.leftWrist : POSE.rightWrist

    const shoulder = pose[shoulderIndex]
    const elbow = pose[elbowIndex]
    const wrist = pose[wristIndex]

    if (usable(shoulder, elbow)) {
      this.alignBone(
        `${side}Arm`,
        `${side}ForeArm`,
        mappedDirection(shoulder, elbow),
        timestamp
      )
    }

    if (usable(elbow, wrist)) {
      this.alignBone(
        `${side}ForeArm`,
        `${side}Hand`,
        mappedDirection(elbow, wrist),
        timestamp
      )
    }

    if (!hand || !this.handGeometryIsUsable(hand)) return
    const handFrame = this.alignHand(side, hand, timestamp)
    if (handFrame) this.alignFingers(side, hand, handFrame, timestamp)
  }

  private alignHand(side: HandSide, hand: readonly Landmark[], timestamp: number): HandFrame | null {
    const boneName = `${side}Hand`
    const handPosition = this.worldPosition(boneName)
    const indexPosition = this.worldPosition(`${side}HandIndex1`)
    const middlePosition = this.worldPosition(`${side}HandMiddle1`)
    const pinkyPosition = this.worldPosition(`${side}HandPinky1`)
    if (!handPosition || !indexPosition || !middlePosition || !pinkyPosition) return null

    const restAcross = indexPosition.clone().sub(pinkyPosition)
    const restForward = middlePosition.clone().sub(handPosition)
    const targetWrist = mappedHandPoint(hand[0])
    const targetAcross = mappedHandPoint(hand[5]).sub(mappedHandPoint(hand[17]))
    const targetForward = mappedHandPoint(hand[9]).sub(targetWrist)

    if (targetAcross.lengthSq() < 1e-6 || targetForward.lengthSq() < 1e-6) return null

    const palmNormal = new Vector3().crossVectors(targetAcross, targetForward)
    const minimumArea = Math.sqrt(targetAcross.lengthSq() * targetForward.lengthSq()) * 0.08
    if (palmNormal.length() < minimumArea) return null
    palmNormal.normalize()

    const restBasis = basisQuaternion(restAcross, restForward)
    const targetBasis = basisQuaternion(targetAcross, targetForward)
    const delta = targetBasis.clone().multiply(restBasis.clone().invert())
    const desiredWorld = delta.clone().multiply(this.worldQuaternion(boneName))
    this.setFromWorld(boneName, desiredWorld, timestamp)
    return { delta, palmNormal }
  }

  private alignFingers(
    side: HandSide,
    hand: readonly Landmark[],
    handFrame: HandFrame,
    timestamp: number
  ) {
    const rawDirections = new Map<FingerName, Vector3[]>()

    for (const finger of FINGER_NAMES) {
      const indices = FINGER_LANDMARKS[finger]
      const directions = [0, 1, 2].map((segment) =>
        mappedHandDirection(hand[indices[segment]], hand[indices[segment + 1]])
      )
      rawDirections.set(finger, directions)
    }

    const preferredBendSign = this.updateHandBendSign(
      side,
      rawDirections,
      handFrame.palmNormal
    )

    for (const finger of FINGER_NAMES) {
      const directions = rawDirections.get(finger)
      if (!directions) continue

      const baseName = `${side}Hand${finger}1`
      const baseChild = `${side}Hand${finger}2`
      const restBaseDirection = this.restDirection(baseName, baseChild)
      if (!restBaseDirection) continue

      const expectedBaseDirection = restBaseDirection.applyQuaternion(handFrame.delta)
      const baseAngles = this.mcpAngles(
        expectedBaseDirection,
        directions[0],
        handFrame.palmNormal
      )
      if (!baseAngles) continue

      const baseFlex = this.anatomicalBend(
        baseAngles.flex,
        preferredBendSign,
        radians(MCP_FLEX_LIMITS[finger]),
        finger === 'Thumb' ? radians(16) : radians(5)
      )
      const spread = Math.max(
        -radians(MCP_SPREAD_LIMITS[finger]),
        Math.min(radians(MCP_SPREAD_LIMITS[finger]), baseAngles.spread)
      )
      this.setFingerRotation(baseName, spread, baseFlex, timestamp)

      let previousBend = Math.abs(baseFlex)
      for (let joint = 2; joint <= 3; joint += 1) {
        const boneName = `${side}Hand${finger}${joint}`
        let maxBend = radians(HINGE_BEND_LIMITS[finger][joint - 2])
        if (joint === 3 && finger !== 'Thumb') {
          // DIP flexion is mechanically coupled to the PIP. This blocks the
          // isolated folded fingertip poses produced by noisy landmarks.
          maxBend = Math.min(maxBend, previousBend * 0.82 + radians(10))
        }
        const signedBend = this.signedHingeAngle(
          directions[joint - 2],
          directions[joint - 1],
          handFrame.palmNormal
        )
        const bend = this.anatomicalBend(
          signedBend,
          finger === 'Thumb' ? undefined : preferredBendSign,
          maxBend,
          finger === 'Thumb' ? radians(14) : radians(4)
        )
        previousBend = Math.abs(bend)
        this.setFingerRotation(boneName, 0, bend, timestamp)
      }
    }
  }

  private handGeometryIsUsable(hand: readonly Landmark[]) {
    if (hand.length < 21 || hand.some((landmark) => !finiteLandmark(landmark))) return false

    const wrist = mappedHandPoint(hand[0])
    const indexBase = mappedHandPoint(hand[5])
    const middleBase = mappedHandPoint(hand[9])
    const pinkyBase = mappedHandPoint(hand[17])
    const palmWidth = indexBase.distanceTo(pinkyBase)
    const palmLength = wrist.distanceTo(middleBase)
    if (palmWidth < 0.01 || palmLength < 0.01) return false

    const palmScale = Math.max(palmWidth, palmLength)
    for (const finger of FINGER_NAMES) {
      const indices = FINGER_LANDMARKS[finger]
      for (let segment = 0; segment < 3; segment += 1) {
        const length = mappedHandPoint(hand[indices[segment]])
          .distanceTo(mappedHandPoint(hand[indices[segment + 1]]))
        if (length < palmScale * 0.035 || length > palmScale * 1.35) return false
      }
    }
    return true
  }

  private signedHingeAngle(parent: Vector3, raw: Vector3, palmNormal: Vector3) {
    const hinge = new Vector3().crossVectors(parent, palmNormal)
    if (hinge.lengthSq() < 1e-8) return 0
    hinge.normalize()

    const projected = raw.clone().addScaledVector(hinge, -raw.dot(hinge))
    if (projected.lengthSq() < 1e-8) return 0
    projected.normalize()

    const cross = new Vector3().crossVectors(parent, projected)
    return Math.atan2(cross.dot(hinge), Math.max(-1, Math.min(1, parent.dot(projected))))
  }

  private updateHandBendSign(
    side: HandSide,
    directions: Map<FingerName, Vector3[]>,
    palmNormal: Vector3
  ) {
    let signedWeight = 0
    let totalWeight = 0

    for (const finger of ['Index', 'Middle', 'Ring', 'Pinky'] as const) {
      const segments = directions.get(finger)
      if (!segments) continue
      for (let joint = 1; joint <= 2; joint += 1) {
        const signed = this.signedHingeAngle(
          segments[joint - 1],
          segments[joint],
          palmNormal
        )
        const magnitude = Math.min(Math.abs(signed), radians(105))
        if (magnitude < radians(9)) continue
        signedWeight += Math.sign(signed) * magnitude
        totalWeight += magnitude
      }
    }

    const previous = this.handBendState.get(side) ?? { score: 0 }
    if (totalWeight === 0) return previous.sign

    const measurement = signedWeight / totalWeight
    const score = previous.score * 0.82 + measurement * 0.18
    let sign = previous.sign
    if (!sign && Math.abs(measurement) > 0.58 && Math.abs(score) > 0.18) {
      sign = Math.sign(score)
    } else if (
      sign &&
      sign * measurement < -0.9 &&
      sign * score < -0.68
    ) {
      // A sign change needs both a near-unanimous frame and sustained history.
      // This keeps an occluded hand from turning every joint inside-out.
      sign = -sign
    }
    this.handBendState.set(side, { score, sign })
    return sign
  }

  private anatomicalBend(
    requested: number,
    preferredSign: number | undefined,
    maximum: number,
    reverseLimit: number
  ) {
    if (!Number.isFinite(requested)) return 0
    const magnitude = Math.min(Math.abs(requested), maximum)
    const requestedSign = Math.sign(requested) || preferredSign || 1
    if (!preferredSign || requestedSign === preferredSign) {
      return requestedSign * magnitude
    }
    return requestedSign * Math.min(magnitude, reverseLimit)
  }

  private mcpAngles(
    expected: Vector3,
    raw: Vector3,
    palmNormal: Vector3
  ) {
    const openDirection = expected.clone().normalize()
    const normal = palmNormal.clone().normalize()

    const expectedInPalm = openDirection.clone().addScaledVector(
      normal,
      -openDirection.dot(normal)
    )
    const rawInPalm = raw.clone().addScaledVector(normal, -raw.dot(normal))
    if (expectedInPalm.lengthSq() < 1e-8 || rawInPalm.lengthSq() < 1e-8) {
      return null
    }
    expectedInPalm.normalize()
    rawInPalm.normalize()

    const spreadCross = new Vector3().crossVectors(expectedInPalm, rawInPalm)
    const spreadAngle = Math.atan2(
      spreadCross.dot(normal),
      Math.max(-1, Math.min(1, expectedInPalm.dot(rawInPalm)))
    )
    const spreadDirection = openDirection
      .clone()
      .applyAxisAngle(normal, spreadAngle)
      .normalize()

    const flexAxis = new Vector3().crossVectors(spreadDirection, normal)
    if (flexAxis.lengthSq() < 1e-8) return null
    flexAxis.normalize()

    const rawFlexPlane = raw.clone().addScaledVector(flexAxis, -raw.dot(flexAxis))
    if (rawFlexPlane.lengthSq() < 1e-8) return null
    rawFlexPlane.normalize()

    const flexCross = new Vector3().crossVectors(spreadDirection, rawFlexPlane)
    const flexAngle = Math.atan2(
      flexCross.dot(flexAxis),
      Math.max(-1, Math.min(1, spreadDirection.dot(rawFlexPlane)))
    )
    return { spread: spreadAngle, flex: flexAngle }
  }

  private setFingerRotation(
    boneName: string,
    requestedSpread: number,
    requestedFlex: number,
    timestamp: number
  ) {
    const bone = this.bones.get(boneName)
    const rest = bone && this.rest.get(bone)
    const rig = this.fingerRig.get(boneName)
    if (!bone || !rest || !rig) return

    const spread = this.filterScalar(
      `${boneName}:spread`,
      requestedSpread,
      timestamp,
      false
    )
    const flex = this.filterScalar(
      `${boneName}:flex`,
      requestedFlex,
      timestamp,
      true
    )
    const target = rest.local
      .clone()
      .multiply(new Quaternion().setFromAxisAngle(rig.spreadAxis, spread))
      .multiply(new Quaternion().setFromAxisAngle(rig.flexAxis, flex))
      .normalize()

    this.targets.set(boneName, target)
    const parentWorld = this.resolveDesiredWorld(bone.parent)
    this.desiredWorld.set(bone, parentWorld.multiply(target))
    this.lastSeen.set(boneName, timestamp)
  }

  private filterScalar(
    name: string,
    requested: number,
    timestamp: number,
    fast: boolean
  ) {
    const previous = this.scalarHistory.get(name)
    if (!previous) {
      this.scalarHistory.set(name, { value: requested, timestamp })
      return requested
    }

    const elapsed = Math.max(1 / 240, Math.min(0.12, (timestamp - previous.timestamp) / 1000))
    const maximumSpeed = radians(fast ? 720 : 360)
    const baseAllowance = radians(fast ? 8 : 4)
    const maximumDelta = baseAllowance + maximumSpeed * elapsed
    const delta = Math.max(
      -maximumDelta,
      Math.min(maximumDelta, requested - previous.value)
    )
    const limited = previous.value + delta
    const response = fast ? 17 : 13
    const alpha = 1 - Math.exp(-response * elapsed)
    const filtered = previous.value + (limited - previous.value) * alpha
    this.scalarHistory.set(name, { value: filtered, timestamp })
    return filtered
  }

  private driveHead(face: readonly Landmark[], timestamp: number) {
    const rightEye = face[33]
    const leftEye = face[263]
    const forehead = face[10]
    const chin = face[152]
    if (!rightEye || !leftEye || !forehead || !chin) return

    const across = mappedPoint(rightEye).sub(mappedPoint(leftEye))
    const up = mappedPoint(forehead).sub(mappedPoint(chin))
    const current = basisQuaternion(across, up)

    if (!this.faceBaseline) {
      this.faceBaseline = current.clone()
      this.faceCalibrationFrames = 1
      return
    }

    if (this.faceCalibrationFrames < 10) {
      this.faceCalibrationFrames += 1
      this.faceBaseline.slerp(current, 1 / this.faceCalibrationFrames)
    }

    const delta = current.multiply(this.faceBaseline.clone().invert())
    delta.slerp(identityQuaternion, 0.18)
    this.setFromWorld('Head', delta.multiply(this.worldQuaternion('Head')), timestamp)
  }

  private driveFace(face: readonly Landmark[], timestamp: number) {
    const distance = (a: number, b: number) => {
      const p1 = face[a]
      const p2 = face[b]
      if (!p1 || !p2) return 0
      return Math.hypot(p1.x - p2.x, p1.y - p2.y, p1.z - p2.z)
    }

    const mouthWidth = Math.max(0.001, distance(61, 291))
    const mouthOpen = distance(13, 14) / mouthWidth
    const leftEyeWidth = Math.max(0.001, distance(33, 133))
    const rightEyeWidth = Math.max(0.001, distance(362, 263))
    const leftEyeOpen = distance(159, 145) / leftEyeWidth
    const rightEyeOpen = distance(386, 374) / rightEyeWidth

    const faceWidth = Math.max(0.001, distance(234, 454))
    const leftBrowGap = distance(105, 159) / faceWidth
    const rightBrowGap = distance(334, 386) / faceWidth

    const mouthAmount = clamp01((mouthOpen - 0.025) * 6.4)
    const leftBlink = clamp01((0.19 - leftEyeOpen) * 8)
    const rightBlink = clamp01((0.19 - rightEyeOpen) * 8)
    const smile = clamp01((mouthWidth / faceWidth - 0.34) * 5)
    const leftBrow = clamp01((leftBrowGap - 0.105) * 9)
    const rightBrow = clamp01((rightBrowGap - 0.105) * 9)

    // Keep morph support for compatible replacement rigs, while the supplied
    // GLB uses the equivalent jaw/eyelid/brow/mouth bones below.
    this.morphTargets.set('mouthOpen', mouthAmount)
    this.morphTargets.set('eyeBlinkLeft', leftBlink)
    this.morphTargets.set('eyeBlinkRight', rightBlink)
    this.morphTargets.set('mouthSmile', smile)

    this.setLocalRotationDelta('Jaw', new Vector3(1, 0, 0), 0.34 * mouthAmount, timestamp)
    this.setLocalRotationDelta('LeftEyelid', new Vector3(1, 0, 0), 0.28 * leftBlink, timestamp)
    this.setLocalRotationDelta('RightEyelid', new Vector3(1, 0, 0), 0.28 * rightBlink, timestamp)

    this.setLocalPositionOffset('LeftEyebrow', new Vector3(0, 0.008 * leftBrow, 0), timestamp)
    this.setLocalPositionOffset('RightEyebrow', new Vector3(0, 0.008 * rightBrow, 0), timestamp)
    this.setLocalPositionOffset(
      'LeftMouth',
      new Vector3(0.0045 * smile, 0.0035 * smile - 0.0025 * mouthAmount, 0),
      timestamp
    )
    this.setLocalPositionOffset(
      'RightMouth',
      new Vector3(-0.0045 * smile, 0.0035 * smile - 0.0025 * mouthAmount, 0),
      timestamp
    )
  }

  private setLocalRotationDelta(
    boneName: string,
    axis: Vector3,
    angle: number,
    timestamp: number
  ) {
    const bone = this.bones.get(boneName)
    const rest = bone && this.rest.get(bone)
    if (!bone || !rest) return
    const target = rest.local
      .clone()
      .multiply(new Quaternion().setFromAxisAngle(axis, angle))
      .normalize()
    this.targets.set(boneName, target)
    this.lastSeen.set(boneName, timestamp)
  }

  private setLocalPositionOffset(boneName: string, offset: Vector3, timestamp: number) {
    const bone = this.bones.get(boneName)
    const rest = bone && this.rest.get(bone)
    if (!bone || !rest) return
    this.positionTargets.set(boneName, rest.localPosition.clone().add(offset))
    this.lastSeen.set(boneName, timestamp)
  }

  private alignBone(
    boneName: string,
    childName: string,
    targetDirection: Vector3,
    timestamp: number
  ) {
    if (targetDirection.lengthSq() < 1e-6) return
    const bonePosition = this.worldPosition(boneName)
    const childPosition = this.worldPosition(childName)
    if (!bonePosition || !childPosition) return

    const restDirection = childPosition.sub(bonePosition).normalize()
    const delta = tmpQuaternionA.setFromUnitVectors(restDirection, targetDirection)
    const desiredWorld = tmpQuaternionB
      .copy(delta)
      .multiply(this.worldQuaternion(boneName))
      .clone()

    this.setFromWorld(boneName, desiredWorld, timestamp)
  }

  private setFromWorld(boneName: string, desiredWorld: Quaternion, timestamp: number) {
    const bone = this.bones.get(boneName)
    if (!bone) return

    const parentWorld = this.resolveDesiredWorld(bone.parent)
    const local = tmpQuaternionC
      .copy(parentWorld)
      .invert()
      .multiply(desiredWorld)
      .normalize()
      .clone()

    this.targets.set(boneName, local)
    this.desiredWorld.set(bone, parentWorld.clone().multiply(local))
    this.lastSeen.set(boneName, timestamp)
  }

  private resolveDesiredWorld(node: Object3D | null): Quaternion {
    if (!node) return new Quaternion()
    const direct = this.desiredWorld.get(node)
    if (direct) return direct.clone()

    const rest = this.rest.get(node)
    if (!rest) return node.getWorldQuaternion(new Quaternion())
    if (!node.parent || !this.rest.has(node.parent)) return rest.world.clone()

    return this.resolveDesiredWorld(node.parent).multiply(rest.local)
  }

  private worldPosition(name: string) {
    const bone = this.bones.get(name)
    return bone ? this.rest.get(bone)?.position.clone() ?? null : null
  }

  private restDirection(name: string, childName: string) {
    const start = this.worldPosition(name)
    const end = this.worldPosition(childName)
    return start && end ? end.sub(start).normalize() : null
  }

  private worldQuaternion(name: string) {
    const bone = this.bones.get(name)
    return bone ? this.rest.get(bone)?.world.clone() ?? new Quaternion() : new Quaternion()
  }
}
