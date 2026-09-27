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
  type Object3D,
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
import type { MotionBinding, MotionClip } from '../motion/clip/MotionClip'
import type { HandStateCode } from '../motion/clip/format'
import { LiveMotionPipeline } from '../motion/live/LiveMotionPipeline'
import { PoseApplier } from '../motion/retarget/PoseApplier'
import { Rig } from '../motion/rig/Rig'
import type { MotionEngine, TrackingFrame } from '../types/tracking'

export interface StageStatus {
  engine: MotionEngine
  handState: { left: HandStateCode; right: HandStateCode }
  /** Offline: frame index being shown. Live: main-thread solve cost (ms). */
  frameIndex: number | null
  solveMs: number | null
  channels: number
}

const props = withDefaults(defineProps<{
  frame: TrackingFrame | null
  /** 'offline' plays `clip` in lockstep with `media`; 'live' solves `frame`s causally. */
  engine?: MotionEngine
  clip?: MotionClip | null
  media?: HTMLVideoElement | null
  smoothing?: number
  strength?: number
  trackingActive?: boolean
}>(), {
  engine: 'live',
  clip: null,
  media: null,
  smoothing: 15,
  strength: 1,
  trackingActive: false
})

const emit = defineEmits<{
  ready: []
  error: [message: string]
  status: [status: StageStatus]
}>()

const host = ref<HTMLDivElement | null>(null)
const ready = ref(false)
const loadError = ref<string | null>(null)

let scene: Scene | null = null
let camera: PerspectiveCamera | null = null
let renderer: WebGLRenderer | null = null
let controls: OrbitControls | null = null
let avatarRoot: Object3D | null = null
let pipeline: LiveMotionPipeline | null = null
let applier: PoseApplier | null = null
let binding: MotionBinding | null = null
let resizeObserver: ResizeObserver | null = null
let animationFrame = 0
let disposed = false
let lastStatusKey = ''
let lastStatusAt = 0
let liveHandState: StageStatus['handState'] = { left: 'A', right: 'A' }
let liveSolveMs: number | null = null
let lastLiveFrameAt = 0
let lastStatus: StageStatus | null = null
let lastFrameHasWorld = false
let lastOfflineTime: number | null = null
// While tracking is active, a live pose older than this eases back to rest
// (tracker stalled); while paused the last pose is held.
const LIVE_STALE_MS = 1500

// Offline engine clock: the media time of the frame the browser actually
// presented (requestVideoFrameCallback), so the avatar shows the motion of
// exactly the video frame on screen. Falls back to currentTime.
let presentedMediaTime: number | null = null
let frameCallbackHandle = 0
let frameCallbackVideo: HTMLVideoElement | null = null

const SMOOTHING_DEFAULT = 15

function resetPose() {
  pipeline?.reset()
  applier?.reset()
  binding?.reset()
  presentedMediaTime = null
  lastLiveFrameAt = 0
  liveHandState = { left: 'A', right: 'A' }
}

/** Restart temporal state; the live path also recalibrates (face neutral, scale). */
function resetCalibration() {
  pipeline?.reset()
}

defineExpose({ resetPose, resetCalibration })

watch(() => props.frame, (value) => {
  if (!value || !pipeline || !applier || props.engine !== 'live') return
  lastFrameHasWorld = Boolean(value.poseWorldLandmarks?.length)
  try {
    const result = pipeline.update({
      pose: value.poseLandmarks,
      poseWorld: value.poseWorldLandmarks,
      leftHand: value.leftHandLandmarks,
      rightHand: value.rightHandLandmarks,
      face: value.faceLandmarks,
      timestampMs: value.timestamp,
      image: { width: value.imageWidth ?? props.media?.videoWidth ?? 640, height: value.imageHeight ?? props.media?.videoHeight ?? 480 }
    })
    applier.setTarget(result.pose)
    liveHandState = result.handState
    liveSolveMs = result.solveMs
    lastLiveFrameAt = performance.now()
  } catch (cause) {
    emit('error', cause instanceof Error ? cause.message : String(cause))
  }
})

watch(() => props.smoothing, (value) => pipeline?.setSmoothing(value / SMOOTHING_DEFAULT), { immediate: true })

watch(() => props.engine, (engine) => {
  // Switching engines never blends two drivers: start from rest.
  applier?.reset()
  binding?.reset()
  if (engine === 'live') pipeline?.reset()
  bindClip()
})

watch(() => props.clip, () => bindClip())

watch(() => props.media, (video) => attachFrameClock(video ?? null), { immediate: true })

function bindClip() {
  binding = null
  if (!avatarRoot || !props.clip || props.engine !== 'offline') return
  try {
    binding = props.clip.bind(avatarRoot)
  } catch (cause) {
    emit('error', cause instanceof Error ? cause.message : String(cause))
  }
}

function attachFrameClock(video: HTMLVideoElement | null) {
  if (frameCallbackVideo?.cancelVideoFrameCallback && frameCallbackHandle) frameCallbackVideo.cancelVideoFrameCallback(frameCallbackHandle)
  frameCallbackHandle = 0
  frameCallbackVideo = video
  presentedMediaTime = null
  if (!video?.requestVideoFrameCallback) return
  const onFrame = (_now: DOMHighResTimeStamp, metadata: VideoFrameCallbackMetadata) => {
    if (disposed || frameCallbackVideo !== video) return
    presentedMediaTime = metadata.mediaTime
    frameCallbackHandle = video.requestVideoFrameCallback!(onFrame)
  }
  frameCallbackHandle = video.requestVideoFrameCallback(onFrame)
}

function offlineTime() {
  const video = props.media
  if (!video) return 0
  // After a seek while paused, rVFC reports the newly presented frame; if it
  // has not fired yet, currentTime is the best available estimate.
  if (presentedMediaTime !== null && Math.abs(presentedMediaTime - video.currentTime) < 0.25) return presentedMediaTime
  return video.currentTime
}

/**
 * Read-only inspection hook for automated end-to-end tests, installed only
 * when the page URL has ?debug=1. Exposes bone LOCAL rotations and the last
 * status; it cannot change the pose.
 */
function installDebugHook() {
  if (typeof window === 'undefined' || !new URLSearchParams(window.location.search).has('debug') || !avatarRoot) return
  const nodes = new Map<string, Object3D>()
  avatarRoot.traverse((node) => { if (node.name && !nodes.has(node.name)) nodes.set(node.name, node) })
  ;(window as unknown as Record<string, unknown>).__deafferenceStage = {
    bone: (name: string) => nodes.get(name)?.quaternion.toArray() ?? null,
    status: () => lastStatus,
    engine: () => props.engine,
    offlineTime: () => lastOfflineTime,
    lastFrameHasWorld: () => lastFrameHasWorld
  }
}

function publishStatus(status: StageStatus) {
  lastStatus = status
  const key = `${status.engine}|${status.handState.left}|${status.handState.right}|${status.channels}`
  const now = performance.now()
  if (key === lastStatusKey && now - lastStatusAt < 250) return
  lastStatusKey = key
  lastStatusAt = now
  emit('status', status)
}

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

    avatarRoot = avatar
    // Same rig model the offline tools build from the GLB (model space =
    // GLB scene root; the placement transform above is excluded).
    const rig = Rig.fromObject3D(avatar)
    pipeline = new LiveMotionPipeline(rig)
    pipeline.setSmoothing(props.smoothing / SMOOTHING_DEFAULT)
    applier = new PoseApplier(avatar, pipeline.solver.controlled, pipeline.solver.translated)
    bindClip()
    installDebugHook()

    resizeObserver = new ResizeObserver(resize)
    resizeObserver.observe(host.value)
    resize()

    const clock = new Clock()
    const animate = () => {
      if (disposed || !renderer || !scene || !camera) return
      animationFrame = requestAnimationFrame(animate)
      const dt = clock.getDelta()
      if (props.engine === 'offline' && binding && props.clip) {
        const time = offlineTime()
        lastOfflineTime = time
        props.clip.applyTo(binding, time)
        binding.applyStrength(props.strength)
        publishStatus({ engine: 'offline', handState: props.clip.handStateAt(time), frameIndex: props.clip.sampleAt(time).index0, solveMs: null, channels: props.clip.file.tracks.length })
      } else if (props.engine === 'live' && applier) {
        const stale = props.trackingActive && lastLiveFrameAt > 0 && performance.now() - lastLiveFrameAt > LIVE_STALE_MS
        if (stale) {
          applier.setRestTarget()
          liveHandState = { left: 'A', right: 'A' }
        }
        applier.update(dt, props.strength, stale ? 0.25 : 0.035)
        publishStatus({ engine: 'live', handState: liveHandState, frameIndex: null, solveMs: liveSolveMs, channels: (pipeline?.solver.controlled.length ?? 0) + (pipeline?.solver.translated.length ?? 0) })
      }
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
  attachFrameClock(null)
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
