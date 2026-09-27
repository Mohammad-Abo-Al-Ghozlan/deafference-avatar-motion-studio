import { Bone, Object3D } from 'three'
import type { Node as GltfNode } from '@gltf-transform/core'
import type { LoadedGltfRig } from './gltfRig'

/**
 * Build a bare three.js hierarchy (Object3D / Bone, no meshes) from the glTF
 * nodes so browser-side code that expects a scene graph (the legacy solver,
 * the MotionClip binding) can run headless in Node.
 */
export function buildThreeHierarchy(loaded: LoadedGltfRig) {
  const root = new Object3D()
  root.name = 'Scene'
  const scene = loaded.document.getRoot().getDefaultScene() ?? loaded.document.getRoot().listScenes()[0]
  const byName = new Map<string, Object3D>()
  const visit = (node: GltfNode, parent: Object3D) => {
    const object = loaded.jointNames.has(node.getName()) ? new Bone() : new Object3D()
    object.name = node.getName()
    object.position.fromArray(node.getTranslation())
    object.quaternion.fromArray(node.getRotation())
    object.scale.fromArray(node.getScale())
    parent.add(object)
    byName.set(object.name, object)
    for (const child of node.listChildren()) visit(child, object)
  }
  for (const child of scene.listChildren()) visit(child, root)
  root.updateMatrixWorld(true)
  return { root, byName }
}
