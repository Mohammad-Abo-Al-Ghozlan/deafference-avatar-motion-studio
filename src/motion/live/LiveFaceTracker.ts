import { Quaternion, type Vector3 } from 'three'
import type { Landmark } from '../../types/tracking'
import { angleBetweenQuaternions, DEG, smoothstep } from '../math'
import { OneEuroFilter, OneEuroQuaternionFilter, RollingQuantiles } from '../filters/online'
import {
  buildFaceTemplate, measureFace, normalizeFaceSignals, recenterTemplate, rigidShape,
  type FaceFeatureBaselines, type FaceFeatureValues, type FaceTemplate
} from '../source/faceFeatures'
import { toModelSpace, type ImageSpace } from '../source/landmarks'
import type { SourceFace } from '../retarget/types'
import type { LiveFaceConfig } from './defaults'

const FEATURES = ['mouthOpen', 'mouthWidth', 'cornerLiftLeft', 'cornerLiftRight', 'eyeOpenLeft', 'eyeOpenRight', 'browLeft', 'browRight'] as const
type Feature = (typeof FEATURES)[number]

/**
 * Causal head pose + restrained expression signals.
 *
 * Calibration: the first `calibrationFrames` valid faces build the rigid
 * neutral template (Procrustes) and define "neutral" as their mean head pose
 * (the signer is assumed to face the camera at the start; restart to
 * recalibrate). Expression baselines start from the sample-clip defaults and
 * adapt with rolling quantiles over the last `baselineWindow` frames.
 */
export class LiveFaceTracker {
  private readonly config: LiveFaceConfig
  private readonly zScale: number
  private readonly defaults: FaceFeatureBaselines
  private cutoffScale = 1
  private template: FaceTemplate | null = null
  private readonly calibrationShapes: Map<number, Vector3>[] = []
  private readonly residuals: RollingQuantiles
  private readonly quantiles: Record<Feature, RollingQuantiles>
  private readonly rotationFilter: OneEuroQuaternionFilter
  private readonly featureFilters: Record<Feature, OneEuroFilter>
  private lastRotation: Quaternion | null = null
  private lastOutput: SourceFace | null = null
  private lastValidTime = -Infinity
  private framesSinceBaseline = 0
  private baselines: FaceFeatureBaselines

  constructor(config: LiveFaceConfig, zScale: number, defaults: FaceFeatureBaselines) {
    this.config = config
    this.zScale = zScale
    this.defaults = defaults
    this.baselines = structuredClone(defaults)
    this.residuals = new RollingQuantiles(config.baselineWindow)
    this.quantiles = Object.fromEntries(FEATURES.map((f) => [f, new RollingQuantiles(config.baselineWindow)])) as Record<Feature, RollingQuantiles>
    this.rotationFilter = new OneEuroQuaternionFilter(config.rotationMinCutoff, config.rotationBeta, 1)
    const cutoff = (f: Feature) => (f.startsWith('eye') ? config.eyeMinCutoff : f.startsWith('brow') ? config.browMinCutoff : config.mouthMinCutoff)
    this.featureFilters = Object.fromEntries(FEATURES.map((f) => [f, new OneEuroFilter(cutoff(f), 0, 1)])) as Record<Feature, OneEuroFilter>
  }

  get calibrated() {
    return this.template !== null
  }

  setSmoothing(scale: number) {
    this.cutoffScale = 1 / Math.max(0.25, scale)
    this.rotationFilter.minCutoff = this.config.rotationMinCutoff * this.cutoffScale
    for (const f of FEATURES) {
      const base = f.startsWith('eye') ? this.config.eyeMinCutoff : f.startsWith('brow') ? this.config.browMinCutoff : this.config.mouthMinCutoff
      this.featureFilters[f].minCutoff = base * this.cutoffScale
    }
  }

  reset() {
    this.template = null
    this.calibrationShapes.length = 0
    this.residuals.clear()
    FEATURES.forEach((f) => {
      this.quantiles[f].clear()
      this.featureFilters[f].reset()
    })
    this.rotationFilter.reset()
    this.lastRotation = null
    this.lastOutput = null
    this.lastValidTime = -Infinity
    this.framesSinceBaseline = 0
    this.baselines = structuredClone(this.defaults)
  }

  update(face: readonly Landmark[] | null | undefined, image: ImageSpace, time: number): SourceFace | null {
    const lookup = (index: number) => {
      const landmark = face?.[index]
      return landmark && Number.isFinite(landmark.x) && Number.isFinite(landmark.y) && Number.isFinite(landmark.z) ? toModelSpace(landmark, image, this.zScale) : null
    }
    if (face && face.length >= 468) {
      if (!this.template) {
        const shape = rigidShape(lookup)
        if (shape) this.calibrationShapes.push(shape.points)
        if (this.calibrationShapes.length >= this.config.calibrationFrames) this.finishCalibration()
        return this.coast(time)
      }
      const m = measureFace(lookup, this.template)
      const residualGate = this.residuals.size > 30 ? this.residuals.quantile(0.99) * 1.5 : Infinity
      const valid = m !== null && m.residual <= residualGate && FEATURES.every((f) => Number.isFinite(m[f]))
      if (m) this.residuals.push(m.residual)
      if (valid && m) {
        const spike = this.lastRotation !== null && time - this.lastValidTime < 0.1 && angleBetweenQuaternions(m.rotation, this.lastRotation) > this.config.spikeDeg * DEG
        if (!spike) return this.track(m, time)
      }
    }
    return this.coast(time)
  }

  private finishCalibration() {
    let template = buildFaceTemplate(this.calibrationShapes, this.zScale, 3)
    const rotations: Quaternion[] = []
    for (const shape of this.calibrationShapes) {
      // Re-measure the calibration shapes against the template to get their
      // rotations, then make their mean the neutral pose.
      const measured = measureFace((index) => shape.get(index) ?? null, template)
      if (measured) rotations.push(measured.rotation)
    }
    if (rotations.length) template = recenterTemplate(template, rotations)
    this.template = template
    this.calibrationShapes.length = 0
  }

  private track(m: FaceFeatureValues & { rotation: Quaternion }, time: number): SourceFace {
    this.lastRotation = m.rotation.clone()
    this.lastValidTime = time
    const rotation = this.rotationFilter.filter(m.rotation, time)
    const values = {} as FaceFeatureValues
    for (const f of FEATURES) {
      this.quantiles[f].push(m[f])
      values[f] = this.featureFilters[f].filter(m[f], time)
    }
    this.framesSinceBaseline += 1
    if (this.framesSinceBaseline >= 15 && this.quantiles.mouthOpen.size >= 60) {
      this.framesSinceBaseline = 0
      this.baselines = this.rollingBaselines()
    }
    const signals = normalizeFaceSignals(values, this.baselines)
    this.lastOutput = { rotation, ...signals }
    return this.lastOutput
  }

  /** Same percentiles the offline cleaner takes over the whole clip, over a rolling window. */
  private rollingBaselines(): FaceFeatureBaselines {
    const q = (f: Feature, p: number) => this.quantiles[f].quantile(p)
    const cornerNeutral = (q('cornerLiftLeft', 0.5) + q('cornerLiftRight', 0.5)) / 2
    const cornerHigh = (q('cornerLiftLeft', 0.97) + q('cornerLiftRight', 0.97)) / 2
    const d = this.defaults
    // Guard against degenerate windows (e.g. a person who never opens the
    // mouth in the window): never shrink a range below 40% of the default.
    const range = (low: number, high: number, defaultRange: number) => (high - low < 0.4 * defaultRange ? low + 0.4 * defaultRange : high)
    return {
      mouthOpen: { closed: q('mouthOpen', 0.1), open: range(q('mouthOpen', 0.1), q('mouthOpen', 0.97), d.mouthOpen.open - d.mouthOpen.closed) },
      mouthWidth: { neutral: q('mouthWidth', 0.5), wide: range(q('mouthWidth', 0.5), q('mouthWidth', 0.97), d.mouthWidth.wide - d.mouthWidth.neutral), narrow: Math.min(q('mouthWidth', 0.03), q('mouthWidth', 0.5) - 0.4 * (d.mouthWidth.neutral - d.mouthWidth.narrow)) },
      cornerLift: { neutral: cornerNeutral, range: Math.max(0.4 * d.cornerLift.range, cornerHigh - cornerNeutral) },
      eyeOpen: {
        left: { open: q('eyeOpenLeft', 0.7), closed: Math.min(q('eyeOpenLeft', 0.005), q('eyeOpenLeft', 0.7) - 0.4 * (d.eyeOpen.left.open - d.eyeOpen.left.closed)) },
        right: { open: q('eyeOpenRight', 0.7), closed: Math.min(q('eyeOpenRight', 0.005), q('eyeOpenRight', 0.7) - 0.4 * (d.eyeOpen.right.open - d.eyeOpen.right.closed)) }
      },
      brow: {
        left: { neutral: q('browLeft', 0.5), up: range(q('browLeft', 0.5), q('browLeft', 0.97), d.brow.left.up - d.brow.left.neutral), down: Math.min(q('browLeft', 0.03), q('browLeft', 0.5) - 0.4 * (d.brow.left.neutral - d.brow.left.down)) },
        right: { neutral: q('browRight', 0.5), up: range(q('browRight', 0.5), q('browRight', 0.97), d.brow.right.up - d.brow.right.neutral), down: Math.min(q('browRight', 0.03), q('browRight', 0.5) - 0.4 * (d.brow.right.neutral - d.brow.right.down)) }
      }
    }
  }

  /** No valid face: hold the last output, then fade to neutral. */
  private coast(time: number): SourceFace | null {
    if (!this.lastOutput) return null
    const fade = smoothstep(this.config.holdSec, this.config.holdSec + this.config.fadeSec, time - this.lastValidTime)
    if (fade <= 0) return this.lastOutput
    const keep = 1 - fade
    const o = this.lastOutput
    return {
      rotation: new Quaternion().slerp(o.rotation, keep),
      jawOpen: o.jawOpen * keep,
      smile: o.smile * keep,
      mouthStretch: o.mouthStretch * keep,
      blinkLeft: o.blinkLeft * keep,
      blinkRight: o.blinkRight * keep,
      browLeft: o.browLeft * keep,
      browRight: o.browRight * keep
    }
  }
}
