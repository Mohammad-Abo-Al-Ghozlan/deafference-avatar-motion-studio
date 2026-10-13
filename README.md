# Deafference Avatar Motion Studio

A privacy-first Vue/Three.js app that transfers the motion of a recorded or live signer onto the supplied rigged 3D character (`public/models/deafference-avatar.glb`).

The app has three tabs:

- **Motion studio**: the sample clip (precomputed motion), upload, and live camera.
- **Sign clips** (`#sign-clips`): two recorded signing clips, each shown in its own section next to the avatar replaying its precomputed motion. Both clips went through the same offline pipeline and QA as the sample clip. See [Sign clips tab](#sign-clips-tab).
- **Sign library** (`#sign-library`): a test bench for the 250 isolated signs the asl-v2 data pipeline baked for this avatar. Every word plays on the avatar, raw and conformed to the studio's joint model, with per-word QA, a word-lookup test and Deaf review export. See [Sign library tab](#sign-library-tab).

**This is motion retargeting, not translation.** It reproduces a performance that already exists in a video. It does not translate speech or text into signing, it is not a trained sign-language model, and its output has not been reviewed by a fluent Deaf signer. See [Limitations](#limitations).

## Quick start

```bash
npm install          # Node >= 20.19
npm run dev          # http://localhost:5173
npm test             # 57 unit tests (Node test runner)
npm run build        # vue-tsc + tsc (tools) + vite build
npm run preview
```

## Motion sources and engines

| Source | Engine | What drives the avatar |
|---|---|---|
| **Sample clip** (Qassem's Story, 3:13), default | **Precomputed (offline)** | `public/motion/qassem-story/avatar-motion.json.gz`, played by the video's media time. The pose shown is the pose of the video frame on screen (`requestVideoFrameCallback`), so seeking, pausing, speed changes and looping stay in lockstep. No inference runs. |
| Sample clip | Live tracker (toggle in the source panel) | In-browser MediaPipe Holistic + the causal pipeline below. |
| Upload video | Live (causal) | Same as above. |
| Live camera | Live (causal) | Same as above. |
| **Sign clips** tab, sections 1 and 2 | **Precomputed (offline)** | `public/motion/sign-clip-{1,2}/avatar-motion.json.gz`, each played by its own video's media time, exactly like the sample clip. |

Both engines use the **same anatomical solver** (`src/motion/retarget/AvatarSolver.ts`). The difference is how the landmarks are conditioned before solving:

- **Offline:** whole-clip, zero-phase processing. It uses the past and the future of every frame (Viterbi, filtfilt, PCHIP), then runs full numerical QA.
- **Live:** strictly causal processing, with no future frames (One Euro filters, greedy temporal choices, occlusion hold). The avatar eases toward each new solve at render rate (τ = 35 ms).

The HUD shows the state of each hand: **tracked**, **interpolated**, **holding** (amber) or **easing to a relaxed hand** (amber). Uncertain periods are therefore visible to the viewer rather than hidden.

## Sign clips tab

Two sections, one per recorded clip (`src/views/signClips.ts` lists them):

| Section | Clip id | Source file | Length | Frames |
|---|---|---|---|---|
| 1 | `sign-clip-1` | `WhatsApp Video 2026-10-02 at 3.15.17 AM 1.mp4` | 0:17 | 524 @ 30 fps |
| 2 | `sign-clip-2` | `WhatsApp Video 2026-10-02 at 3.15.17 AM.mp4` | 0:29 | 882 @ 30 fps |

Each section shows the recorded signer (with a "Hide person" toggle) next to the avatar. It has its own timeline, play/pause, restart and speed control (0.5×, 0.75×, 1×), a frame readout and per-hand quality badges. The avatar shows the pose of the video frame on screen, so pausing, scrubbing and slow motion stay in lockstep. Only one section plays at a time: starting one pauses the other.

Rendering notes:

- The avatar texture is 8192 × 8192, about 360 MB of GPU memory per WebGL context. The two sections therefore share **one** WebGL context and one parsed GLB (`src/three/sharedAvatarRenderer.ts`). Each section gets its own skeleton clone, rendered into the shared buffer and copied into the section's own canvas.
- The studio is unmounted while this tab is open, and the reverse, so there is never more than one avatar texture upload.
- Every avatar view, the studio included, frames the avatar waist-up like the recordings (`SIGNING_FRAMING` in `src/three/studioScene.ts`).

**Logo.** All three avatar views (the studio and both clip sections) show the Deafference logo in the top-left corner of the stage (`src/components/AvatarCornerLabel.vue`). The image is `public/brand/deafference-logo-on-dark.png`. `python3 tools/brand/make_logo_variants.py` generates it from the untouched original, `media/brand/deafference-logo.original.png`. The mark keeps its colours, and the dark wordmark is recoloured to the UI's light ink because it would be invisible on the dark stage.

### Adding a clip

The pipeline is the same for every clip. Copy the original to `media/source/<id>.original.mp4` (it is never modified), then run:

```bash
npm run motion:clip -- --clip <id> --python .venv-motion/bin/python
```

This runs, in order, with every stage also runnable on its own:

```bash
python3 pipeline/extract_landmarks.py --video media/source/<id>.original.mp4 --clip-id <id>   # reused when cached
npm run motion:clean -- --clip <id>
python3 pipeline/make_playback.py --video media/source/<id>.original.mp4 --clip-id <id>      # public/samples/<id>.mp4 + poster
npm run motion:solve -- --clip <id> --playback-video public/samples/<id>.mp4
npm run motion:qa -- --clip <id>
npm run motion:export -- --clip <id>
```

Then add the clip to `src/views/signClips.ts`.

`make_playback.py` builds the constant-frame-rate playback MP4 from the cleaning stage's slot → source-frame map. Frame *k* of the MP4 is therefore exactly the source frame that motion frame *k* was solved from. Frames are re-encoded from raw yuv420p, with no colour conversion, and the audio is dropped, as for the sample clip. The script verifies the frame count and that every timestamp is *k / 30*. For both clips, every playback frame was also checked to be the closest match (PSNR ≥ 42.9 dB) to its mapped source frame. The original sample clip's playback MP4 came with the project; the new clips use this script.

## Sign library tab

The Sign library tab (`#sign-library`, `src/views/SignLibraryView.vue`) is a test bench for the **250 isolated signs** (GISLR glosses, one dataset take per word) that the asl-v2 data pipeline retargeted onto this avatar. The pipeline baked them for the same GLB (sha256 `18df37e0d48b…`), so its local bone rotations play on this rig unchanged. The tab plays them with the studio's `MotionClip` player in the shared WebGL context, and the importer checks every word with the studio's full-clip QA.

**It is a lookup library, not translation.** Each word is an isolated sign. The lookup test plays known English words back to back in English word order, with an ease to the idle pose between them. There is no ASL grammar, facial grammar or coarticulation, and **no clip is Deaf-approved**.

What the tab offers:

- **Word test.** Search the 250 words, or filter them: two-handed, *Check* (QA findings or a large conformance change), unreviewed, reviewed. Play/pause, scrub, loop, previous/next, and 0.25× to 1× speed. The phase track marks the sign itself (the stroke) between the ease from and back to the idle pose.
- **Conformed / Raw.** Switch at the same position between the pipeline's bake as delivered (*raw*) and its projection onto the studio's joint model (*conformed*, the default). See below.
- **Play every word.** Plays the words in the list one after another (≈ 7 min at 1×).
- **Lookup test.** Type English words; matched words play back to back, and unknown words are listed as not in the library. Compound glosses map their English forms (`src/motion/library/lookup.ts`): *thank you* → `thankyou`, *ice cream* → `icecream`, *he / she / it* → `hesheit`.
- **Recognizer (round-trip).** When the pipeline's avatar recognizer has judged the takes (`train-all`, then the `library` stage), the detail panel shows its verdict on the take (recognized, or what it read the take as), the *Misread* filter lists the takes it misread, and the stats strip counts the recognized takes. This is a review-order signal, not correctness: the recognizer is right on about half of the clips of signers it never saw, and for asymmetric two-handed signs it sees a base hand synthesized from the word's own lexicon entry.
- **Deaf review.** A reviewer approves or rejects the take on screen, with notes. Decisions are saved in that browser and exported as the pipeline's `deaf_review_decisions.csv` (same columns as the pipeline's `viewer/clip_viewer.html`). Put the file in `s3://<bucket>/v2/05_library/<avatar>/reviews/` and rerun `python -m aslv2 library`. Approved takes are chosen first, and a rejected take is replaced by the next-ranked candidate. A decision belongs to the take (sign + sequence id), so a decision about an older take is shown as stale and not exported. Review works one word at a time and is disabled while a phrase plays. Shortcuts outside text fields: Space play/pause, N next, P previous, A approve, X reject.

### Raw vs conformed

The raw bake fails the studio's anatomical QA on every word. The failures are mostly finger roll ("corkscrew") and thumb joints off their hinge, followed by finger and wrist ranges. `src/motion/library/conform.ts` (`AnatomicalConformer`) projects each word onto the joint model that `AvatarSolver` builds poses with:

1. **Elbow swivel.** A Viterbi over the whole word rotates the arm about the shoulder→wrist axis. This keeps the hand's position **and** orientation in space exactly as given (location and palm orientation, what a viewer reads) while choosing an elbow position that keeps the wrist in range. The first and last frames stay at swivel 0, so every word still starts and ends at the shared idle pose.
2. **Elbow.** A pure hinge, with flexion clamped to [3°, 148°].
3. **Wrist.** Per-axis limits on whatever the swivel could not absorb.
4. **Long fingers.** The MCP keeps flexion and abduction only (no axial roll), with a flexion-dependent abduction range and adjacent fingers kept in order. PIP and DIP are pure hinges.
5. **Thumb.** MCP and IP are pure hinges within range.

The conformance is deterministic. The unit tests recompute it from the committed pipeline output and check that it is a projection: applying it twice changes < 0.25° (worst 0.16°, a finger MCP near full flexion, from the Int16 input).

### Data and commands

```bash
# 1. Copy the pipeline's library folder, s3://<bucket>/v2/05_library/<avatar>/<run>/:
#    baked_signs.json → motion/sign-library/source/baked_signs.json.gz
#    library.json     → motion/sign-library/source/library.json.gz
#    (gzip -9 -n, or pass --baked / --library with plain .json paths)
npm run library:import    # validate, conform, quantise, QA → public/motion/sign-library/ + qa-report
npm test                  # includes tests/signLibrary.test.ts
npm run build && npm run e2e:library [-- --url https://<deployment>]
```

The importer refuses input that was baked for a different GLB, comes from mismatched select runs, or lists different words in its two files. It exits non-zero if a conformed word fails QA for anything except the tolerated findings (`TOLERATED_QA_FINDINGS` in `src/motion/library/format.ts`). Output:

| File | Content |
|---|---|
| `public/motion/sign-library/sign-library.json` | Index (208 KB): words, timing (ease in / sign / ease out), provenance (dataset take, signer, rank, selection), how the take was chosen and the recognizer's verdict on it, per-variant QA failures, conformance statistics, review status |
| `public/motion/sign-library/sign-library.bin.gz` | 13,170 frames × 47 bones of local quaternions, Int16 (error < 0.004°), raw and conformed blocks (4.8 MB) |
| `motion/sign-library/qa-report.md`, `qa-report.json.gz` | QA summary, and per-word metrics of both variants |
| `motion/sign-library/source/` | The pipeline output the files above were built from (select run `20261012T230856Z_0eb172`, round-trip `avatar_20261013_0104`) |

`tests/signLibrary.test.ts` (16 tests, about 8 s) checks the following:

- The shipped files are the import of the committed source (sha256), and the raw frames equal the bake within quantisation error for every word, frame and bone.
- The conformed frames are reproducible, and every word starts and ends at the same idle pose in both variants.
- The stored QA equals the QA recomputed on the decoded data, and each word's take choice and recognizer verdict match the pipeline's library.json.
- The player, the clock, sequences, lookup, the review CSV and the loader behave correctly, including when a host decodes the `.gz` on the fly.

`npm run e2e:library` loads the tab in headless Chromium. For 8 words × 2 variants it checks that the avatar's bones equal the library at the presented time. It also checks that the *Misread* filter lists exactly the takes the recognizer misread, approves a word and checks the exported CSV byte for byte, plays the lookup test, and checks that switching variant keeps the phrase that is playing. It saves screenshots to `evidence/e2e/library-*.png`. With `--url` it runs against a deployment.

### QA results (250 words)

| | Studio QA pass | Findings (words) |
|---|---|---|
| Raw (pipeline bake) | 0 / 250 | thumb off-hinge 247, finger twist 240, finger ranges 141, wrist limits 115, elbow range 25, finger crossing 13, rest-pose hand 2, one-frame finger spike 1 |
| Conformed | **248 / 250** | rest-pose hand 2 (tolerated, see below) |

What the conformance changed: the elbow swivelled in 113 words (max 60°), and the wrist position moved at most 22 mm. Hand orientation, worst frame per word, changed by a median of 0° and a max of 55°. Fingertip displacement, worst frame per word, had a median of 18 mm and a max of 105 mm. Details per word: `motion/sign-library/qa-report.md`, and the tab's detail panel.

Before the round-trip tie-breaker (best-ranked take for every word) the conformed pass was 241 / 250, with 9 rest-pose hands.

Findings to check by eye, listed under the *Check* filter:

- **No finger data, 2 words** (`beside`, `grandma`). The dominant hand stays at the rig's rest handshape during the sign, because the pipeline had no finger data for that take. These words need another take. The round-trip tie-breaker already replaced the takes of the other 7 such words (`black`, `farm`, `food`, `give`, `jump`, `loud`, `toy`) with takes that have finger data.
- **Hand turned ≥ 15° by the wrist limits, 13 words** (`beside` 55°, `empty` 42°, `on` 34°, `read` 31°, `chair` 29°, `old` 28°, `cat` 25°, `that` 25°, `quiet` 24°, `every` 21°, `lion` 21°, `green` 17°, `helicopter` 15°). The raw take bends the wrist beyond its anatomical range. Compare Conformed with Raw: the palm orientation may matter for the meaning.
- **Two-handed words, 87.** Every second hand is synthesized, never recorded. 52 are a mirror of the dominant arm and hand (symmetric signs), and 35 are a static base hand from a hearing-authored lexicon (asymmetric signs). The pipeline's base-hand placement (`2a`) produces impossible wrist angles: in the raw bake the `beside` left wrist reaches 81° radial deviation (limit 28°), and `empty` and `on` 62–66° ulnar deviation (limit 40°). The conformance absorbs most of this by swivelling the elbow out, and clamps the rest, which turns the base hand (`beside` 55°, `empty` 42°). The proper fix belongs in the pipeline (aslv2 `motion/passive.py`).

### Recognizer round-trip (pipeline `train-all`, 2026-10-13)

The pipeline trained two small sign recognizers (250 classes, same signer split). One reads the original tracked landmarks, the other the avatar's motion. On the 3 test signers neither model saw (12,966 clips):

| Sign type | Signs | Landmarks | Avatar |
|---|---|---|---|
| One-handed | 163 | 50.2% | 49.0% |
| Two-handed, symmetric (mirrored second hand) | 52 | 43.1% | 46.4% |
| Two-handed, asymmetric (lexicon base hand) | 35 | 45.7% | 75.5% |
| All | 250 | 48.1% | 52.1% |

The numbers show first-guess accuracy.

- **The fair comparison is the one-handed row: the avatar motion keeps 98% of what the recognizer can read from the tracking.** The asymmetric row is a label leak. The pipeline builds the base hand of those signs from the lexicon entry of the word itself, in every split, so the avatar recognizer sees the answer. Don't quote the overall "52.1% vs 48.1%".
- **The recognizer is weak.** It gets about half of the clips of new signers right (69–70% on the validation signers), so a single misread is weak evidence.

The pipeline's `library` stage uses the round-trip (the avatar recognizer run on each exported take) to break ties between unreviewed takes of the same word, which cancels the leak. When the recognizer misreads the best-ranked unrejected take and recognizes another unrejected take of the same word, the best-ranked recognized take ships instead (`choice: roundtrip`).

- **Takes switched:** 70 words (48 to their second-ranked take, 22 to their third).
- **Effect:** conformed QA went from 241 to 248 / 250, and words with no finger data went from 9 to 2.
- **Recognized now:** 234 / 250 shipped takes.
- **Still misread (16):** `any`, `awake`, `bee`, `drawer`, `grandma`, `hot`, `kiss`, `lamp`, `mouth`, `pizza`, `say`, `sleepy`, `snack`, `sun`, `who`, `will`. These come first in Deaf review. Some are near-synonyms rather than bad motion (`mouth` is read as *lips*).

A Deaf decision always overrides the recognizer.

## Pipeline

```text
OFFLINE (sample clip)
 media/source/qassem-story.original.mp4   (read-only copy, sha256 08a276ad…)
   │ pipeline/extract_landmarks.py        Python, mediapipe 0.10.14 legacy Holistic — the same
   │                                      .tflite models as the browser bundle, every decoded frame
   ▼
 motion/qassem-story/raw-landmarks.json.gz        cached, versioned, resumable (per-chunk cache)
   │ tools/clean-landmarks.ts   VFR → uniform 30 fps grid (no frame dropped) · hand identity
   │                            · solver calibration · articulated hand-model fit per frame
   │                            · palm/back disambiguation (Viterbi) · outlier rejection
   │                            · short-gap interpolation · long-gap hold → relaxed fallback
   │                            · zero-phase smoothing + rate limits · anatomical projection
   ▼
 motion/qassem-story/clean-landmarks.json.gz
   │ tools/solve-motion.ts      elbow-swivel Viterbi · 2-bone IK · twist continuity → local
   │                            bone quaternions
   ▼
 motion/qassem-story/avatar-motion.json.gz ──► public/motion/… (app)   tools/validate-motion.ts → qa-report.{json,md}
   │ tools/export-glb.ts
   ▼
 motion/qassem-story/qassem-story.animation.glb   original GLB + one glTF animation clip

LIVE (camera / upload / sample in live mode), src/motion/live/*
 Holistic (browser) → hand identity → warm-started hand-model fit + palm continuity gate
   → One Euro filters, rate limits, depth gate, occlusion hold/fallback → same AvatarSolver
   → PoseApplier (render-rate easing, motion strength)
```

### What the solver guarantees (enforced by construction, verified by QA)

- **PIP, DIP and thumb IP** are pure hinges about the rig's own joint axes. The axes are measured from the GLB rest pose. The joints receive scalar, clamped angles, so they cannot swing sideways, twist or bend backwards.
- **MCP** allows flexion plus bounded abduction. The abduction range narrows as the finger flexes, DIP is coupled to PIP, and adjacent fingers keep their order (no crossing).
- **Thumb** uses its own CMC model (azimuth/elevation with opposition coupling) plus MCP/IP hinges.
- **Elbow** is a pure hinge within [3°, 148°], so it never hyperextends. Upper-arm roll is fully determined by the elbow plane, so the shoulder cannot corkscrew.
- **Wrist** swing is limited per anatomical axis. Pronation/supination is moved into the forearm twist bone, which prevents the "candy-wrapper" effect.
- **Hand placement:** the hand is placed where the viewer sees it. The source hand centre is mapped to the avatar, and near the face the mapping is face-relative. A target that monocular depth collapses onto the shoulder is completed forward in depth instead of folding the arm.
- **Continuity:** quaternion hemispheres are aligned per track. Nothing resets to the rest pose while a hand is tracked.

## Commands

### 1. Landmark extraction (Python, offline)

```bash
python3.11 -m venv .venv-motion          # mediapipe 0.10.14 supports Python 3.9-3.12
. .venv-motion/bin/activate
pip install -r pipeline/requirements.txt
npm run motion:extract                   # = python3 pipeline/extract_landmarks.py --video media/source/qassem-story.original.mp4 --clip-id qassem-story
# other clips: python3 pipeline/extract_landmarks.py --video <file> --clip-id <id>  (writes motion/<id>/raw-landmarks.json.gz)
```

The extractor never modifies the video. It processes every decoded frame in timestamp order, caches progress per chunk (so an interrupted run resumes), and records model hashes, configuration and detection statistics in the cache file.

### 2. Clean → solve → QA → export (Node)

```bash
npm run rig:report          # motion/rig-report.{json,md}: programmatic GLB rig inspection + semantic map validation
npm run motion:clean        # raw → clean-landmarks.json.gz + processing-report.json
npm run motion:solve        # clean → avatar-motion.json.gz (+ copy in public/motion/ for the app)
npm run motion:qa           # full-clip numerical QA; exits non-zero on any hard failure
npm run motion:export       # animated GLB + export report (Khronos glTF-Validator: 0 errors)
npm run motion:all          # clean + solve + qa + export
```

All tools take `--clip <id>`, `--motion-dir`, `--glb`, … (run with an unknown flag to list the options). Every path is repo-relative or configurable, and no device-specific paths are used.

### 3. Live-path verification and before/after data

```bash
npm run motion:live-replay                      # recorded tracker output → causal pipeline, frame by frame (Node)
npm run motion:qa -- --motion evidence/live-motion.json.gz --out evidence/live-qa-report.json
npm run motion:live-replay -- --stride 2 --out evidence/live-motion-15fps.json.gz   # tracker at 15 fps
npm run motion:legacy-replay                    # the ORIGINAL solver, replayed headlessly → evidence/legacy-motion.json.gz
```

Both replays read `evidence/inputs/raw-landmarks.live-smoothed.json.gz`, which is tracker output with Holistic's `smoothLandmarks` on, as the browser app runs it. To regenerate that file:

```bash
python3 pipeline/extract_landmarks.py --video media/source/qassem-story.original.mp4 --clip-id qassem-story \
  --smooth-landmarks --out-name raw-landmarks.live-smoothed.json.gz
mv motion/qassem-story/raw-landmarks.live-smoothed.json.gz evidence/inputs/
```

### 4. Visual evidence and browser end-to-end test

```bash
npm run dev -- --port 5174 --strictPort &      # the evidence harness is served by the dev server
npm run evidence:record -- --mode clip --clip /motion/qassem-story/avatar-motion.json.gz --view full --out evidence/video/after-offline-full.mp4
npm run evidence:record -- --mode clip --clip /evidence/legacy-motion.json.gz --view right --width 360 --height 360 --out evidence/video/before-legacy-right-hand.mp4
python3 tools/evidence/source_crops.py --video public/samples/qassem-story.mp4 --clean motion/qassem-story/clean-landmarks.json.gz --out evidence/video/source-right-hand.mp4
python3 tools/evidence/compose_videos.py sidebyside   # | hands | sheets | review

npm run build
npm run e2e -- --video-override <vp9-transcode-of-sample.webm> --camera <clip.y4m> \
  --clip-video-overrides sign-clip-1=<vp9-of-sign-clip-1.webm>,sign-clip-2=<vp9-of-sign-clip-2.webm>
```

The E2E also opens the Sign clips tab. It checks that both avatars equal their own motion files at the presented media time (0° error at 3 seek points each), that starting one section pauses the other, that both views share one WebGL context, and that switching back to the studio works. It also checks that the logo is loaded in the top-left corner of all three avatar views.

Rendering is frame-stepped and deterministic: output frame *k* is the pose at *t = k / 30*. Two options exist only because of limits in headless Chromium:

- `--video-override` (and `--clip-video-overrides` for the sign clips) swaps the MP4 for a VP9 transcode of the same frames. Playwright's Chromium has no H.264 decoder.
- `--camera` feeds a real signing clip through Chrome's fake camera device.

## Outputs

| File | Content |
|---|---|
| `motion/rig-report.{json,md}` | Rig: 90 nodes / 88 joints, 1 skinned mesh, no morph targets (face is bone-driven), rest == bind; validated semantic map, derived hinge axes |
| `motion/qassem-story/raw-landmarks.json.gz` | Raw Holistic output for all 5,761 decoded frames: pose, world pose, hands, face subset |
| `motion/qassem-story/clean-landmarks.json.gz` | Cleaned, constrained source motion on the 5,794-slot grid, with per-frame hand state |
| `motion/qassem-story/avatar-motion.json.gz` | **The motion export**: timestamped LOCAL transforms for 54 channels (50 rotation + 4 translation) × 5,794 frames; timeline map to source frames/timestamps; per-frame hand-state quality; rig and video sha256 |
| `motion/qassem-story/qassem-story.animation.glb` | Original GLB byte-for-byte, plus one LINEAR glTF animation (54 channels, 30 fps) and metadata in `animations[0].extras` |
| `motion/qassem-story/processing-report.json` | Timeline mapping, calibration constants, cleaning statistics, solver diagnostics |
| `motion/qassem-story/qa-report.{json,md}` | Numerical QA over the full clip, including the before/after comparison |
| `motion/sign-clip-{1,2}/…` | The same set of files for each sign clip, plus `playback-report.json` (slot → source-frame map and the verified playback encode) |
| `public/samples/sign-clip-{1,2}.mp4`, `…-poster.jpg` | Constant-frame-rate playback videos (no audio) and first-frame posters used by the Sign clips tab |
| `public/motion/sign-library/…`, `motion/sign-library/…` | Sign library index, quaternion data (raw + conformed), QA report and the pipeline output they were imported from; see [Sign library tab](#sign-library-tab) |
| `evidence/` | Legacy and live replays, live QA reports, E2E report and screenshots, videos, contact sheets |

`avatar-motion.json` schema (v1): `{ schema, schemaVersion, clipId, generator, rig{file,sha256,profile,joints}, source{video,sha256,playbackVideo,playbackSha256}, clean{file,sha256}, fps, frameCount, durationSec, space, timeline{sourceFrame[],sourceTime[]}, tracks[{bone, path: rotation|translation, values[]}], quality{handState{left,right}, legend, uncertainIntervals[]}, notes[] }`. Frame *k* is at *t = k / fps* on the video timeline. `quality.handState` holds one character per frame: T tracked, I interpolated, H holding, F easing to relaxed, A absent.

## QA results (full clip, 5,794 frames)

| Check | Original solver | Offline pipeline | Live pipeline (30 fps tracker) |
|---|---|---|---|
| NaN / non-unit quaternions / sign flips | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 |
| PIP/DIP reverse-bend frames | 354 / 124 (up to 93° past the limit) | 0 / 0 | 0 / 0 |
| PIP/DIP range violations | 2,229 / 124 | 0 / 0 | 0 / 0 |
| PIP/DIP/thumb off-hinge frames (> 1°) | 0 | 0 | 0 |
| Finger twist (> 3°) / order reversals / palm penetration | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 |
| Elbow off-hinge frames | 10,263 (up to 70.6°) | 0 | 0 |
| Wrist flex / deviation / twist violations | 567 / 651 / 621 | 0 / 0 / 0 | 0 / 0 / 0 |
| Wrist teleports (impulsive jumps) | 8 (up to 0.40 m in one frame) | 0 | 0 |
| Max wrist speed | 12.1 m/s | 3.7 m/s (1 fast step, explained by the source) | 3.5 m/s |
| One-frame spikes finger / wrist / arm | 0 / 8 / 0 | 0 / 0 / 0 | 0 / 0 / 0 |
| Max per-frame step finger / wrist / arm (°) | 42.5 / 70.5 / 48.6 | 29.7 / 35.3 / 25.9 | 41.3 / 33.5 / 32.6 |
| Rest-pose resets while tracked | 0 | 0 | 0 |

Notes:

- The "original solver" column is the uploaded `AvatarRetargeter` replayed headlessly on the same tracker output (with Holistic `smoothLandmarks` on, as in the app), evaluated with identical metrics.
- Live mode: mean solve time is 4.4 ms per frame (p95 9.3 ms) on top of Holistic inference.
- With the tracker at 15 fps, anatomy stays clean. The 30 fps QA then flags 5 "impulsive" steps, which come from the 15 Hz update cadence rather than from pops (see `evidence/live-qa-report-15fps.json`).

Source tracking coverage:

| Hand | Tracked | Interpolated | Holding | Easing to relaxed | Absent |
|---|---|---|---|---|---|
| Right (dominant) | 78.8% | 10.1% | 5.8% | 4.6% | 0.7% |
| Left | 25.6% | 4.2% | 7.9% | 19.3% | 43.1% |

The left hand is outside the 368×368 frame for most of the clip, so there is no evidence of its fingers for those periods and the avatar shows a relaxed hand.

### Sign clips (full clips)

| Check | `sign-clip-1` (524 frames) | `sign-clip-2` (882 frames) |
|---|---|---|
| Verdict | **PASS** | **PASS** |
| NaN / non-unit quaternions / sign flips | 0 / 0 / 0 | 0 / 0 / 0 |
| Reverse bends, range, hinge, twist, order, penetration, wrist-limit violations | 0 | 0 |
| Wrist teleports / rest resets while tracked | 0 / 0 | 0 / 0 |
| Max wrist speed | 4.3 m/s (1 fast step, explained by the source: ratio 1.03) | 4.0 m/s (1 fast step, ratio 1.24) |
| Max per-frame step finger / wrist / arm (°) | 26.6 / 27.0 / 42.0 | 26.7 / 23.3 / 28.6 |
| One-frame spikes finger / wrist / arm | 0 / 0 / 0 | 0 / 0 / 0 |
| Right hand tracked / interpolated / holding / easing / absent | 97.1 / 1.1 / 0.4 / 1.3 / 0.0 % | 91.6 / 2.5 / 2.7 / 2.7 / 0.5 % |
| Left hand tracked / interpolated / holding / easing / absent | 26.1 / 0.0 / 5.0 / 13.9 / 55.0 % | 33.3 / 0.2 / 4.8 / 16.7 / 45.0 % |

The signer's left hand is mostly lowered or below the frame, so for those periods the avatar shows a relaxed left hand (badge: not observed / uncertain). Clip 1's fast step is its last frame, where the right arm drops out of view.

**Fix found while processing these clips:** the body cleaner left samples before a hand's first observation and after its last one at placeholder zeros, and the zero-phase filter smeared that fake step into the neighbouring observed frames. In `sign-clip-1` the hand was pulled toward the shoulder midpoint and then jumped 0.28 m (8.5 m/s) on the final frame, and QA failed. Those samples now hold the nearest observation (`fillHoldEdges` in `tools/lib/cleanBody.ts`, with a regression test). The sample clip was re-solved with the fix. Only frames near its start and end changed, and its QA is unchanged apart from the wrist p99.9 step (27.9° → 25.9°).

## Limitations

- **Single camera, 368×368 source.** Palms are about 50-60 px wide. Monocular depth is estimated, not measured, and occluded fingers are inferred under anatomical constraints, not observed. With 1.5 px landmark noise, a single-frame finger fit has a median error of about 5° (see `tests/handModel.test.ts`). Temporal filtering reduces this, but it cannot recover information the camera never saw.
- **Palm vs. back of hand is ambiguous in 2D.** It is resolved by temporal continuity (offline Viterbi; live continuity gate). Short edge-on moments can still be interpreted wrongly.
- **Proportions differ.** Signer and avatar proportions differ. Hand placement preserves what the viewer sees, and is face-relative near the face, but contact points are approximate. There is no hand–hand or hand–body contact solver.
- **Calibration, not training.** No neural network was trained on this video. The pipeline estimates about 30 physical constants from the clip: MediaPipe hand depth scale, palm/phalanx proportions, face depth scale, a shoulder-width normaliser, and expression baselines. The live mode reuses these as defaults. They are not a general model and are not validated on other signers or cameras.
- **Facial non-manual markers are restrained.** The rig's jaw, eyelid, brow and mouth-corner bones carry them. The avatar has no morph targets, so fine mouth shapes are not reproducible.
- **Not linguistic output.** The clip's title is Arabic (قصة قاسم) and its sign language has not been identified, and the same holds for the two sign clips. Nothing here claims correct ASL or any other sign language. **A fluent Deaf signer must review any animation before it is presented as signing.**
- **Sign clips: handshape limits.** Visual review of full-length close-ups (`evidence/video/sign-clip-*-right-hand-closeup.mp4`) shows the usual monocular limits. Tight fists render as loosely curled hands, an edge-on thumbs-up can read as extended fingers, and a hand pointing straight at the camera loses depth. Calibration constants are re-estimated per clip (hand depth scale L/R: clip 1 2.3/2.2, clip 2 1.95/2.2); this is calibration, not training.
- **Sign library: isolated, synthesized, unreviewed.** Each word is one take of an isolated sign by one dataset signer, normalised to right-hand dominance. Second hands of two-handed signs are synthesized. The lookup test is dictionary lookup in English word order, not translation. Where the conformance clamps a wrist, the palm orientation in space changes (up to 55°, `beside`). No word may be presented to users as correct signing before a fluent Deaf signer approves it.
- **Test environment blockers.** In the headless test environment:
  - Holistic runs at about 3 s per frame on SwiftShader, so no real-time live baseline was recorded. The "before" footage is a frame-stepped replay of the unchanged original solver.
  - H.264 is unavailable in Playwright's Chromium, hence the VP9 test transcode.
  - The MediaPipe model CDN was blocked, so offline extraction uses the PyPI `mediapipe==0.10.14` wheel. Its bundled models were verified identical to the browser bundle.

## Privacy

All processing happens locally: Python/Node offline, and the browser for live mode. No video, frame or landmark leaves the machine, and no paid or external APIs are used.
