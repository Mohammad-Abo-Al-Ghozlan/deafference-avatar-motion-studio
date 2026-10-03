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
import { type Object3D, Clock, type PerspectiveCamera, type Scene, WebGLRenderer } from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { MediaFrameClock } from '../motion/clip/MediaFrameClock'
import type { MotionBinding, MotionClip } from '../motion/clip/MotionClip'
import type { HandStateCode } from '../motion/clip/format'
import { LiveMotionPipeline } from '../motion/live/LiveMotionPipeline'
import { PoseApplier } from '../motion/retarget/PoseApplier'
import { Rig } from '../motion/rig/Rig'
import {
  AVATAR_URL,
  configureOrbitControls,
  configureRenderer,
  createStudioCamera,
  createStudioScene,
  disposeScene,
  frameAvatar,
  prepareAvatar,
  SIGNING_FRAMING
} from '../three/studioScene'
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

// Offline engine clock: media time of the presented video frame.
const frameClock = new MediaFrameClock()

const SMOOTHING_DEFAULT = 15

function resetPose() {
  pipeline?.reset()
  applier?.reset()
  binding?.reset()
  frameClock.reset()
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

watch(() => props.media, (video) => frameClock.attach(video ?? null), { immediate: true })

function bindClip() {
  binding = null
  if (!avatarRoot || !props.clip || props.engine !== 'offline') return
  try {
    binding = props.clip.bind(avatarRoot)
  } catch (cause) {
    emit('error', cause instanceof Error ? cause.message : String(cause))
  }
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
    scene = createStudioScene()
    camera = createStudioCamera()

    renderer = new WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    configureRenderer(renderer)
    renderer.domElement.setAttribute('aria-label', 'Animated Deafference signing avatar')
    renderer.domElement.className = 'avatar-canvas'
    host.value.prepend(renderer.domElement)

    controls = new OrbitControls(camera, renderer.domElement)
    configureOrbitControls(controls)

    const gltf = await new GLTFLoader().loadAsync(AVATAR_URL)
    if (disposed) return

    const avatar = gltf.scene
    prepareAvatar(avatar)
    scene.add(avatar)
    frameAvatar(avatar, camera, controls, SIGNING_FRAMING)

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
        const time = frameClock.time()
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
  frameClock.dispose()
  cancelAnimationFrame(animationFrame)
  resizeObserver?.disconnect()
  controls?.dispose()
  renderer?.dispose()
  renderer?.domElement.remove()
  if (scene) disposeScene(scene)
})
</script>
