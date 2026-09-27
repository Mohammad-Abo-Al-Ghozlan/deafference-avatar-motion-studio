import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Quaternion, Vector3 } from 'three'
import { angleBetweenQuaternions, DEG, swingTwist } from '../src/motion/math'
import { AvatarSolver, DEFAULT_SOLVER_CONFIG } from '../src/motion/retarget/AvatarSolver'
import { PoseState } from '../src/motion/retarget/PoseState'
import type { SourcePose } from '../src/motion/retarget/types'
import { createHandModel, relaxedHandParams } from '../src/motion/source/handModel'
import { DEFAULT_HAND_TEMPLATE } from '../src/motion/live/defaults'
import { LONG_FINGERS, SIDES } from '../src/motion/rig/semanticMap'
import { loadAvatar, rng } from './helpers'

const neutral = { left: { ...DEFAULT_HAND_TEMPLATE.neutralAbduction }, right: { ...DEFAULT_HAND_TEMPLATE.neutralAbduction } }

test('no source streams -> every controlled joint stays exactly at its rest pose', async () => {
  const { rig } = await loadAvatar()
  const solver = new AvatarSolver(rig, neutral)
  const solved = solver.solve({ body: null, hands: { left: null, right: null }, face: null })
  for (const [bone, q] of solved.rotations) assert.ok(angleBetweenQuaternions(q, rig.get(bone).restLocalQuaternion) < 1e-6, bone)
  for (const [bone, p] of solved.translations) assert.ok(p.distanceTo(rig.get(bone).restLocalPosition) < 1e-9, bone)
})

test('arm IK: reaches random targets exactly, elbow is a pure hinge within [3, 148] deg', async () => {
  const { rig, geometry } = await loadAvatar()
  const solver = new AvatarSolver(rig, neutral)
  const pose = new PoseState(rig)
  const random = rng(17)
  for (let i = 0; i < 150; i += 1) {
    const target = (side: 'left' | 'right') => new Vector3((side === 'left' ? 1 : -1) * (0.2 + random() * 0.8), -1 + random() * 1.6, 0.9 + random() * 0.8)
    const source: SourcePose = {
      body: {
        torsoYaw: 0,
        torsoRoll: 0,
        wrist: { left: target('left'), right: target('right') },
        wristConfidence: { left: 1, right: 1 },
        elbow: { left: new Vector3(0.9, -0.8, 0.2), right: new Vector3(-0.9, -0.8, 0.2) },
        elbowConfidence: { left: 0.8, right: 0.8 },
        shrug: { left: 0, right: 0 }
      },
      hands: { left: null, right: null },
      face: null
    }
    const solved = solver.solve(source, { swivel: { left: (random() - 0.5) * 1.2, right: (random() - 0.5) * 1.2 } })
    for (const [bone, q] of solved.rotations) pose.local[pose.index(bone)].copy(q)
    for (const side of SIDES) {
      const d = solved.diagnostics.arms[side]
      if (!d.reachClamped) assert.ok(d.ikErrorM < 1e-6, `ik error ${d.ikErrorM}`)
      assert.ok(d.elbowFlexion >= DEFAULT_SOLVER_CONFIG.arm.minFlexion - 1e-9 && d.elbowFlexion <= DEFAULT_SOLVER_CONFIG.arm.maxFlexion + 1e-9)
      const arm = geometry.arms[side]
      const delta = solved.rotations.get(arm.forearm)!.clone().multiply(rig.get(arm.forearm).restLocalQuaternion.clone().invert())
      const { swing } = swingTwist(delta, arm.elbowAxisUpper)
      assert.ok(angleBetweenQuaternions(swing, new Quaternion()) < 1e-5, 'elbow rotated off its hinge axis')
    }
  }
})

test('fingers: PIP/DIP are pure hinges about the rig axes, at the requested angles', async () => {
  const { rig, geometry } = await loadAvatar()
  const solver = new AvatarSolver(rig, neutral)
  for (const side of SIDES) {
    const model = createHandModel(side, DEFAULT_HAND_TEMPLATE, geometry.hands[side])
    const params = relaxedHandParams(model)
    params.index.pip = 70 * DEG
    params.index.dip = 49 * DEG
    const source: SourcePose = { body: null, hands: { left: null, right: null, [side]: { palmWeight: 0, rotation: new Quaternion(), params } }, face: null }
    const solved = solver.solve(source)
    for (const finger of LONG_FINGERS) {
      const g = geometry.hands[side].fingers[finger]
      for (const [joint, value] of [[g.pip, params[finger].pip], [g.dip, params[finger].dip]] as const) {
        const delta = solved.rotations.get(joint.bone)!.clone().multiply(rig.get(joint.bone).restLocalQuaternion.clone().invert())
        const st = swingTwist(delta, joint.axisParent)
        assert.ok(angleBetweenQuaternions(st.swing, new Quaternion()) < 1e-5, `${joint.bone} swings off-axis`)
        assert.ok(Math.abs(joint.restAngle + st.twistAngle - value) < 1e-4, `${joint.bone} angle`)
      }
    }
  }
})

test('near-shoulder targets are depth-completed instead of folding the arm through the shoulder', async () => {
  const { rig } = await loadAvatar()
  const solver = new AvatarSolver(rig, neutral)
  const source: SourcePose = {
    body: {
      torsoYaw: 0, torsoRoll: 0,
      wrist: { left: new Vector3(0.5, 0, -0.1), right: new Vector3(-0.5, 0.02, 0) },
      wristConfidence: { left: 1, right: 1 },
      elbow: { left: new Vector3(0.8, -0.8, 0), right: new Vector3(-0.8, -0.8, 0) },
      elbowConfidence: { left: 0.8, right: 0.8 },
      shrug: { left: 0, right: 0 }
    },
    hands: { left: null, right: null },
    face: null
  }
  const solved = solver.solve(source)
  for (const side of SIDES) {
    assert.ok(solved.diagnostics.arms[side].depthCompletedM > 0, 'completion engaged')
    assert.ok(solved.diagnostics.arms[side].elbowFlexion < DEFAULT_SOLVER_CONFIG.arm.maxFlexion, 'arm not folded to its limit')
  }
})
