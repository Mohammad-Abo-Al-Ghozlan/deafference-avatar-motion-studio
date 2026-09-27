/**
 * Numerical QA over the COMPLETE clip.
 *
 *   npm run motion:qa -- --clip qassem-story [--compare evidence/legacy-motion.json.gz]
 *
 * Writes motion/<clip>/qa-report.json and qa-report.md. Exits non-zero when a
 * hard acceptance criterion fails (NaN, non-unit quaternions, off-hinge PIP/
 * DIP/elbow rotation, reverse bending, limit violations, one-frame spikes,
 * rest resets while tracked, missing frames, bone-length drift, ...).
 */
import { existsSync, writeFileSync } from 'node:fs'
import { validateMotionFile, type AvatarMotionFile } from '../src/motion/clip/format'
import { evaluateMotion, DEFAULT_QA, type QaResult } from '../src/motion/qa/metrics'
import { claudiaProfile, validateSemanticSkeleton } from '../src/motion/rig/semanticMap'
import { buildRigGeometry } from '../src/motion/rig/rigGeometry'
import { parseArgs, readJson, repoPath, writeJson } from './lib/cli'
import { loadGltfRig } from './lib/gltfRig'
import type { CleanFileJson } from './lib/cleanFile'
import type { Side } from '../src/motion/rig/semanticMap'

const args = parseArgs(process.argv.slice(2), {
  clip: 'qassem-story',
  motionDir: 'motion',
  glb: 'public/models/deafference-avatar.glb',
  motion: '',
  compare: '',
  out: '',
  fail: true
})

function trackingSummary(clean: CleanFileJson) {
  const stats = clean.stats as Record<string, any>
  const hands = stats.hands as Record<string, any>
  const out: Record<string, unknown> = {
    processedFrames: clean.timeline.frameCount,
    decodedSourceFrames: stats.rawFrames,
    droppedSourceSlots: (clean.timeline as any).droppedSlots,
    duplicateTrackerFrames: stats.duplicateTrackerFrames,
    identityCorrections: stats.identity
  }
  for (const side of ['left', 'right'] as const) {
    const h = hands[side]
    const intervals = (h.intervals as { state: string; startSec: number; endSec: number }[])
    out[side] = {
      detectedSlots: h.observedSlots,
      acceptedFits: h.acceptedFits,
      rejectedFits: h.rejectedFits,
      rejectReasons: h.rejectReasons,
      rejectedOutliers: { palmOrientationSpikes: h.palmSpikesRejected, scaleOutliers: h.scaleOutliersRejected, jointChannelOutliers: h.channelOutliersRejected },
      states: h.states,
      missingHandIntervals: intervals.filter((i) => i.state === 'absent' || i.state === 'fallback' || i.state === 'held').length,
      interpolatedIntervals: intervals.filter((i) => i.state === 'interpolated').length,
      uncertainIntervals: intervals.filter((i) => i.state === 'held' || i.state === 'fallback').map((i) => [i.startSec, i.endSec])
    }
  }
  out.face = { validSlots: stats.face.validSlots, headSpikesRejected: stats.face.headSpikesRejected, featureOutliersRejected: stats.face.featureOutliersRejected }
  return out
}

type V3 = [number, number, number]
interface FastEvent { frame: number; side: Side; jumpM: number }

/**
 * Every fast (but continuous) avatar wrist step must be explained by the
 * cleaned source motion: compare it with the source wrist / hand-centre step
 * over the same frame, converted to avatar metres by the body calibration.
 * A ratio well above 1 means the retarget amplified or invented motion.
 */
function fastMotionCrossCheck(events: FastEvent[], clean: CleanFileJson, maxRatio = 2.5) {
  const shoulderWidthM = Number((clean.calibration.body as Record<string, unknown>).shoulderWidthM)
  const dist = (u: V3, v: V3) => Math.hypot(u[0] - v[0], u[1] - v[1], u[2] - v[2]) * shoulderWidthM
  const dist2d = (u: V3, v: V3) => Math.hypot(u[0] - v[0], u[1] - v[1]) * shoulderWidthM
  const rows = events.map((event) => {
    const a = clean.frames[event.frame - 1].body
    const b = clean.frames[event.frame].body
    const wristM = dist(a.wrist[event.side], b.wrist[event.side])
    const handM = dist(a.handCenter[event.side], b.handCenter[event.side])
    const source = Math.max(wristM, handM)
    return {
      ...event,
      timeSec: Math.round((event.frame / clean.timeline.fps) * 1000) / 1000,
      handState: clean.frames[event.frame].hands[event.side].state,
      sourceWristStepM: Math.round(wristM * 1e4) / 1e4,
      sourceHandCentreStepM: Math.round(handM * 1e4) / 1e4,
      sourceImagePlaneStepM: Math.round(Math.max(dist2d(a.wrist[event.side], b.wrist[event.side]), dist2d(a.handCenter[event.side], b.handCenter[event.side])) * 1e4) / 1e4,
      avatarToSourceRatio: Math.round((event.jumpM / Math.max(source, 1e-3)) * 100) / 100
    }
  })
  const unexplained = rows.filter((row) => row.avatarToSourceRatio > maxRatio)
  return { maxRatio, events: rows.length, explained: rows.length - unexplained.length, unexplained: unexplained.length, rows }
}

function markdown(result: QaResult, tracking: Record<string, any> | null, compare: QaResult | null, crossCheck: ReturnType<typeof fastMotionCrossCheck> | null) {
  const lines: string[] = []
  const a = result.anatomical as Record<string, any>
  const n = result.numeric as Record<string, any>
  const s = result.structural as Record<string, any>
  lines.push(`# Motion QA report — ${args.clip}`, '')
  lines.push(`Verdict: **${result.failures.length ? 'FAIL' : 'PASS'}**${result.failures.length ? ` (${result.failures.join('; ')})` : ''}`, '')
  lines.push('| Check | Result |', '|---|---|')
  lines.push(`| Frames / fps / duration | ${s.frameCount} / ${s.fps} / ${s.durationSec}s (missing ${s.missingFrames}) |`)
  lines.push(`| Timestamps monotonic, mapping complete | ${s.timestampsMonotonic}, ${s.timelineMappingComplete} |`)
  lines.push(`| NaN/Inf values | ${n.nonFiniteValues} |`)
  lines.push(`| Max quaternion norm error | ${Number(n.maxQuaternionNormError).toExponential(2)} |`)
  lines.push(`| Quaternion sign flips | ${n.quaternionHemisphereFlips} |`)
  lines.push(`| PIP / DIP off-hinge frames (>${DEFAULT_QA.hingeOffAxisDeg}°) | ${a.hingeOffAxis.pip.frames} / ${a.hingeOffAxis.dip.frames} |`)
  lines.push(`| Thumb MCP / IP off-hinge frames | ${a.hingeOffAxis.thumbMcp.frames} / ${a.hingeOffAxis.thumbIp.frames} |`)
  lines.push(`| Elbow off-hinge frames | ${a.hingeOffAxis.elbow.frames} |`)
  lines.push(`| Reverse-bend frames PIP / DIP | ${a.reverseBending.pip.frames} / ${a.reverseBending.dip.frames} |`)
  lines.push(`| Finger twist frames (>${DEFAULT_QA.fingerTwistDeg}°) | ${a.fingerTwist.frames} (max ${a.extremesDeg.fingerTwist}°) |`)
  lines.push(`| Joint-range violations PIP / DIP / MCP / thumb | ${a.rangeViolations.pip.frames} / ${a.rangeViolations.dip.frames} / ${a.rangeViolations.mcp.frames} / ${a.rangeViolations.thumb.frames} |`)
  lines.push(`| Elbow hyperextension / overflexion frames | ${a.rangeViolations.elbowHyperextension.frames} / ${a.rangeViolations.elbowOverflex.frames} |`)
  lines.push(`| Wrist flex / deviation / twist violations | ${a.wristLimitViolations.flex.frames} / ${a.wristLimitViolations.dev.frames} / ${a.wristLimitViolations.twist.frames} |`)
  lines.push(`| Finger-order reversals | ${a.fingerOrderReversals.frames} |`)
  lines.push(`| Fingertip-palm penetration frames | ${a.fingertipPalmPenetration.frames} |`)
  lines.push(`| Rest-pose resets while tracked | ${a.restPoseResetsWhileTracked} |`)
  lines.push(`| Wrist teleports (impulsive step >${DEFAULT_QA.wristImpulseRatio}x both neighbours, jump-and-return, or >${DEFAULT_QA.wristMaxSpeedMs} m/s) | ${a.wristTeleports.frames} |`)
  lines.push(`| Fast continuous wrist motion (>${DEFAULT_QA.wristFastSpeedMs} m/s) | ${a.wristFastMotion.frames} frames, max ${a.wristFastMotion.maxStepM} m/frame${crossCheck ? `; source cross-check: ${crossCheck.explained}/${crossCheck.events} explained by source motion (avatar/source step ratio <= ${crossCheck.maxRatio})` : ''} |`)
  lines.push(`| Max wrist speed | ${a.maxWristSpeedMs} m/s |`)
  lines.push(`| Max bone-length error | ${Number(a.maxBoneLengthErrorM).toExponential(2)} m |`)
  lines.push('', '## Joint extremes (degrees)', '', '```json', JSON.stringify(a.extremesDeg, null, 2), '```', '')
  lines.push('## Temporal (per bone class)', '', '| Class | Max step (°/frame) | worst bone | p99.9 step | Max ang. velocity (°/s) | p99.9 ang. accel (°/s²) | One-frame spikes |', '|---|---|---|---|---|---|---|')
  for (const [cls, v] of Object.entries(result.temporal as Record<string, any>)) {
    lines.push(`| ${cls} | ${v.maxStepDeg} | ${v.worstBone} | ${v.p999StepDeg} | ${v.maxAngularVelocityDegS} | ${v.p999AccelerationDegS2} | ${v.oneFrameSpikes} |`)
  }
  if (crossCheck && crossCheck.rows.length) {
    lines.push('', '## Fast wrist motion vs source', '', '| Frame | t (s) | Side | Hand state | Avatar step (m) | Source wrist step (m) | Source hand-centre step (m) | Source image-plane step (m) | Ratio |', '|---|---|---|---|---|---|---|---|---|')
    for (const r of crossCheck.rows) lines.push(`| ${r.frame} | ${r.timeSec} | ${r.side} | ${r.handState} | ${r.jumpM} | ${r.sourceWristStepM} | ${r.sourceHandCentreStepM} | ${r.sourceImagePlaneStepM} | ${r.avatarToSourceRatio} |`)
  }
  if (tracking) {
    lines.push('', '## Tracking and cleaning', '', '```json', JSON.stringify(tracking, null, 2), '```')
  }
  if (compare) {
    const b = compare.anatomical as Record<string, any>
    lines.push('', '## Before (legacy solver) vs after', '', '| Metric | Before | After |', '|---|---|---|')
    const rows: [string, (r: Record<string, any>) => unknown][] = [
      ['Reverse-bend frames PIP', (r) => r.reverseBending.pip.frames],
      ['Reverse-bend frames DIP', (r) => r.reverseBending.dip.frames],
      ['PIP range violations', (r) => r.rangeViolations.pip.frames],
      ['DIP range violations', (r) => r.rangeViolations.dip.frames],
      ['MCP range violations', (r) => r.rangeViolations.mcp.frames],
      ['Finger twist frames', (r) => r.fingerTwist.frames],
      ['Max finger twist (°)', (r) => r.extremesDeg.fingerTwist],
      ['Finger-order reversals', (r) => r.fingerOrderReversals.frames],
      ['Fingertip-palm penetration', (r) => r.fingertipPalmPenetration.frames],
      ['Wrist deviation violations', (r) => r.wristLimitViolations.dev.frames],
      ['Wrist flexion violations', (r) => r.wristLimitViolations.flex.frames],
      ['Wrist twist violations', (r) => r.wristLimitViolations.twist.frames],
      ['Elbow hyperextension frames', (r) => r.rangeViolations.elbowHyperextension.frames],
      ['Rest resets while tracked', (r) => r.restPoseResetsWhileTracked],
      ['Wrist teleports (impulsive)', (r) => r.wristTeleports.frames],
      ['Fast wrist motion frames', (r) => r.wristFastMotion.frames],
      ['Max wrist speed (m/s)', (r) => r.maxWristSpeedMs]
    ]
    for (const [label, get] of rows) lines.push(`| ${label} | ${get(b)} | ${get(a)} |`)
    const tb = compare.temporal as Record<string, any>
    const ta = result.temporal as Record<string, any>
    for (const cls of ['finger', 'wrist', 'arm']) {
      if (tb[cls] && ta[cls]) {
        lines.push(`| ${cls} max step (°/frame) | ${tb[cls].maxStepDeg} | ${ta[cls].maxStepDeg} |`)
        lines.push(`| ${cls} one-frame spikes | ${tb[cls].oneFrameSpikes} | ${ta[cls].oneFrameSpikes} |`)
      }
    }
  }
  return lines.join('\n')
}

async function main() {
  const motionPath = args.motion || `${args.motionDir}/${args.clip}/avatar-motion.json.gz`
  const motion = readJson<AvatarMotionFile>(motionPath)
  validateMotionFile(motion)
  const { rig } = await loadGltfRig(repoPath(args.glb))
  const map = claudiaProfile()
  const validation = validateSemanticSkeleton(rig, map)
  if (!validation.ok) throw new Error('rig validation failed')
  const geometry = buildRigGeometry(rig, map, validation.facing, validation.characterLeft)
  const started = Date.now()
  const result = evaluateMotion(motion, rig, map, geometry)
  const cleanPath = `${args.motionDir}/${args.clip}/clean-landmarks.json.gz`
  const clean = existsSync(repoPath(cleanPath)) ? readJson<CleanFileJson>(cleanPath) : null
  const tracking = clean ? trackingSummary(clean) : null
  const events = (result.anatomical as Record<string, any>).wristFastMotion.events as FastEvent[]
  const crossCheck = clean && (clean.timeline.frameCount === motion.frameCount) ? fastMotionCrossCheck(events, clean) : null
  if (crossCheck?.unexplained) result.failures.push(`${crossCheck.unexplained} fast wrist steps not explained by source motion`)
  let compare: QaResult | null = null
  // The canonical clip report includes the before/after comparison whenever
  // the legacy replay exists (tools/legacy-motion.ts).
  if (!args.compare && !args.motion && existsSync(repoPath('evidence/legacy-motion.json.gz'))) args.compare = 'evidence/legacy-motion.json.gz'
  if (args.compare) {
    const legacy = readJson<AvatarMotionFile>(args.compare)
    validateMotionFile(legacy)
    compare = evaluateMotion(legacy, rig, map, geometry)
  }
  const report = {
    schema: 'deafference.qa-report',
    schemaVersion: 1,
    clipId: args.clip,
    motion: motionPath,
    thresholds: DEFAULT_QA,
    verdict: result.failures.length ? 'FAIL' : 'PASS',
    ...result,
    tracking,
    fastMotionSourceCrossCheck: crossCheck,
    ...(compare ? { legacyComparison: { motion: args.compare, verdict: compare.failures.length ? 'FAIL' : 'PASS', failures: compare.failures, anatomical: compare.anatomical, temporal: compare.temporal } } : {}),
    seconds: Math.round((Date.now() - started) / 100) / 10
  }
  const out = args.out || `${args.motionDir}/${args.clip}/qa-report.json`
  writeJson(out, report, true)
  writeFileSync(repoPath(out.replace(/\.json$/, '.md')), markdown(result, tracking, compare, crossCheck))
  console.log(`QA ${report.verdict} (${report.seconds}s) -> ${out}`)
  for (const failure of result.failures) console.log(`  FAIL: ${failure}`)
  if (compare) console.log(`legacy comparison verdict: ${report.legacyComparison!.verdict} (${compare.failures.length} failure classes)`)
  if (args.fail && result.failures.length) process.exit(1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
