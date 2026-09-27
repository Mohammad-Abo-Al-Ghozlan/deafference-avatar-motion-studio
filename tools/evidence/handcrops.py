#!/usr/bin/env python3
"""Crop the signer's hand from the playback video for close-up comparisons.

    python tools/evidence/handcrops.py --video public/samples/qassem-story.mp4 \
        --clean motion/qassem-story/clean-landmarks.json.gz --side right \
        --frames 150,420 --out-dir .scratch/crops-right [--overlay]

Crops are centred on the cleaned hand landmarks (falls back to the pose wrist
when the hand is not tracked). With --overlay the raw (red) and cleaned
(green) hand skeletons are drawn, for landmark-cleaning QA.
"""
import argparse
import gzip
import json
import sys
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from compose import decode_frames  # noqa: E402

BONES = [(0, 1), (1, 2), (2, 3), (3, 4), (0, 5), (5, 6), (6, 7), (7, 8), (5, 9), (9, 10), (10, 11), (11, 12),
         (9, 13), (13, 14), (14, 15), (15, 16), (13, 17), (0, 17), (17, 18), (18, 19), (19, 20)]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--video", required=True, type=Path)
    parser.add_argument("--clean", required=True, type=Path)
    parser.add_argument("--raw", type=Path, default=None)
    parser.add_argument("--side", choices=("left", "right"), default="right")
    parser.add_argument("--frames", required=True)
    parser.add_argument("--size", type=int, default=360)
    parser.add_argument("--out-dir", required=True, type=Path)
    parser.add_argument("--overlay", action="store_true")
    args = parser.parse_args()
    clean = json.load(gzip.open(args.clean, "rt"))
    raw = json.load(gzip.open(args.raw, "rt")) if args.raw else None
    frames = [int(v) for v in args.frames.split(",") if v.strip()]
    video = decode_frames(args.video, set(frames))
    args.out_dir.mkdir(parents=True, exist_ok=True)
    key = "rightHand" if args.side == "right" else "leftHand"
    for k in frames:
        image = video.get(k)
        if image is None:
            continue
        h, w = image.shape[:2]
        slot = clean["frames"][k]
        lm = slot["hands"][args.side]["landmarks"]
        if lm:
            pts = np.array(lm, dtype=float).reshape(21, 3)[:, :2] * [w, h]
            center = pts.mean(axis=0)
            extent = max(np.ptp(pts[:, 0]), np.ptp(pts[:, 1]))
        else:
            center = np.array([w * 0.5, h * 0.7])
            extent = w * 0.25
        half = max(extent * 0.75, w * 0.12)
        x0, y0 = int(center[0] - half), int(center[1] - half)
        size = int(2 * half)
        canvas = np.zeros((size, size, 3), np.uint8)
        sx0, sy0 = max(0, x0), max(0, y0)
        sx1, sy1 = min(w, x0 + size), min(h, y0 + size)
        if sx1 > sx0 and sy1 > sy0:
            canvas[sy0 - y0:sy1 - y0, sx0 - x0:sx1 - x0] = image[sy0:sy1, sx0:sx1]
        scale = args.size / size
        crop = cv2.resize(canvas, (args.size, args.size), interpolation=cv2.INTER_CUBIC)
        if args.overlay:
            layers = []
            if raw is not None and slot["source"] is not None:
                raw_hand = raw["frames"][slot["source"]][key]
                if raw_hand:
                    layers.append((np.array(raw_hand).reshape(21, 3)[:, :2] * [w, h], (0, 0, 255)))
            if lm:
                layers.append((np.array(lm).reshape(21, 3)[:, :2] * [w, h], (0, 255, 0)))
            for points, color in layers:
                p = [(int((x - x0) * scale), int((y - y0) * scale)) for x, y in points]
                for a, b in BONES:
                    cv2.line(crop, p[a], p[b], color, 1, cv2.LINE_AA)
        state = slot["hands"][args.side]["state"]
        cv2.putText(crop, state, (6, args.size - 8), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 0), 1, cv2.LINE_AA)
        cv2.imwrite(str(args.out_dir / f"frame-{k:05d}.jpg"), crop, [cv2.IMWRITE_JPEG_QUALITY, 90])
    print(f"wrote {len(frames)} crops to {args.out_dir}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
