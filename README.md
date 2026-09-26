# Deafference Avatar Motion Studio

A privacy-first Vue/Three.js prototype that transfers motion from an ASL video or live camera onto a rigged 3D character in the browser.

## Run

```bash
npm install
npm run dev
```

Production check:

```bash
npm run build
npm run preview
```

## What works

- Built-in 3:13 `Qassem's Story` signing reference clip
- Local video upload (MP4, WebM, or browser-supported MOV)
- Live webcam input
- On-device MediaPipe Holistic inference with locally bundled model assets
- Geometric retargeting for torso, head, shoulders, upper arms, forearms, wrists, and 30 finger bones
- Anatomical finger retargeting with fixed local flexion axes, bounded MCP spread, PIP/DIP coupling, depth damping, scalar velocity limits, and brief occlusion hold
- Bone-driven jaw, mouth-corner, eyebrow, and left/right eyelid motion
- Source-identity protection mode with landmark-only presentation
- Playback, seek, speed, smoothing, and motion-strength controls
- Responsive desktop and mobile UI

## Pipeline

```text
Video / camera frame
  → MediaPipe Holistic landmarks
  → normalized body and palm directions plus scalar finger curls
  → wrist quaternion solving and local anatomical finger hinges
  → temporal smoothing and stale-landmark recovery
  → Three.js skinned-mesh rendering
```

All inference happens in the browser. This project does not upload camera or video frames to a server.

## Supplied avatar integration

`public/models/deafference-avatar.glb` is the exact uploaded character asset. It contains one skinned mesh and an 88-joint custom Blender skeleton. `src/lib/AvatarRetargeter.ts` maps the rig's `hip`, `spine_*`, `upperarm_*`, `lowerarm_*`, `hand_*`, and individual finger-joint names to semantic solver channels. The same layer also drives the model's jaw, eyelids, eyebrows, and mouth-corner bones; the GLB does not contain morph targets.

The bundled source under `public/samples/qassem-story.mp4` preserves the uploaded video's full 3:13 timeline and 368×368 image frames. Its audio was removed because the local tracker consumes video frames only.

## Accuracy boundary

This is **motion retargeting**, not speech-to-ASL translation and not linguistic generation. It reproduces a performance already present in a clip. Single-camera MediaPipe tracking cannot recover perfectly occluded fingers, motion outside the crop, or true motion-capture depth, so mathematically literal motion is not possible from this source alone. Every sign animation still requires review by a fluent Deaf signer before release.

For production-grade fidelity, use multi-view capture or hand/body mocap, preserve facial non-manual markers, calibrate the final rig, and export reviewed animation clips instead of treating raw live tracking as the final dataset.
