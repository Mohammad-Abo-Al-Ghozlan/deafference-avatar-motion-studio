import { Quaternion, Vector3 } from 'three'
import { angleBetweenQuaternions, DEG, RAD, signedAngleAbout, swingTwist } from '../math'
import type { AvatarMotionFile } from '../clip/format'
import type { Rig } from '../rig/Rig'
import { azimuth, elevation, type RigGeometry } from '../rig/rigGeometry'
import { LONG_FINGERS, SIDES, type SemanticSkeleton, type Side } from '../rig/semanticMap'
import { PoseState } from '../retarget/PoseState'

/**
 * Anatomical and temporal QA of an avatar-motion file against the rig.
 * Everything is reconstructed from the exported LOCAL quaternions, so the
 * same metrics can be run on any solver's output (new or legacy).
 */

export interface QaThresholds {
  quaternionNormTolerance: number
  hingeOffAxisDeg: number
  fingerTwistDeg: number
  pipRangeDeg: [number, number]
  dipRangeDeg: [number, number]
  mcpFlexRangeDeg: [number, number]
  thumbHingeRangeDeg: [number, number]
  elbowRangeDeg: [number, number]
  wristFlexDeg: number
  wristExtDeg: number
  wristRadialDeg: number
  wristUlnarDeg: number
  wristTwistDeg: number
  limitToleranceDeg: number
  spikeDeg: Record<'finger' | 'wrist' | 'arm' | 'trunk' | 'face', number>
  crossingToleranceDeg: number
  palmPenetrationM: number
  /** Wrist speed above which a frame counts as fast motion (reported, m/s). */
  wristFastSpeedMs: number
  /** Physiologically implausible wrist speed (hard fail, m/s). */
  wristMaxSpeedMs: number
  /** A fast step this many times larger than both neighbouring steps is an
   *  impulsive discontinuity (identity swap / pop signature), not motion. */
  wristImpulseRatio: number
}

export const DEFAULT_QA: QaThresholds = {
  quaternionNormTolerance: 1e-3,
  hingeOffAxisDeg: 1,
  fingerTwistDeg: 3,
  pipRangeDeg: [-5, 110],
  dipRangeDeg: [-10, 85],
  mcpFlexRangeDeg: [-25, 95],
  thumbHingeRangeDeg: [-20, 88],
  elbowRangeDeg: [0, 150],
  wristFlexDeg: 80,
  wristExtDeg: 70,
  wristRadialDeg: 28,
  wristUlnarDeg: 40,
  wristTwistDeg: 100,
  limitToleranceDeg: 0.5,
  spikeDeg: { finger: 20, wrist: 20, arm: 15, trunk: 8, face: 12 },
  crossingToleranceDeg: 30,
  palmPenetrationM: 0.004,
  wristFastSpeedMs: 3.6,
  wristMaxSpeedMs: 7.5,
  wristImpulseRatio: 2.5
}

interface Counter {
  frames: number
  max: number
  firstFrames: number[]
}

function counter(): Counter {
  return { frames: 0, max: 0, firstFrames: [] }
}

function hit(c: Counter, frame: number, magnitude: number) {
  c.frames += 1
  c.max = Math.max(c.max, magnitude)
  if (c.firstFrames.length < 12) c.firstFrames.push(frame)
}

export interface QaResult {
  structural: Record<string, unknown>
  numeric: Record<string, unknown>
  anatomical: Record<string, unknown>
  temporal: Record<string, unknown>
  failures: string[]
}

function boneClass(name: string): keyof QaThresholds['spikeDeg'] {
  if (/^(thumb|index|middle|ring|pinky)_/.test(name)) return 'finger'
  if (/^hand_/.test(name)) return 'wrist'
  if (/^(upperarm|lowerarm|shoulder)/.test(name)) return 'arm'
  if (/^(jaw|eyelid|eyebrow|mouth|eye_)/.test(name)) return 'face'
  return 'trunk'
}

export function evaluateMotion(motion: AvatarMotionFile, rig: Rig, map: SemanticSkeleton, geometry: RigGeometry, t: QaThresholds = DEFAULT_QA): QaResult {
  const failures: string[] = []
  const n = motion.frameCount
  const rotationTracks = motion.tracks.filter((track) => track.path === 'rotation')
  const translationTracks = motion.tracks.filter((track) => track.path === 'translation')

  // ---- Structural
  const missingBones = motion.tracks.filter((track) => !rig.has(track.bone)).map((track) => track.bone)
  const badLength = motion.tracks.filter((track) => track.values.length !== n * (track.path === 'rotation' ? 4 : 3)).map((track) => track.bone)
  const timelineOk = motion.timeline.sourceFrame.length === n && motion.timeline.sourceTime.length === n
  let sourceMonotonic = true
  let lastTime = -Infinity
  let lastFrame = -Infinity
  for (let k = 0; k < n; k += 1) {
    const time = motion.timeline.sourceTime[k]
    const frame = motion.timeline.sourceFrame[k]
    if (time !== null) {
      if (!(time > lastTime)) sourceMonotonic = false
      lastTime = time
    }
    if (frame !== null) {
      if (!(frame > lastFrame)) sourceMonotonic = false
      lastFrame = frame
    }
  }
  const expectedFrames = Math.round(motion.durationSec * motion.fps) + 1
  const structural = {
    frameCount: n,
    fps: motion.fps,
    durationSec: motion.durationSec,
    expectedFrames,
    missingFrames: Math.max(0, expectedFrames - n),
    rotationTracks: rotationTracks.length,
    translationTracks: translationTracks.length,
    tracksWithUnknownBones: missingBones,
    tracksWithWrongLength: badLength,
    timelineMappingComplete: timelineOk,
    timestampsMonotonic: sourceMonotonic,
    gridTimestampsMonotonic: true
  }
  if (missingBones.length) failures.push(`tracks reference bones missing from the rig: ${missingBones.join(', ')}`)
  if (badLength.length) failures.push(`tracks with wrong length: ${badLength.join(', ')}`)
  if (structural.missingFrames) failures.push(`${structural.missingFrames} missing frames`)
  if (!sourceMonotonic) failures.push('source timestamps/frames are not monotonic')

  // ---- Numeric
  let nonFinite = 0
  let maxNormError = 0
  let hemisphereFlips = 0
  for (const track of motion.tracks) {
    for (const value of track.values) if (!Number.isFinite(value)) nonFinite += 1
  }
  for (const track of rotationTracks) {
    const v = track.values
    for (let k = 0; k < n; k += 1) {
      const norm = Math.hypot(v[k * 4], v[k * 4 + 1], v[k * 4 + 2], v[k * 4 + 3])
      maxNormError = Math.max(maxNormError, Math.abs(norm - 1))
      if (k > 0) {
        const dot = v[k * 4] * v[k * 4 - 4] + v[k * 4 + 1] * v[k * 4 - 3] + v[k * 4 + 2] * v[k * 4 - 2] + v[k * 4 + 3] * v[k * 4 - 1]
        if (dot < 0) hemisphereFlips += 1
      }
    }
  }
  let maxTranslationOffset = 0
  for (const track of translationTracks) {
    const rest = rig.get(track.bone).restLocalPosition
    for (let k = 0; k < n; k += 1) {
      maxTranslationOffset = Math.max(maxTranslationOffset, Math.hypot(track.values[k * 3] - rest.x, track.values[k * 3 + 1] - rest.y, track.values[k * 3 + 2] - rest.z))
    }
  }
  const numeric = {
    nonFiniteValues: nonFinite,
    maxQuaternionNormError: maxNormError,
    quaternionHemisphereFlips: hemisphereFlips,
    maxFaceTranslationOffsetM: maxTranslationOffset
  }
  if (nonFinite) failures.push(`${nonFinite} NaN/Inf values`)
  if (maxNormError > t.quaternionNormTolerance) failures.push(`quaternion norm error ${maxNormError.toExponential(2)} exceeds ${t.quaternionNormTolerance}`)
  if (hemisphereFlips) failures.push(`${hemisphereFlips} quaternion sign flips between consecutive frames`)
  if (maxTranslationOffset > 0.02) failures.push(`face bone translation offset ${maxTranslationOffset.toFixed(4)} m exceeds 2 cm`)

  // ---- Anatomical (per frame reconstruction)
  const pose = new PoseState(rig)
  const trackByBone = new Map(rotationTracks.map((track) => [track.bone, track.values]))
  const translationByBone = new Map(translationTracks.map((track) => [track.bone, track.values]))
  const q = new Quaternion()
  const localAt = (bone: string, k: number) => {
    const v = trackByBone.get(bone)
    return v ? q.set(v[k * 4], v[k * 4 + 1], v[k * 4 + 2], v[k * 4 + 3]).clone().normalize() : rig.get(bone).restLocalQuaternion.clone()
  }
  const hingeOffAxis = { pip: counter(), dip: counter(), thumbMcp: counter(), thumbIp: counter(), elbow: counter() }
  const range = { pip: counter(), dip: counter(), mcp: counter(), thumb: counter(), elbowHyperextension: counter(), elbowOverflex: counter() }
  const reverseBend = { pip: counter(), dip: counter() }
  const twist = { finger: counter() }
  const wrist = { flex: counter(), dev: counter(), twist: counter() }
  const crossing = counter()
  const penetration = counter()
  const restResets = counter()
  const extremes = { pip: [Infinity, -Infinity], dip: [Infinity, -Infinity], mcp: [Infinity, -Infinity], elbow: [Infinity, -Infinity], wristFlex: [Infinity, -Infinity], wristDev: [Infinity, -Infinity], wristTwist: [Infinity, -Infinity], fingerTwist: 0, hingeOffAxis: 0 }
  const updateExtreme = (key: 'pip' | 'dip' | 'mcp' | 'elbow' | 'wristFlex' | 'wristDev' | 'wristTwist', value: number) => {
    extremes[key][0] = Math.min(extremes[key][0], value)
    extremes[key][1] = Math.max(extremes[key][1], value)
  }
  const tol = t.limitToleranceDeg
  // Hinge purity is judged against each joint's own dominant axis (so any
  // solver that rotates a joint about ONE fixed axis passes), and that axis
  // is also compared with the rig's anatomical hinge axis.
  const rotationVectors = new Map<string, { kind: keyof typeof hingeOffAxis; anatomical: Vector3; vectors: Vector3[] }>()
  const recordRotationVector = (key: string, kind: keyof typeof hingeOffAxis, anatomical: Vector3, delta: Quaternion, frame: number) => {
    const entry = rotationVectors.get(key) ?? { kind, anatomical: anatomical.clone(), vectors: [] }
    const d = delta.w < 0 ? new Quaternion(-delta.x, -delta.y, -delta.z, -delta.w) : delta
    const angle = 2 * Math.acos(Math.min(1, d.w))
    const axis = new Vector3(d.x, d.y, d.z)
    entry.vectors[frame] = axis.lengthSq() > 1e-12 ? axis.normalize().multiplyScalar(angle) : new Vector3()
    rotationVectors.set(key, entry)
  }
  let maxBoneLengthErrorM = 0
  const wristTrack: Record<Side, Float64Array> = { left: new Float64Array(n * 3), right: new Float64Array(n * 3) }

  for (let k = 0; k < n; k += 1) {
    for (const [bone, values] of trackByBone) pose.local[pose.index(bone)].set(values[k * 4], values[k * 4 + 1], values[k * 4 + 2], values[k * 4 + 3]).normalize()
    for (const [bone, values] of translationByBone) pose.localPosition[pose.index(bone)].set(values[k * 3], values[k * 3 + 1], values[k * 3 + 2])

    for (const side of SIDES) {
      const hand = geometry.hands[side]
      const arm = geometry.arms[side]
      const handState = motion.quality.handState[side][k]

      // Elbow: pure hinge about the rig's elbow axis.
      const foreDelta = localAt(arm.forearm, k).multiply(rig.get(arm.forearm).restLocalQuaternion.clone().invert())
      const fore = swingTwist(foreDelta, arm.elbowAxisUpper)
      recordRotationVector(`${side}.elbow`, 'elbow', arm.elbowAxisUpper, foreDelta, k)
      const elbowFlex = (arm.restElbowFlexion + fore.twistAngle) * RAD
      updateExtreme('elbow', elbowFlex)
      if (elbowFlex < t.elbowRangeDeg[0] - tol) hit(range.elbowHyperextension, k, t.elbowRangeDeg[0] - elbowFlex)
      if (elbowFlex > t.elbowRangeDeg[1] + tol) hit(range.elbowOverflex, k, elbowFlex - t.elbowRangeDeg[1])

      // Wrist: swing (twist-carried anatomical axes) and pronation twist.
      const handDelta = localAt(arm.hand, k).multiply(rig.get(arm.hand).restLocalQuaternion.clone().invert())
      const forearmRestInv = rig.get(arm.forearm).restWorldQuaternion.clone().invert()
      const twistAxis = arm.forearmAxisLocal.clone().normalize()
      const flexAxis0 = new Vector3().crossVectors(hand.palm.forward, hand.palm.volar).normalize().applyQuaternion(forearmRestInv)
      flexAxis0.addScaledVector(twistAxis, -flexAxis0.dot(twistAxis)).normalize()
      const devAxis0 = new Vector3().crossVectors(twistAxis, flexAxis0).normalize()
      if (devAxis0.dot(hand.palm.volar.clone().multiplyScalar(-hand.handSign).applyQuaternion(forearmRestInv)) < 0) devAxis0.negate()
      const w = swingTwist(handDelta, arm.forearmAxisLocal)
      const twistQ = new Quaternion().setFromAxisAngle(arm.forearmAxisLocal, w.twistAngle)
      const swingAngle = 2 * Math.acos(Math.min(1, Math.abs(w.swing.w)))
      const swingAxis = new Vector3(w.swing.x, w.swing.y, w.swing.z)
      if (w.swing.w < 0) swingAxis.negate()
      const rv = swingAxis.lengthSq() > 1e-12 ? swingAxis.normalize().multiplyScalar(swingAngle) : new Vector3()
      const flexDeg = rv.dot(flexAxis0.clone().applyQuaternion(twistQ)) * RAD
      const devDeg = rv.dot(devAxis0.clone().applyQuaternion(twistQ)) * RAD
      const twistDeg = w.twistAngle * RAD
      updateExtreme('wristFlex', flexDeg)
      updateExtreme('wristDev', devDeg)
      updateExtreme('wristTwist', twistDeg)
      if (flexDeg > t.wristFlexDeg + tol || flexDeg < -t.wristExtDeg - tol) hit(wrist.flex, k, Math.max(flexDeg - t.wristFlexDeg, -t.wristExtDeg - flexDeg))
      if (devDeg > t.wristRadialDeg + tol || devDeg < -t.wristUlnarDeg - tol) hit(wrist.dev, k, Math.max(devDeg - t.wristRadialDeg, -t.wristUlnarDeg - devDeg))
      if (Math.abs(twistDeg) > t.wristTwistDeg + tol) hit(wrist.twist, k, Math.abs(twistDeg) - t.wristTwistDeg)

      // Long fingers.
      const azimuths: number[] = []
      const flexions: number[] = []
      let allRest = true
      for (const finger of LONG_FINGERS) {
        const g = hand.fingers[finger]
        const l1 = localAt(g.mcp.bone, k)
        const l2 = localAt(g.pip.bone, k)
        const l3 = localAt(g.dip.bone, k)
        for (const [bone, local] of [[g.mcp.bone, l1], [g.pip.bone, l2], [g.dip.bone, l3]] as const) {
          if (angleBetweenQuaternions(local, rig.get(bone).restLocalQuaternion) > 0.5 * DEG) allRest = false
        }
        for (const [joint, local, geo, limits, reverse] of [
          ['pip', l2, g.pip, t.pipRangeDeg, reverseBend.pip],
          ['dip', l3, g.dip, t.dipRangeDeg, reverseBend.dip]
        ] as const) {
          const delta = local.clone().multiply(rig.get(geo.bone).restLocalQuaternion.clone().invert())
          const st = swingTwist(delta, geo.axisParent)
          recordRotationVector(`${side}.${finger}.${joint}`, joint, geo.axisParent, delta, k)
          const angle = (geo.restAngle + st.twistAngle) * RAD
          updateExtreme(joint, angle)
          if (angle < limits[0] - tol || angle > limits[1] + tol) hit(range[joint], k, Math.max(limits[0] - angle, angle - limits[1]))
          if (angle < limits[0] - tol) hit(reverse, k, limits[0] - angle)
        }
        // MCP: direction in the palm frame, and roll of the finger's hinge
        // relative to the anatomically expected hinge (finger twist).
        const handRestInv = rig.get(hand.hand).restWorldQuaternion.clone().invert()
        const toHand = (v: Vector3) => v.clone().applyQuaternion(handRestInv)
        const palmLocal = { forward: toHand(hand.palm.forward), radial: toHand(hand.palm.radial), volar: toHand(hand.palm.volar), origin: new Vector3(), basis: new Quaternion() }
        const restDir = toHand(rig.get(g.pip.bone).restWorldPosition.clone().sub(rig.get(g.mcp.bone).restWorldPosition).normalize())
        const mcpDelta = l1.clone().multiply(rig.get(g.mcp.bone).restLocalQuaternion.clone().invert())
        const direction = restDir.clone().applyQuaternion(mcpDelta)
        const flex = elevation(direction, palmLocal) * RAD
        const az = azimuth(direction, palmLocal)
        updateExtreme('mcp', flex)
        if (flex < t.mcpFlexRangeDeg[0] - tol || flex > t.mcpFlexRangeDeg[1] + tol) hit(range.mcp, k, Math.max(t.mcpFlexRangeDeg[0] - flex, flex - t.mcpFlexRangeDeg[1]))
        // Finger roll (corkscrew): with MCP = abduction (about the palm normal)
        // followed by flexion (about the abducted hinge), the PIP hinge axis
        // always stays in the palm plane. Its elevation out of that plane is
        // the unintended axial twist, well defined at any flexion.
        const actualHinge = g.pip.axisParent.clone().applyQuaternion(l1).normalize()
        const roll = Math.asin(Math.min(1, Math.abs(actualHinge.dot(palmLocal.volar)))) * RAD
        extremes.fingerTwist = Math.max(extremes.fingerTwist, roll)
        if (roll > t.fingerTwistDeg) hit(twist.finger, k, roll)
        azimuths.push(az * RAD)
        flexions.push(flex)

        // Fingertip vs palm plane (hand-local FK of the finger chain).
        if (finger === 'middle' || finger === 'ring') {
          const handWorld = pose.worldQuaternion(hand.hand).invert()
          const handPos = pose.worldPosition(hand.hand)
          const tip = pose.worldPosition(map.arms[side].digits[finger][3]).sub(handPos).applyQuaternion(handWorld)
          const origin = toHand(hand.restPositions.wrist.clone().sub(hand.restPositions.wrist))
          const alongForward = tip.clone().sub(origin).dot(palmLocal.forward) / hand.palmLength
          const volarDistance = tip.dot(palmLocal.volar)
          if (alongForward > 0.15 && alongForward < 0.95 && volarDistance < t.palmPenetrationM) hit(penetration, k, t.palmPenetrationM - volarDistance)
        }
      }
      for (let i = 0; i < azimuths.length - 1; i += 1) {
        // Ordered radial->ulnar; flag reversals beyond tolerance when both
        // fingers are extended enough for the order to be visible.
        if (flexions[i] < 60 && flexions[i + 1] < 60 && azimuths[i] - azimuths[i + 1] < -t.crossingToleranceDeg) hit(crossing, k, azimuths[i + 1] - azimuths[i])
      }
      // Thumb hinges.
      for (const [joint, geo] of [['thumbMcp', hand.thumb.mcp], ['thumbIp', hand.thumb.ip]] as const) {
        const delta = localAt(geo.bone, k).multiply(rig.get(geo.bone).restLocalQuaternion.clone().invert())
        const st = swingTwist(delta, geo.axisParent)
        recordRotationVector(`${side}.thumb.${joint}`, joint, geo.axisParent, delta, k)
        const angle = (geo.restAngle + st.twistAngle) * RAD
        if (angle < t.thumbHingeRangeDeg[0] - tol || angle > t.thumbHingeRangeDeg[1] + tol) hit(range.thumb, k, Math.max(t.thumbHingeRangeDeg[0] - angle, angle - t.thumbHingeRangeDeg[1]))
      }
      if (allRest && handState === 'T') hit(restResets, k, 1)

      const wristPos = pose.worldPosition(arm.hand)
      wristTrack[side][k * 3] = wristPos.x
      wristTrack[side][k * 3 + 1] = wristPos.y
      wristTrack[side][k * 3 + 2] = wristPos.z
    }

    // Bone lengths (every 25th frame): rotation-only tracks must preserve them.
    if (k % 25 === 0) {
      for (const joint of rig.joints) {
        if (!joint.isJoint || joint.parent < 0 || !rig.joints[joint.parent].isJoint) continue
        if (translationByBone.has(joint.name)) continue
        const length = pose.worldPosition(joint.name).distanceTo(pose.worldPosition(rig.joints[joint.parent].name))
        maxBoneLengthErrorM = Math.max(maxBoneLengthErrorM, Math.abs(length - joint.restLocalPosition.length()))
      }
    }
  }

  // Wrist trajectory. A teleport is a discontinuity, not a fast movement: an
  // identity swap or pose pop shows up as one step far larger than both of
  // its neighbours, as a jump that immediately jumps back, or as a speed no
  // human wrist reaches. Fast but continuous motion (bell-shaped speed
  // profile over several frames) is reported separately and cross-checked
  // against the source by tools/validate-motion.ts.
  const teleports = counter()
  const fastMotion = counter()
  const fastEvents: { frame: number; side: Side; jumpM: number }[] = []
  const fastStep = t.wristFastSpeedMs / motion.fps
  const maxStep = t.wristMaxSpeedMs / motion.fps
  let maxWristSpeed = 0
  for (const side of SIDES) {
    const p = wristTrack[side]
    const d = new Float64Array(n)
    for (let k = 1; k < n; k += 1) d[k] = Math.hypot(p[k * 3] - p[k * 3 - 3], p[k * 3 + 1] - p[k * 3 - 2], p[k * 3 + 2] - p[k * 3 - 1])
    for (let k = 1; k < n; k += 1) {
      maxWristSpeed = Math.max(maxWristSpeed, d[k] * motion.fps)
      if (d[k] <= fastStep) continue
      const before = k > 1 ? d[k - 1] : 0
      const after = k < n - 1 ? d[k + 1] : 0
      const impulsive = d[k] > t.wristImpulseRatio * Math.max(before, after)
      let backAndForth = false
      if (k < n - 1 && after > fastStep) {
        const skip = Math.hypot(p[k * 3 + 3] - p[k * 3 - 3], p[k * 3 + 4] - p[k * 3 - 2], p[k * 3 + 5] - p[k * 3 - 1])
        backAndForth = skip < 0.5 * Math.min(d[k], after)
      }
      if (impulsive || backAndForth || d[k] > maxStep) hit(teleports, k, d[k])
      else {
        hit(fastMotion, k, d[k])
        if (fastEvents.length < 500) fastEvents.push({ frame: k, side, jumpM: Math.round(d[k] * 1e4) / 1e4 })
      }
    }
  }

  const hingeAxes: Record<string, { axisVsAnatomicalDeg: number; maxOffAxisDeg: number }> = {}
  for (const [key, entry] of rotationVectors) {
    // Dominant axis = principal eigenvector of sum(r r^T) (power iteration).
    const m = [0, 0, 0, 0, 0, 0, 0, 0, 0]
    for (const r of entry.vectors) {
      if (!r) continue
      m[0] += r.x * r.x; m[1] += r.x * r.y; m[2] += r.x * r.z
      m[4] += r.y * r.y; m[5] += r.y * r.z; m[8] += r.z * r.z
    }
    m[3] = m[1]; m[6] = m[2]; m[7] = m[5]
    let axis = entry.anatomical.clone()
    for (let iteration = 0; iteration < 60; iteration += 1) {
      const next = new Vector3(m[0] * axis.x + m[1] * axis.y + m[2] * axis.z, m[3] * axis.x + m[4] * axis.y + m[5] * axis.z, m[6] * axis.x + m[7] * axis.y + m[8] * axis.z)
      if (next.lengthSq() < 1e-18) break
      axis = next.normalize()
    }
    let maxOff = 0
    entry.vectors.forEach((r, frame) => {
      if (!r) return
      const off = r.clone().addScaledVector(axis, -r.dot(axis)).length() * RAD
      maxOff = Math.max(maxOff, off)
      extremes.hingeOffAxis = Math.max(extremes.hingeOffAxis, off)
      if (off > t.hingeOffAxisDeg) hit(hingeOffAxis[entry.kind], frame, off)
    })
    hingeAxes[key] = {
      axisVsAnatomicalDeg: Math.round(Math.min(axis.angleTo(entry.anatomical), axis.clone().negate().angleTo(entry.anatomical)) * RAD * 100) / 100,
      maxOffAxisDeg: Math.round(maxOff * 1000) / 1000
    }
  }

  const summarize = (c: Counter) => ({ frames: c.frames, maxExcessDeg: Math.round(c.max * 100) / 100, firstFrames: c.firstFrames })
  const anatomical = {
    hingeOffAxis: Object.fromEntries(Object.entries(hingeOffAxis).map(([key, c]) => [key, summarize(c)])),
    hingeAxes,
    rangeViolations: Object.fromEntries(Object.entries(range).map(([key, c]) => [key, summarize(c)])),
    reverseBending: Object.fromEntries(Object.entries(reverseBend).map(([key, c]) => [key, summarize(c)])),
    fingerTwist: summarize(twist.finger),
    wristLimitViolations: Object.fromEntries(Object.entries(wrist).map(([key, c]) => [key, summarize(c)])),
    fingerOrderReversals: summarize(crossing),
    fingertipPalmPenetration: { frames: penetration.frames, maxDepthM: Math.round(penetration.max * 1e4) / 1e4, firstFrames: penetration.firstFrames },
    restPoseResetsWhileTracked: restResets.frames,
    wristTeleports: { frames: teleports.frames, maxJumpM: Math.round(teleports.max * 1e3) / 1e3, firstFrames: teleports.firstFrames },
    wristFastMotion: { frames: fastMotion.frames, maxStepM: Math.round(fastMotion.max * 1e3) / 1e3, firstFrames: fastMotion.firstFrames, events: fastEvents },
    maxWristSpeedMs: Math.round(maxWristSpeed * 100) / 100,
    maxBoneLengthErrorM: maxBoneLengthErrorM,
    extremesDeg: Object.fromEntries(Object.entries(extremes).map(([key, value]) => [key, Array.isArray(value) ? value.map((v) => Math.round(v * 10) / 10) : Math.round(value * 100) / 100]))
  }
  if (hingeOffAxis.pip.frames || hingeOffAxis.dip.frames) failures.push('PIP/DIP rotate off their hinge axis (sideways swing / twist)')
  if (hingeOffAxis.thumbMcp.frames || hingeOffAxis.thumbIp.frames) failures.push('thumb MCP/IP rotate off their hinge axis')
  if (hingeOffAxis.elbow.frames) failures.push('elbow rotates off its hinge axis')
  if (reverseBend.pip.frames || reverseBend.dip.frames) failures.push('fingers reverse-bend beyond anatomical hyperextension')
  if (range.pip.frames || range.dip.frames || range.mcp.frames || range.thumb.frames) failures.push('finger joint angles outside anatomical ranges')
  if (range.elbowHyperextension.frames || range.elbowOverflex.frames) failures.push('elbow outside [0, 150] deg')
  if (twist.finger.frames) failures.push('finger twist (corkscrew) beyond tolerance')
  if (wrist.flex.frames || wrist.dev.frames || wrist.twist.frames) failures.push('wrist outside anatomical limits')
  if (crossing.frames) failures.push('adjacent fingers reverse order (crossing)')
  if (restResets.frames) failures.push('hand resets to rest pose while tracked')
  if (teleports.frames) failures.push('wrist teleports: impulsive / implausible wrist jumps (identity swap or pose pop signature)')
  if (maxBoneLengthErrorM > 1e-4) failures.push(`bone length drift ${maxBoneLengthErrorM.toExponential(2)} m`)

  // ---- Temporal
  const temporal: Record<string, unknown> = {}
  const perClass: Record<string, { maxStepDeg: number; p999StepDeg: number; maxVelocityDegS: number; p999AccelerationDegS2: number; spikes: number; spikeFrames: number[]; worstBone: string }> = {}
  for (const track of rotationTracks) {
    const cls = boneClass(track.bone)
    const v = track.values
    const quats: Quaternion[] = []
    for (let k = 0; k < n; k += 1) quats.push(new Quaternion(v[k * 4], v[k * 4 + 1], v[k * 4 + 2], v[k * 4 + 3]).normalize())
    const steps = new Float64Array(n)
    for (let k = 1; k < n; k += 1) steps[k] = angleBetweenQuaternions(quats[k], quats[k - 1]) * RAD
    const entry = perClass[cls] ?? { maxStepDeg: 0, p999StepDeg: 0, maxVelocityDegS: 0, p999AccelerationDegS2: 0, spikes: 0, spikeFrames: [], worstBone: '' }
    let maxStep = 0
    for (let k = 1; k < n; k += 1) maxStep = Math.max(maxStep, steps[k])
    if (maxStep > entry.maxStepDeg) {
      entry.maxStepDeg = maxStep
      entry.worstBone = track.bone
    }
    const sorted = Array.from(steps).sort((a, b) => a - b)
    entry.p999StepDeg = Math.max(entry.p999StepDeg, sorted[Math.floor(0.999 * (n - 1))])
    entry.maxVelocityDegS = Math.max(entry.maxVelocityDegS, maxStep * motion.fps)
    const accel: number[] = []
    for (let k = 2; k < n; k += 1) accel.push(Math.abs(steps[k] - steps[k - 1]) * motion.fps * motion.fps)
    accel.sort((a, b) => a - b)
    entry.p999AccelerationDegS2 = Math.max(entry.p999AccelerationDegS2, accel[Math.floor(0.999 * (accel.length - 1))] ?? 0)
    const threshold = t.spikeDeg[cls]
    for (let k = 1; k < n - 1; k += 1) {
      if (steps[k] > threshold && angleBetweenQuaternions(quats[k], quats[k + 1]) * RAD > threshold && angleBetweenQuaternions(quats[k - 1], quats[k + 1]) * RAD < threshold / 2) {
        entry.spikes += 1
        if (entry.spikeFrames.length < 12) entry.spikeFrames.push(k)
      }
    }
    perClass[cls] = entry
  }
  for (const [cls, entry] of Object.entries(perClass)) {
    temporal[cls] = {
      maxStepDeg: Math.round(entry.maxStepDeg * 100) / 100,
      worstBone: entry.worstBone,
      p999StepDeg: Math.round(entry.p999StepDeg * 100) / 100,
      maxAngularVelocityDegS: Math.round(entry.maxVelocityDegS),
      p999AngularAccelerationDegS2: Math.round(entry.p999AccelerationDegS2),
      oneFrameSpikes: entry.spikes,
      spikeFrames: entry.spikeFrames
    }
    if (entry.spikes) failures.push(`${entry.spikes} one-frame ${cls} spikes (> ${t.spikeDeg[cls as keyof QaThresholds['spikeDeg']]} deg)`)
  }
  return { structural, numeric, anatomical, temporal, failures }
}
