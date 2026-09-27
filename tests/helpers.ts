import { claudiaProfile, validateSemanticSkeleton } from '../src/motion/rig/semanticMap'
import { buildRigGeometry } from '../src/motion/rig/rigGeometry'
import { loadGltfRig } from '../tools/lib/gltfRig'
import { repoPath } from '../tools/lib/cli'

export const GLB = 'public/models/deafference-avatar.glb'

let cached: Promise<Awaited<ReturnType<typeof load>>> | null = null

async function load() {
  const loaded = await loadGltfRig(repoPath(GLB))
  const map = claudiaProfile()
  const validation = validateSemanticSkeleton(loaded.rig, map)
  const geometry = buildRigGeometry(loaded.rig, map, validation.facing, validation.characterLeft)
  return { ...loaded, map, validation, geometry }
}

/** The supplied avatar's rig, loaded once per test process. */
export function loadAvatar() {
  cached ??= load()
  return cached
}

/** Small deterministic PRNG (mulberry32) so randomized tests are reproducible. */
export function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
