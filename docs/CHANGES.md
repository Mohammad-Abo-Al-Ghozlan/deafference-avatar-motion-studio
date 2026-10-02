# Changes vs. baseline (commit 1d50650, the project as uploaded)

Branch `motion-engine-v2`. This list covers the motion engine v2 work up to `95584fe`. Later work, such as the Sign clips tab, is described in the README and in `git log 95584fe..`.

Commits (newest first):

- bf3d672 Export test independent of generated artifacts; update instructions
- 927b67f evidence: index of visual/numerical evidence
- e7c5c2e docs: change list and code patch vs baseline
- b21e0a7 Engineering summary: dependency changes
- 6d7fe6a Bump vite 7.0.6 -> 7.3.6 (dev-server security fixes)
- 324134b Refresh E2E and QA reports from the clean-install verification run
- 028593b Evidence review selection, tsx 4.23.15
- 0e0a9f2 Motion engine v2: anatomical hand/arm solver, offline pipeline, causal live mode
- (this file) docs: refresh change list

Code diff (text files only): `docs/changes-vs-baseline.patch`. Generated data and binary assets are listed below but not diffed.

## Files (A added, M modified, D deleted, R renamed)

```
A	.gitignore
M	README.md
A	docs/APPLY_UPDATE.md
A	docs/CHANGES.md
A	docs/ENGINEERING_SUMMARY.md
A	docs/changes-vs-baseline.patch
A	evidence/README_EVIDENCE.md
A	evidence/e2e/e2e-report.json
A	evidence/inputs/raw-landmarks.live-smoothed.json.gz
A	evidence/legacy-motion.json.gz
A	evidence/live-motion-15fps.json.gz
A	evidence/live-motion-15fps.timing.json
A	evidence/live-motion.json.gz
A	evidence/live-motion.timing.json
A	evidence/live-qa-report-15fps.json
A	evidence/live-qa-report-15fps.md
A	evidence/live-qa-report.json
A	evidence/live-qa-report.md
A	media/source/qassem-story.original.mp4
A	motion/qassem-story/avatar-motion.json.gz
A	motion/qassem-story/clean-landmarks.json.gz
A	motion/qassem-story/processing-report.json
A	motion/qassem-story/qa-report.json
A	motion/qassem-story/qa-report.md
A	motion/qassem-story/qassem-story.animation.export-report.json
A	motion/qassem-story/raw-landmarks.json.gz
A	motion/rig-report.json
A	motion/rig-report.md
M	package-lock.json
M	package.json
A	pipeline/deafference_pipeline/__init__.py
A	pipeline/deafference_pipeline/extract.py
A	pipeline/deafference_pipeline/face_subset.py
A	pipeline/deafference_pipeline/holistic.py
A	pipeline/deafference_pipeline/video.py
A	pipeline/extract_landmarks.py
A	pipeline/requirements.txt
A	public/motion/qassem-story/avatar-motion.json.gz
M	src/App.vue
M	src/components/AvatarStage.vue
M	src/composables/useHolisticTracker.ts
A	src/motion/clip/MotionClip.ts
A	src/motion/clip/format.ts
A	src/motion/filters/offline.ts
A	src/motion/filters/online.ts
A	src/motion/live/LiveBodyTracker.ts
A	src/motion/live/LiveFaceTracker.ts
A	src/motion/live/LiveHandTracker.ts
A	src/motion/live/LiveMotionPipeline.ts
A	src/motion/live/defaults.ts
A	src/motion/math.ts
A	src/motion/qa/metrics.ts
A	src/motion/retarget/AvatarSolver.ts
A	src/motion/retarget/PoseApplier.ts
A	src/motion/retarget/PoseState.ts
A	src/motion/retarget/types.ts
A	src/motion/rig/Rig.ts
A	src/motion/rig/rigGeometry.ts
A	src/motion/rig/semanticMap.ts
A	src/motion/solver/lm.ts
A	src/motion/source/bodyFeatures.ts
A	src/motion/source/faceFeatures.ts
A	src/motion/source/handCalibration.ts
A	src/motion/source/handIdentity.ts
A	src/motion/source/handModel.ts
A	src/motion/source/handParams.ts
A	src/motion/source/landmarks.ts
M	src/styles.css
M	src/types/tracking.ts
A	tests/filters.test.ts
A	tests/glbExport.test.ts
A	tests/handModel.test.ts
A	tests/helpers.ts
A	tests/live.test.ts
A	tests/math.test.ts
A	tests/motion.test.ts
A	tests/rig.test.ts
A	tests/solver.test.ts
A	tests/timeline.test.ts
A	tools/clean-landmarks.ts
A	tools/e2e/app-smoke.ts
A	tools/evidence/compose.py
A	tools/evidence/compose_videos.py
A	tools/evidence/handcrops.py
A	tools/evidence/harness.html
A	tools/evidence/harness.ts
R099	src/lib/AvatarRetargeter.ts	tools/evidence/legacy/AvatarRetargeter.legacy.ts
A	tools/evidence/record.ts
A	tools/evidence/source_crops.py
A	tools/export-glb.ts
A	tools/legacy-motion.ts
A	tools/lib/cleanBody.ts
A	tools/lib/cleanFace.ts
A	tools/lib/cleanFile.ts
A	tools/lib/cleanHands.ts
A	tools/lib/cli.ts
A	tools/lib/gltfRig.ts
A	tools/lib/raw.ts
A	tools/lib/threeRig.ts
A	tools/lib/timeline.ts
A	tools/live-replay.ts
A	tools/rig-report.ts
A	tools/solve-motion.ts
A	tools/types/gltf-validator.d.ts
A	tools/validate-motion.ts
A	tsconfig.node.json
```

## Diffstat

```
 106 files changed, 44196 insertions(+), 194 deletions(-)
```
