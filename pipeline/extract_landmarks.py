#!/usr/bin/env python3
"""Extract a versioned, cached landmark stream from a signing video.

Example (from the repository root):

    python pipeline/extract_landmarks.py \
        --video media/source/qassem-story.original.mp4 \
        --clip-id qassem-story

Outputs ``motion/<clip-id>/raw-landmarks.json.gz``. Chunks are cached under
``motion/<clip-id>/.extract-chunks`` so an interrupted run resumes.
"""

from __future__ import annotations

import argparse
import logging
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(Path(__file__).resolve().parent))

from deafference_pipeline.extract import ChunkPlan, extract  # noqa: E402
from deafference_pipeline.holistic import HolisticConfig  # noqa: E402
from deafference_pipeline.video import VideoError, probe_video  # noqa: E402


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--video", type=Path, required=True, help="Source video (never modified)")
    parser.add_argument("--clip-id", required=True, help="Identifier used for the output folder, e.g. qassem-story")
    parser.add_argument("--out-dir", type=Path, default=REPO_ROOT / "motion", help="Motion output root (default: ./motion)")
    parser.add_argument("--model-complexity", type=int, choices=(0, 1, 2), default=1,
                        help="Pose model: 1 (full) matches the browser bundle; 2 needs a network download")
    parser.add_argument("--min-detection-confidence", type=float, default=0.5)
    parser.add_argument("--min-tracking-confidence", type=float, default=0.5)
    parser.add_argument("--chunk-size", type=int, default=600)
    parser.add_argument("--warmup-frames", type=int, default=45)
    parser.add_argument("--max-frames", type=int, default=None, help="Debug: process only the first N frames")
    parser.add_argument("--smooth-landmarks", action="store_true",
                        help="Enable MediaPipe's internal landmark smoothing (the browser app's live setting). "
                             "Off by default: the offline cleaner applies zero-phase filtering instead.")
    parser.add_argument("--out-name", default="raw-landmarks.json.gz", help="Output file name inside motion/<clip-id>/")
    parser.add_argument("-v", "--verbose", action="store_true")
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO, format="%(asctime)s %(name)s %(message)s")
    log = logging.getLogger("extract")

    video = args.video.expanduser().resolve()
    if not video.is_file():
        log.error("video not found: %s", video)
        return 2
    if not 0 < args.min_detection_confidence < 1 or not 0 < args.min_tracking_confidence < 1:
        log.error("confidence thresholds must be in (0, 1)")
        return 2
    if args.chunk_size < 60 or args.warmup_frames < 0 or args.warmup_frames >= args.chunk_size:
        log.error("invalid chunking: chunk-size >= 60 and 0 <= warmup-frames < chunk-size")
        return 2

    clip_dir = args.out_dir.expanduser().resolve() / args.clip_id
    out_path = clip_dir / args.out_name
    try:
        probe = probe_video(video)
    except VideoError as error:
        log.error("%s", error)
        return 2

    timing = probe.timing_report()
    log.info("probe %dx%d %s frames=%d duration=%.3fs vfr=%s gaps=%d", probe.width, probe.height, probe.codec,
             probe.frame_count, probe.duration_sec, timing["variableFrameRate"], len(timing["droppedFrameGaps"]))

    try:
        label = str(video.relative_to(REPO_ROOT))
    except ValueError:
        label = video.name

    payload = extract(
        probe=probe,
        out_path=out_path,
        work_dir=clip_dir / (".extract-chunks-smoothed" if args.smooth_landmarks else ".extract-chunks"),
        clip_id=args.clip_id,
        source_label=label,
        tracker=HolisticConfig(
            model_complexity=args.model_complexity,
            min_detection_confidence=args.min_detection_confidence,
            min_tracking_confidence=args.min_tracking_confidence,
            smooth_landmarks=args.smooth_landmarks,
        ),
        plan=ChunkPlan(chunk_size=args.chunk_size, warmup_frames=args.warmup_frames),
        max_frames=args.max_frames,
    )
    stats = payload["stats"]
    for key in ("pose", "leftHand", "rightHand", "face"):
        log.info("%-9s detected %5d/%d (%.1f%%) missing-intervals=%d longest-gap=%d frames", key,
                 stats[key]["detected"], stats["frames"], 100 * stats[key]["detectedRatio"],
                 stats[key]["missingIntervals"], stats[key]["longestMissingFrames"])
    log.info("wrote %s", out_path)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
