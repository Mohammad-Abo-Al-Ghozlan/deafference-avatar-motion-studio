<template>
  <div ref="host" class="avatar-stage" :class="{ 'is-ready': ready }">
    <div v-if="!ready && !loadError" class="stage-loader" aria-live="polite">
      <div class="loader-orbit"><span></span></div>
      <p>Preparing the avatar rig</p>
      <small>88 bones · articulated facial rig</small>
    </div>

    <div v-if="loadError" class="stage-error" role="alert">
      <strong>Avatar could not load</strong>
      <span>{{ loadError }}</span>
    </div>

    <div class="studio-floor" aria-hidden="true"></div>
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  ACESFilmicToneMapping,
  AmbientLight,
  Box3,
  Clock,
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
  WebGLRenderer
} from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { AvatarRetargeter } from '../lib/AvatarRetargeter'
import type { TrackingFrame } from '../types/tracking'

const props = withDefaults(defineProps<{
  frame: TrackingFrame | null
  smoothing?: number
  strength?: number
  trackingActive?: boolean
}>(), {
  smoothing: 15,
  strength: 1,
  trackingActive: false
})

const emit = defineEmits<{
  ready: []
  error: [message: string]
}>()

const host = ref<HTMLDivElement | null>(null)
const ready = ref(false)
const loadError = ref<string | null>(null)

let scene: Scene | null = null
let camera: PerspectiveCamera | null = null
let renderer: WebGLRenderer | null = null
let controls: OrbitControls | null = null
let retargeter: AvatarRetargeter | null = null
let resizeObserver: ResizeObserver | null = null
let animationFrame = 0
let disposed = false

const resetPose = () => retargeter?.reset()
const resetCalibration = () => retargeter?.resetCalibration()

defineExpose({ resetPose, resetCalibration })

watch(() => props.frame, (value) => {
  if (value && retargeter) retargeter.update(value)
})

watch(() => props.smoothing, (value) => retargeter?.setSmoothing(value), { immediate: true })
watch(() => props.strength, (value) => retargeter?.setStrength(value), { immediate: true })

function resize() {
  if (!host.value || !renderer || !camera) return
  const width = Math.max(1, host.value.clientWidth)
  const height = Math.max(1, host.value.clientHeight)
  renderer.setSize(width, height, false)
  camera.aspect = width / height
  camera.updateProjectionMatrix()
}

onMounted(async () => {
  if (!host.value) return

  try {
    scene = new Scene()
    scene.background = new Color('#11191d')

    camera = new PerspectiveCamera(31, 1, 0.01, 100)
    camera.position.set(0, 1.3, 2.65)

    renderer = new WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    renderer.outputColorSpace = SRGBColorSpace
    renderer.toneMapping = ACESFilmicToneMapping
    renderer.toneMappingExposure = 1.03
    renderer.shadowMap.enabled = true
    renderer.shadowMap.type = PCFSoftShadowMap
    renderer.domElement.setAttribute('aria-label', 'Animated Deafference signing avatar')
    renderer.domElement.className = 'avatar-canvas'
    host.value.prepend(renderer.domElement)

    controls = new OrbitControls(camera, renderer.domElement)
    controls.enablePan = false
    controls.enableDamping = true
    controls.dampingFactor = 0.06
    controls.minDistance = 1.75
    controls.maxDistance = 4.2
    controls.minPolarAngle = MathUtils.degToRad(60)
    controls.maxPolarAngle = MathUtils.degToRad(98)

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

    const gltf = await new GLTFLoader().loadAsync('/models/deafference-avatar.glb')
    if (disposed) return

    const avatar = gltf.scene
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
    scene.add(avatar)

    const bounds = new Box3().setFromObject(avatar)
    const height = bounds.getSize(new Vector3()).y
    const focusY = height * 0.62
    camera.position.set(0, focusY, height * 1.44)
    controls.target.set(0, focusY, 0)
    controls.update()

    retargeter = new AvatarRetargeter(avatar)
    retargeter.setSmoothing(props.smoothing)
    retargeter.setStrength(props.strength)

    resizeObserver = new ResizeObserver(resize)
    resizeObserver.observe(host.value)
    resize()

    const clock = new Clock()
    const animate = () => {
      if (disposed || !renderer || !scene || !camera) return
      animationFrame = requestAnimationFrame(animate)
      retargeter?.tick(clock.getDelta(), performance.now(), props.trackingActive)
      controls?.update()
      renderer.render(scene, camera)
    }
    animate()

    ready.value = true
    emit('ready')
  } catch (cause) {
    loadError.value = cause instanceof Error ? cause.message : String(cause)
    emit('error', loadError.value)
  }
})

onBeforeUnmount(() => {
  disposed = true
  cancelAnimationFrame(animationFrame)
  resizeObserver?.disconnect()
  controls?.dispose()
  renderer?.dispose()
  renderer?.domElement.remove()
  scene?.traverse((node) => {
    const mesh = node as Mesh
    if (!mesh.isMesh) return
    mesh.geometry?.dispose()
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    materials.forEach((material) => material?.dispose())
  })
})
</script>
