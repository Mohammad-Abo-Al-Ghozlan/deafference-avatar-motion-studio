/**
 * Clock for precomputed (offline) playback: the media time of the video frame
 * the browser actually PRESENTED (requestVideoFrameCallback), so the avatar
 * shows the motion of exactly the frame on screen. Falls back to currentTime
 * when the callback is unavailable or has not fired since a seek.
 */
export class MediaFrameClock {
  private video: HTMLVideoElement | null = null
  private handle = 0
  private presented: number | null = null
  private disposed = false

  attach(video: HTMLVideoElement | null) {
    if (this.video?.cancelVideoFrameCallback && this.handle) this.video.cancelVideoFrameCallback(this.handle)
    this.handle = 0
    this.video = video
    this.presented = null
    if (!video?.requestVideoFrameCallback || this.disposed) return
    const onFrame = (_now: DOMHighResTimeStamp, metadata: VideoFrameCallbackMetadata) => {
      if (this.disposed || this.video !== video) return
      this.presented = metadata.mediaTime
      this.handle = video.requestVideoFrameCallback!(onFrame)
    }
    this.handle = video.requestVideoFrameCallback(onFrame)
  }

  /** Forget the last presented frame (e.g. after a source change). */
  reset() {
    this.presented = null
  }

  time() {
    const video = this.video
    if (!video) return 0
    // After a seek while paused, rVFC reports the newly presented frame; if it
    // has not fired yet, currentTime is the best available estimate.
    if (this.presented !== null && Math.abs(this.presented - video.currentTime) < 0.25) return this.presented
    return video.currentTime
  }

  dispose() {
    this.attach(null)
    this.disposed = true
  }
}
