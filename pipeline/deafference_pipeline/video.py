"""Video probing and exact-timestamp frame decoding.

OpenCV's ``CAP_PROP_POS_MSEC`` is unreliable for variable-frame-rate files, so
frames are decoded through an ffmpeg pipe with ``-fps_mode passthrough`` (no
frame is dropped or duplicated) and paired with presentation timestamps read by
ffprobe. The two enumerations are cross-checked before any inference runs.
"""

from __future__ import annotations

import hashlib
import json
import shutil
import subprocess
from dataclasses import dataclass, field
from fractions import Fraction
from pathlib import Path
from typing import Iterator

import numpy as np


class VideoError(RuntimeError):
    pass


def _require(binary: str) -> str:
    path = shutil.which(binary)
    if not path:
        raise VideoError(f"'{binary}' was not found on PATH. Install ffmpeg (includes ffprobe).")
    return path


def sha256_file(path: Path, chunk: int = 1 << 20) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while True:
            block = handle.read(chunk)
            if not block:
                break
            digest.update(block)
    return digest.hexdigest()


@dataclass
class VideoProbe:
    path: Path
    width: int
    height: int
    codec: str
    pix_fmt: str
    time_base: str
    r_frame_rate: str
    avg_frame_rate: str
    duration_sec: float
    rotation: int
    color: dict
    pts: list[int] = field(repr=False)
    pts_sec: list[float] = field(repr=False)
    key_frames: list[int] = field(repr=False)

    @property
    def frame_count(self) -> int:
        return len(self.pts)

    def timing_report(self) -> dict:
        t = np.asarray(self.pts_sec, dtype=np.float64)
        d = np.diff(t)
        nominal = float(Fraction(self.r_frame_rate)) if self.r_frame_rate not in ("0/0", "") else 0.0
        nominal_dt = 1.0 / nominal if nominal > 0 else float(np.median(d))
        gaps = np.where(d > nominal_dt * 1.5)[0]
        return {
            "frameCount": int(len(t)),
            "firstPtsSec": float(t[0]) if len(t) else None,
            "lastPtsSec": float(t[-1]) if len(t) else None,
            "nominalFps": nominal,
            "averageFps": float((len(t) - 1) / (t[-1] - t[0])) if len(t) > 1 else None,
            "monotonic": bool(np.all(d > 0)),
            "duplicateTimestamps": int(np.sum(d == 0)),
            "minDeltaMs": float(d.min() * 1000) if len(d) else None,
            "maxDeltaMs": float(d.max() * 1000) if len(d) else None,
            "variableFrameRate": bool(len(d) and (d.max() - d.min()) > 0.002),
            "droppedFrameGaps": [
                {"afterFrame": int(i), "atSec": round(float(t[i]), 4), "gapMs": round(float(d[i] * 1000), 2)}
                for i in gaps
            ],
            "keyFrames": len(self.key_frames),
        }


def probe_video(path: Path) -> VideoProbe:
    ffprobe = _require("ffprobe")
    if not path.is_file():
        raise VideoError(f"Video not found: {path}")

    stream_cmd = [
        ffprobe, "-v", "error", "-select_streams", "v:0", "-print_format", "json",
        "-show_streams", "-show_format", str(path),
    ]
    info = json.loads(subprocess.run(stream_cmd, capture_output=True, check=True, text=True).stdout)
    if not info.get("streams"):
        raise VideoError(f"No video stream in {path}")
    stream = info["streams"][0]

    rotation = 0
    for side in stream.get("side_data_list", []) or []:
        if "rotation" in side:
            rotation = int(side["rotation"])
    if "rotate" in (stream.get("tags") or {}):
        rotation = int(stream["tags"]["rotate"])

    frame_cmd = [
        ffprobe, "-v", "error", "-select_streams", "v:0", "-show_entries",
        "frame=pts,best_effort_timestamp,key_frame", "-print_format", "json", str(path),
    ]
    frames = json.loads(subprocess.run(frame_cmd, capture_output=True, check=True, text=True).stdout)["frames"]
    time_base = Fraction(stream["time_base"])
    pts: list[int] = []
    keys: list[int] = []
    for index, frame in enumerate(frames):
        value = frame.get("pts", frame.get("best_effort_timestamp"))
        if value is None:
            raise VideoError(f"Frame {index} has no timestamp")
        pts.append(int(value))
        if int(frame.get("key_frame", 0)):
            keys.append(index)
    order = np.argsort(np.asarray(pts), kind="stable")
    if not np.array_equal(order, np.arange(len(pts))):
        raise VideoError("Decoded frame order is not presentation order; refusing to guess a mapping.")

    duration = float(stream.get("duration") or info.get("format", {}).get("duration") or 0.0)
    return VideoProbe(
        path=path,
        width=int(stream["width"]),
        height=int(stream["height"]),
        codec=str(stream.get("codec_name")),
        pix_fmt=str(stream.get("pix_fmt")),
        time_base=str(stream["time_base"]),
        r_frame_rate=str(stream.get("r_frame_rate")),
        avg_frame_rate=str(stream.get("avg_frame_rate")),
        duration_sec=duration,
        rotation=rotation,
        color={
            key: stream.get(key)
            for key in ("color_range", "color_space", "color_transfer", "color_primaries")
        },
        pts=pts,
        pts_sec=[float(value * time_base) for value in pts],
        key_frames=keys,
    )


def iter_rgb_frames(probe: VideoProbe, start: int = 0, stop: int | None = None) -> Iterator[tuple[int, np.ndarray]]:
    """Yield ``(frame_index, rgb_uint8[h, w, 3])`` in presentation order.

    Decoding always starts from the beginning of the file so frame indices can
    never drift from the ffprobe enumeration (seeking in long-GOP H.264 is not
    frame exact). Frames before ``start`` are decoded and discarded.
    """
    ffmpeg = _require("ffmpeg")
    if probe.rotation not in (0, 360, -360):
        # ffmpeg auto-rotates on decode; width/height would swap. Keep explicit.
        raise VideoError(f"Rotated video ({probe.rotation} deg) is not supported without normalization.")
    stop = probe.frame_count if stop is None else min(stop, probe.frame_count)
    cmd = [
        ffmpeg, "-v", "error", "-nostdin", "-i", str(probe.path),
        "-map", "0:v:0", "-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", "rgb24", "-",
    ]
    frame_bytes = probe.width * probe.height * 3
    process = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    assert process.stdout is not None
    index = 0
    try:
        while index < stop:
            buffer = process.stdout.read(frame_bytes)
            if len(buffer) < frame_bytes:
                break
            if index >= start:
                yield index, np.frombuffer(buffer, dtype=np.uint8).reshape(probe.height, probe.width, 3)
            index += 1
    finally:
        process.stdout.close()
        process.kill()
        process.wait()
    if index < stop:
        raise VideoError(f"ffmpeg produced {index} frames but ffprobe enumerated {probe.frame_count}")
