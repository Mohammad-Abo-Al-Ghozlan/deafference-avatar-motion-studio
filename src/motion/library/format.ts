/**
 * Sign library: isolated signs (one clip per word) baked for the supplied
 * avatar by the asl-v2 data pipeline, imported by tools/import-sign-library.ts.
 *
 * Two files under public/motion/sign-library/:
 *   - sign-library.json      index: words, timing, provenance, QA summaries
 *   - sign-library.bin.gz    gzip of little-endian Int16 quaternions
 *
 * Binary layout: one block per variant (in `variants` order). A block holds
 * every word's frames back to back (word.frameOffset is the same in every
 * block); a frame is `bones.length` LOCAL quaternions [x, y, z, w], each
 * component quantised as round(v * 32767). Quantisation error is below
 * 0.004 deg per bone; decoded quaternions are renormalised.
 */

export const SIGN_LIBRARY_SCHEMA = 'deafference.sign-library'
export const SIGN_LIBRARY_SCHEMA_VERSION = 1
export const QUATERNION_SCALE = 32767

/** `raw` = the pipeline's bake as delivered; `conformed` = projected onto the studio's anatomical joint limits. */
export type LibraryVariant = 'raw' | 'conformed'
export const LIBRARY_VARIANTS: readonly LibraryVariant[] = ['raw', 'conformed']

export type ReviewStatus = 'pending_deaf_review' | 'approved' | 'rejected'

/**
 * Studio QA findings that are reported per word but do not fail the import:
 * they describe the recording, not a joint-model violation the conformance
 * could remove. A dominant hand left at the rig's rest pose during the stroke
 * means the pipeline had no finger data for that take.
 */
export const TOLERATED_QA_FINDINGS: readonly RegExp[] = [/^hand resets to rest pose while tracked$/, /^\d+ one-frame finger spikes/]

export const isToleratedQaFinding = (failure: string) => TOLERATED_QA_FINDINGS.some((pattern) => pattern.test(failure))

export interface WordQa {
  pass: boolean
  /** Failure messages of the studio's anatomical/temporal QA (src/motion/qa/metrics.ts). */
  failures: string[]
}

export interface WordConformance {
  /** Frames where at least one joint was changed by the conformance. */
  changedFrames: number
  /** Largest elbow swivel applied to keep the wrist in range (deg; the hand stays where it was). */
  maxSwivelDeg: number
  /** Largest change of a hand's orientation in space (deg): what the wrist limits could not absorb. */
  maxHandOrientationChangeDeg: number
  /** Largest change of a wrist's position in space (mm): only the elbow range clamp moves it. */
  maxHandPositionShiftMm: number
  /** Largest fingertip displacement in space (any finger, any frame), millimetres. */
  maxFingertipShiftMm: number
  /** Largest change of an elbow (forearm bone) local rotation, degrees. */
  maxElbowChangeDeg: number
  /** Adjacent-finger order corrections applied (frames x pairs). */
  crossingCorrections: number
}

export interface SignLibraryWord {
  /** Gloss id as used by the dataset and the pipeline (e.g. "TV", "thankyou"). */
  gloss: string
  /** First frame of this word inside each variant block. */
  frameOffset: number
  frameCount: number
  /** frames[holdIn, holdIn + stroke) is the sign; the rest eases from/to the idle pose. */
  holdIn: number
  stroke: number
  holdOut: number
  /** The pipeline normalises every signer to a right-dominant signer. */
  hands: 'right' | 'both'
  /** Lexicon handedness class: "1" one-handed, "2s" symmetric, "2a" asymmetric two-handed. */
  signClass: string
  /** How the non-dominant hand was produced ("none", "recorded", "mirrored_...", "base"). */
  passive: string
  review: ReviewStatus
  source: {
    sequenceId: string
    participantId: string
    rank: number
    /** held_out (test/val signer), split_fallback (training signer) or gate_relaxed. */
    selection: string
    quality: number | null
    /** File name of the clip in the pipeline's select run (the review CSV's clip_file column). */
    clipFile: string
    alternatives: number
  }
  qa: Record<LibraryVariant, WordQa>
  conformance: WordConformance
}

export interface SignLibraryIndex {
  schema: typeof SIGN_LIBRARY_SCHEMA
  schemaVersion: typeof SIGN_LIBRARY_SCHEMA_VERSION
  generator: string
  rig: { file: string; sha256: string; profile: string; joints: number }
  source: {
    pipeline: string
    libraryFormat: string
    avatarId: string
    selectRun: string
    createdUtc: string
    bakedSha256: string
    librarySha256: string
    reviewPolicy: string
    twoHandedNote: string
  }
  fps: number
  bones: string[]
  variants: LibraryVariant[]
  data: { file: string; encoding: 'int16-quaternion'; scale: number; totalFrames: number; values: number }
  /** Idle pose (arms hanging) every word starts and ends at. */
  idlePose: Record<string, [number, number, number, number]>
  words: SignLibraryWord[]
  counts: {
    words: number
    twoHanded: number
    pendingDeafReview: number
    approved: number
    qaPass: Record<LibraryVariant, number>
  }
  qaConvention: string
  notes: string[]
}

export function validateLibraryIndex(value: unknown): asserts value is SignLibraryIndex {
  const index = value as Partial<SignLibraryIndex>
  if (!index || index.schema !== SIGN_LIBRARY_SCHEMA) throw new Error('Not a deafference.sign-library index')
  if (index.schemaVersion !== SIGN_LIBRARY_SCHEMA_VERSION) throw new Error(`Unsupported sign-library schemaVersion ${String(index.schemaVersion)}`)
  if (!Number.isFinite(index.fps) || !index.fps || index.fps <= 0) throw new Error('Invalid fps')
  if (!Array.isArray(index.bones) || !index.bones.length) throw new Error('No bones')
  if (!Array.isArray(index.variants) || !index.variants.length) throw new Error('No variants')
  if (!Array.isArray(index.words) || !index.words.length) throw new Error('No words')
  if (!index.data || index.data.encoding !== 'int16-quaternion') throw new Error('Unsupported data encoding')
  let expectedOffset = 0
  const seen = new Set<string>()
  for (const word of index.words) {
    if (seen.has(word.gloss)) throw new Error(`Duplicate word "${word.gloss}"`)
    seen.add(word.gloss)
    if (word.frameOffset !== expectedOffset) throw new Error(`Word "${word.gloss}" starts at frame ${word.frameOffset}, expected ${expectedOffset}`)
    if (word.frameCount < 2 || word.holdIn + word.stroke + word.holdOut !== word.frameCount) throw new Error(`Word "${word.gloss}" timing does not add up`)
    expectedOffset += word.frameCount
  }
  if (expectedOffset !== index.data.totalFrames) throw new Error(`Words cover ${expectedOffset} frames, data has ${index.data.totalFrames}`)
  const values = index.variants.length * index.data.totalFrames * index.bones.length * 4
  if (index.data.values !== values) throw new Error(`Data declares ${index.data.values} values, layout needs ${values}`)
}

/** Quantise unit quaternion components to Int16 (writer side). */
export function quantize(value: number) {
  return Math.max(-QUATERNION_SCALE, Math.min(QUATERNION_SCALE, Math.round(value * QUATERNION_SCALE)))
}

/** Decoded, renormalised frames of one word: frameCount x bones x [x, y, z, w]. */
export function decodeWord(index: SignLibraryIndex, data: Int16Array, variant: LibraryVariant, word: SignLibraryWord): Float32Array {
  const variantIndex = index.variants.indexOf(variant)
  if (variantIndex < 0) throw new Error(`Variant "${variant}" is not in this library`)
  const stride = index.bones.length * 4
  const start = (variantIndex * index.data.totalFrames + word.frameOffset) * stride
  const out = new Float32Array(word.frameCount * stride)
  for (let i = 0; i < out.length; i += 4) {
    const x = data[start + i]
    const y = data[start + i + 1]
    const z = data[start + i + 2]
    const w = data[start + i + 3]
    const norm = Math.hypot(x, y, z, w) || 1
    out[i] = x / norm
    out[i + 1] = y / norm
    out[i + 2] = z / norm
    out[i + 3] = w / norm
  }
  return out
}

/** Bytes (possibly gzip) -> Int16Array, checking the length against the index. */
export function int16View(index: SignLibraryIndex, bytes: Uint8Array): Int16Array {
  if (bytes.byteLength !== index.data.values * 2) throw new Error(`Library data has ${bytes.byteLength} bytes, expected ${index.data.values * 2}`)
  // Copy into an aligned buffer; the file is little-endian like every browser and Node target we support.
  const aligned = new Uint8Array(bytes.byteLength)
  aligned.set(bytes)
  return new Int16Array(aligned.buffer)
}
