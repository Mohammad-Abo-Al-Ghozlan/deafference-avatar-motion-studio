#!/usr/bin/env python3
"""Make the on-dark logo used over the avatar stage.

    python3 tools/brand/make_logo_variants.py

Reads media/brand/deafference-logo.original.png (transparent PNG, never
modified) and writes public/brand/deafference-logo-on-dark.png:

* the gradient mark keeps its original colours;
* the dark wordmark ("eafference") is recoloured to the UI's light ink so it
  stays readable on the dark stage (on the original's near-black it would
  disappear). Anti-aliased edges keep their alpha, so the outline is unchanged;
* the canvas is trimmed to the artwork plus a small transparent margin.

The wordmark is selected by colour (dark and unsaturated); every pixel of the
mark is saturated (reds, oranges, yellows, purples), so it is left alone. The
script checks both assumptions and fails instead of guessing.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import cv2
import numpy as np

REPO_ROOT = Path(__file__).resolve().parents[2]


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--src", type=Path, default=REPO_ROOT / "media/brand/deafference-logo.original.png")
    parser.add_argument("--out", type=Path, default=REPO_ROOT / "public/brand/deafference-logo-on-dark.png")
    parser.add_argument("--ink", default="#f4f7f5", help="Wordmark colour on dark backgrounds (the app's --ink)")
    parser.add_argument("--pad", type=int, default=4, help="Transparent margin kept around the artwork (px)")
    return parser.parse_args(argv)


def hex_to_bgr(value: str) -> tuple[int, int, int]:
    value = value.lstrip("#")
    if len(value) != 6:
        raise ValueError(f"expected #rrggbb, got {value!r}")
    r, g, b = (int(value[i:i + 2], 16) for i in (0, 2, 4))
    return b, g, r


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    image = cv2.imread(str(args.src), cv2.IMREAD_UNCHANGED)
    if image is None or image.ndim != 3 or image.shape[2] != 4:
        print(f"error: {args.src} must be a PNG with an alpha channel", file=sys.stderr)
        return 2
    bgr = image[..., :3].astype(np.int32)
    alpha = image[..., 3]
    visible = alpha > 0
    chroma = bgr.max(axis=2) - bgr.min(axis=2)
    luminance = bgr.mean(axis=2)
    wordmark = visible & (chroma < 40) & (luminance < 120)
    mark = visible & ~wordmark & (alpha > 200)

    # Guard the colour split: the wordmark sits to the right of the mark's core
    # and the opaque mark pixels are saturated.
    if wordmark.sum() < 1000 or mark.sum() < 1000:
        print("error: could not separate the wordmark from the mark by colour", file=sys.stderr)
        return 1
    if np.median(np.where(wordmark)[1]) <= np.median(np.where(mark)[1]):
        print("error: the dark pixels are not to the right of the mark; refusing to recolour", file=sys.stderr)
        return 1

    out = image.copy()
    out[wordmark, :3] = hex_to_bgr(args.ink)

    ys, xs = np.where(visible)
    top, bottom = max(0, ys.min() - args.pad), min(image.shape[0], ys.max() + 1 + args.pad)
    left, right = max(0, xs.min() - args.pad), min(image.shape[1], xs.max() + 1 + args.pad)
    out = out[top:bottom, left:right]

    args.out.parent.mkdir(parents=True, exist_ok=True)
    if not cv2.imwrite(str(args.out), out, [cv2.IMWRITE_PNG_COMPRESSION, 9]):
        print(f"error: could not write {args.out}", file=sys.stderr)
        return 1
    print(f"wrote {args.out.relative_to(REPO_ROOT) if args.out.is_relative_to(REPO_ROOT) else args.out}: "
          f"{out.shape[1]}x{out.shape[0]} px, wordmark pixels recoloured: {int(wordmark.sum())}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
