#!/usr/bin/env python3
"""Render a hand close-up video of the SOURCE signer, frame-exact with the grid.

    python3 tools/evidence/source_crops.py --video public/samples/qassem-story.mp4 \
        --clean motion/qassem-story/clean-landmarks.json.gz --side right \
        --out evidence/video/source-right-hand.mp4

Frame k of the output is frame k of the constant-frame-rate playback video
(t = k / 30), cropped around the signer's hand. The crop centre follows the
cleaned hand landmarks (held while the hand is not tracked) and is smoothed
with a zero-phase moving average so the framing does not jitter; the crop
size is constant (derived from the median hand extent) so hand scale is
comparable across the clip. Read-only with respect to the source video.
"""
import argparse
import gzip
import json
import subprocess
from pathlib import Path

import cv2
import numpy as np


def probe_size(video: Path) -> tuple[int, int]:
    out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height",
                          "-of", "csv=p=0", str(video)], capture_output=True, text=True, check=True).stdout.strip().split(",")
    return int(out[0]), int(out[1])


def smooth(values: np.ndarray, window: int) -> np.ndarray:
    """Zero-phase moving average (symmetric window, edge-padded)."""
    if window <= 1:
        return values
    pad = window // 2
    padded = np.pad(values, ((pad, pad), (0, 0)), mode="edge")
    kernel = np.ones(window) / window
    return np.stack([np.convolve(padded[:, c], kernel, mode="valid") for c in range(values.shape[1])], axis=1)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--video", required=True, type=Path)
    parser.add_argument("--clean", required=True, type=Path)
    parser.add_argument("--side", choices=("left", "right"), default="right")
    parser.add_argument("--size", type=int, default=360)
    parser.add_argument("--fps", type=float, default=30.0)
    parser.add_argument("--smooth", type=int, default=7, help="centre smoothing window (frames)")
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args()

    clean = json.load(gzip.open(args.clean, "rt"))
    frames = clean["frames"]
    width, height = probe_size(args.video)
    n = len(frames)

    centres = np.zeros((n, 2))
    extents = []
    last = np.array([width * (0.3 if args.side == "right" else 0.7), height * 0.7])
    tracked = np.zeros(n, dtype=bool)
    for k, frame in enumerate(frames):
        lm = frame["hands"][args.side]["landmarks"]
        if lm:
            pts = np.array(lm, dtype=float).reshape(21, 3)[:, :2] * [width, height]
            last = pts.mean(axis=0)
            extents.append(max(np.ptp(pts[:, 0]), np.ptp(pts[:, 1])))
            tracked[k] = True
        centres[k] = last
    centres = smooth(centres, args.smooth)
    half = max(float(np.median(extents)) * 0.95 if extents else width * 0.2, width * 0.12)

    args.out.parent.mkdir(parents=True, exist_ok=True)
    decoder = subprocess.Popen(["ffmpeg", "-v", "error", "-i", str(args.video), "-fps_mode", "passthrough", "-f", "rawvideo",
                                "-pix_fmt", "bgr24", "-"], stdout=subprocess.PIPE)
    encoder = subprocess.Popen(["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{args.size}x{args.size}",
                                "-framerate", str(args.fps), "-i", "-", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
                                "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(args.out)], stdin=subprocess.PIPE)
    frame_bytes = width * height * 3
    padding = int(half) + 2
    for k in range(n):
        buffer = decoder.stdout.read(frame_bytes)
        if len(buffer) < frame_bytes:
            break
        image = np.frombuffer(buffer, np.uint8).reshape(height, width, 3)
        padded = cv2.copyMakeBorder(image, padding, padding, padding, padding, cv2.BORDER_CONSTANT, value=(12, 18, 20))
        # Landmarks can be extrapolated far outside the frame: keep the crop
        # window overlapping the image (it then shows the border region).
        cx = float(np.clip(centres[k][0], 0, width)) + padding
        cy = float(np.clip(centres[k][1], 0, height)) + padding
        x0, y0 = int(round(cx - half)), int(round(cy - half))
        crop = padded[y0:y0 + int(2 * half), x0:x0 + int(2 * half)]
        crop = cv2.resize(crop, (args.size, args.size), interpolation=cv2.INTER_CUBIC)
        if not tracked[k]:
            cv2.putText(crop, "hand not tracked", (8, args.size - 10), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (80, 180, 255), 1, cv2.LINE_AA)
        encoder.stdin.write(crop.tobytes())
    decoder.kill()
    encoder.stdin.close()
    encoder.wait()
    print(f"wrote {args.out} ({n} frames, crop {2 * half:.0f}px)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
