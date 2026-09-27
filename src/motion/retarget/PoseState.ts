import { Quaternion, Vector3 } from 'three'
import type { Rig } from '../rig/Rig'

/**
 * Mutable local pose of the rig with on-demand forward kinematics in model
 * space. Solvers write parent joints before children and query world
 * transforms of already-solved ancestors, so every child rotation is computed
 * against its parent's DESIRED transform (never a stale scene-graph value).
 */
export class PoseState {
  readonly rig: Rig
  readonly local: Quaternion[]
  readonly localPosition: Vector3[]

  constructor(rig: Rig) {
    // Positions below are composed without scale; the supplied rig has unit
    // scale on every node. Refuse rigs where that assumption would be wrong.
    for (const joint of rig.joints) {
      const s = joint.restLocalScale
      if (Math.abs(s.x - 1) > 1e-4 || Math.abs(s.y - 1) > 1e-4 || Math.abs(s.z - 1) > 1e-4) {
        throw new Error(`PoseState requires unit node scale; "${joint.name}" has scale ${s.toArray().join(',')}`)
      }
    }
    this.rig = rig
    this.local = rig.joints.map((joint) => joint.restLocalQuaternion.clone())
    this.localPosition = rig.joints.map((joint) => joint.restLocalPosition.clone())
  }

  reset() {
    this.rig.joints.forEach((joint, index) => {
      this.local[index].copy(joint.restLocalQuaternion)
      this.localPosition[index].copy(joint.restLocalPosition)
    })
  }

  index(name: string) {
    return this.rig.get(name).index
  }

  setLocal(name: string, quaternion: Quaternion) {
    this.local[this.index(name)].copy(quaternion).normalize()
  }

  getLocal(name: string) {
    return this.local[this.index(name)].clone()
  }

  setLocalPosition(name: string, position: Vector3) {
    this.localPosition[this.index(name)].copy(position)
  }

  /** World (model-space) rotation of a joint under the current local pose. */
  worldQuaternion(name: string, out = new Quaternion()) {
    let index = this.index(name)
    out.copy(this.local[index])
    let parent = this.rig.joints[index].parent
    while (parent >= 0) {
      out.premultiply(this.local[parent])
      index = parent
      parent = this.rig.joints[index].parent
    }
    return out
  }

  /** World (model-space) position of a joint under the current local pose. */
  worldPosition(name: string, out = new Vector3()) {
    const chain: number[] = []
    let index = this.index(name)
    while (index >= 0) {
      chain.push(index)
      index = this.rig.joints[index].parent
    }
    const rotation = new Quaternion()
    out.set(0, 0, 0)
    for (let i = chain.length - 1; i >= 0; i -= 1) {
      const joint = chain[i]
      out.add(this.localPosition[joint].clone().applyQuaternion(rotation))
      rotation.multiply(this.local[joint])
    }
    return out
  }

  /** Set a joint so that its WORLD rotation equals `world`, given its parent's current pose. */
  setWorld(name: string, world: Quaternion) {
    const joint = this.rig.get(name)
    const parentWorld = joint.parent >= 0 ? this.worldQuaternion(this.rig.joints[joint.parent].name) : new Quaternion()
    this.local[joint.index].copy(parentWorld.invert().multiply(world)).normalize()
  }
}
