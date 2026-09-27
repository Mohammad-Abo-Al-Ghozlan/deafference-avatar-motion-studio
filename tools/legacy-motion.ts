/**
 * Replay the ORIGINAL (pre-fix) solver headlessly and export its output in
 * the avatar-motion format, so the same QA metrics can measure before/after.
 *
 *   npx tsx tools/legacy-motion.ts --raw evidence/inputs/raw-landmarks.live-smoothed.json.gz \
 *       --out evidence/legacy-motion.json.gz
 *
 * Frame stepping mirrors the live app: update() on every tracker result (here:
 * every source frame, the legacy solver's best case), tick() at 60 Hz render
 * rate, timestamps on the source timeline.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { Landmark, TrackingFrame } from '../src/types/tracking'
import { roundTo } from '../src/motion/math'
import { HAND_STATE_LEGEND, type AvatarMotionFile, type MotionTrack } from '../src/motion/clip/format'
import { AvatarRetargeter as LegacyRetargeter } from './evidence/legacy/AvatarRetargeter.legacy'
import { parseArgs, readJson, repoPath, writeJson } from './lib/cli'
import { loadGltfRig } from './lib/gltfRig'
import { buildThreeHierarchy } from './lib/threeRig'
import type { RawClipJson } from './lib/raw'

const args = parseArgs(process.argv.slice(2), {
  raw: 'evidence/inputs/raw-landmarks.live-smoothed.json.gz',
  glb: 'public/models/deafference-avatar.glb',
  out: 'evidence/legacy-motion.json.gz',
  fps: 30,
  smoothing: 15
})

function unpack(flat: number[] | null, stride: number): Landmark[] | undefined {
  if (!flat) return undefined
  const out: Landmark[] = []
  for (let i = 0; i < flat.length; i += stride) out.push({ x: flat[i], y: flat[i + 1], z: flat[i + 2], visibility: stride >= 4 ? flat[i + 3] : undefined })
  return out
}

async function main() {
  const raw = readJson<RawClipJson>(args.raw)
  const loaded = await loadGltfRig(repoPath(args.glb))
  const { root, byName } = buildThreeHierarchy(loaded)
  const legacy = new LegacyRetargeter(root)
  legacy.setSmoothing(args.smoothing)
  legacy.setStrength(1)

  const faceIndices = raw.layout.faceIndices
  const bySlot = new Map<number, TrackingFrame>()
  for (const frame of raw.frames) {
    const k = Math.round(frame.t * args.fps)
    if (bySlot.has(k)) continue
    let face: Landmark[] | undefined
    if (frame.face) {
      face = new Array(478)
      faceIndices.forEach((meshIndex, i) => { face![meshIndex] = { x: frame.face![i * 3], y: frame.face![i * 3 + 1], z: frame.face![i * 3 + 2] } })
    }
    bySlot.set(k, {
      poseLandmarks: unpack(frame.pose, 5),
      leftHandLandmarks: unpack(frame.leftHand, 3),
      rightHandLandmarks: unpack(frame.rightHand, 3),
      faceLandmarks: face,
      timestamp: frame.t * 1000
    })
  }
  const frameCount = Math.round(raw.frames[raw.frames.length - 1].t * args.fps) + 1

  // Bones the legacy solver writes (its CONTROLLED_BONES resolved to this rig).
  const suffix = (s: string) => (s === 'Left' ? 'l' : 'r')
  const rotated = ['spine_03', 'head', 'jaw', 'eyelid_l', 'eyelid_r']
  for (const side of ['Left', 'Right']) {
    rotated.push(`upperarm_${suffix(side)}`, `lowerarm_${suffix(side)}`, `hand_${suffix(side)}`)
    for (const finger of ['thumb', 'index', 'middle', 'ring', 'pinky']) for (const j of ['01', '02', '03']) rotated.push(`${finger}_${j}_${suffix(side)}`)
  }
  const translated = ['eyebrow_l', 'eyebrow_r', 'mouth_l', 'mouth_r']
  const rotValues = new Map(rotated.map((name) => [name, [] as number[]]))
  const posValues = new Map(translated.map((name) => [name, [] as number[]]))

  for (let k = 0; k < frameCount; k += 1) {
    const frame = bySlot.get(k)
    if (frame) legacy.update(frame)
    const base = (k / args.fps) * 1000
    legacy.tick(1 / 60, base + 1000 / 120, true)
    legacy.tick(1 / 60, base + 1000 / 60, true)
    for (const name of rotated) {
      const q = byName.get(name)!.quaternion
      rotValues.get(name)!.push(...[q.x, q.y, q.z, q.w].map((v) => roundTo(v, 6)))
    }
    for (const name of translated) {
      const p = byName.get(name)!.position
      posValues.get(name)!.push(...[p.x, p.y, p.z].map((v) => roundTo(v, 6)))
    }
  }

  const tracks: MotionTrack[] = [
    ...rotated.map((bone) => ({ bone, path: 'rotation' as const, values: rotValues.get(bone)! })),
    ...translated.map((bone) => ({ bone, path: 'translation' as const, values: posValues.get(bone)! }))
  ]
  const code = (k: number, key: 'leftHandLandmarks' | 'rightHandLandmarks') => (bySlot.get(k)?.[key] ? 'T' : 'A')
  const motion: AvatarMotionFile = {
    schema: 'deafference.avatar-motion',
    schemaVersion: 1,
    clipId: raw.clipId,
    generator: 'tools/legacy-motion.ts (replay of the original AvatarRetargeter, for before/after evidence only)',
    rig: { file: args.glb, sha256: createHash('sha256').update(readFileSync(repoPath(args.glb))).digest('hex'), profile: 'legacy-alias-map', joints: loaded.jointNames.size },
    source: { video: raw.source.file, sha256: raw.source.sha256 },
    fps: args.fps,
    frameCount,
    durationSec: roundTo((frameCount - 1) / args.fps, 5),
    space: 'glTF node LOCAL transforms (legacy solver output).',
    timeline: { sourceFrame: Array.from({ length: frameCount }, () => null), sourceTime: Array.from({ length: frameCount }, () => null) },
    tracks,
    quality: {
      handState: {
        left: Array.from({ length: frameCount }, (_, k) => code(k, 'leftHandLandmarks')).join(''),
        right: Array.from({ length: frameCount }, (_, k) => code(k, 'rightHandLandmarks')).join('')
      },
      legend: HAND_STATE_LEGEND,
      uncertainIntervals: []
    },
    notes: ['Legacy solver replay. Not a deliverable motion; used to quantify the pre-fix failure modes.']
  }
  writeJson(args.out, motion)
  console.log(`legacy motion: ${frameCount} frames, ${tracks.length} tracks -> ${args.out}`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
