"""MediaPipe Holistic runner (the same solution graph and model weights as the
browser tracker ``@mediapipe/holistic``) producing plain numpy arrays.

The legacy Holistic graph does not expose per-hand presence scores, so hand
confidence is estimated later from geometry and pose-wrist agreement.
"""

from __future__ import annotations

import hashlib
import os
from dataclasses import asdict, dataclass
from pathlib import Path

import numpy as np

POSE_COUNT = 33
HAND_COUNT = 21
FACE_COUNT = 478  # 468 mesh + 10 iris points with refine_face_landmarks=True


@dataclass(frozen=True)
class HolisticConfig:
    model_complexity: int = 1
    smooth_landmarks: bool = False  # raw measurements; smoothing is zero-phase downstream
    refine_face_landmarks: bool = True
    min_detection_confidence: float = 0.5
    min_tracking_confidence: float = 0.5
    static_image_mode: bool = False

    def as_dict(self) -> dict:
        return asdict(self)


def mediapipe_version() -> str:
    import mediapipe

    return str(mediapipe.__version__)


def model_checksums(complexity: int) -> dict[str, str]:
    import mediapipe

    root = Path(os.path.dirname(mediapipe.__file__)) / "modules"
    pose_model = {0: "pose_landmark_lite.tflite", 1: "pose_landmark_full.tflite", 2: "pose_landmark_heavy.tflite"}[complexity]
    wanted = [
        f"pose_landmark/{pose_model}",
        "pose_detection/pose_detection.tflite",
        "hand_landmark/hand_landmark_full.tflite",
        "holistic_landmark/hand_recrop.tflite",
        "face_detection/face_detection_short_range.tflite",
        "face_landmark/face_landmark_with_attention.tflite",
    ]
    result = {}
    for rel in wanted:
        path = root / rel
        result[rel] = hashlib.md5(path.read_bytes()).hexdigest() if path.exists() else "missing"
    return result


class HolisticRunner:
    """Thin stateful wrapper. One instance == one continuous tracking session."""

    def __init__(self, config: HolisticConfig):
        from mediapipe.python.solutions import holistic as mp_holistic

        self.config = config
        self._holistic = mp_holistic.Holistic(
            static_image_mode=config.static_image_mode,
            model_complexity=config.model_complexity,
            smooth_landmarks=config.smooth_landmarks,
            enable_segmentation=False,
            refine_face_landmarks=config.refine_face_landmarks,
            min_detection_confidence=config.min_detection_confidence,
            min_tracking_confidence=config.min_tracking_confidence,
        )

    def close(self) -> None:
        self._holistic.close()

    def __enter__(self) -> "HolisticRunner":
        return self

    def __exit__(self, *_exc) -> None:
        self.close()

    def process(self, rgb: np.ndarray) -> dict[str, np.ndarray | None]:
        results = self._holistic.process(rgb)
        return {
            # x, y, z, visibility, presence
            "pose": _landmarks(results.pose_landmarks, POSE_COUNT, with_scores=True),
            "poseWorld": _landmarks(results.pose_world_landmarks, POSE_COUNT, with_scores=False),
            "leftHand": _landmarks(results.left_hand_landmarks, HAND_COUNT, with_scores=False),
            "rightHand": _landmarks(results.right_hand_landmarks, HAND_COUNT, with_scores=False),
            "face": _landmarks(results.face_landmarks, None, with_scores=False),
        }


def _landmarks(landmark_list, expected: int | None, with_scores: bool) -> np.ndarray | None:
    if landmark_list is None:
        return None
    points = landmark_list.landmark
    if expected is not None and len(points) != expected:
        return None
    if with_scores:
        data = np.array([[p.x, p.y, p.z, p.visibility, p.presence] for p in points], dtype=np.float64)
    else:
        data = np.array([[p.x, p.y, p.z] for p in points], dtype=np.float64)
    if not np.all(np.isfinite(data)):
        # Never cache NaN/Inf; a non-finite tracker output is a missed detection.
        return None
    return data
