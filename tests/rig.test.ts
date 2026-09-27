import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LONG_FINGERS, SIDES } from '../src/motion/rig/semanticMap'
import { loadAvatar } from './helpers'

test('the supplied GLB matches the semantic skeleton profile (validated, not assumed)', async () => {
  const { rig, validation, jointNames } = await loadAvatar()
  assert.equal(validation.ok, true, JSON.stringify(validation.issues.filter((i) => i.level === 'error')))
  assert.ok(jointNames.size >= 80, `skin joints: ${jointNames.size}`)
  // Facing and character-left are derived from the rig geometry, and orthogonal.
  assert.ok(Math.abs(validation.facing.dot(validation.characterLeft)) < 1e-6)
  assert.ok(rig.has('hand_l') && rig.has('hand_r'))
})

test('rig geometry: arm lengths, elbow hinge axes and finger hinge axes are well defined', async () => {
  const { geometry } = await loadAvatar()
  for (const side of SIDES) {
    const arm = geometry.arms[side]
    assert.ok(arm.upperLength > 0.15 && arm.upperLength < 0.45, `upper ${arm.upperLength}`)
    assert.ok(arm.forearmLength > 0.15 && arm.forearmLength < 0.45, `fore ${arm.forearmLength}`)
    assert.ok(Math.abs(arm.elbowAxisUpper.length() - 1) < 1e-9)
    const hand = geometry.hands[side]
    for (const finger of LONG_FINGERS) {
      const g = hand.fingers[finger]
      assert.ok(Math.abs(g.pip.axisParent.length() - 1) < 1e-9)
      assert.ok(Math.abs(g.dip.axisParent.length() - 1) < 1e-9)
    }
    // Palm frame is right-handed and orthonormal.
    const { forward, radial, volar } = hand.palm
    assert.ok(Math.abs(forward.dot(radial)) < 1e-6 && Math.abs(forward.dot(volar)) < 1e-6 && Math.abs(radial.dot(volar)) < 1e-6)
  }
  assert.ok(geometry.torso.shoulderWidth > 0.2 && geometry.torso.shoulderWidth < 0.5)
})
