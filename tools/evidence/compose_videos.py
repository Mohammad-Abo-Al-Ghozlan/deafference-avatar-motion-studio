#!/usr/bin/env python3
"""Compose the visual evidence from frame-exact renders (output frame k = motion frame k = t k/30).

    python3 tools/evidence/compose_videos.py sidebyside   # source | before | after (offline) | after (live)
    python3 tools/evidence/compose_videos.py hands        # source hand crop | before | after, right hand
    python3 tools/evidence/compose_videos.py sheets       # contact sheets every 4 s over the whole clip
    python3 tools/evidence/compose_videos.py review       # rule-selected review frames (fast, contact, fist...)

All inputs/outputs are repo-relative and configurable; see --help of each command.
"""
import argparse
import gzip
import json
import subprocess
import sys
from pathlib import Path

import cv2
import numpy as np

FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
ROOT = Path(__file__).resolve().parents[2]


def run(cmd: list[str]) -> None:
    print(" ".join(cmd[:6]), "...", file=sys.stderr)
    subprocess.run(cmd, check=True)


def label_filter(index: int, text: str, width: int, bar: int, extra: str = "") -> str:
    safe = text.replace(":", "\\:").replace("'", "")
    return (f"[{index}:v]scale={width}:{width}:flags=bicubic,pad={width}:{width + bar}:0:{bar}:color=0x0b1215,"
            f"drawtext=fontfile={FONT}:text='{safe}':x=10:y=({bar}-text_h)/2:fontsize={int(bar * 0.45)}:fontcolor=white{extra}[p{index}]")


def sidebyside(args: argparse.Namespace) -> int:
    inputs = [(args.source, "SOURCE (unchanged)"), (args.before, "BEFORE: original solver"),
              (args.after, "AFTER: offline pipeline"), (args.live, "AFTER: live causal pipeline")]
    inputs = [(Path(p), t) for p, t in inputs if p]
    bar = 34
    stamp = ":drawtext=fontfile=" + FONT + ":text='k=%{frame_num}  t=%{pts\\:hms}':x=10:y=h-th-8:fontsize=15:fontcolor=white:box=1:boxcolor=0x000000AA"
    filters = [label_filter(i, t, args.size, bar, stamp if i == 0 else "") for i, (_, t) in enumerate(inputs)]
    filters.append("".join(f"[p{i}]" for i in range(len(inputs))) + f"hstack=inputs={len(inputs)}[out]")
    cmd = ["ffmpeg", "-v", "error", "-y"]
    for path, _ in inputs:
        cmd += ["-i", str(ROOT / path)]
    cmd += ["-filter_complex", ";".join(filters), "-map", "[out]", "-r", "30", "-c:v", "libx264", "-preset", "veryfast",
            "-crf", str(args.crf), "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(ROOT / args.out)]
    run(cmd)
    return 0


def hands(args: argparse.Namespace) -> int:
    inputs = [(Path(args.source), "SOURCE right hand"), (Path(args.before), "BEFORE: original solver"), (Path(args.after), "AFTER: offline pipeline")]
    bar = 30
    stamp = ":drawtext=fontfile=" + FONT + ":text='k=%{frame_num}':x=8:y=h-th-6:fontsize=13:fontcolor=white:box=1:boxcolor=0x000000AA"
    filters = [label_filter(i, t, args.size, bar, stamp if i == 0 else "") for i, (_, t) in enumerate(inputs)]
    filters.append("[p0][p1][p2]hstack=inputs=3[out]")
    cmd = ["ffmpeg", "-v", "error", "-y"]
    for path, _ in inputs:
        cmd += ["-i", str(ROOT / path)]
    cmd += ["-filter_complex", ";".join(filters), "-map", "[out]", "-r", "30", "-c:v", "libx264", "-preset", "veryfast",
            "-crf", str(args.crf), "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(ROOT / args.out)]
    run(cmd)
    return 0


def decode(video: Path, wanted: set[int]) -> dict[int, np.ndarray]:
    probe = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", str(video)],
                           capture_output=True, text=True, check=True).stdout.strip().split(",")
    w, h = int(probe[0]), int(probe[1])
    proc = subprocess.Popen(["ffmpeg", "-v", "error", "-i", str(video), "-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", "bgr24", "-"],
                            stdout=subprocess.PIPE)
    out: dict[int, np.ndarray] = {}
    last = max(wanted)
    k = 0
    while k <= last:
        buf = proc.stdout.read(w * h * 3)
        if len(buf) < w * h * 3:
            break
        if k in wanted:
            out[k] = np.frombuffer(buf, np.uint8).reshape(h, w, 3).copy()
        k += 1
    proc.kill()
    return out


def cell(image: np.ndarray | None, size: int, text: str) -> np.ndarray:
    img = np.zeros((size, size, 3), np.uint8) if image is None else cv2.resize(image, (size, size), interpolation=cv2.INTER_AREA)
    cv2.rectangle(img, (0, 0), (size, 20), (0, 0, 0), -1)
    cv2.putText(img, text, (5, 14), cv2.FONT_HERSHEY_SIMPLEX, 0.42, (255, 255, 255), 1, cv2.LINE_AA)
    return img


def write_sheets(frames: list[int], columns: list[tuple[str, Path]], size: int, rows_per_sheet: int, out_prefix: Path, titles: dict[int, str] | None = None) -> list[Path]:
    wanted = set(frames)
    decoded = [(name, decode(ROOT / path, wanted)) for name, path in columns]
    rows = []
    for k in frames:
        t = k / 30
        head = f"k={k} t={int(t // 60)}:{t % 60:05.2f}"
        if titles and k in titles:
            head = f"{titles[k]} | {head}"
        cells = [cell(frames_by_k.get(k), size, head if i == 0 else name) for i, (name, frames_by_k) in enumerate(decoded)]
        rows.append(np.hstack(cells))
    outputs = []
    out_prefix.parent.mkdir(parents=True, exist_ok=True)
    for s in range(0, len(rows), rows_per_sheet):
        sheet = np.vstack(rows[s:s + rows_per_sheet])
        path = out_prefix.with_name(f"{out_prefix.name}-{s // rows_per_sheet + 1:02d}.jpg")
        cv2.imwrite(str(path), sheet, [cv2.IMWRITE_JPEG_QUALITY, 88])
        outputs.append(path)
    return outputs


def sheets(args: argparse.Namespace) -> int:
    total = int(subprocess.run(["ffprobe", "-v", "error", "-count_packets", "-select_streams", "v:0", "-show_entries", "stream=nb_read_packets",
                                "-of", "csv=p=0", str(ROOT / args.after)], capture_output=True, text=True, check=True).stdout.strip())
    frames = list(range(0, total, args.every))
    full = write_sheets(frames, [("source", Path(args.source)), ("before (original)", Path(args.before)), ("after (offline)", Path(args.after)),
                                 ("after (live)", Path(args.live))], args.size, args.rows, ROOT / args.out_dir / "contact-full")
    hand = write_sheets(frames, [("source R hand", Path(args.source_hand)), ("before (original)", Path(args.before_hand)),
                                 ("after (offline)", Path(args.after_hand))], args.size, args.rows, ROOT / args.out_dir / "contact-right-hand")
    print("\n".join(str(p.relative_to(ROOT)) for p in full + hand))
    return 0


def select_review_frames(clean_path: Path, motion_qa: Path) -> list[tuple[str, int]]:
    """Rule-based (not hand-picked) review frames covering the requested situations."""
    clean = json.load(gzip.open(clean_path, "rt"))
    frames = clean["frames"]
    names = clean["channels"]["handParams"]
    idx = {n: i for i, n in enumerate(names)}
    n = len(frames)
    state = {side: np.array([f["hands"][side]["state"] for f in frames]) for side in ("left", "right")}
    params = {side: np.array([f["hands"][side]["params"] for f in frames]) for side in ("left", "right")}
    chosen: list[tuple[str, int]] = []

    def far(k: int) -> bool:
        return all(abs(k - c) > 45 for _, c in chosen)

    def pick(label: str, score: np.ndarray, mask: np.ndarray) -> None:
        order = np.argsort(-np.where(mask, score, -np.inf))
        for k in order[:2000]:
            if not mask[k] or not np.isfinite(score[k]):
                break
            if far(int(k)):
                chosen.append((label, int(k)))
                return

    deg = 180 / np.pi
    tracked_r = state["right"] == "tracked"
    p = params["right"]
    pip = np.stack([p[:, idx[f"{f}.pip"]] for f in ("index", "middle", "ring", "pinky")], axis=1) * deg
    mcp = np.stack([p[:, idx[f"{f}.mcp"]] for f in ("index", "middle", "ring", "pinky")], axis=1) * deg

    chosen.append(("start", 30))
    chosen.append(("middle", n // 2))
    chosen.append(("end", n - 31))
    qa = json.load(open(motion_qa))
    fast_rows = (qa.get("fastMotionSourceCrossCheck") or {}).get("rows") or []
    for row in fast_rows[:1]:
        chosen.append(("fastest wrist motion", int(row["frame"])))
    # Fast finger articulation: largest clean PIP change over 3 frames.
    speed = np.zeros(n)
    speed[3:] = np.abs(pip[3:] - pip[:-3]).max(axis=1)
    pick("fast finger articulation", speed, tracked_r)
    pick("fist (all fingers flexed)", np.minimum(pip.min(axis=1), mcp.min(axis=1)), tracked_r & (pip.min(axis=1) > 60))
    pick("pointing (index extended)", pip[:, 1:].min(axis=1) - pip[:, 0] - mcp[:, 0], tracked_r & (pip[:, 0] < 20) & (mcp[:, 0] < 30) & (pip[:, 1:].min(axis=1) > 55))
    pick("open hand (all extended)", -np.abs(pip).max(axis=1) - np.abs(mcp).max(axis=1), tracked_r & (np.abs(pip).max(axis=1) < 15) & (np.abs(mcp).max(axis=1) < 25))
    # Pinch / circle: thumb tip close to index tip (clean landmarks, palm-length normalised).
    pinch = np.full(n, -np.inf)
    for k, f in enumerate(frames):
        lm = f["hands"]["right"]["landmarks"]
        if lm and f["hands"]["right"]["state"] == "tracked":
            pts = np.array(lm).reshape(21, 3)[:, :2]
            palm = np.linalg.norm(pts[9] - pts[0]) + 1e-9
            pinch[k] = -np.linalg.norm(pts[4] - pts[8]) / palm
    pick("pinch / circle (thumb-index contact)", pinch, pinch > -0.3)
    # Hand near / touching the face (face-relative placement active).
    near = np.full(n, -np.inf)
    for k, f in enumerate(frames):
        b = f["body"]
        if f["hands"]["right"]["state"] == "tracked" and b["faceScale"] > 0:
            d = np.hypot(b["handCenter"]["right"][0] - b["faceAnchor"][0], b["handCenter"]["right"][1] - b["faceAnchor"][1]) / b["faceScale"]
            near[k] = -d
    pick("hand at the face (contact region)", near, near > -2.5)
    # Crossed hands: signer's left hand image-left of the right hand, both tracked.
    cross = np.full(n, -np.inf)
    for k, f in enumerate(frames):
        l, r = f["hands"]["left"]["landmarks"], f["hands"]["right"]["landmarks"]
        if l and r and f["hands"]["left"]["state"] == "tracked" and f["hands"]["right"]["state"] == "tracked":
            cross[k] = np.array(r).reshape(21, 3)[:, 0].mean() - np.array(l).reshape(21, 3)[:, 0].mean()
    pick("hands crossed / overlapping", cross, np.isfinite(cross) & (cross > -0.05))
    # Entering / leaving the frame, and low-confidence (fallback) intervals.
    enter = np.zeros(n, dtype=bool)
    leave = np.zeros(n, dtype=bool)
    enter[1:] = (state["right"][1:] == "tracked") & np.isin(state["right"][:-1], ["absent", "fallback"])
    leave[1:] = np.isin(state["right"][1:], ["held"]) & (state["right"][:-1] == "tracked")
    pick("right hand entering frame", np.arange(n, dtype=float), enter)
    pick("right hand leaving frame (hold)", np.arange(n, dtype=float), leave)
    pick("low confidence: easing to relaxed hand", np.arange(n, dtype=float), state["right"] == "fallback")
    left_in = state["left"] == "tracked"
    pick("left hand tracked (mostly out of frame)", np.arange(n, dtype=float), left_in)
    return sorted(chosen, key=lambda item: item[1])


def review(args: argparse.Namespace) -> int:
    selection = select_review_frames(ROOT / args.clean, ROOT / args.qa)
    frames = [k for _, k in selection]
    titles = {k: label for label, k in selection}
    full = write_sheets(frames, [("source", Path(args.source)), ("before (original)", Path(args.before)), ("after (offline)", Path(args.after)),
                                 ("after (live)", Path(args.live))], args.size, 8, ROOT / args.out_dir / "review-full", titles)
    hand = write_sheets(frames, [("source R hand", Path(args.source_hand)), ("before (original)", Path(args.before_hand)),
                                 ("after (offline)", Path(args.after_hand))], args.size, 8, ROOT / args.out_dir / "review-right-hand", titles)
    (ROOT / args.out_dir / "review-frames.json").write_text(json.dumps([{"label": l, "frame": k, "timeSec": round(k / 30, 3)} for l, k in selection], indent=2))
    print("\n".join(str(p.relative_to(ROOT)) for p in full + hand))
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    v = "evidence/video"
    common = {
        "--source": "public/samples/qassem-story.mp4",
        "--before": f"{v}/before-legacy-full.mp4",
        "--after": f"{v}/after-offline-full.mp4",
        "--live": f"{v}/after-live-full.mp4",
        "--source-hand": f"{v}/source-right-hand.mp4",
        "--before-hand": f"{v}/before-legacy-right-hand.mp4",
        "--after-hand": f"{v}/after-offline-right-hand.mp4",
    }
    a = sub.add_parser("sidebyside")
    for key in ("--source", "--before", "--after", "--live"):
        a.add_argument(key, default=common[key])
    a.add_argument("--size", type=int, default=480)
    a.add_argument("--crf", type=int, default=24)
    a.add_argument("--out", default=f"{v}/side-by-side-full.mp4")
    b = sub.add_parser("hands")
    b.add_argument("--source", default=common["--source-hand"])
    b.add_argument("--before", default=common["--before-hand"])
    b.add_argument("--after", default=common["--after-hand"])
    b.add_argument("--size", type=int, default=360)
    b.add_argument("--crf", type=int, default=22)
    b.add_argument("--out", default=f"{v}/right-hand-closeup-full.mp4")
    for name in ("sheets", "review"):
        c = sub.add_parser(name)
        for key, value in common.items():
            c.add_argument(key, default=value)
        c.add_argument("--size", type=int, default=240)
        c.add_argument("--out-dir", default="evidence/sheets")
        if name == "sheets":
            c.add_argument("--every", type=int, default=120)
            c.add_argument("--rows", type=int, default=10)
        else:
            c.add_argument("--clean", default="motion/qassem-story/clean-landmarks.json.gz")
            c.add_argument("--qa", default="motion/qassem-story/qa-report.json")
    args = parser.parse_args()
    return {"sidebyside": sidebyside, "hands": hands, "sheets": sheets, "review": review}[args.command](args)


if __name__ == "__main__":
    raise SystemExit(main())
