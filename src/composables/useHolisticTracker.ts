import { computed, readonly, ref } from 'vue'
import { Holistic, type Results } from '@mediapipe/holistic'
import type { TrackingFrame } from '../types/tracking'

const LOCAL_ASSET_ROOT = '/mediapipe/'

export function useHolisticTracker() {
  const frame = ref<TrackingFrame | null>(null)
  const loading = ref(false)
  const ready = ref(false)
  const processing = ref(false)
  const error = ref<string | null>(null)
  const inferenceMs = ref(0)
  const fps = ref(0)

  let holistic: Holistic | null = null
  let lastResultAt = 0
  let smoothedFps = 0

  const initialize = async () => {
    if (ready.value || loading.value) return

    loading.value = true
    error.value = null

    try {
      holistic = new Holistic({
        locateFile: (file: string) => `${LOCAL_ASSET_ROOT}${file}`
      })

      holistic.setOptions({
        modelComplexity: 1,
        smoothLandmarks: true,
        enableSegmentation: false,
        smoothSegmentation: false,
        refineFaceLandmarks: true,
        minDetectionConfidence: 0.55,
        minTrackingConfidence: 0.55
      })

      holistic.onResults((results: Results) => {
        const now = performance.now()
        const instantFps = lastResultAt ? 1000 / Math.max(1, now - lastResultAt) : 0
        smoothedFps = smoothedFps ? smoothedFps * 0.82 + instantFps * 0.18 : instantFps
        lastResultAt = now
        fps.value = Math.round(smoothedFps)

        frame.value = {
          poseLandmarks: results.poseLandmarks,
          leftHandLandmarks: results.leftHandLandmarks,
          rightHandLandmarks: results.rightHandLandmarks,
          faceLandmarks: results.faceLandmarks,
          timestamp: now
        }
        processing.value = false
      })

      await holistic.initialize()
      ready.value = true
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause)
      holistic = null
      throw cause
    } finally {
      loading.value = false
    }
  }

  const process = async (source: HTMLVideoElement | HTMLImageElement | HTMLCanvasElement) => {
    if (!holistic || !ready.value || processing.value) return false
    if (source instanceof HTMLVideoElement && source.readyState < 2) return false

    processing.value = true
    const startedAt = performance.now()
    try {
      await holistic.send({ image: source })
      inferenceMs.value = Math.round(performance.now() - startedAt)
      return true
    } catch (cause) {
      processing.value = false
      error.value = cause instanceof Error ? cause.message : String(cause)
      return false
    }
  }

  const clear = () => {
    frame.value = null
    fps.value = 0
    lastResultAt = 0
    smoothedFps = 0
  }

  const close = async () => {
    if (holistic) await holistic.close()
    holistic = null
    ready.value = false
    processing.value = false
    clear()
  }

  const detections = computed(() => ({
    body: Boolean(frame.value?.poseLandmarks?.length),
    leftHand: Boolean(frame.value?.leftHandLandmarks?.length),
    rightHand: Boolean(frame.value?.rightHandLandmarks?.length),
    face: Boolean(frame.value?.faceLandmarks?.length)
  }))

  return {
    frame: readonly(frame),
    loading: readonly(loading),
    ready: readonly(ready),
    processing: readonly(processing),
    error: readonly(error),
    inferenceMs: readonly(inferenceMs),
    fps: readonly(fps),
    detections,
    initialize,
    process,
    clear,
    close
  }
}
