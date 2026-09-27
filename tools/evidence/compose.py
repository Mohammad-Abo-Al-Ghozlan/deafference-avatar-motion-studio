#!/usr/bin/env python3
"""Compose evidence images: source frame | avatar render(s), tiled into sheets.

    python tools/evidence/compose.py --video public/samples/qassem-story.mp4 \
        --frames 150,420 --columns avatar=.scratch/stills --out evidence/sheet.jpg

Each --columns entry is label=directory containing frame-XXXXX.jpg renders.
Source frames are decoded by index from the constant-frame-rate playback
video, i.e. exactly what the player shows at t = k / 30.
"""
import argparse
import subprocess
import sys
from pathlib import Path

import cv2
import numpy as np


def decode_frames(video: Path, wanted: set[int]) -> dict[int, np.ndarray]:
    probe = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height",
                            "-of", "csv=p=0", str(video)], capture_output=True, text=True, check=True).stdout.strip().split(",")
    width, height = int(probe[0]), int(probe[1])
    process = subprocess.Popen(["ffmpeg", "-v", "error", "-i", str(video), "-fps_mode", "passthrough", "-f", "rawvideo",
                                "-pix_fmt", "bgr24", "-"], stdout=subprocess.PIPE)
    frames: dict[int, np.ndarray] = {}
    index = 0
    size = width * height * 3
    last = max(wanted)
    while index <= last:
        buffer = process.stdout.read(size)
        if len(buffer) < size:
            break
        if index in wanted:
            frames[index] = np.frombuffer(buffer, np.uint8).reshape(height, width, 3).copy()
        index += 1
    process.kill()
    return frames


def label(image: np.ndarray, text: str, scale: float = 0.55) -> np.ndarray:
    out = image.copy()
    cv2.rectangle(out, (0, 0), (out.shape[1], 24), (0, 0, 0), -1)
    cv2.putText(out, text, (6, 17), cv2.FONT_HERSHEY_SIMPLEX, scale, (255, 255, 255), 1, cv2.LINE_AA)
    return out


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--video", required=True, type=Path)
    parser.add_argument("--frames", required=True)
    parser.add_argument("--columns", nargs="+", default=[], help="label=dir")
    parser.add_argument("--size", type=int, default=400)
    parser.add_argument("--per-row", type=int, default=2, help="frame groups per row")
    parser.add_argument("--fps", type=float, default=30.0)
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args()
    frames = [int(v) for v in args.frames.split(",") if v.strip()]
    source = decode_frames(args.video, set(frames))
    columns = [tuple(c.split("=", 1)) for c in args.columns]
    groups = []
    for k in frames:
        if k not in source:
            print(f"frame {k} not in video", file=sys.stderr)
            continue
        t = k / args.fps
        stamp = f"{int(t // 60)}:{t % 60:05.2f}"
        cells = [label(cv2.resize(source[k], (args.size, args.size), interpolation=cv2.INTER_CUBIC), f"source  k={k}  t={stamp}")]
        for name, directory in columns:
            path = Path(directory) / f"frame-{k:05d}.jpg"
            image = cv2.imread(str(path))
            if image is None:
                image = np.zeros((args.size, args.size, 3), np.uint8)
            cells.append(label(cv2.resize(image, (args.size, args.size), interpolation=cv2.INTER_AREA), name))
        groups.append(np.hstack(cells))
    if not groups:
        return 1
    blank = np.zeros_like(groups[0])
    rows = []
    for i in range(0, len(groups), args.per_row):
        row = groups[i:i + args.per_row]
        row += [blank] * (args.per_row - len(row))
        rows.append(np.hstack(row))
    sheet = np.vstack(rows)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(args.out), sheet, [cv2.IMWRITE_JPEG_QUALITY, 88])
    print(f"wrote {args.out} {sheet.shape[1]}x{sheet.shape[0]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
