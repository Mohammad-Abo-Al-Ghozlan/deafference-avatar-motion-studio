import { Quaternion, Vector3, type Object3D } from 'three'
import { validateMotionFile, type AvatarMotionFile, type HandStateCode } from './format'

export interface FrameSample {
  index0: number
  index1: number
  alpha: number
}

const tmpA = new Quaternion()
const tmpB = new Quaternion()

/**
 * Deterministic player for a precomputed avatar-motion file. Pose is a pure
 * function of MEDIA TIME (not render frame count): the renderer asks for the
 * video's current time and gets an interpolated local pose.
 */
export class MotionClip {
  readonly file: AvatarMotionFile
  readonly duration: number
  private readonly rotations: { bone: string; values: Float32Array }[]
  private readonly translations: { bone: string; values: Float32Array }[]

  constructor(file: AvatarMotionFile) {
    validateMotionFile(file)
    this.file = file
    this.duration = (file.frameCount - 1) / file.fps
    this.rotations = file.tracks.filter((t) => t.path === 'rotation').map((t) => ({ bone: t.bone, values: Float32Array.from(t.values) }))
    this.translations = file.tracks.filter((t) => t.path === 'translation').map((t) => ({ bone: t.bone, values: Float32Array.from(t.values) }))
  }

  static async load(url: string, signal?: AbortSignal): Promise<MotionClip> {
    const response = await fetch(url, { signal })
    if (!response.ok) throw new Error(`Motion file request failed (${response.status}) for ${url}`)
    const buffer = new Uint8Array(await response.arrayBuffer())
    let text: string
    // Servers may or may not transparently decode .gz; sniff the magic bytes.
    if (buffer[0] === 0x1f && buffer[1] === 0x8b) {
      if (typeof DecompressionStream === 'undefined') throw new Error('This browser cannot decompress the motion file (no DecompressionStream)')
      const stream = new Blob([buffer]).stream().pipeThrough(new DecompressionStream('gzip'))
      text = await new Response(stream).text()
    } else {
      text = new TextDecoder().decode(buffer)
    }
    const json = JSON.parse(text) as unknown
    validateMotionFile(json)
    return new MotionClip(json)
  }

  get boneNames() {
    return [...new Set([...this.rotations, ...this.translations].map((t) => t.bone))]
  }

  sampleAt(time: number): FrameSample {
    const f = Math.min(Math.max(time, 0), this.duration) * this.file.fps
    const index0 = Math.min(Math.floor(f), this.file.frameCount - 1)
    const index1 = Math.min(index0 + 1, this.file.frameCount - 1)
    return { index0, index1, alpha: index1 === index0 ? 0 : f - index0 }
  }

  handStateAt(time: number): { left: HandStateCode; right: HandStateCode } {
    const { index0 } = this.sampleAt(time)
    return {
      left: this.file.quality.handState.left[index0] as HandStateCode,
      right: this.file.quality.handState.right[index0] as HandStateCode
    }
  }

  /** Bind track names to scene nodes; throws if the rig does not match. */
  bind(root: Object3D) {
    const nodes = new Map<string, Object3D>()
    root.traverse((node) => {
      if (node.name && !nodes.has(node.name)) nodes.set(node.name, node)
    })
    const missing = this.boneNames.filter((name) => !nodes.has(name))
    if (missing.length) throw new Error(`Motion file does not match this avatar; missing bones: ${missing.join(', ')}`)
    return new MotionBinding(this, nodes)
  }

  /** Write the pose at `time` into the bound nodes. */
  applyTo(binding: MotionBinding, time: number) {
    const { index0, index1, alpha } = this.sampleAt(time)
    for (const track of this.rotations) {
      const node = binding.nodes.get(track.bone)!
      const v = track.values
      const a = index0 * 4
      const b = index1 * 4
      tmpA.set(v[a], v[a + 1], v[a + 2], v[a + 3])
      if (alpha > 0) {
        tmpB.set(v[b], v[b + 1], v[b + 2], v[b + 3])
        tmpA.slerp(tmpB, alpha)
      }
      node.quaternion.copy(tmpA)
    }
    for (const track of this.translations) {
      const node = binding.nodes.get(track.bone)!
      const v = track.values
      const a = index0 * 3
      const b = index1 * 3
      node.position.set(
        v[a] + (v[b] - v[a]) * alpha,
        v[a + 1] + (v[b + 1] - v[a + 1]) * alpha,
        v[a + 2] + (v[b + 2] - v[a + 2]) * alpha
      )
    }
  }
}

export class MotionBinding {
  readonly clip: MotionClip
  readonly nodes: Map<string, Object3D>
  private readonly rest = new Map<Object3D, { quaternion: Quaternion; position: Vector3 }>()

  constructor(clip: MotionClip, nodes: Map<string, Object3D>) {
    this.clip = clip
    this.nodes = nodes
    for (const name of clip.boneNames) {
      const node = nodes.get(name)!
      this.rest.set(node, { quaternion: node.quaternion.clone(), position: node.position.clone() })
    }
  }

  /**
   * Blend the pose currently written to the bound nodes toward the rest pose
   * (1 = unchanged, 0 = rest). Call after MotionClip.applyTo().
   */
  applyStrength(strength: number) {
    const s = Math.min(1, Math.max(0, strength))
    if (s >= 1) return
    for (const [node, rest] of this.rest) {
      node.quaternion.copy(tmpB.copy(rest.quaternion).slerp(node.quaternion, s))
      node.position.lerpVectors(rest.position, node.position, s)
    }
  }

  /** Restore the rest pose of every bound node. */
  reset() {
    for (const [node, rest] of this.rest) {
      node.quaternion.copy(rest.quaternion)
      node.position.copy(rest.position)
    }
  }
}
