import { Quaternion, Vector3 } from 'three'
import type { Landmark } from '../../src/types/tracking'
import { clamp, DEG, smoothstep, angleBetweenQuaternions } from '../../src/motion/math'
import type { RigGeometry } from '../../src/motion/rig/rigGeometry'
import type { Side } from '../../src/motion/rig/semanticMap'
import {
  alignQuaternionSequence, butterworthLowpass, filtfilt, filtfiltQuaternions, hampel, limitRate, pchipFill, runs
} from '../../src/motion/filters/offline'
import {
  createHandModel, DIGITS, fitHandHypotheses, handLandmarksFromFit, LONG, relaxedHandParams,
  type HandFit, type HandModelContext, type HandParams, type HandTemplate
} from '../../src/motion/source/handModel'
import { calibrateTemplate, calibrateZScale, type CalibrationSample } from '../../src/motion/source/handCalibration'
import { resolveHandIdentity } from '../../src/motion/source/handIdentity'
import { enforceHandConstraints, flattenParams, PARAM_CHANNELS, unflattenParams } from '../../src/motion/source/handParams'
import { fromModelSpace, outOfFrameRatio, toModelSpace, type ImageSpace } from '../../src/motion/source/landmarks'
import type { RawFrame } from './raw'
import type { Timeline } from './timeline'

export type HandState = 'tracked' | 'interpolated' | 'held' | 'fallback' | 'absent'

export interface HandCleanConfig {
  maxPalmError: number
  maxMeanDigitError: number
  maxDigitError: number
  maxOutOfFrame: number
  hampelHalfWindow: number
  hampelSigmas: number
  hampelFloorDeg: number
  palmSpikeDeg: number
  shortGapFrames: number
  holdFrames: number
  fallbackBlendFrames: number
  reacquireBlendFrames: number
  cutoffFingersHz: number
  cutoffPalmHz: number
  cutoffScaleHz: number
  cutoffWristHz: number
  maxFingerStepDeg: number
  maxPalmStepDeg: number
  palmSigmaDeg: number
  palmCostScale: number
  palmRejectCost: number
}

export const DEFAULT_HAND_CLEAN: HandCleanConfig = {
  maxPalmError: 0.3,
  maxMeanDigitError: 0.45,
  maxDigitError: 0.6,
  maxOutOfFrame: 0.55,
  hampelHalfWindow: 4,
  hampelSigmas: 3.5,
  hampelFloorDeg: 14,
  palmSpikeDeg: 40,
  shortGapFrames: 8,
  holdFrames: 6,
  fallbackBlendFrames: 15,
  reacquireBlendFrames: 8,
  cutoffFingersHz: 7,
  cutoffPalmHz: 6,
  cutoffScaleHz: 3,
  cutoffWristHz: 6,
  maxFingerStepDeg: 25,
  maxPalmStepDeg: 20,
  palmSigmaDeg: 35,
  palmCostScale: 200,
  palmRejectCost: 6
}

export interface HandTrackFrame {
  state: HandState
  observed: boolean
  quality: number
  palmWeight: number
  fingerWeight: number
  rotation: Quaternion
  scale: number
  wrist: Vector3
  params: HandParams
  landmarks: Landmark[] | null
}

export interface HandTrack {
  side: Side
  model: HandModelContext
  frames: HandTrackFrame[]
  stats: Record<string, unknown>
}

export interface HandCalibrationResult {
  template: HandTemplate
  zScale: Record<Side, number>
  zScaleCurve: Record<Side, { zScale: number; inconsistency: number }[]>
  legacyDepthScaleInconsistency: Record<Side, number>
  samples: Record<Side, number>
}

export interface IdentityStats {
  swaps: number
  duplicatesDropped: number
  relabelled: number
}

/** Identity-resolve every source frame (sequential: uses previous wrists). */
export function resolveIdentities(frames: RawFrame[]) {
  const stats: IdentityStats = { swaps: 0, duplicatesDropped: 0, relabelled: 0 }
  const previous: Record<Side, { x: number; y: number } | null> = { left: null, right: null }
  const resolved = frames.map((frame) => {
    const result = resolveHandIdentity({ pose: frame.pose, left: frame.left, right: frame.right, previous, aspect: 1 })
    if (result.swapped) stats.swaps += 1
    if (result.droppedDuplicate) stats.duplicatesDropped += 1
    if (result.relabelled) stats.relabelled += 1
    for (const side of ['left', 'right'] as const) {
      const hand = result[side]
      if (hand) previous[side] = { x: hand[0].x, y: hand[0].y }
    }
    return { left: result.left, right: result.right, swapped: result.swapped, dropped: result.droppedDuplicate, relabelled: result.relabelled }
  })
  return { resolved, stats }
}

export function calibrateHands(resolved: { left: readonly Landmark[] | null; right: readonly Landmark[] | null }[], image: ImageSpace, label: string): HandCalibrationResult {
  const samples: Record<Side, CalibrationSample[]> = { left: [], right: [] }
  for (const frame of resolved) {
    for (const side of ['left', 'right'] as const) {
      const hand = frame[side]
      if (hand && outOfFrameRatio(hand, 0) === 0) samples[side].push({ side, landmarks: hand })
    }
  }
  const left = calibrateZScale(samples.left, image)
  const right = calibrateZScale(samples.right, image)
  const zScale = { left: left.zScale, right: right.zScale }
  const template = calibrateTemplate([...samples.left, ...samples.right], image, zScale, label)
  // Report what the previous solver's depth attenuation did to bone lengths.
  const legacy = (list: { zScale: number; inconsistency: number }[]) =>
    list.reduce((best, entry) => (Math.abs(entry.zScale - 0.4) < Math.abs(best.zScale - 0.4) ? entry : best)).inconsistency
  return {
    template,
    zScale,
    zScaleCurve: { left: left.curve, right: right.curve },
    legacyDepthScaleInconsistency: { left: legacy(left.curve), right: legacy(right.curve) },
    samples: { left: samples.left.length, right: samples.right.length }
  }
}

function blendParams(values: { params: HandParams; weight: number }[]): HandParams {
  const total = values.reduce((sum, v) => sum + v.weight, 0)
  const flat = new Array(PARAM_CHANNELS.length).fill(0)
  for (const v of values) {
    const f = flattenParams(v.params)
    for (let c = 0; c < flat.length; c += 1) flat[c] += (f[c] * v.weight) / total
  }
  return unflattenParams(flat)
}

export function cleanHandTrack(
  side: Side,
  frames: RawFrame[],
  resolved: { left: readonly Landmark[] | null; right: readonly Landmark[] | null }[],
  timeline: Timeline,
  image: ImageSpace,
  rig: RigGeometry,
  calibration: HandCalibrationResult,
  config: HandCleanConfig = DEFAULT_HAND_CLEAN
): HandTrack {
  const model = createHandModel(side, calibration.template, rig.hands[side])
  const zScale = calibration.zScale[side]
  const n = timeline.slots.length
  const fits: (HandFit | null)[] = new Array(n).fill(null)
  const observed = new Array<boolean>(n).fill(false)
  let rejected = 0
  const rejectReasons: Record<string, number> = { palmError: 0, digitError: 0, outOfFrame: 0, fitFailed: 0, orientationVote: 0 }

  // 1. Per-slot articulated fit, both palm/back hypotheses.
  const hypotheses: HandFit[][] = new Array(n).fill(null).map(() => [])
  for (const slot of timeline.slots) {
    if (slot.source === null) continue
    const hand = resolved[slot.source][side]
    if (!hand) continue
    observed[slot.k] = true
    const points = hand.map((landmark) => toModelSpace(landmark, image, zScale))
    const weights = hand.map((landmark) => (landmark.x < 0 || landmark.x > 1 || landmark.y < 0 || landmark.y > 1 ? 0.25 : 1))
    hypotheses[slot.k] = fitHandHypotheses(model, points, weights)
  }

  // 1b. Palm/back disambiguation over time. Monocular hand landmarks can
  //     flip between the two mirror interpretations for runs of frames
  //     (edge-on or occluded palms); a genuine rotation is continuous, a flip
  //     is a >90 deg jump. Viterbi over per-frame states {hypothesis A,
  //     hypothesis B, reject}: unary = normalised fit cost (reject = fixed
  //     price), transition = squared orientation change (a reject state holds
  //     the orientation of its best predecessor). A flipped run is kept only
  //     when it is long and fits better than rejecting it.
  const choice = viterbiPalmChoice(hypotheses, config)
  let flipsResolved = 0
  let orientationRejected = 0
  for (let k = 0; k < n; k += 1) {
    if (!hypotheses[k].length) continue
    if (choice[k] < 0) orientationRejected += 1
    else if (choice[k] > 0) flipsResolved += 1
  }

  for (let k = 0; k < n; k += 1) {
    if (!observed[k]) continue
    if (choice[k] < 0) {
      rejected += 1
      rejectReasons.orientationVote += 1
      continue
    }
    const fit = hypotheses[k][choice[k]]
    const meanDigit = DIGITS.reduce((sum, digit) => sum + fit.digitError[digit], 0) / DIGITS.length
    if (fit.palmError > config.maxPalmError) rejectReasons.palmError += 1
    else if (meanDigit > config.maxMeanDigitError) rejectReasons.digitError += 1
    else if (fit.outOfFrame > config.maxOutOfFrame) rejectReasons.outOfFrame += 1
    else {
      fits[k] = fit
      continue
    }
    rejected += 1
  }

  // 2. Channel tracks.
  const valid = fits.map(Boolean)
  const rotations = fits.map((fit) => (fit ? fit.palm.rotation.clone() : new Quaternion()))
  alignQuaternionSequence(rotations)
  const logScale = fits.map((fit) => (fit ? Math.log(fit.palm.scale) : 0))
  const wrist = [0, 1, 2].map((axis) => fits.map((fit) => (fit ? fit.palm.wrist.getComponent(axis) : 0)))
  const channels = PARAM_CHANNELS.map((_, c) => fits.map((fit) => (fit ? flattenParams(fit.params)[c] : 0)))
  const channelValid = PARAM_CHANNELS.map((channel) => fits.map((fit) => (fit ? fit.digitError[channel.digit] <= config.maxDigitError : false)))

  // 3. Palm orientation spikes (one-frame flips the neighbours do not share).
  let palmSpikes = 0
  const nearestValid = (k: number, step: number) => {
    for (let j = k + step, count = 0; j >= 0 && j < n && count < 3; j += step, count += 1) if (valid[j]) return j
    return -1
  }
  for (let k = 0; k < n; k += 1) {
    if (!valid[k]) continue
    const p = nearestValid(k, -1)
    const q = nearestValid(k, 1)
    if (p < 0 || q < 0) continue
    if (
      angleBetweenQuaternions(rotations[k], rotations[p]) > config.palmSpikeDeg * DEG &&
      angleBetweenQuaternions(rotations[k], rotations[q]) > config.palmSpikeDeg * DEG &&
      angleBetweenQuaternions(rotations[p], rotations[q]) < 25 * DEG
    ) {
      valid[k] = false
      palmSpikes += 1
    }
  }
  const scaleOutliers = hampel(logScale, valid, config.hampelHalfWindow, config.hampelSigmas, 0.12)
  let scaleRejected = 0
  scaleOutliers.forEach((outlier, k) => {
    if (outlier) {
      valid[k] = false
      scaleRejected += 1
    }
  })
  for (let c = 0; c < channels.length; c += 1) for (let k = 0; k < n; k += 1) if (!valid[k]) channelValid[c][k] = false

  // 4. Per-channel robust outliers.
  let channelOutliers = 0
  for (let c = 0; c < channels.length; c += 1) {
    const mask = hampel(channels[c], channelValid[c], config.hampelHalfWindow, config.hampelSigmas, config.hampelFloorDeg * DEG)
    mask.forEach((outlier, k) => {
      if (outlier) {
        channelValid[c][k] = false
        channelOutliers += 1
      }
    })
  }

  // 5. Gap classification on hand presence.
  const state = new Array<HandState>(n).fill('absent')
  valid.forEach((v, k) => { if (v) state[k] = 'tracked' })
  const shortFill = new Array<boolean>(n).fill(false)
  const longGaps: [number, number][] = []
  for (const [start, end] of runs(valid, false)) {
    const bounded = start > 0 && end < n
    if (bounded && end - start <= config.shortGapFrames) {
      for (let k = start; k < end; k += 1) {
        shortFill[k] = true
        state[k] = 'interpolated'
      }
    } else {
      longGaps.push([start, end])
    }
  }
  const fillMask = valid.map((v, k) => v || shortFill[k])

  // 6. Fill channels: short presence gaps + channel outliers (PCHIP / SLERP).
  const filledRotations = slerpFillMasked(rotations, valid, shortFill)
  const filledLogScale = pchipFill(logScale, valid, shortFill)
  const filledWrist = wrist.map((axis) => pchipFill(axis, valid, shortFill))
  const filledChannels = channels.map((channel, c) => {
    const inner = fillMask.map((v, k) => v && !channelValid[c][k])
    const out = pchipFill(channel, channelValid[c], fillMask.map((v, k) => shortFill[k] || inner[k]))
    // Channel samples still unknown inside tracked spans (edge outliers): hold nearest.
    holdNearest(out, fillMask.map((v, k) => v && !channelValid[c][k]), channelValid[c])
    return out
  })

  // 7. Long gaps: hold, blend to a relaxed hand, and blend back on reacquire.
  const relaxed = flattenParams(relaxedHandParams(model))
  const palmWeight = new Float64Array(n).fill(0)
  const fingerWeight = new Float64Array(n).fill(0)
  for (let k = 0; k < n; k += 1) if (fillMask[k]) {
    palmWeight[k] = 1
    fingerWeight[k] = 1
  }
  const heldFrames = { held: 0, fallback: 0 }
  for (const [start, end] of longGaps) {
    const a = start > 0 ? start - 1 : -1
    const b = end < n ? end : -1
    for (let k = start; k < end; k += 1) {
      const dA = k - start + 1
      const dB = end - k
      const wA = a >= 0 ? 1 - smoothstep(config.holdFrames, config.holdFrames + config.fallbackBlendFrames, dA) : 0
      const wB = b >= 0 ? 1 - smoothstep(0, config.reacquireBlendFrames, dB) : 0
      const wR = Math.max(0, 1 - wA - wB)
      const total = wA + wB + wR
      const values = new Array(relaxed.length).fill(0)
      for (let c = 0; c < relaxed.length; c += 1) {
        values[c] = ((a >= 0 ? filledChannels[c][a] : 0) * wA + (b >= 0 ? filledChannels[c][b] : 0) * wB + relaxed[c] * wR) / total
        filledChannels[c][k] = values[c]
      }
      const measured = Math.min(1, wA + wB)
      palmWeight[k] = measured
      fingerWeight[k] = measured
      // Palm orientation / scale / wrist: blend the two anchors (the arm stage
      // decides how much of the measured palm to use via palmWeight).
      if (a >= 0 && b >= 0) {
        const t = wA + wB > 0 ? wB / (wA + wB) : 0.5
        filledRotations[k] = filledRotations[a].clone().slerp(filledRotations[b], t)
        filledLogScale[k] = filledLogScale[a] * (1 - t) + filledLogScale[b] * t
        for (let axis = 0; axis < 3; axis += 1) filledWrist[axis][k] = filledWrist[axis][a] * (1 - t) + filledWrist[axis][b] * t
      } else {
        const anchor = a >= 0 ? a : b
        if (anchor >= 0) {
          filledRotations[k] = filledRotations[anchor].clone()
          filledLogScale[k] = filledLogScale[anchor]
          for (let axis = 0; axis < 3; axis += 1) filledWrist[axis][k] = filledWrist[axis][anchor]
        }
      }
      state[k] = measured >= 0.999 ? 'held' : measured > 0 ? 'fallback' : 'absent'
      if (state[k] === 'held') heldFrames.held += 1
      else heldFrames.fallback += 1
    }
  }

  // 8. Symmetric glitch-rate limiting, then zero-phase smoothing (fingers keep
  //    ~7 Hz: fast articulation survives, holds stay still), then a final rate
  //    guard. Limiting BEFORE the filter matters: a limiter applied last turns
  //    a short tracking burst (e.g. a motion-blurred re-acquisition frame)
  //    into a triangle with a sharp one-frame apex; limited first, the filter
  //    rounds the reversal into a physically plausible decelerate/reverse.
  const fs = timeline.fps
  const fingerFilter = butterworthLowpass(config.cutoffFingersHz, fs)
  const fingerStep = config.maxFingerStepDeg * DEG
  const smoothedChannels = filledChannels.map((channel) => limitRate(filtfilt(fingerFilter, limitRate(channel, fingerStep)), fingerStep))
  alignQuaternionSequence(filledRotations)
  const smoothedRotations = limitQuaternionRate(filtfiltQuaternions(butterworthLowpass(config.cutoffPalmHz, fs), filledRotations), config.maxPalmStepDeg * DEG)
  const smoothedScale = filtfilt(butterworthLowpass(config.cutoffScaleHz, fs), filledLogScale)
  const smoothedWrist = filledWrist.map((axis) => filtfilt(butterworthLowpass(config.cutoffWristHz, fs), axis))
  const smoothedPalmWeight = filtfilt(butterworthLowpass(2, fs), palmWeight)
  const smoothedFingerWeight = filtfilt(butterworthLowpass(2, fs), fingerWeight)

  // 9. Final anatomical projection + clean landmarks.
  let crossingCorrections = 0
  const outFrames: HandTrackFrame[] = []
  for (let k = 0; k < n; k += 1) {
    const params = unflattenParams(smoothedChannels.map((channel) => channel[k]))
    const constrained = enforceHandConstraints(model.template, params, model.template.neutralAbduction, 10 * DEG)
    crossingCorrections += constrained.crossingCorrections
    const rotation = smoothedRotations[k].clone()
    const scale = Math.exp(smoothedScale[k])
    const wristPoint = new Vector3(smoothedWrist[0][k], smoothedWrist[1][k], smoothedWrist[2][k])
    const visible = state[k] === 'tracked' || state[k] === 'interpolated'
    const landmarks = visible
      ? handLandmarksFromFit(model, { rotation, scale, wrist: wristPoint }, constrained.params).map((p) => roundLandmark(fromModelSpace(p, image, zScale)))
      : null
    const fit = fits[k]
    const quality = fit ? clamp(1 - DIGITS.reduce((s, d) => s + fit.digitError[d], 0) / DIGITS.length / config.maxMeanDigitError, 0, 1) : 0
    outFrames.push({
      state: state[k],
      observed: observed[k],
      quality,
      palmWeight: clamp(smoothedPalmWeight[k], 0, 1),
      fingerWeight: clamp(smoothedFingerWeight[k], 0, 1),
      rotation,
      scale,
      wrist: wristPoint,
      params: constrained.params,
      landmarks
    })
  }

  const count = (s: HandState) => state.filter((v) => v === s).length
  const intervals = collectIntervals(state, timeline.fps)
  return {
    side,
    model,
    frames: outFrames,
    stats: {
      slots: n,
      observedSlots: observed.filter(Boolean).length,
      acceptedFits: fits.filter(Boolean).length,
      rejectedFits: rejected,
      rejectReasons,
      palmSpikesRejected: palmSpikes,
      palmFlipHypothesesSelected: flipsResolved,
      palmOrientationRejected: orientationRejected,
      scaleOutliersRejected: scaleRejected,
      channelOutliersRejected: channelOutliers,
      crossingCorrections,
      states: { tracked: count('tracked'), interpolated: count('interpolated'), held: count('held'), fallback: count('fallback'), absent: count('absent') },
      intervals
    }
  }
}

function roundLandmark(landmark: Landmark): Landmark {
  return { x: Math.round(landmark.x * 1e5) / 1e5, y: Math.round(landmark.y * 1e5) / 1e5, z: Math.round(landmark.z * 1e5) / 1e5 }
}

function slerpFillMasked(sequence: Quaternion[], valid: boolean[], fillMask: boolean[]) {
  const out = sequence.map((q) => q.clone())
  for (const [start, end] of runs(valid, false)) {
    if (start === 0 || end >= sequence.length) continue
    const a = sequence[start - 1]
    const b = sequence[end]
    for (let k = start; k < end; k += 1) {
      if (!fillMask[k]) continue
      out[k] = a.clone().slerp(b, (k - start + 1) / (end - start + 1))
    }
  }
  return out
}

function holdNearest(values: Float64Array, holes: boolean[], valid: boolean[]) {
  for (let k = 0; k < values.length; k += 1) {
    if (!holes[k] || valid[k]) continue
    let best = -1
    for (let d = 1; d < values.length && best < 0; d += 1) {
      if (k - d >= 0 && valid[k - d]) best = k - d
      else if (k + d < values.length && valid[k + d]) best = k + d
    }
    if (best >= 0) values[k] = values[best]
  }
}

function limitQuaternionRate(sequence: Quaternion[], maxStep: number) {
  // Symmetric: forward and backward clamped passes, averaged by slerp.
  const forward = sequence.map((q) => q.clone())
  for (let k = 1; k < forward.length; k += 1) {
    const angle = angleBetweenQuaternions(forward[k - 1], forward[k])
    if (angle > maxStep) forward[k] = forward[k - 1].clone().slerp(forward[k], maxStep / angle)
  }
  const backward = sequence.map((q) => q.clone())
  for (let k = backward.length - 2; k >= 0; k -= 1) {
    const angle = angleBetweenQuaternions(backward[k + 1], backward[k])
    if (angle > maxStep) backward[k] = backward[k + 1].clone().slerp(backward[k], maxStep / angle)
  }
  return forward.map((q, k) => q.clone().slerp(backward[k], 0.5).normalize())
}

function collectIntervals(state: HandState[], fps: number) {
  const out: { state: HandState; start: number; end: number; startSec: number; endSec: number }[] = []
  let begin = 0
  for (let k = 1; k <= state.length; k += 1) {
    if (k === state.length || state[k] !== state[begin]) {
      if (state[begin] !== 'tracked') {
        out.push({ state: state[begin], start: begin, end: k - 1, startSec: Math.round((begin / fps) * 1000) / 1000, endSec: Math.round(((k - 1) / fps) * 1000) / 1000 })
      }
      begin = k
    }
  }
  return out
}

export { LONG }

/**
 * Temporal palm-hypothesis selection (see step 1b). Returns, per slot, the
 * chosen hypothesis index or -1 (rejected / no observation).
 */
export function viterbiPalmChoice(hypotheses: HandFit[][], config: HandCleanConfig) {
  const n = hypotheses.length
  const choice = new Array<number>(n).fill(-1)
  const observedSlots = hypotheses.map((h, k) => (h.length ? k : -1)).filter((k) => k >= 0)
  if (!observedSlots.length) return choice
  type State = { cost: number; orientation: Quaternion; back: number }
  const layers: State[][] = []
  const sigma = config.palmSigmaDeg * DEG
  const unary = (fit: HandFit) => Math.min(fit.cost / config.palmCostScale, 30)
  let previousSlot = -1
  for (const k of observedSlots) {
    const gap = previousSlot < 0 ? 1 : k - previousSlot
    const sig = sigma * Math.sqrt(Math.max(1, gap))
    const candidates = hypotheses[k]
    const layer: State[] = []
    const prev = layers[layers.length - 1]
    // Accept states.
    candidates.forEach((fit) => {
      let best = Infinity
      let back = -1
      if (prev) {
        prev.forEach((state, index) => {
          const angle = angleBetweenQuaternions(state.orientation, fit.palm.rotation)
          const value = state.cost + (angle / sig) ** 2
          if (value < best) {
            best = value
            back = index
          }
        })
      } else {
        best = 0
      }
      layer.push({ cost: best + unary(fit), orientation: fit.palm.rotation, back })
    })
    // Reject state: holds the orientation of its cheapest predecessor.
    if (prev) {
      let best = Infinity
      let back = 0
      prev.forEach((state, index) => {
        if (state.cost < best) {
          best = state.cost
          back = index
        }
      })
      layer.push({ cost: best + config.palmRejectCost, orientation: prev[back].orientation, back })
    } else {
      layer.push({ cost: config.palmRejectCost, orientation: candidates[0].palm.rotation, back: -1 })
    }
    layers.push(layer)
    previousSlot = k
  }
  let index = 0
  const last = layers[layers.length - 1]
  last.forEach((state, i) => { if (state.cost < last[index].cost) index = i })
  for (let layerIndex = layers.length - 1; layerIndex >= 0; layerIndex -= 1) {
    const k = observedSlots[layerIndex]
    const isReject = index === layers[layerIndex].length - 1
    choice[k] = isReject ? -1 : index
    index = layers[layerIndex][index].back
    if (index < 0) break
  }
  return choice
}
