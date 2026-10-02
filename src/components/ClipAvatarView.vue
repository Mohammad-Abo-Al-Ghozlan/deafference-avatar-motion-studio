<template>
  <div class="avatar-stage" :class="{ 'is-ready': ready }">
    <canvas ref="canvas" class="avatar-canvas" role="img" :aria-label="label"></canvas>

    <div v-if="!ready && !loadError" class="stage-loader" aria-live="polite">
      <div class="loader-orbit"><span></span></div>
      <p>Preparing the avatar rig</p>
      <small>Precomputed motion · same rig as the studio</small>
    </div>

    <div v-if="loadError" class="stage-error" role="alert">
      <strong>Avatar could not load</strong>
      <span>{{ loadError }}</span>
    </div>

    <div class="studio-floor" aria-hidden="true"></div>
  </div>
</template>

<script setup lang="ts">
/**
 * Precomputed-motion avatar view: plays `clip` in lockstep with `media` (the
 * pose of the video frame on screen). Unlike AvatarStage it has no live
 * tracker and renders through the page's shared WebGL context, so several
 * views can be on screen without one avatar texture upload each.
 */
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { Object3D, PerspectiveCamera, Scene } from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { MediaFrameClock } from '../motion/clip/MediaFrameClock'
import type { MotionBinding, MotionClip } from '../motion/clip/MotionClip'
import type { HandStateCode } from '../motion/clip/format'
import { acquireSharedAvatarRenderer, type SharedAvatarRenderer } from '../three/sharedAvatarRenderer'
import { configureOrbitControls, createStudioCamera, createStudioScene, disposeScene, frameAvatar, prepareAvatar, SIGNING_FRAMING } from '../three/studioScene'

export interface ClipViewStatus {
  frameIndex: number
  handState: { left: HandStateCode; right: HandStateCode }
}

const props = withDefaults(defineProps<{
  clip: MotionClip | null
  media: HTMLVideoElement | null
  strength?: number
  label?: string
  /** Key of the read-only E2E inspection hook (installed only with ?debug=1). */
  debugId?: string
}>(), {
  strength: 1,
  label: 'Animated Deafference signing avatar',
  debugId: ''
})

const emit = defineEmits<{
  ready: []
  error: [message: string]
  status: [status: ClipViewStatus]
}>()

const canvas = ref<HTMLCanvasElement | null>(null)
const ready = ref(false)
const loadError = ref<string | null>(null)

let shared: SharedAvatarRenderer | null = null
let removeView: (() => void) | null = null
let scene: Scene | null = null
let camera: PerspectiveCamera | null = null
let controls: OrbitControls | null = null
let avatar: Object3D | null = null
let binding: MotionBinding | null = null
let disposed = false
let lastStatusKey = ''
let lastTime: number | null = null
const clock = new MediaFrameClock()

watch(() => props.media, (video) => clock.attach(video), { immediate: true })
watch(() => props.clip, () => bindClip())

function bindClip() {
  binding?.reset()
  binding = null
  if (!avatar || !props.clip) return
  try {
    binding = props.clip.bind(avatar)
  } catch (cause) {
    emit('error', cause instanceof Error ? cause.message : String(cause))
  }
}

function update() {
  if (binding && props.clip) {
    const time = clock.time()
    lastTime = time
    props.clip.applyTo(binding, time)
    binding.applyStrength(props.strength)
    const sample = props.clip.sampleAt(time)
    const handState = props.clip.handStateAt(time)
    const key = `${sample.index0}|${handState.left}|${handState.right}`
    if (key !== lastStatusKey) {
      lastStatusKey = key
      emit('status', { frameIndex: sample.index0, handState })
    }
  }
  controls?.update()
}

function installDebugHook() {
  if (!props.debugId || typeof window === 'undefined' || !new URLSearchParams(window.location.search).has('debug') || !avatar) return
  const nodes = new Map<string, Object3D>()
  avatar.traverse((node) => { if (node.name && !nodes.has(node.name)) nodes.set(node.name, node) })
  const registry = ((window as unknown as Record<string, unknown>).__deafferenceClipViews ??= {}) as Record<string, unknown>
  registry[props.debugId] = {
    bone: (name: string) => nodes.get(name)?.quaternion.toArray() ?? null,
    offlineTime: () => lastTime,
    clipId: () => props.clip?.file.clipId ?? null
  }
}

onMounted(async () => {
  try {
    const handle = await acquireSharedAvatarRenderer()
    if (disposed || !canvas.value) {
      handle.release()
      return
    }
    shared = handle
    scene = createStudioScene()
    camera = createStudioCamera()
    controls = new OrbitControls(camera, canvas.value)
    configureOrbitControls(controls)
    avatar = handle.cloneAvatar()
    prepareAvatar(avatar)
    scene.add(avatar)
    frameAvatar(avatar, camera, controls, SIGNING_FRAMING)
    bindClip()
    installDebugHook()
    removeView = handle.addView({ canvas: canvas.value, scene, camera, update })
    ready.value = true
    emit('ready')
  } catch (cause) {
    loadError.value = cause instanceof Error ? cause.message : String(cause)
    emit('error', loadError.value)
  }
})

onBeforeUnmount(() => {
  disposed = true
  clock.dispose()
  removeView?.()
  controls?.dispose()
  // The avatar clone shares geometry, materials and textures with the
  // renderer's template: only this view's floor and grid are disposed here.
  if (scene) disposeScene(scene, avatar)
  if (props.debugId) {
    const registry = (window as unknown as Record<string, Record<string, unknown> | undefined>).__deafferenceClipViews
    if (registry) delete registry[props.debugId]
  }
  shared?.release()
})
</script>
