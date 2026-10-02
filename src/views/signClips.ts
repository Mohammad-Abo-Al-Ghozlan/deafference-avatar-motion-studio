/**
 * Recorded clips shown in the "Sign clips" tab. Every asset is produced by the
 * offline pipeline (see README, "Adding a clip"): playback MP4 + poster by
 * pipeline/make_playback.py, motion by tools/solve-motion.ts.
 */
export interface SignClipConfig {
  /** Pipeline clip id: motion/<id>/, public/motion/<id>/, public/samples/<id>.mp4 */
  id: string
  section: number
  title: string
  /** Name of the file the clip was recorded as (shown for traceability). */
  sourceFile: string
  video: string
  poster: string
  motion: string
}

function clip(id: string, section: number, sourceFile: string): SignClipConfig {
  return {
    id,
    section,
    title: `Recorded signing · clip ${section}`,
    sourceFile,
    video: `/samples/${id}.mp4`,
    poster: `/samples/${id}-poster.jpg`,
    motion: `/motion/${id}/avatar-motion.json.gz`
  }
}

export const SIGN_CLIPS: readonly SignClipConfig[] = [
  clip('sign-clip-1', 1, 'WhatsApp Video 2026-10-02 at 3.15.17 AM 1.mp4'),
  clip('sign-clip-2', 2, 'WhatsApp Video 2026-10-02 at 3.15.17 AM.mp4')
]
