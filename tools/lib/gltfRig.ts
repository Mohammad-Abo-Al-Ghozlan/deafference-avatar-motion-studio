import { NodeIO, type Document, type Node as GltfNode } from '@gltf-transform/core'
import { Rig, type RigNodeInput } from '../../src/motion/rig/Rig'

export interface LoadedGltfRig {
  document: Document
  rig: Rig
  /** Rig node index -> glTF node (for export). */
  gltfNodes: GltfNode[]
  jointNames: Set<string>
}

/**
 * Load the GLB with gltf-transform (no DOM needed) and build the same Rig the
 * browser builds from GLTFLoader: model space = the glTF scene root.
 */
export async function loadGltfRig(path: string): Promise<LoadedGltfRig> {
  const io = new NodeIO()
  const document = await io.read(path)
  const root = document.getRoot()
  const scene = root.getDefaultScene() ?? root.listScenes()[0]
  if (!scene) throw new Error(`${path} has no scene`)
  const jointNames = new Set<string>()
  for (const skin of root.listSkins()) for (const joint of skin.listJoints()) jointNames.add(joint.getName())

  const nodes: RigNodeInput[] = [{ name: '__scene__', parent: -1, translation: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], isJoint: false }]
  const gltfNodes: GltfNode[] = []
  const visit = (node: GltfNode, parent: number) => {
    const index = nodes.length
    nodes.push({
      name: node.getName(),
      parent,
      translation: node.getTranslation() as [number, number, number],
      rotation: node.getRotation() as [number, number, number, number],
      scale: node.getScale() as [number, number, number],
      isJoint: jointNames.has(node.getName())
    })
    gltfNodes[index] = node
    for (const child of node.listChildren()) visit(child, index)
  }
  for (const child of scene.listChildren()) visit(child, 0)
  return { document, rig: new Rig(nodes), gltfNodes, jointNames }
}
