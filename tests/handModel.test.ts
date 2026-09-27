import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Quaternion, Vector3 } from 'three'
import { angleBetweenQuaternions, DEG, RAD } from '../src/motion/math'
import {
  clampLongFinger, clampThumb, coupledAxial, createHandModel, fitHand, fitHandHypotheses, handLandmarksFromFit, LONG, type HandParams
} from '../src/motion/source/handModel'
import { enforceHandConstraints } from '../src/motion/source/handParams'
import { DEFAULT_HAND_TEMPLATE } from '../src/motion/live/defaults'
import { SIDES } from '../src/motion/rig/semanticMap'
import { loadAvatar, rng } from './helpers'

function randomParams(model: ReturnType<typeof createHandModel>, random: () => number): HandParams {
  const t = model.template
  const out = {} as HandParams
  for (const finger of LONG) {
    const pip = (5 + random() * 85) * DEG
    out[finger] = clampLongFinger(t, finger, {
      abduction: t.neutralAbduction[finger] + (random() - 0.5) * 12 * DEG,
      mcp: (5 + random() * 70) * DEG,
      pip,
      dip: 0.7 * pip
    })
  }
  const elevation = model.thumb.restElevation + (random() - 0.5) * 20 * DEG
  out.thumb = clampThumb({
    azimuth: model.thumb.restAzimuth + (random() - 0.5) * 20 * DEG,
    elevation,
    axial: coupledAxial(model, elevation),
    mcp: (5 + random() * 30) * DEG,
    ip: (5 + random() * 40) * DEG
  })
  return enforceHandConstraints(t, out, t.neutralAbduction, 10 * DEG).params
}

test('articulated hand fit recovers known joint angles from synthetic landmarks (FK -> fit round trip)', async (t) => {
  const { geometry } = await loadAvatar()
  const random = rng(11)
  const errors: number[] = []
  let palmError = 0
  for (const side of SIDES) {
    const model = createHandModel(side, DEFAULT_HAND_TEMPLATE, geometry.hands[side])
    for (let i = 0; i < 40; i += 1) {
      const params = randomParams(model, random)
      const rotation = new Quaternion().setFromAxisAngle(new Vector3(random() - 0.5, random() - 0.5, random() - 0.5).normalize(), random() * 1.2)
      const palm = { rotation, scale: 55 + random() * 20, wrist: new Vector3(180, -200, 0) }
      const points = handLandmarksFromFit(model, palm, params)
      const fit = fitHand(model, points, new Array(21).fill(1))
      assert.ok(fit, 'fit failed')
      palmError = Math.max(palmError, angleBetweenQuaternions(fit!.palm.rotation, rotation) * RAD)
      for (const finger of LONG) {
        for (const key of ['mcp', 'pip', 'dip'] as const) errors.push(Math.abs(fit!.params[finger][key] - params[finger][key]) * RAD)
      }
    }
  }
  errors.sort((a, b) => a - b)
  const median = errors[errors.length >> 1]
  const p95 = errors[Math.floor(errors.length * 0.95)]
  t.diagnostic(`flexion error median ${median.toFixed(3)} deg, p95 ${p95.toFixed(3)} deg, max palm error ${palmError.toFixed(3)} deg (${errors.length} joint samples)`)
  assert.ok(median < 1, `median flexion error ${median.toFixed(2)} deg`)
  assert.ok(p95 < 5, `p95 flexion error ${p95.toFixed(2)} deg`)
  assert.ok(palmError < 5, `max palm orientation error ${palmError.toFixed(2)} deg`)
})

test('hand fit degrades gracefully under landmark noise (1.5 px image-plane, 4 px depth at 60 px palm)', async (t) => {
  const { geometry } = await loadAvatar()
  const random = rng(23)
  const gauss = () => Math.sqrt(-2 * Math.log(Math.max(1e-12, random()))) * Math.cos(2 * Math.PI * random())
  const errors: number[] = []
  const model = createHandModel('right', DEFAULT_HAND_TEMPLATE, geometry.hands.right)
  for (let i = 0; i < 60; i += 1) {
    const params = randomParams(model, random)
    const rotation = new Quaternion().setFromAxisAngle(new Vector3(random() - 0.5, random() - 0.5, random() - 0.5).normalize(), random() * 1.2)
    const points = handLandmarksFromFit(model, { rotation, scale: 60, wrist: new Vector3(180, -200, 0) }, params)
    points.forEach((p) => p.add(new Vector3(gauss() * 1.5, gauss() * 1.5, gauss() * 4)))
    const fit = fitHand(model, points, new Array(21).fill(1))
    assert.ok(fit)
    for (const finger of LONG) for (const key of ['mcp', 'pip'] as const) errors.push(Math.abs(fit!.params[finger][key] - params[finger][key]) * RAD)
  }
  errors.sort((a, b) => a - b)
  const median = errors[errors.length >> 1]
  const p95 = errors[Math.floor(errors.length * 0.95)]
  t.diagnostic(`noisy flexion error median ${median.toFixed(2)} deg, p95 ${p95.toFixed(2)} deg`)
  // Characterisation, not a precision claim: a 1.5 px endpoint error on a
  // ~15 px phalanx is ~8 deg of direction error, so a single-frame fit cannot
  // do much better; temporal filtering reduces it further.
  assert.ok(median < 7, `median ${median}`)
  assert.ok(p95 < 25, `p95 ${p95}`)
})

test('palm/back ambiguity: the mirrored hypothesis is produced when it is a genuinely different pose', async () => {
  const { geometry } = await loadAvatar()
  const model = createHandModel('right', DEFAULT_HAND_TEMPLATE, geometry.hands.right)
  const params = randomParams(model, rng(3))
  const palm = { rotation: new Quaternion(), scale: 60, wrist: new Vector3(180, -200, 0) }
  const points = handLandmarksFromFit(model, palm, params)
  // Flatten depth: the monocular case where palm and back are ambiguous.
  points.forEach((p) => { p.z = 0 })
  const hypotheses = fitHandHypotheses(model, points, new Array(21).fill(1))
  assert.ok(hypotheses.length >= 1)
  if (hypotheses.length === 2) assert.ok(angleBetweenQuaternions(hypotheses[0].palm.rotation, hypotheses[1].palm.rotation) > Math.PI / 2)
})

test('anatomical projection never produces reverse bending or out-of-range joints', async () => {
  const { geometry } = await loadAvatar()
  const model = createHandModel('left', DEFAULT_HAND_TEMPLATE, geometry.hands.left)
  const random = rng(5)
  for (let i = 0; i < 200; i += 1) {
    const wild = randomParams(model, random)
    for (const finger of LONG) {
      wild[finger].pip = (random() - 0.5) * 400 * DEG
      wild[finger].dip = (random() - 0.5) * 400 * DEG
      wild[finger].mcp = (random() - 0.5) * 400 * DEG
    }
    const { params } = enforceHandConstraints(model.template, wild, model.template.neutralAbduction, 10 * DEG)
    for (const finger of LONG) {
      assert.ok(params[finger].pip >= -5 * DEG - 1e-9 && params[finger].pip <= 110 * DEG + 1e-9)
      assert.ok(params[finger].dip >= -10 * DEG - 1e-9 && params[finger].dip <= 85 * DEG + 1e-9)
    }
  }
})
