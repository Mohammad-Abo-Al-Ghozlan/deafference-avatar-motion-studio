import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Quaternion, Vector3 } from 'three'
import { angleBetweenQuaternions, DEG, signedAngleAbout, swingTwist } from '../src/motion/math'
import { rng } from './helpers'

test('swing-twist decomposition recomposes and isolates the twist axis', () => {
  const random = rng(7)
  for (let i = 0; i < 200; i += 1) {
    const axis = new Vector3(random() - 0.5, random() - 0.5, random() - 0.5).normalize()
    const q = new Quaternion(random() - 0.5, random() - 0.5, random() - 0.5, random() - 0.5).normalize()
    const { swing, twist, twistAngle } = swingTwist(q, axis)
    // acos near 1 limits the resolution of the angle metric to ~1e-8 rad.
    assert.ok(angleBetweenQuaternions(swing.clone().multiply(twist), q) < 1e-6)
    // The swing moves the axis but never rotates about it.
    const swingAxis = new Vector3(swing.x, swing.y, swing.z)
    assert.ok(Math.abs(swingAxis.dot(axis)) < 1e-9)
    assert.ok(Math.abs(twistAngle) <= Math.PI + 1e-12)
  }
})

test('pure twist about the axis is fully recovered', () => {
  const axis = new Vector3(0, 1, 0)
  const q = new Quaternion().setFromAxisAngle(axis, 37 * DEG)
  const { twistAngle, swing } = swingTwist(q, axis)
  assert.ok(Math.abs(twistAngle - 37 * DEG) < 1e-12)
  assert.ok(angleBetweenQuaternions(swing, new Quaternion()) < 1e-6)
})

test('signedAngleAbout is signed by the right-hand rule', () => {
  const x = new Vector3(1, 0, 0)
  const y = new Vector3(0, 1, 0)
  const z = new Vector3(0, 0, 1)
  assert.ok(Math.abs(signedAngleAbout(x, y, z) - Math.PI / 2) < 1e-12)
  assert.ok(Math.abs(signedAngleAbout(y, x, z) + Math.PI / 2) < 1e-12)
})
