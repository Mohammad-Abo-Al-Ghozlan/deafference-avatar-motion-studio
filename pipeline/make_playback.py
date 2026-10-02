#!/usr/bin/env python3
"""Build the constant-frame-rate playback MP4 and poster for a clip.

Run after the cleaning stage (it reads the slot -> source-frame map) and
before solving (the solver records the playback file's sha256):

    python pipeline/make_playback.py \
        --video media/source/sign-clip-1.original.mp4 \
        --clip-id sign-clip-1

Writes public/samples/<clip-id>.mp4, public/samples/<clip-id>-poster.jpg and
motion/<clip-id>/playback-report.json. Frame k of the MP4 is exactly the source
frame that motion frame k was solved from, so the player can sample motion by
media time without drift. Audio is not carried over: the player is muted and
the tracker uses video frames only (same as the bundled sample clip).
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(Path(__file__).resolve().parent))

from deafference_pipeline.playback import (  # noqa: E402
    encode_playback, load_clean_timeline, plan_slots, verify_playback, write_poster,
)
from deafference_pipeline.video import VideoError, probe_video, sha256_file  # noqa: E402


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--video", type=Path, required=True, help="Original source video (never modified)")
    parser.add_argument("--clip-id", required=True)
    parser.add_argument("--motion-dir", type=Path, default=REPO_ROOT / "motion")
    parser.add_argument("--out-dir", type=Path, default=REPO_ROOT / "public" / "samples")
    parser.add_argument("--crf", type=int, default=20, help="x264 quality (lower = better, larger)")
    parser.add_argument("--preset", default="slow")
    parser.add_argument("--poster-sec", type=float, default=0.0,
                        help="Grid time of the poster frame (default: the first frame, which is also the pose shown before playback)")
    parser.add_argument("-v", "--verbose", action="store_true")
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO, format="%(asctime)s %(name)s %(message)s")
    log = logging.getLogger("playback")

    video = args.video.expanduser().resolve()
    clip_dir = args.motion_dir.expanduser().resolve() / args.clip_id
    clean_path = clip_dir / "clean-landmarks.json.gz"
    if not video.is_file():
        log.error("video not found: %s", video)
        return 2
    if not clean_path.is_file():
        log.error("run the cleaning stage first: %s is missing", clean_path)
        return 2
    if not 0 <= args.crf <= 51:
        log.error("--crf must be in [0, 51]")
        return 2

    try:
        clean = load_clean_timeline(clean_path)
        source_sha = sha256_file(video)
        expected_sha = clean["raw"]["sourceSha256"]
        if source_sha != expected_sha:
            log.error("video sha256 %s does not match the clip's raw landmarks (%s)", source_sha[:12], expected_sha[:12])
            return 2
        probe = probe_video(video)
        if probe.frame_count != clean["stats"]["rawFrames"]:
            log.error("video has %d frames, the landmark cache %d", probe.frame_count, clean["stats"]["rawFrames"])
            return 2
        plan = plan_slots(clean)
        out_path = args.out_dir.expanduser().resolve() / f"{args.clip_id}.mp4"
        command = encode_playback(probe, plan, out_path, args.crf, args.preset)
        verified = verify_playback(out_path, len(plan.sources), plan.fps)
        poster_frame = min(len(plan.sources) - 1, max(0, round(args.poster_sec * plan.fps)))
        poster_path = out_path.with_name(f"{args.clip_id}-poster.jpg")
        write_poster(out_path, poster_path, poster_frame)
    except VideoError as error:
        log.error("%s", error)
        return 1

    def rel(path: Path) -> str:
        try:
            return str(path.relative_to(REPO_ROOT))
        except ValueError:
            return path.name

    report = {
        "schema": "deafference.playback-report",
        "schemaVersion": 1,
        "clipId": args.clip_id,
        "source": {"file": rel(video), "sha256": source_sha, "frames": probe.frame_count, "width": probe.width, "height": probe.height},
        "timeline": {"file": rel(clean_path), "fps": plan.fps, "slots": len(plan.sources), "filledSlots": plan.filled},
        "output": {"file": rel(out_path), **verified, "poster": rel(poster_path), "posterFrame": poster_frame},
        "encoder": {"crf": args.crf, "preset": args.preset, "audio": "dropped", "command": " ".join(["ffmpeg", *command[1:-1], rel(out_path)])},
        "note": "Frame k of the playback file shows source frame timeline.sources[k]; filled slots repeat the nearest source frame.",
    }
    report_path = clip_dir / "playback-report.json"
    report_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    log.info("wrote %s: %d frames @ %d fps (%d filled slots), %.2f MB, sha256 %s", rel(out_path), verified["frames"], plan.fps,
             len(plan.filled), out_path.stat().st_size / 1e6, verified["sha256"][:12])
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
