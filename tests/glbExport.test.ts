import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { bakeAnimation, parseGlb, writeGlb } from '../tools/export-glb'
import { readJson, repoPath } from '../tools/lib/cli'
import type { AvatarMotionFile } from '../src/motion/clip/format'
import { GLB } from './helpers'

const EXPORT = 'motion/qassem-story/qassem-story.animation.glb'

function exportInMemory() {
  const motion = readJson<AvatarMotionFile>('motion/qassem-story/avatar-motion.json.gz')
  const original = parseGlb(readFileSync(repoPath(GLB)))
  const baked = bakeAnimation(original, motion, motion.clipId, { test: true })
  return { motion, original, exported: parseGlb(writeGlb(baked.json, baked.bin)) }
}

test('animated GLB export: original asset untouched, one animation carrying every motion track', () => {
  const { motion, original, exported } = exportInMemory()
  assert.ok(exported.bin.subarray(0, original.bin.length).equals(original.bin), 'original binary data is a byte-identical prefix')
  for (const key of ['nodes', 'meshes', 'materials', 'textures', 'images', 'skins', 'extensionsUsed']) {
    assert.deepEqual(exported.json[key], original.json[key], key)
  }
  const animations = exported.json.animations as { channels: { sampler: number; target: { node: number; path: string } }[]; samplers: { input: number; output: number; interpolation: string }[] }[]
  assert.equal(animations.length, 1)
  assert.equal(animations[0].channels.length, motion.tracks.length)
  const accessors = exported.json.accessors as { bufferView: number; count: number; max?: number[] }[]
  const views = exported.json.bufferViews as { byteOffset: number; byteLength: number }[]
  const times = accessors[animations[0].samplers[0].input]
  assert.equal(times.count, motion.frameCount)
  assert.ok(Math.abs(times.max![0] - (motion.frameCount - 1) / motion.fps) < 1e-4)
  motion.tracks.forEach((track, i) => {
    const channel = animations[0].channels[i]
    const node = (exported.json.nodes as { name: string }[])[channel.target.node]
    assert.equal(node.name, track.bone)
    assert.equal(channel.target.path, track.path)
    assert.equal(animations[0].samplers[channel.sampler].interpolation, 'LINEAR')
    const accessor = accessors[animations[0].samplers[channel.sampler].output]
    const view = views[accessor.bufferView]
    const data = new Float32Array(exported.bin.buffer.slice(exported.bin.byteOffset + view.byteOffset, exported.bin.byteOffset + view.byteOffset + view.byteLength))
    const width = track.path === 'rotation' ? 4 : 3
    for (const k of [0, 1234, motion.frameCount - 1]) {
      for (let c = 0; c < width; c += 1) assert.ok(Math.abs(data[k * width + c] - track.values[k * width + c]) < 1e-5)
    }
  })
})

test('on-disk export (when present) matches a fresh in-memory export of the same motion', (t) => {
  if (!existsSync(repoPath(EXPORT))) {
    t.skip('run `npm run motion:export` to produce the animated GLB')
    return
  }
  const onDisk = parseGlb(readFileSync(repoPath(EXPORT)))
  const { exported, original } = exportInMemory()
  assert.ok(onDisk.bin.equals(exported.bin), 'animation data and original data identical')
  assert.ok(onDisk.bin.subarray(0, original.bin.length).equals(original.bin))
})
