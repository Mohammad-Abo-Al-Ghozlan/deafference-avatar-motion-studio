import { Matrix4, Object3D, Quaternion, Vector3 } from 'three'

/** Plain description of one transform node, independent of any loader. */
export interface RigNodeInput {
  name: string
  parent: number
  translation: [number, number, number]
  rotation: [number, number, number, number]
  scale: [number, number, number]
  isJoint: boolean
}

export interface RigJoint {
  readonly index: number
  readonly name: string
  readonly parent: number
  readonly children: number[]
  readonly isJoint: boolean
  readonly restLocalPosition: Vector3
  readonly restLocalQuaternion: Quaternion
  readonly restLocalScale: Vector3
  readonly restWorldMatrix: Matrix4
  readonly restWorldPosition: Vector3
  readonly restWorldQuaternion: Quaternion
}

/**
 * Loader-independent skeleton model in *model space* (the GLB scene root's
 * space, excluding whatever placement transform the app applies to it).
 * Built identically from the browser's GLTFLoader scene and from Node tools,
 * so offline solving and live solving see the same numbers.
 */
export class Rig {
  readonly joints: RigJoint[]
  private readonly byName = new Map<string, RigJoint>()

  constructor(nodes: RigNodeInput[]) {
    const joints: RigJoint[] = nodes.map((node, index) => ({
      index,
      name: node.name,
      parent: node.parent,
      children: [],
      isJoint: node.isJoint,
      restLocalPosition: new Vector3(...node.translation),
      restLocalQuaternion: new Quaternion(...node.rotation).normalize(),
      restLocalScale: new Vector3(...node.scale),
      restWorldMatrix: new Matrix4(),
      restWorldPosition: new Vector3(),
      restWorldQuaternion: new Quaternion()
    }))

    joints.forEach((joint) => {
      if (joint.parent >= 0) {
        if (joint.parent >= joint.index) {
          throw new Error(`Rig nodes must be topologically ordered (parent before child): ${joint.name}`)
        }
        joints[joint.parent].children.push(joint.index)
      }
    })

    for (const joint of joints) {
      const local = new Matrix4().compose(joint.restLocalPosition, joint.restLocalQuaternion, joint.restLocalScale)
      if (joint.parent >= 0) joint.restWorldMatrix.multiplyMatrices(joints[joint.parent].restWorldMatrix, local)
      else joint.restWorldMatrix.copy(local)
      const scale = new Vector3()
      joint.restWorldMatrix.decompose(joint.restWorldPosition, joint.restWorldQuaternion, scale)
      const existing = this.byName.get(joint.name)
      if (existing) {
        // Loaders may emit several unnamed/duplicate helper nodes; only
        // duplicate *joints* make name-based retargeting ambiguous.
        if (joint.isJoint || existing.isJoint) throw new Error(`Duplicate joint name in rig: ${joint.name}`)
        continue
      }
      this.byName.set(joint.name, joint)
    }
    this.joints = joints
  }

  has(name: string) {
    return this.byName.has(name)
  }

  get(name: string): RigJoint {
    const joint = this.byName.get(name)
    if (!joint) throw new Error(`Rig has no node named "${name}"`)
    return joint
  }

  find(name: string): RigJoint | undefined {
    return this.byName.get(name)
  }

  /** Ancestors from the joint's parent up to the root. */
  ancestors(name: string) {
    const result: RigJoint[] = []
    let parent = this.get(name).parent
    while (parent >= 0) {
      result.push(this.joints[parent])
      parent = this.joints[parent].parent
    }
    return result
  }

  isAncestor(ancestor: string, descendant: string) {
    return this.ancestors(descendant).some((joint) => joint.name === ancestor)
  }

  /**
   * Build from a loaded three.js hierarchy. `root` is the GLB scene root; its
   * own transform is excluded so the result is in model space.
   */
  static fromObject3D(root: Object3D) {
    const nodes: RigNodeInput[] = []
    const indexOf = new Map<Object3D, number>()
    const visit = (node: Object3D, parent: number) => {
      const index = nodes.length
      indexOf.set(node, index)
      nodes.push({
        name: node.name,
        parent,
        translation: node === root ? [0, 0, 0] : [node.position.x, node.position.y, node.position.z],
        rotation: node === root ? [0, 0, 0, 1] : [node.quaternion.x, node.quaternion.y, node.quaternion.z, node.quaternion.w],
        scale: node === root ? [1, 1, 1] : [node.scale.x, node.scale.y, node.scale.z],
        isJoint: Boolean((node as { isBone?: boolean }).isBone)
      })
      node.children.forEach((child) => visit(child, index))
    }
    visit(root, -1)
    return new Rig(nodes)
  }
}
