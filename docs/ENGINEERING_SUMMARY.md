# Engineering summary: avatar motion engine v2

Scope: make the supplied avatar reproduce the body, arm, wrist, hand, finger, head and face motion of the 3:13 signing clip with the original timing. Hands had to be anatomically valid, and the real-time camera mode had to stay working. Baseline: git commit `1d50650` ("uploaded project as received").

## Root cause

The finger failures came from the original `src/lib/AvatarRetargeter.ts`. I reproduced them by replaying that code, unchanged, on the same tracker output (`tools/legacy-motion.ts`) and measuring the result.

1. **Distorted 3D hand geometry.** Hand landmark depth was multiplied by 0.38. On this clip, bone lengths are *least* consistent at that scale. Phalanx lengths are most constant at 2.10 (right) and 2.25 (left), so 0.38 skewed every 3D finger direction.
2. **Flexion sign chosen by a per-hand vote.** Each joint's bend was measured from landmark directions, and its sign came from a heuristic "preferred bend sign" vote over the whole hand. When the palm normal flipped (palm/back ambiguity, noisy depth), whole fingers bent backwards: 354 PIP frames, up to 93° past the anatomical limit.
3. **Rest curl counted twice.** Bend was applied on top of the rig's rest rotation, so the rest curl was counted twice. There was also no per-frame kinematic model tying the 21 points together (bone lengths, DIP↔PIP coupling, finger order). Result: 2,229 PIP-range and 124 DIP-range violation frames.
4. **Arm and wrist bones aimed independently.** The elbow rotated off its hinge in 10,263 frames (up to 70.6°). The wrist had no per-axis limits and no forearm twist distribution: 567/651/621 flex/deviation/twist violations, up to 93° excess.
5. **No temporal model.** It used exponential smoothing at render rate, stale-pose resets, and no hand-identity checks. The wrist jumped up to 0.40 m in a single frame, the maximum wrist speed was 12.1 m/s, and there were 8 one-frame wrist spikes.
6. **Camera mode never started processing (pre-existing, found by the E2E test).** The loop only started from the `play` event. MediaStreams fire `play` before `loadedmetadata`, so the loop exited early and was never restarted. In headless Chromium with a fake camera, the original app ran 0 inferences in 60 s.

## What was built

| Area | Files | Algorithm |
|---|---|---|
| Rig inspection | `src/motion/rig/{Rig,semanticMap,rigGeometry}.ts`, `tools/rig-report.ts` | Loader-independent rig (browser GLTFLoader ≡ Node gltf-transform). Semantic map validated against topology and geometry, never assumed. Hinge axes, rest angles, palm frames, arm lengths and body proxies are derived from the GLB rest pose. |
| Extraction | `pipeline/` (Python) | mediapipe 0.10.14 legacy Holistic (same `.tflite` models as the browser; parity verified) on every decoded frame. Chunked, resumable, with model hashes and config digest. |
| Timeline | `tools/lib/timeline.ts` | VFR source (5,761 frames, gaps up to 200 ms) → 5,794-slot 30 fps grid matching the CFR playback MP4. Collisions are pushed forward; no frame is ever dropped. |
| Calibration (not training) | `src/motion/source/handCalibration.ts`, face/body cleaners | Hand depth scale by bone-length constancy, pooled palm/phalanx template, face depth scale by rigidity, face Procrustes template, shoulder-width normaliser, expression baselines. About 30 physical constants in total, all reported. |
| Hand model | `src/motion/source/handModel.ts`, `handParams.ts` | Articulated per-frame fit (bounded Levenberg–Marquardt, alternating similarity/digit passes). Priors: DIP≈0.7·PIP, MCP hyperextension, flexion-dependent abduction, thumb opposition coupling. Anatomical projection plus anti-crossing. Both palm/back hypotheses are fitted. |
| Offline cleaning | `tools/lib/clean{Hands,Body,Face}.ts` | Palm/back choice by Viterbi. Hampel outliers, PCHIP short gaps, hold → relaxed fallback → re-acquire blends. Rate limit → zero-phase Butterworth → rate guard. Quaternion hemisphere alignment. |
| Solver | `src/motion/retarget/AvatarSolver.ts` | Restrained torso/neck/head. Analytic 2-bone IK with a pure-hinge elbow. Upper-arm roll from the elbow plane. Swing-twist wrist with per-axis soft limits and twist moved to the forearm twist bone. Hand-centroid placement (face-relative near the face), body collision proxies, near-shoulder depth completion. Scalar-hinge fingers. |
| Offline solve | `tools/solve-motion.ts` | Swivel cost over 48 candidates → Viterbi → zero-phase smoothing. Forearm-twist side changes are replaced by smooth transitions. |
| Export | `src/motion/clip/*`, `tools/export-glb.ts` | `avatar-motion.json.gz` (local transforms, timeline, quality). The GLB is edited at container level: the original BIN chunk is a byte-identical prefix, JSON objects are unchanged, one LINEAR animation is appended. Khronos glTF-Validator reports 0 errors and no new issues. |
| QA | `src/motion/qa/metrics.ts`, `tools/validate-motion.ts` | Checks: hinge purity against the dominant and anatomical axes, reverse bend, ranges, finger roll, order, palm penetration, wrist limits, rest resets, bone lengths, per-class step/velocity/acceleration/spikes, impulsive teleports vs. source-explained fast motion. |
| Live (causal) path | `src/motion/live/*`, `src/motion/filters/online.ts`, `src/motion/retarget/PoseApplier.ts` | Warm-started hand fit with a palm continuity gate. One Euro filters and rate limits. Robust depth gate plus depth completion. Trust-weighted wrist speed limits near the image border. Pose/hand wrist cross-fades, occlusion hold → relaxed, greedy swivel with a continuity penalty, rate-limited forearm twist, render-rate easing. |
| App | `src/App.vue`, `src/components/AvatarStage.vue`, `src/composables/useHolisticTracker.ts`, `src/types/tracking.ts`, `src/styles.css` | Offline engine plays the clip by the presented frame's media time. Live engine for camera, upload, and the sample in live mode. HUD shows hand-state quality. Camera race fixed. World landmarks read from the Holistic bundle (`za`). Copy no longer labels the clip as ASL. |

**Dependencies:**
- Runtime dependencies are unchanged.
- Dev dependencies added (exact pins): `tsx`, `@gltf-transform/core`, `@types/node`, `playwright`, `gltf-validator`.
- `vite` bumped 7.0.6 → 7.3.6, same major version. 7.0.6 had seven dev-server advisories, including arbitrary file read and Windows `fs.deny` bypasses, and `npm run dev` binds `0.0.0.0`.
- `npm audit`: 0 vulnerabilities.

Removed: `src/lib/AvatarRetargeter.ts`. It is superseded, and an unchanged copy is kept at `tools/evidence/legacy/AvatarRetargeter.legacy.ts` to produce the "before" evidence. No UI feature was removed. The smoothing and strength sliders still work in live mode; smoothing is baked into precomputed motion.

## Verification

- **Unit tests** (`npm test`): 32 tests, all passing. They cover:
  - filters (zero-phase, rate limits, Hampel, PCHIP, One Euro), swing-twist;
  - rig validation;
  - hand FK→fit round trip (exact on clean data; median 5° under 1.5 px noise);
  - anatomical projection;
  - IK accuracy and pure-hinge elbow;
  - finger hinges;
  - depth completion;
  - motion-file linkage and full QA;
  - GLB export integrity;
  - timeline;
  - live-pipeline causality (future frames never change past output), constraints, and degraded inputs.
- **Numerical QA, offline motion** (`motion/qassem-story/qa-report.md`): PASS. There are 0 violations in every anatomical and continuity check. One fast wrist step (3.7 m/s) is explained by the source motion (avatar/source step ratio 1.22).
- **Numerical QA, live path** (`evidence/live-qa-report.json`, full-clip causal replay): PASS. Solve cost is 4.4 ms mean and 9.3 ms p95 per frame.
- **Before/after**: see the table in the README. The original solver fails 6 check classes on the same clip.
- **Browser E2E** (`npm run e2e`): PASS on the production build.
  - Offline engine: avatar pose equals the motion file at the presented media time, with 0° error at 3 seek points.
  - Live engine: in-browser Holistic, world landmarks received.
  - Fake-camera mode tracks a real signing clip.
  - Upload mode works.
  - No page errors.
- **Visual evidence** in `evidence/video/` and `evidence/sheets/`:
  - full-length source | before | after (offline) | after (live) side-by-side;
  - full-length right-hand close-ups (source crop | before | after);
  - contact sheets every 4 s over the whole clip;
  - a rule-selected review sheet: start/middle/end, fastest motion, fast fingers, fist, pointing, open hand, pinch, hand at face, crossed hands, entering/leaving frame, low confidence, left hand.

## Limitations

These are the same limits listed in the README.

- Monocular, 368×368 source. Finger depth and occlusions are inferred, not observed.
- Palm/back ambiguity is resolved by temporal continuity only.
- The left hand is out of frame for most of the clip, so a relaxed fallback is shown.
- Proportions are mapped heuristically, with no contact solver.
- Facial markers are restrained (bones only).
- The calibration constants come from this clip.
- **No linguistic validation.** The clip's sign language is unidentified. A fluent Deaf signer must review before any use as signing.

## Run commands

```bash
npm install && npm test && npm run build
npm run motion:all                    # clean → solve → QA → export (raw cache already included)
npm run motion:extract                # (optional) re-extract landmarks; needs pipeline/requirements.txt in a Python 3.9-3.12 venv
npm run motion:live-replay && npm run motion:qa -- --motion evidence/live-motion.json.gz --out evidence/live-qa-report.json
npm run dev                            # app; sample clip plays the precomputed motion by default
```
