<template>
  <div class="app-shell">
    <header class="topbar">
      <a class="brand" href="#top" aria-label="Deafference Motion Studio home">
        <span class="brand-mark" aria-hidden="true"><i></i></span>
        <span class="brand-copy">
          <strong>deafference</strong>
          <small>Motion Studio</small>
        </span>
      </a>

      <div class="system-status" :class="statusClass">
        <span class="status-dot"></span>
        <span>{{ statusText }}</span>
      </div>
    </header>

    <main id="top">
      <section class="intro" aria-labelledby="page-title">
        <div>
          <p class="eyebrow"><span>ASL</span> Privacy-first motion transfer</p>
          <h1 id="page-title">The signer disappears.<br /><em>The motion stays.</em></h1>
        </div>
        <p class="intro-copy">
          Body, hands, fingers, head, and facial cues are tracked on-device and
          retargeted to the original Deafference avatar in real time.
        </p>
      </section>

      <section class="source-switcher" aria-label="Choose motion source">
        <button
          class="source-tab"
          :class="{ active: sourceMode === 'sample' }"
          type="button"
          @click="activateSample"
        >
          <span class="source-icon play-icon" aria-hidden="true"></span>
          <span><strong>Sample clip</strong><small>Qassem’s Story · 3:13</small></span>
        </button>
        <button
          class="source-tab"
          :class="{ active: sourceMode === 'upload' }"
          type="button"
          @click="openUpload"
        >
          <span class="source-icon upload-icon" aria-hidden="true"></span>
          <span><strong>Upload video</strong><small>MP4, WebM, MOV</small></span>
        </button>
        <button
          class="source-tab"
          :class="{ active: sourceMode === 'camera' }"
          type="button"
          @click="activateCamera"
        >
          <span class="source-icon camera-icon" aria-hidden="true"></span>
          <span><strong>Live camera</strong><small>Real-time mirror</small></span>
        </button>
        <input
          ref="fileInput"
          class="visually-hidden"
          type="file"
          accept="video/mp4,video/webm,video/quicktime,.mov"
          @change="handleUpload"
        />
      </section>

      <section class="motion-workspace" aria-label="ASL avatar motion workspace">
        <article class="panel avatar-panel">
          <header class="panel-header">
            <div>
              <p>Avatar output</p>
              <h2>Deafference character</h2>
            </div>
            <span class="live-badge"><i></i> Live retarget</span>
          </header>

          <div class="avatar-wrap">
            <AvatarStage
              ref="avatarStage"
              :frame="tracker.frame.value"
              :smoothing="smoothing"
              :strength="trackingStrength"
              :tracking-active="isPlaying"
              @ready="modelReady = true"
              @error="handleAvatarError"
            />

            <div class="avatar-corner-label">
              <span>Motion</span>
              <strong>{{ activeSourceName }}</strong>
            </div>

            <div class="avatar-hud" aria-label="Detected tracking channels">
              <span :class="{ detected: tracker.detections.value.body }"><i></i> Body</span>
              <span :class="{ detected: tracker.detections.value.leftHand }"><i></i> L hand</span>
              <span :class="{ detected: tracker.detections.value.rightHand }"><i></i> R hand</span>
              <span :class="{ detected: tracker.detections.value.face }"><i></i> Face</span>
            </div>
          </div>
        </article>

        <aside class="panel source-panel">
          <header class="panel-header source-heading">
            <div>
              <p>Motion source</p>
              <h2>{{ sourcePanelTitle }}</h2>
            </div>
            <button
              class="privacy-toggle"
              :aria-pressed="showSource"
              type="button"
              @click="showSource = !showSource"
            >
              <span :class="showSource ? 'eye-open' : 'eye-closed'" aria-hidden="true"></span>
              {{ showSource ? 'Hide person' : 'Reveal source' }}
            </button>
          </header>

          <div class="source-viewport" :class="{ protected: !showSource, mirrored: sourceMode === 'camera' }">
            <video
              ref="videoElement"
              playsinline
              muted
              :loop="sourceMode === 'sample'"
              :poster="sourceMode === 'sample' ? '/samples/qassem-story-poster.jpg' : undefined"
              @loadedmetadata="handleMediaReady"
              @play="handlePlay"
              @pause="isPlaying = false"
              @ended="handleEnded"
              @timeupdate="syncTimeline"
              @error="handleMediaError"
            ></video>
            <canvas ref="overlayCanvas" aria-hidden="true"></canvas>

            <div v-if="!showSource" class="privacy-shield">
              <span class="shield-icon" aria-hidden="true"></span>
              <strong>Identity protected</strong>
              <small>Only landmarks reach the avatar rig</small>
            </div>

            <div v-if="sourceMode === 'camera' && !cameraActive" class="camera-prompt">
              <span class="camera-large" aria-hidden="true"></span>
              <strong>Camera is off</strong>
              <button type="button" @click="activateCamera">Enable camera</button>
            </div>

            <span class="fps-readout">{{ tracker.fps.value || '—' }} FPS</span>
          </div>

          <div v-if="sourceMode !== 'camera'" class="timeline">
            <input
              type="range"
              min="0"
              :max="Math.max(duration, 0.01)"
              step="0.01"
              :value="currentTime"
              aria-label="Video position"
              @input="seekVideo"
            />
            <div><span>{{ formatTime(currentTime) }}</span><span>{{ formatTime(duration) }}</span></div>
          </div>

          <div class="transport">
            <button class="transport-main" type="button" @click="togglePlayback" :disabled="!mediaReady">
              <span :class="isPlaying ? 'pause-symbol' : 'play-symbol'" aria-hidden="true"></span>
              {{ isPlaying ? 'Pause' : 'Play' }}
            </button>
            <button class="transport-icon" type="button" title="Restart source" @click="restartSource" :disabled="!mediaReady">
              <span class="restart-symbol" aria-hidden="true"></span>
            </button>
            <label v-if="sourceMode !== 'camera'" class="speed-control">
              <span>Speed</span>
              <select v-model.number="playbackRate" @change="applyPlaybackRate">
                <option :value="0.75">0.75×</option>
                <option :value="1">1×</option>
                <option :value="1.25">1.25×</option>
              </select>
            </label>
          </div>

          <div class="tracking-readout">
            <div>
              <span class="metric-label">Inference</span>
              <strong>{{ tracker.inferenceMs.value || '—' }}<small> ms</small></strong>
            </div>
            <div>
              <span class="metric-label">Rig channels</span>
              <strong>45<small> live</small></strong>
            </div>
            <div>
              <span class="metric-label">Privacy</span>
              <strong class="local-word">Local</strong>
            </div>
          </div>

          <div class="tuning">
            <label>
              <span><b>Smoothing</b><output>{{ smoothing }}</output></span>
              <input v-model.number="smoothing" type="range" min="6" max="24" step="1" />
            </label>
            <label>
              <span><b>Motion strength</b><output>{{ Math.round(trackingStrength * 100) }}%</output></span>
              <input v-model.number="trackingStrength" type="range" min="0.55" max="1" step="0.05" />
            </label>
          </div>
        </aside>
      </section>

      <p v-if="errorMessage" class="error-banner" role="alert">
        <strong>Motion engine:</strong> {{ errorMessage }}
        <button type="button" @click="errorMessage = null">Dismiss</button>
      </p>

      <section class="truth-strip" aria-label="Prototype scope">
        <div>
          <span class="truth-number">01</span>
          <p><strong>Motion transfer</strong> reproduces an existing signed performance; it does not invent ASL from text.</p>
        </div>
        <div>
          <span class="truth-number">02</span>
          <p><strong>In-browser processing</strong> keeps the uploaded clip and camera frames on this device.</p>
        </div>
        <div>
          <span class="truth-number">03</span>
          <p><strong>Human review remains required</strong> before any animation is accepted as linguistically accurate ASL.</p>
        </div>
      </section>
    </main>

    <footer class="footer">
      <span>Deafference Motion Studio · Technical prototype</span>
      <span>MediaPipe Holistic → geometric rig retargeting → Three.js</span>
    </footer>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import AvatarStage from './components/AvatarStage.vue'
import { useHolisticTracker } from './composables/useHolisticTracker'
import type { Landmark, SourceMode, TrackingFrame } from './types/tracking'

const tracker = useHolisticTracker()

const videoElement = ref<HTMLVideoElement | null>(null)
const overlayCanvas = ref<HTMLCanvasElement | null>(null)
const fileInput = ref<HTMLInputElement | null>(null)
const avatarStage = ref<InstanceType<typeof AvatarStage> | null>(null)

const sourceMode = ref<SourceMode>('sample')
const uploadName = ref('Uploaded motion')
const showSource = ref(false)
const isPlaying = ref(false)
const mediaReady = ref(false)
const cameraActive = ref(false)
const modelReady = ref(false)
const duration = ref(0)
const currentTime = ref(0)
const playbackRate = ref(1)
const smoothing = ref(15)
const trackingStrength = ref(1)
const errorMessage = ref<string | null>(null)

let cameraStream: MediaStream | null = null
let objectUrl: string | null = null
let processingGeneration = 0
let fallbackAnimationFrame = 0

const activeSourceName = computed(() => {
  if (sourceMode.value === 'sample') return 'QASSEM’S STORY'
  if (sourceMode.value === 'camera') return 'LIVE CAMERA'
  return uploadName.value.toUpperCase()
})

const sourcePanelTitle = computed(() => {
  if (sourceMode.value === 'sample') return 'Qassem’s Story reference'
  if (sourceMode.value === 'camera') return 'Live signing'
  return uploadName.value
})

const statusText = computed(() => {
  if (tracker.error.value) return 'Tracker unavailable'
  if (!modelReady.value || tracker.loading.value) return 'Preparing motion engine'
  if (tracker.processing.value || isPlaying.value) return 'Retargeting live'
  return 'Ready'
})

const statusClass = computed(() => ({
  ready: modelReady.value && tracker.ready.value && !isPlaying.value,
  live: isPlaying.value && tracker.ready.value,
  error: Boolean(tracker.error.value)
}))

async function ensureTracker() {
  if (tracker.ready.value) return true
  try {
    await tracker.initialize()
    return true
  } catch (cause) {
    errorMessage.value = `The landmark model did not initialize. ${cause instanceof Error ? cause.message : String(cause)}`
    return false
  }
}

function stopCamera() {
  if (cameraStream) {
    cameraStream.getTracks().forEach((track) => track.stop())
    cameraStream = null
  }
  cameraActive.value = false
}

function clearObjectUrl() {
  if (objectUrl) URL.revokeObjectURL(objectUrl)
  objectUrl = null
}

function stopProcessingLoop() {
  processingGeneration += 1
  cancelAnimationFrame(fallbackAnimationFrame)
}

async function prepareVideoSource() {
  stopProcessingLoop()
  tracker.clear()
  avatarStage.value?.resetPose()
  mediaReady.value = false
  duration.value = 0
  currentTime.value = 0
  await nextTick()
}

async function activateSample() {
  const video = videoElement.value
  if (!video) return
  stopCamera()
  clearObjectUrl()
  sourceMode.value = 'sample'
  uploadName.value = 'Uploaded motion'
  await prepareVideoSource()
  video.srcObject = null
  video.src = '/samples/qassem-story.mp4'
  video.loop = true
  video.playbackRate = playbackRate.value
  video.load()
}

function openUpload() {
  fileInput.value?.click()
}

async function handleUpload(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  const video = videoElement.value
  if (!file || !video) return

  stopCamera()
  clearObjectUrl()
  sourceMode.value = 'upload'
  uploadName.value = file.name.replace(/\.[^.]+$/, '') || 'Uploaded motion'
  await prepareVideoSource()
  objectUrl = URL.createObjectURL(file)
  video.srcObject = null
  video.src = objectUrl
  video.loop = false
  video.playbackRate = playbackRate.value
  video.load()
  input.value = ''
}

async function activateCamera() {
  const video = videoElement.value
  if (!video) return

  stopCamera()
  clearObjectUrl()
  sourceMode.value = 'camera'
  await prepareVideoSource()

  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: 960 },
        height: { ideal: 720 },
        facingMode: 'user',
        frameRate: { ideal: 30, max: 30 }
      },
      audio: false
    })
    video.removeAttribute('src')
    video.srcObject = cameraStream
    video.loop = false
    cameraActive.value = true
    await video.play()
  } catch (cause) {
    errorMessage.value = cause instanceof Error
      ? `Camera access failed: ${cause.message}`
      : 'Camera access failed.'
    cameraActive.value = false
  }
}

async function handleMediaReady() {
  const video = videoElement.value
  if (!video) return
  mediaReady.value = true
  duration.value = Number.isFinite(video.duration) ? video.duration : 0
  video.playbackRate = playbackRate.value

  const trackerReady = await ensureTracker()
  if (!trackerReady) return

  try {
    await video.play()
  } catch {
    // Browser autoplay policies may require the visible play button.
  }
}

function handlePlay() {
  isPlaying.value = true
  startProcessingLoop()
}

function handleEnded() {
  isPlaying.value = false
  stopProcessingLoop()
}

function handleMediaError() {
  const code = videoElement.value?.error?.code
  if (code) errorMessage.value = `The selected video could not be decoded (media error ${code}).`
}

async function startProcessingLoop() {
  const video = videoElement.value
  if (!video || !mediaReady.value) return
  if (!(await ensureTracker())) return

  const generation = ++processingGeneration

  const processNext = async () => {
    if (generation !== processingGeneration || !videoElement.value) return
    const activeVideo = videoElement.value
    if (activeVideo.paused && sourceMode.value !== 'camera') return

    await tracker.process(activeVideo)
    if (generation !== processingGeneration) return

    if (activeVideo.requestVideoFrameCallback) {
      activeVideo.requestVideoFrameCallback(() => void processNext())
    } else {
      fallbackAnimationFrame = requestAnimationFrame(() => void processNext())
    }
  }

  if (video.requestVideoFrameCallback) {
    video.requestVideoFrameCallback(() => void processNext())
  } else {
    fallbackAnimationFrame = requestAnimationFrame(() => void processNext())
  }
}

async function togglePlayback() {
  const video = videoElement.value
  if (!video || !mediaReady.value) return

  if (sourceMode.value === 'camera' && !cameraActive.value) {
    await activateCamera()
    return
  }

  if (video.paused) await video.play()
  else video.pause()
}

async function restartSource() {
  const video = videoElement.value
  if (!video || !mediaReady.value) return
  avatarStage.value?.resetCalibration()
  tracker.clear()
  if (sourceMode.value !== 'camera') video.currentTime = 0
  await video.play()
}

function applyPlaybackRate() {
  if (videoElement.value) videoElement.value.playbackRate = playbackRate.value
}

function syncTimeline() {
  const video = videoElement.value
  if (!video) return
  currentTime.value = video.currentTime
  if (Number.isFinite(video.duration)) duration.value = video.duration
}

function seekVideo(event: Event) {
  const video = videoElement.value
  if (!video) return
  const value = Number((event.target as HTMLInputElement).value)
  video.currentTime = value
  currentTime.value = value
  avatarStage.value?.resetCalibration()
}

function formatTime(seconds: number) {
  if (!Number.isFinite(seconds)) return '0:00'
  const minutes = Math.floor(seconds / 60)
  const remainder = Math.floor(seconds % 60).toString().padStart(2, '0')
  return `${minutes}:${remainder}`
}

function handleAvatarError(message: string) {
  errorMessage.value = `The supplied avatar failed to load: ${message}`
}

function canvasPoint(landmark: Landmark, width: number, height: number) {
  const video = videoElement.value
  if (!video || !video.videoWidth || !video.videoHeight) {
    return { x: landmark.x * width, y: landmark.y * height }
  }

  const scale = Math.min(width / video.videoWidth, height / video.videoHeight)
  const contentWidth = video.videoWidth * scale
  const contentHeight = video.videoHeight * scale
  const offsetX = (width - contentWidth) / 2
  const offsetY = (height - contentHeight) / 2
  return {
    x: offsetX + landmark.x * contentWidth,
    y: offsetY + landmark.y * contentHeight
  }
}

function drawTracking(frame: TrackingFrame | null) {
  const canvas = overlayCanvas.value
  if (!canvas) return
  const rect = canvas.getBoundingClientRect()
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  const width = Math.max(1, rect.width)
  const height = Math.max(1, rect.height)
  const pixelWidth = Math.round(width * dpr)
  const pixelHeight = Math.round(height * dpr)
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth
    canvas.height = pixelHeight
  }

  const context = canvas.getContext('2d')
  if (!context) return
  context.setTransform(dpr, 0, 0, dpr, 0, 0)
  context.clearRect(0, 0, width, height)
  if (!frame) return

  const drawConnections = (landmarks: readonly Landmark[] | undefined, connections: readonly (readonly [number, number])[], color: string) => {
    if (!landmarks?.length) return
    context.strokeStyle = color
    context.lineWidth = 1.5
    context.lineCap = 'round'
    context.shadowColor = color
    context.shadowBlur = 7
    context.beginPath()
    connections.forEach(([from, to]) => {
      const a = landmarks[from]
      const b = landmarks[to]
      if (!a || !b) return
      const p1 = canvasPoint(a, width, height)
      const p2 = canvasPoint(b, width, height)
      context.moveTo(p1.x, p1.y)
      context.lineTo(p2.x, p2.y)
    })
    context.stroke()
    context.shadowBlur = 0
  }

  const drawPoints = (landmarks: readonly Landmark[] | undefined, indices: readonly number[], color: string, radius: number) => {
    if (!landmarks?.length) return
    context.fillStyle = color
    indices.forEach((index) => {
      const landmark = landmarks[index]
      if (!landmark) return
      const point = canvasPoint(landmark, width, height)
      context.beginPath()
      context.arc(point.x, point.y, radius, 0, Math.PI * 2)
      context.fill()
    })
  }

  const poseConnections = [
    [11, 12], [11, 13], [13, 15], [12, 14], [14, 16],
    [11, 23], [12, 24], [23, 24]
  ] as const
  const handConnections = [
    [0, 1], [1, 2], [2, 3], [3, 4],
    [0, 5], [5, 6], [6, 7], [7, 8],
    [5, 9], [9, 10], [10, 11], [11, 12],
    [9, 13], [13, 14], [14, 15], [15, 16],
    [13, 17], [17, 18], [18, 19], [19, 20], [0, 17]
  ] as const

  drawConnections(frame.poseLandmarks, poseConnections, '#75e7ff')
  drawConnections(frame.leftHandLandmarks, handConnections, '#ffbe78')
  drawConnections(frame.rightHandLandmarks, handConnections, '#ffbe78')
  drawPoints(frame.poseLandmarks, [11, 12, 13, 14, 15, 16], '#e9fbff', 2.4)
  drawPoints(frame.leftHandLandmarks, Array.from({ length: 21 }, (_, index) => index), '#fff1d6', 1.7)
  drawPoints(frame.rightHandLandmarks, Array.from({ length: 21 }, (_, index) => index), '#fff1d6', 1.7)
}

watch(tracker.frame, (value) => drawTracking(value))

onMounted(async () => {
  await nextTick()
  await activateSample()
  void ensureTracker()
})

onBeforeUnmount(() => {
  stopProcessingLoop()
  stopCamera()
  clearObjectUrl()
  void tracker.close()
})
</script>
