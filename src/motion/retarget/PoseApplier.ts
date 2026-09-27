import { Quaternion, Vector3, type Object3D } from 'three'
import type { SolvedPose } from './types'

interface BoundRotation {
  node: Object3D
  rest: Quaternion
  current: Quaternion
  target: Quaternion
}

interface BoundTranslation {
  node: Object3D
  rest: Vector3
  current: Vector3
  target: Vector3
}

/**
 * Writes solved LOCAL transforms into the three.js scene graph at render
 * rate. Live solves arrive at the tracker rate (15-30 Hz); between them the
 * applier eases toward the latest target with a short time constant (causal,
 * ~1 render frame of lag) so the avatar does not visibly step. `strength`
 * blends from the rest pose (1 = full motion).
 */
export class PoseApplier {
  private readonly rotations: BoundRotation[] = []
  private readonly translations: BoundTranslation[] = []
  private hasTarget = false

  constructor(root: Object3D, rotationBones: readonly string[], translationBones: readonly string[]) {
    const nodes = new Map<string, Object3D>()
    root.traverse((node) => {
      if (node.name && !nodes.has(node.name)) nodes.set(node.name, node)
    })
    const missing = [...rotationBones, ...translationBones].filter((name) => !nodes.has(name))
    if (missing.length) throw new Error(`Avatar is missing solver bones: ${missing.join(', ')}`)
    for (const name of rotationBones) {
      const node = nodes.get(name)!
      this.rotations.push({ node, rest: node.quaternion.clone(), current: node.quaternion.clone(), target: node.quaternion.clone() })
    }
    for (const name of translationBones) {
      const node = nodes.get(name)!
      this.translations.push({ node, rest: node.position.clone(), current: node.position.clone(), target: node.position.clone() })
    }
  }

  setTarget(pose: SolvedPose) {
    for (const entry of this.rotations) {
      const q = pose.rotations.get(entry.node.name)
      if (!q) continue
      entry.target.copy(q)
      if (entry.target.dot(entry.current) < 0) entry.target.set(-entry.target.x, -entry.target.y, -entry.target.z, -entry.target.w)
    }
    for (const entry of this.translations) {
      const p = pose.translations.get(entry.node.name)
      if (p) entry.target.copy(p)
    }
    this.hasTarget = true
  }

  /** Ease toward the rest pose (e.g. the tracker stopped delivering frames while active). */
  setRestTarget() {
    for (const entry of this.rotations) {
      entry.target.copy(entry.rest)
      if (entry.target.dot(entry.current) < 0) entry.target.set(-entry.target.x, -entry.target.y, -entry.target.z, -entry.target.w)
    }
    for (const entry of this.translations) entry.target.copy(entry.rest)
  }

  /** Advance the render-rate easing and write the scene graph. */
  update(dtSec: number, strength: number, followTauSec = 0.035) {
    if (!this.hasTarget) return
    const alpha = 1 - Math.exp(-Math.max(0, dtSec) / Math.max(1e-3, followTauSec))
    const s = Math.min(1, Math.max(0, strength))
    for (const entry of this.rotations) {
      entry.current.slerp(entry.target, alpha)
      entry.node.quaternion.copy(entry.rest).slerp(entry.current, s)
    }
    for (const entry of this.translations) {
      entry.current.lerp(entry.target, alpha)
      entry.node.position.copy(entry.rest).lerp(entry.current, s)
    }
  }

  /** Restore the rest pose immediately. */
  reset() {
    for (const entry of this.rotations) {
      entry.current.copy(entry.rest)
      entry.target.copy(entry.rest)
      entry.node.quaternion.copy(entry.rest)
    }
    for (const entry of this.translations) {
      entry.current.copy(entry.rest)
      entry.target.copy(entry.rest)
      entry.node.position.copy(entry.rest)
    }
    this.hasTarget = false
  }
}
