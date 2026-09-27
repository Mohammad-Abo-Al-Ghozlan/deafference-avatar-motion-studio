import { DEG } from '../math'
import { DEFAULT_SOLVER_CONFIG, type SolverConfig } from '../retarget/AvatarSolver'
import type { HandTemplate } from '../source/handModel'
import type { FaceFeatureBaselines } from '../source/faceFeatures'

/**
 * Defaults for the causal (real-time) path.
 *
 * The hand template and face baselines are the solver-calibration constants
 * measured on the bundled sample clip (see motion/qassem-story/
 * processing-report.json). They are GEOMETRIC constants in MediaPipe landmark
 * space (palm shape, phalanx ratios relative to palm length, relaxed finger
 * spread), not a learned model; the live path uses them as a starting point
 * and adapts face baselines online. A per-user calibration step would improve
 * finger accuracy for hands with very different proportions.
 */
export const DEFAULT_HAND_TEMPLATE: HandTemplate = {
  version: 1,
  palm: {
    thumbCmc: [0.2166, 0.2656, 0.297],
    indexMcp: [0.2546, 1.0047, 0.0504],
    middleMcp: [0, 1, 0],
    ringMcp: [-0.2567, 0.9333, 0.0079],
    pinkyMcp: [-0.505, 0.8223, 0.0504]
  },
  lengths: {
    thumb: [0.4129, 0.3333, 0.256],
    index: [0.4407, 0.2493, 0.2041],
    middle: [0.4748, 0.2832, 0.2142],
    ring: [0.5046, 0.3031, 0.2167],
    pinky: [0.417, 0.2247, 0.1827]
  },
  neutralAbduction: { index: -0.19158, middle: -0.18619, ring: -0.25227, pinky: -0.37135 },
  zScale: 2.175,
  source: 'qassem-story calibration (default for live mode)'
}

/** MediaPipe hand relative-depth rescale (calibrated 2.10-2.25 on the sample clip). */
export const DEFAULT_HAND_Z_SCALE = 2.175

/** Face mesh depth scale (rigidity-calibrated value on the sample clip). */
export const DEFAULT_FACE_Z_SCALE = 1

export const DEFAULT_FACE_BASELINES: FaceFeatureBaselines = {
  mouthOpen: { closed: 0.0083, open: 0.3343 },
  mouthWidth: { neutral: 0.5466, wide: 0.6155, narrow: 0.4192 },
  cornerLift: { neutral: 0.0123, range: 0.0408 },
  eyeOpen: { left: { open: 0.2652, closed: 0.1218 }, right: { open: 0.3113, closed: 0.1714 } },
  brow: { left: { neutral: 0.1972, up: 0.2211, down: 0.1705 }, right: { neutral: 0.1697, up: 0.1945, down: 0.1399 } }
}

export interface LiveHandConfig {
  /** Fit gates (same values as the offline cleaner). */
  maxPalmError: number
  maxMeanDigitError: number
  maxOutOfFrame: number
  /** Palm/back hypothesis choice: orientation-change sigma per frame and cost scale. */
  palmSigmaDeg: number
  palmCostScale: number
  /** Fast path: a warm-started fit within this angle of the recent palm is accepted without the mirror hypothesis. */
  continuousDeg: number
  /** A hypothesis more than this far from the recent palm orientation is treated as a flip and rejected... */
  flipRejectDeg: number
  /** ...unless the hand has not been accepted for this long (a genuine re-orientation while lost). */
  flipMemorySec: number
  /** Occlusion handling. */
  holdSec: number
  fallbackSec: number
  reacquireSec: number
  /** One Euro parameters (Hz, and Hz per rad/s). */
  fingerMinCutoff: number
  fingerBeta: number
  palmMinCutoff: number
  palmBeta: number
  /** Glitch-rate limits. */
  maxFingerRateDegS: number
  maxPalmRateDegS: number
  /** Alternating palm/digit refinement passes for the live fit (offline uses 2). */
  refinePasses: number
}

export interface LiveBodyConfig {
  torsoMinCutoff: number
  wristMinCutoff: number
  wristBeta: number
  elbowMinCutoff: number
  shrugMinCutoff: number
  faceAnchorMinCutoff: number
  handAvailabilityTauSec: number
  /** Wrist depth (shoulder widths): outlier gate floor, One Euro, max rate per second. */
  depthGateFloor: number
  depthMinCutoff: number
  depthBeta: number
  maxDepthRate: number
  /** Max image-plane wrist speed (shoulder widths per second) at full trust. */
  maxWristRate: number
  /** Samples kept for the online shoulder-width / shrug / IPD medians. */
  calibrationWindow: number
  holdSec: number
}

export interface LiveFaceConfig {
  calibrationFrames: number
  rotationMinCutoff: number
  rotationBeta: number
  mouthMinCutoff: number
  eyeMinCutoff: number
  browMinCutoff: number
  /** Head rotation change per frame above which a measurement is a spike. */
  spikeDeg: number
  holdSec: number
  fadeSec: number
  baselineWindow: number
}

export interface LiveSwivelConfig {
  candidates: number
  sigmaDeg: number
  minCutoff: number
  beta: number
}

export interface LiveConfig {
  hand: LiveHandConfig
  body: LiveBodyConfig
  face: LiveFaceConfig
  swivel: LiveSwivelConfig
  /** Max forearm pronation/supination change per second applied by the live path. */
  maxTwistRateDegS: number
}

export const DEFAULT_LIVE_CONFIG: LiveConfig = {
  hand: {
    maxPalmError: 0.3,
    maxMeanDigitError: 0.45,
    maxOutOfFrame: 0.55,
    palmSigmaDeg: 35,
    palmCostScale: 200,
    continuousDeg: 45,
    flipRejectDeg: 100,
    flipMemorySec: 0.6,
    holdSec: 0.25,
    fallbackSec: 0.6,
    reacquireSec: 0.15,
    fingerMinCutoff: 2.2,
    fingerBeta: 0.35,
    palmMinCutoff: 1.6,
    palmBeta: 0.4,
    maxFingerRateDegS: 750,
    maxPalmRateDegS: 600,
    refinePasses: 1
  },
  body: {
    torsoMinCutoff: 0.9,
    wristMinCutoff: 1.4,
    wristBeta: 0.9,
    elbowMinCutoff: 1,
    shrugMinCutoff: 1,
    faceAnchorMinCutoff: 2,
    handAvailabilityTauSec: 0.12,
    depthGateFloor: 0.25,
    depthMinCutoff: 0.9,
    depthBeta: 0.15,
    maxDepthRate: 3.5,
    maxWristRate: 11,
    calibrationWindow: 240,
    holdSec: 0.5
  },
  face: {
    calibrationFrames: 45,
    rotationMinCutoff: 1.2,
    rotationBeta: 0.5,
    mouthMinCutoff: 3,
    eyeMinCutoff: 6,
    browMinCutoff: 2,
    spikeDeg: 25,
    holdSec: 0.4,
    fadeSec: 0.6,
    baselineWindow: 450
  },
  swivel: {
    candidates: 48,
    sigmaDeg: 8,
    minCutoff: 1.5,
    beta: 0.5
  },
  maxTwistRateDegS: 540
}

/**
 * The live path eases between solves at render rate (PoseApplier). Easing two
 * valid wrist poses bone-by-bone can overshoot the twist-carried wrist limits
 * by a couple of degrees, so the live solver keeps a 3 deg margin inside the
 * anatomical wrist limits used offline.
 */
export const LIVE_SOLVER_CONFIG: SolverConfig = {
  ...DEFAULT_SOLVER_CONFIG,
  wrist: {
    ...DEFAULT_SOLVER_CONFIG.wrist,
    flexion: DEFAULT_SOLVER_CONFIG.wrist.flexion - 3 * DEG,
    extension: DEFAULT_SOLVER_CONFIG.wrist.extension - 3 * DEG,
    radial: DEFAULT_SOLVER_CONFIG.wrist.radial - 3 * DEG,
    ulnar: DEFAULT_SOLVER_CONFIG.wrist.ulnar - 3 * DEG,
    twist: DEFAULT_SOLVER_CONFIG.wrist.twist - 3 * DEG
  }
}
