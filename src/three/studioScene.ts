import {
  type Object3D,
  ACESFilmicToneMapping,
  AmbientLight,
  Box3,
  Color,
  DirectionalLight,
  GridHelper,
  HemisphereLight,
  MathUtils,
  Mesh,
  MeshStandardMaterial,
  PCFSoftShadowMap,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  SRGBColorSpace,
  Vector3,
  type WebGLRenderer
} from 'three'
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'

/**
 * The avatar studio look (lights, floor, camera framing), shared by every
 * avatar view so all of them render the supplied avatar identically.
 */
export const AVATAR_URL = '/models/deafference-avatar.glb'
export const STAGE_BACKGROUND = '#11191d'

export function configureRenderer(renderer: WebGLRenderer) {
  renderer.outputColorSpace = SRGBColorSpace
  renderer.toneMapping = ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.03
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = PCFSoftShadowMap
}

export function createStudioCamera() {
  const camera = new PerspectiveCamera(31, 1, 0.01, 100)
  camera.position.set(0, 1.3, 2.65)
  return camera
}

export function configureOrbitControls(controls: OrbitControls) {
  controls.enablePan = false
  controls.enableDamping = true
  controls.dampingFactor = 0.06
  controls.minDistance = 1.75
  controls.maxDistance = 4.2
  controls.minPolarAngle = MathUtils.degToRad(60)
  controls.maxPolarAngle = MathUtils.degToRad(98)
}

/** Background, lights, floor and grid. The avatar is added by the caller. */
export function createStudioScene() {
  const scene = new Scene()
  scene.background = new Color(STAGE_BACKGROUND)

  const hemisphere = new HemisphereLight('#effaff', '#172126', 2.6)
  scene.add(hemisphere)

  const key = new DirectionalLight('#fff9ef', 4.1)
  key.position.set(-2.8, 4.4, 3.6)
  key.castShadow = true
  key.shadow.mapSize.set(1024, 1024)
  scene.add(key)

  const rim = new DirectionalLight('#72d9ff', 2.2)
  rim.position.set(3.2, 2.5, -2.5)
  scene.add(rim)
  scene.add(new AmbientLight('#a5c0ca', 0.9))

  const floor = new Mesh(
    new PlaneGeometry(12, 12),
    new MeshStandardMaterial({ color: '#10171a', roughness: 0.92, metalness: 0.05 })
  )
  floor.rotation.x = -Math.PI / 2
  floor.receiveShadow = true
  scene.add(floor)

  const grid = new GridHelper(8, 32, '#30434a', '#1d2b30')
  grid.position.y = 0.002
  scene.add(grid)
  return scene
}

/** Shadows on, culling off (skinned bounds lag the pose), feet on the floor, centred. */
export function prepareAvatar(avatar: Object3D) {
  avatar.traverse((node) => {
    const renderable = node as Mesh
    if (renderable.isMesh) {
      renderable.castShadow = true
      renderable.receiveShadow = true
      renderable.frustumCulled = false
    }
  })
  const initialBounds = new Box3().setFromObject(avatar)
  const center = initialBounds.getCenter(new Vector3())
  avatar.position.set(-center.x, -initialBounds.min.y, -center.z)
  avatar.updateMatrixWorld(true)
}

export interface Framing {
  /** Camera and target height, as a fraction of the avatar's height. */
  focus: number
  /** Camera distance, as a fraction of the avatar's height. */
  distance: number
}

/** Studio framing: most of the body, standing on the floor. */
export const STUDIO_FRAMING: Framing = { focus: 0.62, distance: 1.44 }
/**
 * Signing-space framing, like a waist-up signing recording: with the 31 deg
 * lens it shows ~0.51-1.13 x the avatar's height (waist to just above the
 * head), so handshapes read at a similar scale to the source video.
 */
export const SIGNING_FRAMING: Framing = { focus: 0.82, distance: 1.12 }

/** Aim the camera at the placed avatar. */
export function frameAvatar(avatar: Object3D, camera: PerspectiveCamera, controls: OrbitControls, framing: Framing = STUDIO_FRAMING) {
  const bounds = new Box3().setFromObject(avatar)
  const height = bounds.getSize(new Vector3()).y
  const focusY = height * framing.focus
  camera.position.set(0, focusY, height * framing.distance)
  controls.target.set(0, focusY, 0)
  controls.update()
}

/**
 * Dispose geometries and materials of a scene, skipping objects in `keep`
 * (e.g. an avatar clone whose geometry, materials and textures are shared).
 */
export function disposeScene(scene: Scene, keep: Object3D | null = null) {
  scene.traverse((node) => {
    const mesh = node as Mesh
    if (!mesh.isMesh) return
    if (keep && isDescendant(mesh, keep)) return
    mesh.geometry?.dispose()
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    materials.forEach((material) => material?.dispose())
  })
}

function isDescendant(node: Object3D, ancestor: Object3D) {
  for (let current: Object3D | null = node; current; current = current.parent) if (current === ancestor) return true
  return false
}
