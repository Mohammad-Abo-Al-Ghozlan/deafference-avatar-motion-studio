/**
 * Stage 3: clean source motion -> avatar local bone transforms.
 *
 *   npm run motion:solve -- --clip qassem-story
 *
 * Reads  motion/<clip>/clean-landmarks.json.gz + the GLB
 * Writes motion/<clip>/avatar-motion.json.gz (canonical export) and a copy at
 *        public/motion/<clip>/avatar-motion.json.gz for the web player.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { Quaternion } from 'three'
import { angleBetweenQuaternions, DEG, RAD, roundTo } from '../src/motion/math'
import { butterworthLowpass, filtfilt } from '../src/motion/filters/offline'
import { AvatarSolver, DEFAULT_SOLVER_CONFIG } from '../src/motion/retarget/AvatarSolver'
import { HAND_STATE_LEGEND, type AvatarMotionFile, type HandStateCode, type MotionTrack } from '../src/motion/clip/format'
import { parseArgs, readJson, repoPath, writeJson } from './lib/cli'
import { loadGltfRig } from './lib/gltfRig'
import { loadCleanFile, neutralAbduction, sourcePoseFromClean } from './lib/cleanFile'

const args = parseArgs(process.argv.slice(2), {
  clip: 'qassem-story',
  motionDir: 'motion',
  glb: 'public/models/deafference-avatar.glb',
  playbackVideo: 'public/samples/qassem-story.mp4',
  publish: true
})

const sha256 = (path: string) => createHash('sha256').update(readFileSync(repoPath(path))).digest('hex')

async function main() {
  const started = Date.now()
  const cleanPath = `${args.motionDir}/${args.clip}/clean-landmarks.json.gz`
  const clean = loadCleanFile(cleanPath)
  const { rig, jointNames } = await loadGltfRig(repoPath(args.glb))
  const solver = new AvatarSolver(rig, neutralAbduction(clean), DEFAULT_SOLVER_CONFIG)
  const n = clean.frames.length

  const rotationTracks = new Map<string, Quaternion[]>()
  const translationTracks = new Map<string, number[][]>()
  solver.controlled.forEach((bone) => rotationTracks.set(bone, []))
  solver.translated.forEach((bone) => translationTracks.set(bone, []))
  const diag = {
    reachClamped: { left: 0, right: 0 },
    wristTwistClamped: { left: 0, right: 0 },
    wristSwingClamped: { left: 0, right: 0 },
    collisionPushes: { left: 0, right: 0 },
    depthCompleted: { left: 0, right: 0 },
    maxDepthCompletionM: { left: 0, right: 0 },
    maxCollisionPushM: { left: 0, right: 0 },
    maxIkErrorM: { left: 0, right: 0 },
    elbowFlexionDeg: { left: [Infinity, -Infinity], right: [Infinity, -Infinity] },
    fingerCrossingCorrections: 0,
    maxHeadAngleDeg: 0,
    forearmTwistSideTransitionsSmoothed: { left: 0, right: 0 }
  }

  // Elbow swivel: per-frame cost curves over 48 candidate angles, then a
  // Viterbi pass for the globally smooth sequence (no elbow flipping between
  // local minima), then zero-phase smoothing of the unwrapped angle.
  const sources = clean.frames.map((frame) => sourcePoseFromClean(frame))
  const candidates = Array.from({ length: 48 }, (_, i) => -Math.PI + (i * 2 * Math.PI) / 48)
  const swivel = { left: new Float64Array(n), right: new Float64Array(n) }
  const costCurves = { left: [] as Float64Array[], right: [] as Float64Array[] }
  const hintTwist: Record<'left' | 'right', number | undefined> = { left: undefined, right: undefined }
  for (let k = 0; k < n; k += 1) {
    const costs = solver.swivelCosts(sources[k], candidates, hintTwist)
    costCurves.left.push(costs.left)
    costCurves.right.push(costs.right)
    // Track the twist of the hint-based solution for unwrapping continuity.
    const hinted = solver.solve(sources[k], { previousTwist: hintTwist })
    hintTwist.left = hinted.diagnostics.arms.left.wristTwistRaw
    hintTwist.right = hinted.diagnostics.arms.right.wristTwistRaw
  }
  for (const side of ['left', 'right'] as const) {
    const path = viterbi(costCurves[side], candidates, 8 * DEG)
    const unwrapped = new Float64Array(n)
    for (let k = 0; k < n; k += 1) {
      const value = candidates[path[k]]
      if (k === 0) unwrapped[k] = value
      else {
        let delta = value - unwrapped[k - 1]
        delta = Math.atan2(Math.sin(delta), Math.cos(delta))
        unwrapped[k] = unwrapped[k - 1] + delta
      }
    }
    swivel[side] = filtfilt(butterworthLowpass(3, clean.timeline.fps), unwrapped)
  }

  // Forearm twist: when the required pronation passes through the
  // anatomically impossible +-180 deg zone, the clamped twist changes side.
  // Replace each such change with a fast but continuous forearm rotation.
  const applied = { left: new Float64Array(n), right: new Float64Array(n) }
  {
    const previous: Record<'left' | 'right', number | undefined> = { left: undefined, right: undefined }
    for (let k = 0; k < n; k += 1) {
      const probe = solver.solve(sources[k], { swivel: { left: swivel.left[k], right: swivel.right[k] }, previousTwist: previous })
      for (const side of ['left', 'right'] as const) {
        applied[side][k] = probe.diagnostics.arms[side].wristTwist
        previous[side] = probe.diagnostics.arms[side].wristTwistRaw
      }
    }
  }
  const twistOverride = { left: new Float64Array(n).fill(NaN), right: new Float64Array(n).fill(NaN) }
  const twistTransitions = { left: 0, right: 0 }
  for (const side of ['left', 'right'] as const) {
    const a = applied[side]
    for (let k = 1; k < n; k += 1) {
      if (Math.abs(a[k] - a[k - 1]) < 60 * DEG) continue
      twistTransitions[side] += 1
      const from = Math.max(0, k - 7)
      const to = Math.min(n - 1, k + 6)
      for (let j = from; j <= to; j += 1) {
        const t = (j - from) / (to - from)
        const w = 0.5 - 0.5 * Math.cos(Math.PI * t)
        twistOverride[side][j] = a[from] * (1 - w) + a[to] * w
      }
    }
  }

  const previousTwist: Record<'left' | 'right', number | undefined> = { left: undefined, right: undefined }
  for (let k = 0; k < n; k += 1) {
    const solved = solver.solve(sources[k], {
      swivel: { left: swivel.left[k], right: swivel.right[k] },
      previousTwist,
      twistOverride: { left: Number.isNaN(twistOverride.left[k]) ? undefined : twistOverride.left[k], right: Number.isNaN(twistOverride.right[k]) ? undefined : twistOverride.right[k] }
    })
    previousTwist.left = solved.diagnostics.arms.left.wristTwistRaw
    previousTwist.right = solved.diagnostics.arms.right.wristTwistRaw
    for (const [bone, q] of solved.rotations) rotationTracks.get(bone)!.push(q)
    for (const [bone, p] of solved.translations) translationTracks.get(bone)!.push([p.x, p.y, p.z])
    for (const side of ['left', 'right'] as const) {
      const a = solved.diagnostics.arms[side]
      if (a.reachClamped) diag.reachClamped[side] += 1
      if (a.wristTwistClamped) diag.wristTwistClamped[side] += 1
      if (a.wristSwingClamped) diag.wristSwingClamped[side] += 1
      if (a.collisionPushM > 1e-4) diag.collisionPushes[side] += 1
      if (a.depthCompletedM > 1e-4) diag.depthCompleted[side] += 1
      diag.maxDepthCompletionM[side] = Math.max(diag.maxDepthCompletionM[side], a.depthCompletedM)
      diag.maxCollisionPushM[side] = Math.max(diag.maxCollisionPushM[side], a.collisionPushM)
      diag.maxIkErrorM[side] = Math.max(diag.maxIkErrorM[side], a.ikErrorM)
      diag.elbowFlexionDeg[side][0] = Math.min(diag.elbowFlexionDeg[side][0], a.elbowFlexion * RAD)
      diag.elbowFlexionDeg[side][1] = Math.max(diag.elbowFlexionDeg[side][1], a.elbowFlexion * RAD)
    }
    diag.fingerCrossingCorrections += solved.diagnostics.fingerCrossingCorrections
    diag.maxHeadAngleDeg = Math.max(diag.maxHeadAngleDeg, solved.diagnostics.headAngle * RAD)
  }

  diag.forearmTwistSideTransitionsSmoothed = twistTransitions

  // Quaternion continuity: one hemisphere per track (no sign flips), and a
  // report of the largest per-frame step for every bone.
  const maxStepDeg: Record<string, number> = {}
  const tracks: MotionTrack[] = []
  for (const [bone, list] of rotationTracks) {
    for (let k = 1; k < list.length; k += 1) if (list[k].dot(list[k - 1]) < 0) list[k].set(-list[k].x, -list[k].y, -list[k].z, -list[k].w)
    let maxStep = 0
    for (let k = 1; k < list.length; k += 1) maxStep = Math.max(maxStep, angleBetweenQuaternions(list[k], list[k - 1]))
    maxStepDeg[bone] = roundTo(maxStep * RAD, 3)
    tracks.push({ bone, path: 'rotation', values: list.flatMap((q) => [q.x, q.y, q.z, q.w].map((v) => roundTo(v, 6))) })
  }
  for (const [bone, list] of translationTracks) {
    tracks.push({ bone, path: 'translation', values: list.flatMap((p) => p.map((v) => roundTo(v, 6))) })
  }

  const code = (state: string): HandStateCode => ({ tracked: 'T', interpolated: 'I', held: 'H', fallback: 'F', absent: 'A' } as const)[state as 'tracked'] ?? 'A'
  const handState = {
    left: clean.frames.map((f) => code(f.hands.left.state)).join(''),
    right: clean.frames.map((f) => code(f.hands.right.state)).join('')
  }
  const uncertain: AvatarMotionFile['quality']['uncertainIntervals'] = []
  for (const side of ['left', 'right'] as const) {
    const states = clean.frames.map((f) => f.hands[side].state)
    let begin = 0
    for (let k = 1; k <= n; k += 1) {
      if (k === n || states[k] !== states[begin]) {
        if (states[begin] === 'held' || states[begin] === 'fallback') {
          uncertain.push({ side, state: states[begin], startSec: roundTo(begin / clean.timeline.fps, 3), endSec: roundTo((k - 1) / clean.timeline.fps, 3) })
        }
        begin = k
      }
    }
  }

  const rawJson = readJson<{ source: { sha256: string; file: string } }>(clean.raw.file)
  const motion: AvatarMotionFile = {
    schema: 'deafference.avatar-motion',
    schemaVersion: 1,
    clipId: args.clip,
    generator: 'tools/solve-motion.ts',
    rig: { file: args.glb, sha256: sha256(args.glb), profile: solver.map.profile, joints: jointNames.size },
    source: {
      video: rawJson.source.file,
      sha256: rawJson.source.sha256,
      ...(existsSync(repoPath(args.playbackVideo)) ? { playbackVideo: args.playbackVideo, playbackSha256: sha256(args.playbackVideo) } : {})
    },
    clean: { file: cleanPath, sha256: sha256(cleanPath) },
    fps: clean.timeline.fps,
    frameCount: n,
    durationSec: clean.timeline.durationSec,
    space: 'glTF node LOCAL (parent-space) transforms of the supplied GLB; rotations are unit quaternions [x,y,z,w]; translations in metres. Frame k is at t = k / fps seconds of the source video timeline.',
    timeline: {
      sourceFrame: clean.frames.map((f) => f.source),
      sourceTime: clean.frames.map((f) => f.sourceTime)
    },
    tracks,
    quality: { handState, legend: HAND_STATE_LEGEND, uncertainIntervals: uncertain },
    notes: [
      'Motion retargeting of one recorded performance; NOT sign-language translation and NOT a trained motion model.',
      'Single-camera tracking: occluded fingers and depth are estimated under anatomical constraints; review by a fluent Deaf signer is required before any linguistic use.'
    ]
  }

  const outPath = `${args.motionDir}/${args.clip}/avatar-motion.json.gz`
  writeJson(outPath, motion)
  if (args.publish) {
    const publicPath = repoPath(`public/motion/${args.clip}/avatar-motion.json.gz`)
    mkdirSync(dirname(publicPath), { recursive: true })
    copyFileSync(repoPath(outPath), publicPath)
  }

  const reportPath = `${args.motionDir}/${args.clip}/processing-report.json`
  const report = existsSync(repoPath(reportPath)) ? readJson<Record<string, unknown>>(reportPath) : {}
  const stages = (report.stages as Record<string, unknown>) ?? {}
  stages.solve = { seconds: roundTo((Date.now() - started) / 1000, 1) }
  report.stages = stages
  report.solve = {
    solverConfig: DEFAULT_SOLVER_CONFIG,
    controlledRotationBones: solver.controlled,
    translatedBones: solver.translated,
    diagnostics: diag,
    maxPerFrameStepDeg: maxStepDeg,
    output: { file: outPath, frames: n, tracks: tracks.length }
  }
  writeJson(reportPath, report, true)
  console.log(`solved ${n} frames, ${tracks.length} tracks in ${((Date.now() - started) / 1000).toFixed(1)} s -> ${outPath}`)
  console.log('diagnostics', JSON.stringify(diag))
}

/** Minimum-cost path through per-frame candidate costs with a wrapped-angle smoothness penalty. */
function viterbi(costs: Float64Array[], candidates: number[], sigma: number) {
  const m = candidates.length
  const n = costs.length
  const transition = new Float64Array(m * m)
  for (let i = 0; i < m; i += 1) {
    for (let j = 0; j < m; j += 1) {
      const d = Math.atan2(Math.sin(candidates[j] - candidates[i]), Math.cos(candidates[j] - candidates[i]))
      transition[i * m + j] = (d / sigma) ** 2
    }
  }
  let total = Float64Array.from(costs[0])
  const back: Int32Array[] = [new Int32Array(m)]
  for (let k = 1; k < n; k += 1) {
    const next = new Float64Array(m)
    const pointer = new Int32Array(m)
    for (let j = 0; j < m; j += 1) {
      let best = Infinity
      let arg = 0
      for (let i = 0; i < m; i += 1) {
        const value = total[i] + transition[i * m + j]
        if (value < best) {
          best = value
          arg = i
        }
      }
      next[j] = best + costs[k][j]
      pointer[j] = arg
    }
    total = next
    back.push(pointer)
  }
  const path = new Int32Array(n)
  let arg = 0
  for (let j = 1; j < m; j += 1) if (total[j] < total[arg]) arg = j
  path[n - 1] = arg
  for (let k = n - 1; k > 0; k -= 1) path[k - 1] = back[k][path[k]]
  return path
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
