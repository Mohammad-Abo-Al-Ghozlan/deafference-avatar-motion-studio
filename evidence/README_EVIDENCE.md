# Visual and numerical evidence: Qassem's Story (5,794 frames, 30 fps)

Every video is frame-exact: output frame *k* shows the pose at *t = k / 30* s of the source timeline. The source panel is the bundled constant-frame-rate playback copy; the original video was never modified.

| File | What it shows |
|---|---|
| `video/side-by-side-full.mp4` | Full clip, 4 panels: source (with frame/timecode) · original solver · offline pipeline · live causal pipeline |
| `video/right-hand-closeup-full.mp4` | Full clip, dominant (right) hand: source crop · original solver · offline pipeline |
| `video/before-legacy-full.mp4`, `video/after-offline-full.mp4`, `video/after-live-full.mp4` | Individual full-view renders (480 px) |
| `video/*-right-hand.mp4`, `video/source-right-hand.mp4` | Individual right-hand close-ups (360 px) |
| `sheets/contact-full-0*.jpg` | Contact sheets every 4 s across the whole clip (source · before · after offline · after live) |
| `sheets/contact-right-hand-0*.jpg` | Same frames, right-hand close-ups |
| `sheets/review-*.jpg`, `sheets/review-frames.json` | Frames picked by rule (not by hand), one or more per situation: start/middle/end, fast signing, fastest wrist motion, fast finger articulation, fist, pointing, open hand, pinch/circle, hand at the face, crossed hands, hand entering and leaving frame, low confidence, left hand |
| `e2e/*.png`, `e2e/e2e-report.json` | Browser end-to-end test of the production build: offline sync, live mode, fake camera, upload |
| `reports/qa-report.md` | Numerical QA of the delivered motion, with the before/after table |
| `reports/live-qa-report*.md` | Numerical QA of the causal live path, replayed at 30 fps and 15 fps |
| `reports/rig-report.md` | Programmatic rig inspection of the supplied GLB |

What to look at, honestly:

- **Where the offline pipeline is clearly better:**
  - fists, open hands, V-handshapes, pinches;
  - hand at the face (the contact location is preserved);
  - elbows that never bend sideways;
  - no fingers bending backwards;
  - no wrist snaps or teleports.
- **Where it is still weak, because the evidence is not in the video:**
  - Fists seen edge-on have self-occluded fingers. At the opening thumbs-up (k≈30) the tracker reports a half-extended index, and the avatar shows it.
  - Crossed and overlapping hands are unreliable (k≈760).
  - The left hand is out of frame most of the time and eases to a relaxed pose.
  - Very fast drops are motion-blurred.
- **Close-up framing:** the close-up camera follows the avatar's hand with light smoothing, so during the fastest movements the hand can briefly leave the close-up frame. That is framing, not pose.

None of this is linguistic validation. The sign language of the clip is unidentified, and a fluent Deaf signer must review any animation before it is presented as signing.

## Sign clips (`sign-clip-1`, 524 frames; `sign-clip-2`, 882 frames)

Same rules: frame *k* is *t = k / 30* s of the clip's constant-frame-rate playback video (`public/samples/<clip>.mp4`), which was itself verified frame by frame against the original.

| File | What it shows |
|---|---|
| `video/sign-clip-*-side-by-side.mp4` | Full clip: source (with frame number) · avatar (offline pipeline, source-like framing) |
| `video/sign-clip-*-right-hand-closeup.mp4` | Full clip, right hand: source crop · avatar |
| `video/sign-clip-*-after-offline-full.mp4`, `video/sign-clip-*-after-offline-right-hand.mp4`, `video/sign-clip-*-source-right-hand.mp4` | The individual renders used above |
| `e2e/clips-sign-clip-*.png`, `e2e/clips-tab.png` | The Sign clips tab in the production build (E2E run) |
| `../motion/sign-clip-*/qa-report.md` | Numerical QA (both PASS) |

Visual review of the close-ups: one-finger, V, L, bent/claw, flat-B and open handshapes, pointing, and hands at the face and chest follow the source. Tight fists render as loosely curled hands, an edge-on thumbs-up (clip 1, k≈360) reads as extended fingers, and a hand pointing straight at the camera (clip 1, k≈120) loses its depth. The left hand is lowered or out of view about half of each clip and is shown relaxed.

