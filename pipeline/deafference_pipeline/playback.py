"""Constant-frame-rate playback video built from the motion timeline.

The web player samples precomputed motion by the video's media time
(``requestVideoFrameCallback``), so frame ``k`` of the playback MP4 must show
exactly the decoded source frame that motion frame ``k`` was solved from. The
cleaning stage records that slot -> source-frame map in
``clean-landmarks.json.gz``; this module re-encodes the original video from
the map instead of letting a generic ``fps`` filter pick frames.

Frames are decoded and re-encoded as raw yuv420p, so no colour conversion
happens; only the H.264 re-encode itself is lossy.
"""

from __future__ import annotations

import gzip
import json
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterator

from .video import VideoError, VideoProbe, _require, sha256_file


@dataclass
class SlotPlan:
    fps: int
    sources: list[int]
    """Decoded source frame shown at each slot (filled slots use a neighbour)."""
    filled: list[dict] = field(default_factory=list)
    """Slots without their own source frame (dropped frames in a VFR source)."""


def load_clean_timeline(path: Path) -> dict:
    with gzip.open(path, "rt", encoding="utf-8") as handle:
        clean = json.load(handle)
    if clean.get("schema") != "deafference.clean-landmarks":
        raise VideoError(f"{path} is not a clean-landmarks file")
    return clean


def plan_slots(clean: dict) -> SlotPlan:
    """Map every grid slot to a decoded source frame.

    A slot with no source frame (a dropped frame in the VFR source) shows the
    neighbouring source frame closest in time; ties keep the earlier frame,
    which is what a player holding the last decoded frame would show.
    """
    fps = int(clean["timeline"]["fps"])
    frames = clean["frames"]
    n = len(frames)
    if n != int(clean["timeline"]["frameCount"]):
        raise VideoError("clean timeline frameCount does not match its frame list")
    sources: list[int | None] = [f["source"] for f in frames]
    times: list[float | None] = [f["sourceTime"] for f in frames]
    if sources[0] is None:
        raise VideoError("slot 0 has no source frame; the grid must start at the first decoded frame")
    plan = SlotPlan(fps=fps, sources=[0] * n)
    previous = None
    for k in range(n):
        if sources[k] is not None:
            if previous is not None and sources[k] <= previous:
                raise VideoError(f"slot {k}: source frames are not strictly increasing")
            plan.sources[k] = int(sources[k])
            previous = sources[k]
            continue
        before = next(j for j in range(k - 1, -1, -1) if sources[j] is not None)
        after = next((j for j in range(k + 1, n) if sources[j] is not None), None)
        t = k / fps
        use = before
        if after is not None and abs(times[after] - t) < abs(times[before] - t):
            use = after
        plan.sources[k] = int(sources[use])
        plan.filled.append({"slot": k, "timeSec": round(t, 5), "shows": int(sources[use]), "from": "next" if use == after else "previous"})
    return plan


def iter_yuv420p_frames(probe: VideoProbe) -> Iterator[tuple[int, bytes]]:
    """Yield ``(frame_index, yuv420p_bytes)`` in presentation order, frame exact."""
    ffmpeg = _require("ffmpeg")
    if probe.rotation not in (0, 360, -360):
        raise VideoError(f"Rotated video ({probe.rotation} deg) is not supported without normalization.")
    if probe.width % 2 or probe.height % 2:
        raise VideoError(f"yuv420p needs even dimensions, got {probe.width}x{probe.height}")
    cmd = [
        ffmpeg, "-v", "error", "-nostdin", "-i", str(probe.path),
        "-map", "0:v:0", "-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", "yuv420p", "-",
    ]
    frame_bytes = probe.width * probe.height * 3 // 2
    process = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    assert process.stdout is not None
    index = 0
    try:
        while True:
            buffer = process.stdout.read(frame_bytes)
            if len(buffer) < frame_bytes:
                break
            yield index, buffer
            index += 1
    finally:
        process.stdout.close()
        process.kill()
        process.wait()
    if index != probe.frame_count:
        raise VideoError(f"ffmpeg produced {index} frames but ffprobe enumerated {probe.frame_count}")


def encode_playback(probe: VideoProbe, plan: SlotPlan, out_path: Path, crf: int, preset: str) -> list[str]:
    """Encode one output frame per slot at a constant ``plan.fps``. Returns the encoder command."""
    ffmpeg = _require("ffmpeg")
    color = probe.color
    tags: list[str] = []
    for flag, key in (("-color_range", "color_range"), ("-colorspace", "color_space"),
                      ("-color_trc", "color_transfer"), ("-color_primaries", "color_primaries")):
        if color.get(key) and color[key] != "unknown":
            tags += [flag, str(color[key])]
    out_path.parent.mkdir(parents=True, exist_ok=True)
    tmp = out_path.with_name(out_path.stem + ".tmp" + out_path.suffix)
    cmd = [
        ffmpeg, "-v", "error", "-y", "-nostdin",
        "-f", "rawvideo", "-pix_fmt", "yuv420p", "-s", f"{probe.width}x{probe.height}",
        "-framerate", str(plan.fps), *tags, "-i", "-",
        "-an", "-c:v", "libx264", "-preset", preset, "-crf", str(crf), "-profile:v", "high",
        "-pix_fmt", "yuv420p", *tags, "-fps_mode", "cfr", "-r", str(plan.fps),
        "-movflags", "+faststart", "-map_metadata", "-1", str(tmp),
    ]
    encoder = subprocess.Popen(cmd, stdin=subprocess.PIPE, stderr=subprocess.PIPE)
    assert encoder.stdin is not None
    decoded = iter_yuv420p_frames(probe)
    current_index = -1
    current: bytes | None = None
    try:
        for wanted in plan.sources:
            while current_index < wanted:
                current_index, current = next(decoded)
            assert current is not None
            encoder.stdin.write(current)
        for _ in decoded:  # drain so the decoder's frame-count check runs
            pass
    finally:
        encoder.stdin.close()
    stderr = encoder.stderr.read().decode("utf-8", "replace") if encoder.stderr else ""
    if encoder.wait() != 0:
        tmp.unlink(missing_ok=True)
        raise VideoError(f"encoder failed: {stderr.strip()}")
    tmp.replace(out_path)
    return cmd


def verify_playback(path: Path, expected_frames: int, fps: int) -> dict:
    """ffprobe the encoded file: frame count, constant rate and exact k / fps timestamps."""
    ffprobe = _require("ffprobe")
    info = json.loads(subprocess.run([
        ffprobe, "-v", "error", "-select_streams", "v:0", "-show_entries",
        "stream=codec_name,profile,width,height,r_frame_rate,avg_frame_rate,nb_frames,pix_fmt,color_range,color_space",
        "-show_entries", "format=duration,bit_rate", "-print_format", "json", str(path),
    ], capture_output=True, check=True, text=True).stdout)
    frames = json.loads(subprocess.run([
        ffprobe, "-v", "error", "-select_streams", "v:0", "-show_entries", "frame=pts_time",
        "-print_format", "json", str(path),
    ], capture_output=True, check=True, text=True).stdout)["frames"]
    times = [float(f["pts_time"]) for f in frames]
    max_error = max(abs(t - k / fps) for k, t in enumerate(times)) if times else float("inf")
    stream = info["streams"][0]
    audio = json.loads(subprocess.run([
        ffprobe, "-v", "error", "-select_streams", "a", "-show_entries", "stream=index", "-print_format", "json", str(path),
    ], capture_output=True, check=True, text=True).stdout).get("streams", [])
    problems = []
    if len(times) != expected_frames:
        problems.append(f"{len(times)} decoded frames, expected {expected_frames}")
    if stream.get("avg_frame_rate") != f"{fps}/1" or stream.get("r_frame_rate") != f"{fps}/1":
        problems.append(f"frame rate {stream.get('r_frame_rate')} / {stream.get('avg_frame_rate')}, expected {fps}/1")
    if max_error > 0.5 / fps:
        problems.append(f"frame timestamps deviate from k/fps by up to {max_error * 1000:.2f} ms")
    if audio:
        problems.append("playback file unexpectedly carries audio")
    if problems:
        raise VideoError("playback verification failed: " + "; ".join(problems))
    return {
        "frames": len(times),
        "maxTimestampErrorMs": round(max_error * 1000, 3),
        "stream": stream,
        "format": info.get("format", {}),
        "sha256": sha256_file(path),
    }


def write_poster(video: Path, out_path: Path, frame: int) -> None:
    ffmpeg = _require("ffmpeg")
    out_path.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run([
        ffmpeg, "-v", "error", "-y", "-nostdin", "-i", str(video),
        "-vf", f"select=eq(n\\,{frame})", "-frames:v", "1", "-q:v", "4", str(out_path),
    ], check=True)
