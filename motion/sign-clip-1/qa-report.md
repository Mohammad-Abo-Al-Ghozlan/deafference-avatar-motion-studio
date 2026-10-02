# Motion QA report — sign-clip-1

Verdict: **PASS**

| Check | Result |
|---|---|
| Frames / fps / duration | 524 / 30 / 17.43333s (missing 0) |
| Timestamps monotonic, mapping complete | true, true |
| NaN/Inf values | 0 |
| Max quaternion norm error | 8.31e-7 |
| Quaternion sign flips | 0 |
| PIP / DIP off-hinge frames (>1°) | 0 / 0 |
| Thumb MCP / IP off-hinge frames | 0 / 0 |
| Elbow off-hinge frames | 0 |
| Reverse-bend frames PIP / DIP | 0 / 0 |
| Finger twist frames (>3°) | 0 (max 0°) |
| Joint-range violations PIP / DIP / MCP / thumb | 0 / 0 / 0 / 0 |
| Elbow hyperextension / overflexion frames | 0 / 0 |
| Wrist flex / deviation / twist violations | 0 / 0 / 0 |
| Finger-order reversals | 0 |
| Fingertip-palm penetration frames | 0 |
| Rest-pose resets while tracked | 0 |
| Wrist teleports (impulsive step >2.5x both neighbours, jump-and-return, or >7.5 m/s) | 0 |
| Fast continuous wrist motion (>3.6 m/s) | 1 frames, max 0.143 m/frame; source cross-check: 1/1 explained by source motion (avatar/source step ratio <= 2.5) |
| Max wrist speed | 4.29 m/s |
| Max bone-length error | 6.11e-16 m |

## Joint extremes (degrees)

```json
{
  "pip": [
    -5,
    110
  ],
  "dip": [
    -10,
    85
  ],
  "mcp": [
    -25,
    90
  ],
  "elbow": [
    11.9,
    94.1
  ],
  "wristFlex": [
    -51.1,
    70.1
  ],
  "wristDev": [
    -39.9,
    28
  ],
  "wristTwist": [
    -93.2,
    97.7
  ],
  "fingerTwist": 0,
  "hingeOffAxis": 0
}
```

## Temporal (per bone class)

| Class | Max step (°/frame) | worst bone | p99.9 step | Max ang. velocity (°/s) | p99.9 ang. accel (°/s²) | One-frame spikes |
|---|---|---|---|---|---|---|
| trunk | 2.24 | head | 2.12 | 67 | 618 | 0 |
| face | 15.96 | eyelid_r | 15.36 | 479 | 9776 | 0 |
| arm | 42.04 | lowerarm_r | 20.72 | 1261 | 18647 | 0 |
| wrist | 27.02 | hand_r | 26.86 | 811 | 14002 | 0 |
| finger | 26.6 | pinky_01_r | 25.53 | 798 | 16339 | 0 |

## Fast wrist motion vs source

| Frame | t (s) | Side | Hand state | Avatar step (m) | Source wrist step (m) | Source hand-centre step (m) | Source image-plane step (m) | Ratio |
|---|---|---|---|---|---|---|---|---|
| 523 | 17.433 | right | held | 0.1429 | 0.1388 | 0.0044 | 0.1388 | 1.03 |

## Tracking and cleaning

```json
{
  "processedFrames": 524,
  "decodedSourceFrames": 522,
  "droppedSourceSlots": 2,
  "duplicateTrackerFrames": 0,
  "identityCorrections": {
    "swaps": 0,
    "duplicatesDropped": 0,
    "relabelled": 0
  },
  "left": {
    "detectedSlots": 145,
    "acceptedFits": 137,
    "rejectedFits": 8,
    "rejectReasons": {
      "palmError": 0,
      "digitError": 0,
      "outOfFrame": 8,
      "fitFailed": 0,
      "orientationVote": 0
    },
    "rejectedOutliers": {
      "palmOrientationSpikes": 0,
      "scaleOutliers": 0,
      "jointChannelOutliers": 72
    },
    "states": {
      "tracked": 137,
      "interpolated": 0,
      "held": 26,
      "fallback": 73,
      "absent": 288
    },
    "missingHandIntervals": 16,
    "interpolatedIntervals": 0,
    "uncertainIntervals": [
      [
        4.167,
        4.367
      ],
      [
        5.933,
        6.1
      ],
      [
        6.133,
        6.567
      ],
      [
        7.1,
        7.3
      ],
      [
        7.767,
        7.933
      ],
      [
        7.967,
        8.267
      ],
      [
        8.3,
        8.333
      ],
      [
        9.333,
        9.5
      ],
      [
        9.533,
        9.967
      ],
      [
        13.2,
        13.4
      ],
      [
        15.067,
        15.233
      ],
      [
        15.267,
        15.7
      ]
    ]
  },
  "right": {
    "detectedSlots": 515,
    "acceptedFits": 511,
    "rejectedFits": 4,
    "rejectReasons": {
      "palmError": 0,
      "digitError": 0,
      "outOfFrame": 0,
      "fitFailed": 0,
      "orientationVote": 4
    },
    "rejectedOutliers": {
      "palmOrientationSpikes": 0,
      "scaleOutliers": 2,
      "jointChannelOutliers": 168
    },
    "states": {
      "tracked": 509,
      "interpolated": 6,
      "held": 2,
      "fallback": 7,
      "absent": 0
    },
    "missingHandIntervals": 2,
    "interpolatedIntervals": 5,
    "uncertainIntervals": [
      [
        0,
        0.2
      ],
      [
        17.4,
        17.433
      ]
    ]
  },
  "face": {
    "validSlots": 522,
    "headSpikesRejected": 0,
    "featureOutliersRejected": 8
  }
}
```