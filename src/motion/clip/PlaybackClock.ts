/**
 * Media-like clock for precomputed motion without a video (library signs):
 * play / pause / seek / rate / loop over a clip duration. The avatar view
 * polls `time()` once per rendered frame, exactly as it polls a video's
 * presented-frame time, so playback is a pure function of this clock.
 */
export class PlaybackClock {
  private base = 0
  private anchor = 0
  private running = false
  private rateValue = 1
  private durationValue = 0
  /** Restart at 0 when the end is reached; otherwise stop at the end. */
  loop = true

  constructor(private readonly now: () => number = () => performance.now() / 1000) {}

  get playing() {
    return this.running
  }

  get rate() {
    return this.rateValue
  }

  get duration() {
    return this.durationValue
  }

  /** True once a non-looping clock has reached the end (cleared by seek/play). */
  get ended() {
    return !this.loop && !this.running && this.durationValue > 0 && this.base >= this.durationValue
  }

  /** Current media time in [0, duration]. Advances the stopped/looped state as a side effect. */
  time() {
    if (!this.running) return this.base
    const elapsed = (this.now() - this.anchor) * this.rateValue
    let t = this.base + elapsed
    const d = this.durationValue
    if (d <= 0) return 0
    if (t >= d) {
      if (this.loop) {
        t %= d
        this.base = t
        this.anchor = this.now()
      } else {
        this.base = d
        this.running = false
        return d
      }
    }
    return t
  }

  /** New clip: duration in seconds, position reset to 0, paused. */
  load(duration: number) {
    this.durationValue = Math.max(0, duration)
    this.base = 0
    this.running = false
  }

  play() {
    if (this.durationValue <= 0) return
    if (this.base >= this.durationValue) this.base = 0
    this.anchor = this.now()
    this.running = true
  }

  pause() {
    this.base = this.time()
    this.running = false
  }

  seek(seconds: number) {
    this.base = Math.min(Math.max(seconds, 0), this.durationValue)
    this.anchor = this.now()
  }

  setRate(rate: number) {
    if (!(rate > 0)) return
    this.base = this.time()
    this.anchor = this.now()
    this.rateValue = rate
  }
}
