# Applying motion engine v2 to your project folder

These archives contain every file that is new or changed relative to the project as you uploaded it. Your large assets are unchanged and are not included: `public/mediapipe/`, `public/models/deafference-avatar.glb`, `public/samples/`, `references/`, `PREVIEW.png`.

1. Extract `deafference-motion-v2-update.zip` over your project folder (the archive's top folder is `deafference-avatar-motion-studio/`). Allow it to overwrite files.
2. Extract `deafference-motion-v2-landmark-caches.zip` the same way. It adds:
   - `motion/qassem-story/raw-landmarks.json.gz`, the offline tracker cache;
   - `evidence/inputs/raw-landmarks.live-smoothed.json.gz`, the input for the before and live replays.
3. Delete `src/lib/AvatarRetargeter.ts`. It was replaced; an unchanged copy lives at `tools/evidence/legacy/AvatarRetargeter.legacy.ts`.
4. Copy your original video to `media/source/qassem-story.original.mp4`. This is only needed to re-run landmark extraction; it is never modified.
5. Run:

```bash
npm install
npm test               # 33 tests
npm run build
npm run motion:export  # rebuilds motion/qassem-story/qassem-story.animation.glb (original GLB + animation clip) in ~2 s
npm run dev
```

Expected hashes:

- avatar GLB: 18df37e0d48b7c7a619fbe1f356fa61186153b8ff2bbaefcba1f6fc0a77bece4
- original video: 08a276adf5c774ff531a81241805a0e987498b675e43d71460e08d1013c4d431

The motion files record these hashes, and `motion:export` refuses to bake onto a different GLB.
