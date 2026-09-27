"""Chunked, resumable, deterministic landmark extraction.

Determinism across resumes: the video is always split into fixed chunks and
every chunk gets a fresh Holistic session that is warmed up on the preceding
``warmup_frames`` frames (their outputs are discarded). A resumed run therefore
produces byte-identical chunks to an uninterrupted run.
"""

from __future__ import annotations

import gzip
import hashlib
import json
import logging
import time
from dataclasses import asdict, dataclass
from pathlib import Path

import numpy as np

from . import RAW_SCHEMA, RAW_SCHEMA_VERSION
from .face_subset import FACE_SUBSET
from .holistic import HolisticConfig, HolisticRunner, mediapipe_version, model_checksums
from .video import VideoProbe, iter_rgb_frames, sha256_file

log = logging.getLogger("extract")


@dataclass(frozen=True)
class ChunkPlan:
    chunk_size: int = 600
    warmup_frames: int = 45


def _round(values: np.ndarray | None, decimals: int) -> list[float] | None:
    if values is None:
        return None
    return np.round(values, decimals).reshape(-1).tolist()


def _config_digest(payload: dict) -> str:
    return hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()[:16]


def _encode_frame(index: int, probe: VideoProbe, result: dict) -> dict:
    face = result["face"]
    face_subset = face[FACE_SUBSET] if face is not None and face.shape[0] >= 478 else None
    return {
        "i": index,
        "pts": probe.pts[index],
        "t": round(probe.pts_sec[index], 6),
        "pose": _round(result["pose"], 5),
        "poseWorld": _round(result["poseWorld"], 5),
        "leftHand": _round(result["leftHand"], 5),
        "rightHand": _round(result["rightHand"], 5),
        "face": _round(face_subset, 5),
    }


def _write_json_gz(path: Path, payload: dict) -> None:
    # mtime=0 keeps the gzip header byte-deterministic across reruns.
    tmp = path.with_suffix(path.suffix + ".tmp")
    data = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    with tmp.open("wb") as raw, gzip.GzipFile(fileobj=raw, mode="wb", compresslevel=9, mtime=0) as handle:
        handle.write(data)
    tmp.replace(path)


def _read_json_gz(path: Path) -> dict:
    with gzip.open(path, "rt", encoding="utf-8") as handle:
        return json.load(handle)


def extract(
    probe: VideoProbe,
    out_path: Path,
    work_dir: Path,
    clip_id: str,
    source_label: str,
    tracker: HolisticConfig = HolisticConfig(),
    plan: ChunkPlan = ChunkPlan(),
    max_frames: int | None = None,
) -> dict:
    total = probe.frame_count if max_frames is None else min(max_frames, probe.frame_count)
    if total <= 0:
        raise ValueError("Nothing to process: the video has no frames.")

    video_sha = sha256_file(probe.path)
    digest = _config_digest({
        "video": video_sha,
        "tracker": tracker.as_dict(),
        "plan": asdict(plan),
        "mediapipe": mediapipe_version(),
        "faceSubset": FACE_SUBSET,
        "schema": RAW_SCHEMA_VERSION,
    })
    work_dir.mkdir(parents=True, exist_ok=True)

    chunks = [(start, min(start + plan.chunk_size, total)) for start in range(0, total, plan.chunk_size)]
    chunk_paths = [work_dir / f"chunk-{k:04d}-{digest}.json.gz" for k in range(len(chunks))]
    pending = {k for k, path in enumerate(chunk_paths) if not path.exists()}
    log.info("video=%s frames=%d chunks=%d pending=%d digest=%s", probe.path.name, total, len(chunks), len(pending), digest)

    started = time.time()
    inference_seconds = 0.0
    if pending:
        first_needed = min(max(0, chunks[k][0] - plan.warmup_frames) for k in pending)
        last_needed = max(chunks[k][1] for k in pending)
        runners: dict[int, HolisticRunner] = {}
        buffers: dict[int, list[dict]] = {}
        for index, rgb in iter_rgb_frames(probe, start=first_needed, stop=last_needed):
            for k in sorted(pending):
                start, stop = chunks[k]
                if index == max(0, start - plan.warmup_frames) and k not in runners:
                    runners[k] = HolisticRunner(tracker)
                    buffers[k] = []
            for k, runner in list(runners.items()):
                start, stop = chunks[k]
                tick = time.time()
                result = runner.process(rgb)
                inference_seconds += time.time() - tick
                if index >= start:
                    buffers[k].append(_encode_frame(index, probe, result))
                if index == stop - 1:
                    runner.close()
                    del runners[k]
                    _write_json_gz(chunk_paths[k], {"digest": digest, "start": start, "stop": stop, "frames": buffers.pop(k)})
                    pending.discard(k)
                    log.info("chunk %d/%d done (frames %d-%d)", k + 1, len(chunks), start, stop - 1)
        for runner in runners.values():
            runner.close()
        if pending:
            raise RuntimeError(f"Decoding ended before chunks {sorted(pending)} completed")

    frames: list[dict] = []
    for k, path in enumerate(chunk_paths):
        chunk = _read_json_gz(path)
        if chunk.get("digest") != digest or chunk["start"] != chunks[k][0] or chunk["stop"] != chunks[k][1]:
            raise RuntimeError(f"Stale or foreign chunk file {path.name}; delete {work_dir} and rerun")
        frames.extend(chunk["frames"])

    indices = [frame["i"] for frame in frames]
    if indices != list(range(total)):
        raise RuntimeError("Frame indices are not contiguous after merging chunks")

    stats = _detection_stats(frames)
    payload = {
        "schema": RAW_SCHEMA,
        "schemaVersion": RAW_SCHEMA_VERSION,
        "clipId": clip_id,
        "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "source": {
            "file": source_label,
            "sha256": video_sha,
            "width": probe.width,
            "height": probe.height,
            "codec": probe.codec,
            "pixFmt": probe.pix_fmt,
            "timeBase": probe.time_base,
            "rFrameRate": probe.r_frame_rate,
            "avgFrameRate": probe.avg_frame_rate,
            "durationSec": probe.duration_sec,
            "rotation": probe.rotation,
            "color": probe.color,
            "timing": probe.timing_report(),
            "framesProcessed": total,
        },
        "tracker": {
            "name": "mediapipe.solutions.holistic",
            "browserEquivalent": "@mediapipe/holistic (public/mediapipe)",
            "mediapipeVersion": mediapipe_version(),
            "config": tracker.as_dict(),
            "modelMd5": model_checksums(tracker.model_complexity),
            "chunking": asdict(plan),
            "configDigest": digest,
        },
        "layout": {
            "pose": "33 x [x, y, z, visibility, presence]; x,y normalized to image width/height, z same scale as x (relative to hips)",
            "poseWorld": "33 x [x, y, z] metres, hip-centred, y down",
            "leftHand": "21 x [x, y, z]; subject's LEFT hand (anatomical); z relative to wrist, ~x scale",
            "rightHand": "21 x [x, y, z]; subject's RIGHT hand (anatomical)",
            "face": "len(faceIndices) x [x, y, z]; subset of the 478-point refined face mesh",
            "faceIndices": FACE_SUBSET,
            "coordinates": "image space: +x right, +y down, smaller z = closer to camera",
            "missing": "null means the tracker produced no (finite) result for that stream on that frame",
        },
        "stats": stats,
        "processing": {
            "wallSeconds": round(time.time() - started, 2),
            "inferenceSeconds": round(inference_seconds, 2),
        },
        "frames": frames,
    }
    out_path.parent.mkdir(parents=True, exist_ok=True)
    _write_json_gz(out_path, payload)
    return payload


def _detection_stats(frames: list[dict]) -> dict:
    total = len(frames)
    out: dict = {"frames": total}
    for key in ("pose", "poseWorld", "leftHand", "rightHand", "face"):
        present = np.array([frame[key] is not None for frame in frames], dtype=bool)
        runs = _missing_runs(present)
        out[key] = {
            "detected": int(present.sum()),
            "detectedRatio": round(float(present.mean()), 4) if total else 0.0,
            "missingIntervals": len(runs),
            "longestMissingFrames": max((b - a for a, b in runs), default=0),
        }
    return out


def _missing_runs(present: np.ndarray) -> list[tuple[int, int]]:
    runs = []
    start = None
    for index, value in enumerate(present):
        if not value and start is None:
            start = index
        elif value and start is not None:
            runs.append((start, index))
            start = None
    if start is not None:
        runs.append((start, len(present)))
    return runs
