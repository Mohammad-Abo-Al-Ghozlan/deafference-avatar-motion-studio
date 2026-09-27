/**
 * Bake an avatar-motion file into a glTF animation clip on the ORIGINAL GLB.
 *
 *   npm run motion:export -- --clip qassem-story
 *   -> motion/<clip>/<clip>.animation.glb (+ .export-report.json)
 *
 * The GLB is edited at the container level instead of being re-serialised by
 * a glTF library: the original JSON objects and the original binary chunk are
 * kept verbatim (the BIN chunk is a byte-identical prefix of the output), and
 * only `animations`, new accessors and new bufferViews are appended. Meshes,
 * skin, materials (incl. KHR_materials_specular), textures (incl. the WebP /
 * JPEG pair of EXT_texture_webp), proportions and rest pose cannot change.
 *
 * Each track becomes one LINEAR channel (quaternions are slerped by glTF
 * players) sampled at the motion file's uniform grid t = k / fps, i.e. the
 * source-video timeline. Metadata linking video, rig and motion lives in
 * `animations[0].extras`.
 */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import validator from 'gltf-validator'
import { validateMotionFile, type AvatarMotionFile } from '../src/motion/clip/format'
import { parseArgs, readJson, repoPath, writeJson } from './lib/cli'

const args = parseArgs(process.argv.slice(2), {
  clip: 'qassem-story',
  motionDir: 'motion',
  glb: 'public/models/deafference-avatar.glb',
  motion: '',
  out: '',
  name: ''
})

const GLB_MAGIC = 0x46546c67
const CHUNK_JSON = 0x4e4f534a
const CHUNK_BIN = 0x004e4942

interface GltfJson {
  asset: Record<string, unknown>
  nodes: { name?: string }[]
  accessors?: Record<string, unknown>[]
  bufferViews?: Record<string, unknown>[]
  buffers: { byteLength: number; uri?: string }[]
  animations?: Record<string, unknown>[]
  [key: string]: unknown
}

export interface ParsedGlb {
  json: GltfJson
  bin: Buffer
}

export function parseGlb(bytes: Buffer): ParsedGlb {
  if (bytes.readUInt32LE(0) !== GLB_MAGIC) throw new Error('Not a GLB file')
  if (bytes.readUInt32LE(4) !== 2) throw new Error('Only glTF 2.0 GLB is supported')
  const total = bytes.readUInt32LE(8)
  if (total !== bytes.length) throw new Error(`GLB length header ${total} != file size ${bytes.length}`)
  let offset = 12
  let json: GltfJson | null = null
  let bin: Buffer | null = null
  while (offset < total) {
    const length = bytes.readUInt32LE(offset)
    const type = bytes.readUInt32LE(offset + 4)
    const data = bytes.subarray(offset + 8, offset + 8 + length)
    if (type === CHUNK_JSON) json = JSON.parse(data.toString('utf8')) as GltfJson
    else if (type === CHUNK_BIN && !bin) bin = Buffer.from(data)
    offset += 8 + length
  }
  if (!json || !bin) throw new Error('GLB is missing its JSON or BIN chunk')
  if (json.buffers.length !== 1 || json.buffers[0].uri !== undefined) throw new Error('Expected exactly one GLB-embedded buffer')
  return { json, bin }
}

function align4(n: number) {
  return (n + 3) & ~3
}

export function writeGlb(json: GltfJson, bin: Buffer): Buffer {
  const jsonBytes = Buffer.from(JSON.stringify(json), 'utf8')
  const jsonPadded = Buffer.alloc(align4(jsonBytes.length), 0x20)
  jsonBytes.copy(jsonPadded)
  const binPadded = Buffer.alloc(align4(bin.length), 0)
  bin.copy(binPadded)
  const total = 12 + 8 + jsonPadded.length + 8 + binPadded.length
  const header = Buffer.alloc(12)
  header.writeUInt32LE(GLB_MAGIC, 0)
  header.writeUInt32LE(2, 4)
  header.writeUInt32LE(total, 8)
  const jsonHeader = Buffer.alloc(8)
  jsonHeader.writeUInt32LE(jsonPadded.length, 0)
  jsonHeader.writeUInt32LE(CHUNK_JSON, 4)
  const binHeader = Buffer.alloc(8)
  binHeader.writeUInt32LE(binPadded.length, 0)
  binHeader.writeUInt32LE(CHUNK_BIN, 4)
  return Buffer.concat([header, jsonHeader, jsonPadded, binHeader, binPadded])
}

/** Append the motion as one animation. Returns the new JSON + BIN (input objects untouched). */
export function bakeAnimation(glb: ParsedGlb, motion: AvatarMotionFile, name: string, extras: Record<string, unknown>) {
  const json = JSON.parse(JSON.stringify(glb.json)) as GltfJson
  json.accessors = json.accessors ?? []
  json.bufferViews = json.bufferViews ?? []
  json.animations = json.animations ?? []
  if (json.animations.some((animation) => animation.name === name)) throw new Error(`GLB already has an animation named "${name}"`)

  const nodeByName = new Map<string, number>()
  json.nodes.forEach((node, index) => {
    if (!node.name) return
    if (nodeByName.has(node.name)) throw new Error(`Duplicate node name "${node.name}" makes the target ambiguous`)
    nodeByName.set(node.name, index)
  })

  const chunks: Buffer[] = [glb.bin]
  let byteLength = glb.bin.length
  const addFloatData = (data: Float32Array, type: 'SCALAR' | 'VEC3' | 'VEC4', count: number, minMax: boolean) => {
    const padding = align4(byteLength) - byteLength
    if (padding) {
      chunks.push(Buffer.alloc(padding))
      byteLength += padding
    }
    const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength)
    chunks.push(Buffer.from(bytes))
    const view = json.bufferViews!.push({ buffer: 0, byteOffset: byteLength, byteLength: bytes.length, name: `anim:${name}:${json.bufferViews!.length}` }) - 1
    byteLength += bytes.length
    const accessor: Record<string, unknown> = { bufferView: view, componentType: 5126, count, type }
    if (minMax) {
      const width = type === 'SCALAR' ? 1 : type === 'VEC3' ? 3 : 4
      const min = new Array(width).fill(Infinity)
      const max = new Array(width).fill(-Infinity)
      for (let i = 0; i < count; i += 1) {
        for (let c = 0; c < width; c += 1) {
          min[c] = Math.min(min[c], data[i * width + c])
          max[c] = Math.max(max[c], data[i * width + c])
        }
      }
      accessor.min = min
      accessor.max = max
    }
    return json.accessors!.push(accessor) - 1
  }

  const n = motion.frameCount
  const times = new Float32Array(n)
  for (let k = 0; k < n; k += 1) times[k] = k / motion.fps
  const input = addFloatData(times, 'SCALAR', n, true)

  const samplers: Record<string, unknown>[] = []
  const channels: Record<string, unknown>[] = []
  let nonFinite = 0
  for (const track of motion.tracks) {
    const node = nodeByName.get(track.bone)
    if (node === undefined) throw new Error(`Track bone "${track.bone}" is not a node of the GLB`)
    const width = track.path === 'rotation' ? 4 : 3
    const data = new Float32Array(n * width)
    for (let k = 0; k < n; k += 1) {
      if (track.path === 'rotation') {
        const [x, y, z, w] = track.values.slice(k * 4, k * 4 + 4)
        const norm = Math.hypot(x, y, z, w)
        if (!Number.isFinite(norm) || norm < 1e-6) nonFinite += 1
        data.set([x / norm, y / norm, z / norm, w / norm], k * 4)
      } else {
        for (let c = 0; c < 3; c += 1) {
          const v = track.values[k * 3 + c]
          if (!Number.isFinite(v)) nonFinite += 1
          data[k * 3 + c] = v
        }
      }
    }
    if (nonFinite) throw new Error(`Track ${track.bone}.${track.path} has non-finite values`)
    const output = addFloatData(data, width === 4 ? 'VEC4' : 'VEC3', n, false)
    const sampler = samplers.push({ input, output, interpolation: 'LINEAR' }) - 1
    channels.push({ sampler, target: { node, path: track.path } })
  }
  json.animations.push({ name, channels, samplers, extras })
  json.buffers[0].byteLength = byteLength
  return { json, bin: Buffer.concat(chunks), channels: channels.length, bytesAdded: byteLength - glb.bin.length }
}

function sha256(buffer: Buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

async function main() {
  const motionPath = args.motion || `${args.motionDir}/${args.clip}/avatar-motion.json.gz`
  const motion = readJson<AvatarMotionFile>(motionPath)
  validateMotionFile(motion)
  const glbBytes = readFileSync(repoPath(args.glb))
  const glbSha = sha256(glbBytes)
  if (motion.rig.sha256 && motion.rig.sha256 !== glbSha) {
    throw new Error(`Motion was solved for rig ${motion.rig.sha256.slice(0, 12)}…, but ${args.glb} is ${glbSha.slice(0, 12)}…`)
  }
  const glb = parseGlb(glbBytes)
  const name = args.name || motion.clipId
  const extras = {
    deafference: {
      schema: 'deafference.animation-clip',
      clipId: motion.clipId,
      fps: motion.fps,
      frameCount: motion.frameCount,
      durationSec: motion.durationSec,
      timeline: 'frame k at t = k / fps seconds of the source video (uniform grid over the VFR source)',
      sourceVideo: motion.source,
      rig: { file: args.glb, sha256: glbSha },
      motion: { file: motionPath, sha256: sha256(readFileSync(repoPath(motionPath))), generator: motion.generator },
      uncertainIntervals: motion.quality.uncertainIntervals.length,
      notes: motion.notes
    }
  }
  const baked = bakeAnimation(glb, motion, name, extras)
  const out = args.out || `${args.motionDir}/${args.clip}/${args.clip}.animation.glb`
  const bytes = writeGlb(baked.json, baked.bin)
  mkdirSync(dirname(repoPath(out)), { recursive: true })
  writeFileSync(repoPath(out), bytes)

  // Self-check: re-parse, original data untouched, samples match the motion file.
  const check = parseGlb(bytes)
  const prefixIdentical = check.bin.subarray(0, glb.bin.length).equals(glb.bin)
  const originalKeys = Object.keys(glb.json).filter((key) => !['accessors', 'bufferViews', 'buffers', 'animations'].includes(key))
  const jsonIdentical = originalKeys.every((key) => JSON.stringify(check.json[key]) === JSON.stringify(glb.json[key])) &&
    JSON.stringify(check.json.accessors!.slice(0, glb.json.accessors?.length ?? 0)) === JSON.stringify(glb.json.accessors ?? []) &&
    JSON.stringify(check.json.bufferViews!.slice(0, glb.json.bufferViews?.length ?? 0)) === JSON.stringify(glb.json.bufferViews ?? [])
  let maxSampleError = 0
  const animation = check.json.animations![check.json.animations!.length - 1] as { channels: { sampler: number }[]; samplers: { output: number }[] }
  motion.tracks.forEach((track, t) => {
    const accessor = check.json.accessors![animation.samplers[animation.channels[t].sampler].output] as { bufferView: number }
    const view = check.json.bufferViews![accessor.bufferView] as { byteOffset: number; byteLength: number }
    const data = new Float32Array(check.bin.buffer.slice(check.bin.byteOffset + view.byteOffset, check.bin.byteOffset + view.byteOffset + view.byteLength))
    const width = track.path === 'rotation' ? 4 : 3
    for (let k = 0; k < motion.frameCount; k += 97) {
      let sign = 1
      if (width === 4) {
        const dot = [0, 1, 2, 3].reduce((s, c) => s + data[k * 4 + c] * track.values[k * 4 + c], 0)
        sign = dot < 0 ? -1 : 1
      }
      for (let c = 0; c < width; c += 1) maxSampleError = Math.max(maxSampleError, Math.abs(sign * data[k * width + c] - track.values[k * width + c]))
    }
  })
  if (!prefixIdentical || !jsonIdentical || maxSampleError > 1e-5) {
    throw new Error(`Export self-check failed: binPrefixIdentical=${prefixIdentical} jsonIdentical=${jsonIdentical} maxSampleError=${maxSampleError}`)
  }

  // Khronos glTF-Validator on input and output: no errors, no new issue codes.
  const summarize = async (data: Buffer) => {
    const result = await validator.validateBytes(new Uint8Array(data), { maxIssues: 200 })
    return {
      errors: result.issues.numErrors,
      warnings: result.issues.numWarnings,
      infos: result.issues.numInfos,
      codes: [...new Set(result.issues.messages.map((m) => `${m.severity === 0 ? 'E' : m.severity === 1 ? 'W' : 'I'}:${m.code}`))].sort(),
      animationCount: result.info?.animationCount
    }
  }
  const validationBefore = await summarize(glbBytes)
  const validationAfter = await summarize(bytes)
  const newCodes = validationAfter.codes.filter((code) => !validationBefore.codes.includes(code))
  if (validationAfter.errors > 0 || newCodes.length) {
    throw new Error(`glTF-Validator: ${validationAfter.errors} errors, new issue codes: ${newCodes.join(', ')}`)
  }

  const report = {
    schema: 'deafference.glb-export-report',
    schemaVersion: 1,
    output: out,
    outputSha256: sha256(bytes),
    outputBytes: bytes.length,
    animation: name,
    channels: baked.channels,
    frames: motion.frameCount,
    fps: motion.fps,
    bytesAdded: baked.bytesAdded,
    originalBinChunkIsBytePrefix: prefixIdentical,
    originalJsonObjectsUnchanged: jsonIdentical,
    maxSampleErrorVsMotionFile: maxSampleError,
    khronosValidator: { version: validator.version(), input: validationBefore, output: validationAfter, newIssueCodes: newCodes },
    rig: { file: args.glb, sha256: glbSha },
    motion: extras.deafference.motion
  }
  writeJson(out.replace(/\.glb$/, '.export-report.json'), report, true)
  console.log(`exported ${baked.channels} channels x ${motion.frameCount} frames -> ${out} (${(bytes.length / 1e6).toFixed(1)} MB, +${(baked.bytesAdded / 1e6).toFixed(2)} MB)`)
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('export-glb.ts')) {
  main().catch((error) => {
    console.error(error)
    process.exit(1)
  })
}
