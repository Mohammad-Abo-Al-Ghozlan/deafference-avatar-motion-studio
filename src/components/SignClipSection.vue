<template>
  <section :id="`section-${config.section}`" class="clip-section" :aria-labelledby="`${config.id}-title`" :data-clip="config.id">
    <header class="clip-section-header">
      <div>
        <p class="clip-section-number">Section {{ String(config.section).padStart(2, '0') }}</p>
        <h2 :id="`${config.id}-title`">{{ config.title }}</h2>
      </div>
      <dl class="clip-facts">
        <div><dt>Length</dt><dd>{{ clip ? formatTime(clip.duration) : '—' }}</dd></div>
        <div><dt>Frames</dt><dd>{{ clip ? `${clip.file.frameCount} @ ${clip.file.fps} fps` : '—' }}</dd></div>
        <div class="clip-file"><dt>Source file</dt><dd :title="config.sourceFile">{{ config.sourceFile }}</dd></div>
      </dl>
    </header>

    <div class="motion-workspace clip-workspace">
      <article class="panel avatar-panel">
        <header class="panel-header">
          <div>
            <p>Avatar output</p>
            <h2>Deafference character</h2>
          </div>
          <span class="live-badge offline"><i></i> Precomputed motion</span>
        </header>

        <div class="avatar-wrap clip-avatar-wrap">
          <ClipAvatarView
            :clip="clip"
            :media="videoElement"
            :debug-id="config.id"
            :label="`Deafference avatar performing section ${config.section}`"
            @ready="avatarReady = true"
            @error="handleAvatarError"
            @status="viewStatus = $event"
          />

          <AvatarCornerLabel :value="`Section ${config.section}`" />

          <div class="avatar-hud" aria-label="Hand tracking quality at this frame">
            <span :class="handClass('left')" :title="handTitle('left')"><i></i> L hand</span>
            <span :class="handClass('right')" :title="handTitle('right')"><i></i> R hand</span>
          </div>
        </div>
      </article>

      <aside class="panel source-panel">
        <header class="panel-header source-heading">
          <div>
            <p>Motion source</p>
            <h2>Recorded signer</h2>
          </div>
          <button class="privacy-toggle" :aria-pressed="showSource" type="button" @click="showSource = !showSource">
            <span :class="showSource ? 'eye-open' : 'eye-closed'" aria-hidden="true"></span>
            {{ showSource ? 'Hide person' : 'Reveal source' }}
          </button>
        </header>

        <div class="source-viewport clip-viewport" :class="{ protected: !showSource }">
          <video
            ref="videoElement"
            :src="config.video"
            :poster="config.poster"
            playsinline
            muted
            loop
            preload="auto"
            :aria-label="`Source video for section ${config.section}`"
            @loadedmetadata="handleMediaReady"
            @play="handlePlay"
            @pause="isPlaying = false"
            @timeupdate="syncTimeline"
            @seeked="syncTimeline"
            @error="handleMediaError"
          ></video>

          <div v-if="!showSource" class="privacy-shield">
            <span class="shield-icon" aria-hidden="true"></span>
            <strong>Identity hidden</strong>
            <small>The avatar keeps playing the motion</small>
          </div>

          <span class="fps-readout">{{ mediaReady ? 'Baked' : 'Loading' }}</span>
        </div>

        <div class="timeline">
          <input
            type="range"
            min="0"
            :max="Math.max(duration, 0.01)"
            step="0.01"
            :value="currentTime"
            :disabled="!mediaReady"
            :aria-label="`Section ${config.section} position`"
            @input="seekVideo"
          />
          <div><span>{{ formatTime(currentTime) }}</span><span>{{ formatTime(duration) }}</span></div>
        </div>

        <div class="transport">
          <button class="transport-main" type="button" :disabled="!mediaReady" @click="togglePlayback">
            <span :class="isPlaying ? 'pause-symbol' : 'play-symbol'" aria-hidden="true"></span>
            {{ isPlaying ? 'Pause' : 'Play' }}
          </button>
          <button class="transport-icon" type="button" title="Restart" aria-label="Restart" :disabled="!mediaReady" @click="restart">
            <span class="restart-symbol" aria-hidden="true"></span>
          </button>
          <label class="speed-control">
            <span>Speed</span>
            <select v-model.number="playbackRate" @change="applyPlaybackRate">
              <option :value="0.5">0.5×</option>
              <option :value="0.75">0.75×</option>
              <option :value="1">1×</option>
            </select>
          </label>
        </div>

        <div class="tracking-readout">
          <div>
            <span class="metric-label">Frame</span>
            <strong>{{ viewStatus?.frameIndex ?? '—' }}<small> / {{ clip ? clip.file.frameCount - 1 : '—' }}</small></strong>
          </div>
          <div>
            <span class="metric-label">Rig channels</span>
            <strong>{{ clip?.file.tracks.length ?? '—' }}<small> baked</small></strong>
          </div>
          <div>
            <span class="metric-label">Privacy</span>
            <strong class="local-word">Local</strong>
          </div>
        </div>

        <div class="hand-legend">
          <p>Hand badges on the avatar</p>
          <dl>
            <div><dt><i class="detected"></i> Tracked</dt><dd>Fitted to the recorded hand in this frame</dd></div>
            <div><dt><i class="uncertain"></i> Uncertain</dt><dd>Hand lost briefly: held, then eased to a relaxed hand</dd></div>
            <div><dt><i></i> Not observed</dt><dd>Hand out of view: relaxed pose, not the signer's</dd></div>
          </dl>
          <small>The pose shown is the pose of the video frame on screen. Scrub or play at 0.5× to compare handshapes.</small>
        </div>
      </aside>
    </div>

    <p v-if="errorMessage" class="error-banner" role="alert">
      <strong>Section {{ config.section }}:</strong> {{ errorMessage }}
      <button type="button" @click="errorMessage = null">Dismiss</button>
    </p>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import AvatarCornerLabel from './AvatarCornerLabel.vue'
import ClipAvatarView, { type ClipViewStatus } from './ClipAvatarView.vue'
import { MotionClip } from '../motion/clip/MotionClip'
import type { HandStateCode } from '../motion/clip/format'
import type { SignClipConfig } from '../views/signClips'

const props = defineProps<{ config: SignClipConfig }>()

const emit = defineEmits<{
  /** Playback started (the parent pauses the other sections). */
  playing: [id: string]
  state: [state: { id: string; ready: boolean; playing: boolean; error: boolean }]
}>()

const videoElement = ref<HTMLVideoElement | null>(null)
const clip = shallowRef<MotionClip | null>(null)
const viewStatus = shallowRef<ClipViewStatus | null>(null)
const avatarReady = ref(false)
const mediaReady = ref(false)
const isPlaying = ref(false)
const showSource = ref(true)
const duration = ref(0)
const currentTime = ref(0)
const playbackRate = ref(1)
const errorMessage = ref<string | null>(null)
const failed = ref(false)

const HAND_STATE_TEXT: Record<HandStateCode, string> = {
  T: 'tracked',
  I: 'interpolated (short gap)',
  H: 'holding last reliable pose',
  F: 'uncertain: easing to relaxed hand',
  A: 'not observed'
}

const ready = computed(() => avatarReady.value && mediaReady.value && clip.value !== null)

watch([ready, isPlaying, failed], () => {
  emit('state', { id: props.config.id, ready: ready.value, playing: isPlaying.value, error: failed.value })
}, { immediate: true })

function handState(side: 'left' | 'right'): HandStateCode {
  return viewStatus.value?.handState[side] ?? 'A'
}

function handClass(side: 'left' | 'right') {
  const state = handState(side)
  return { detected: state === 'T' || state === 'I', uncertain: state === 'H' || state === 'F' }
}

function handTitle(side: 'left' | 'right') {
  return `${side === 'left' ? 'Left' : 'Right'} hand: ${HAND_STATE_TEXT[handState(side)]}`
}

let abort: AbortController | null = null

async function loadMotion() {
  abort = new AbortController()
  try {
    clip.value = await MotionClip.load(props.config.motion, abort.signal)
  } catch (cause) {
    if (abort.signal.aborted) return
    failed.value = true
    errorMessage.value = `Precomputed motion unavailable. ${cause instanceof Error ? cause.message : String(cause)}`
  }
}

function handleAvatarError(message: string) {
  failed.value = true
  errorMessage.value = `The avatar could not be shown: ${message}`
}

function handleMediaReady() {
  const video = videoElement.value
  if (!video) return
  mediaReady.value = true
  duration.value = Number.isFinite(video.duration) ? video.duration : 0
  video.playbackRate = playbackRate.value
}

function handleMediaError() {
  const code = videoElement.value?.error?.code
  if (!code) return
  failed.value = true
  errorMessage.value = `The source video could not be decoded (media error ${code}).`
}

function handlePlay() {
  isPlaying.value = true
  emit('playing', props.config.id)
}

function syncTimeline() {
  const video = videoElement.value
  if (!video) return
  currentTime.value = video.currentTime
  if (Number.isFinite(video.duration)) duration.value = video.duration
  isPlaying.value = !video.paused
}

async function togglePlayback() {
  const video = videoElement.value
  if (!video || !mediaReady.value) return
  if (video.paused) {
    try {
      await video.play()
    } catch (cause) {
      errorMessage.value = `Playback was blocked: ${cause instanceof Error ? cause.message : String(cause)}`
    }
  } else {
    video.pause()
  }
}

async function restart() {
  const video = videoElement.value
  if (!video || !mediaReady.value) return
  video.currentTime = 0
  currentTime.value = 0
  if (video.paused) await togglePlayback()
}

function seekVideo(event: Event) {
  const video = videoElement.value
  if (!video) return
  const value = Number((event.target as HTMLInputElement).value)
  video.currentTime = value
  currentTime.value = value
}

function applyPlaybackRate() {
  if (videoElement.value) videoElement.value.playbackRate = playbackRate.value
}

function pause() {
  videoElement.value?.pause()
}

function formatTime(seconds: number) {
  if (!Number.isFinite(seconds)) return '0:00'
  const minutes = Math.floor(seconds / 60)
  const remainder = Math.floor(seconds % 60).toString().padStart(2, '0')
  return `${minutes}:${remainder}`
}

defineExpose({ pause })

onMounted(() => {
  void loadMotion()
})

onBeforeUnmount(() => {
  abort?.abort()
  videoElement.value?.pause()
})
</script>
