# Motion QA report — sign-clip-2

Verdict: **PASS**

| Check | Result |
|---|---|
| Frames / fps / duration | 882 / 30 / 29.36667s (missing 0) |
| Timestamps monotonic, mapping complete | true, true |
| NaN/Inf values | 0 |
| Max quaternion norm error | 8.68e-7 |
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
| Fast continuous wrist motion (>3.6 m/s) | 1 frames, max 0.133 m/frame; source cross-check: 1/1 explained by source motion (avatar/source step ratio <= 2.5) |
| Max wrist speed | 4 m/s |
| Max bone-length error | 5.55e-16 m |

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
    117.4
  ],
  "wristFlex": [
    -61.5,
    73.5
  ],
  "wristDev": [
    -39.7,
    28
  ],
  "wristTwist": [
    -92.1,
    88.1
  ],
  "fingerTwist": 0,
  "hingeOffAxis": 0
}
```

## Temporal (per bone class)

| Class | Max step (°/frame) | worst bone | p99.9 step | Max ang. velocity (°/s) | p99.9 ang. accel (°/s²) | One-frame spikes |
|---|---|---|---|---|---|---|
| trunk | 2.32 | head | 2.19 | 70 | 740 | 0 |
| face | 15.72 | eyelid_r | 14.13 | 472 | 11464 | 0 |
| arm | 28.55 | lowerarm_l | 27.72 | 856 | 17412 | 0 |
| wrist | 23.33 | hand_r | 23.32 | 700 | 12740 | 0 |
| finger | 26.66 | thumb_01_r | 25.81 | 800 | 17240 | 0 |

## Fast wrist motion vs source

| Frame | t (s) | Side | Hand state | Avatar step (m) | Source wrist step (m) | Source hand-centre step (m) | Source image-plane step (m) | Ratio |
|---|---|---|---|---|---|---|---|---|
| 565 | 18.833 | right | held | 0.1332 | 0.1072 | 0.0356 | 0.1016 | 1.24 |

## Tracking and cleaning

```json
{
  "processedFrames": 882,
  "decodedSourceFrames": 880,
  "droppedSourceSlots": 2,
  "duplicateTrackerFrames": 0,
  "identityCorrections": {
    "swaps": 0,
    "duplicatesDropped": 0,
    "relabelled": 0
  },
  "left": {
    "detectedSlots": 308,
    "acceptedFits": 297,
    "rejectedFits": 11,
    "rejectReasons": {
      "palmError": 0,
      "digitError": 0,
      "outOfFrame": 11,
      "fitFailed": 0,
      "orientationVote": 0
    },
    "rejectedOutliers": {
      "palmOrientationSpikes": 0,
      "scaleOutliers": 3,
      "jointChannelOutliers": 88
    },
    "states": {
      "tracked": 294,
      "interpolated": 2,
      "held": 42,
      "fallback": 147,
      "absent": 397
    },
    "missingHandIntervals": 29,
    "interpolatedIntervals": 2,
    "uncertainIntervals": [
      [
        4.1,
        4.3
      ],
      [
        5.033,
        5.2
      ],
      [
        5.233,
        5.667
      ],
      [
        5.833,
        6.033
      ],
      [
        7.6,
        7.767
      ],
      [
        7.8,
        8.233
      ],
      [
        8.333,
        8.533
      ],
      [
        10.9,
        11.067
      ],
      [
        11.1,
        11.533
      ],
      [
        13.133,
        13.333
      ],
      [
        16.2,
        16.367
      ],
      [
        16.4,
        16.833
      ],
      [
        17.767,
        17.967
      ],
      [
        18.8,
        18.967
      ],
      [
        19,
        19.433
      ],
      [
        21.133,
        21.333
      ],
      [
        22.233,
        22.4
      ],
      [
        22.433,
        22.867
      ],
      [
        26.267,
        26.467
      ],
      [
        27.3,
        27.467
      ],
      [
        27.5,
        27.933
      ]
    ]
  },
  "right": {
    "detectedSlots": 827,
    "acceptedFits": 816,
    "rejectedFits": 11,
    "rejectReasons": {
      "palmError": 0,
      "digitError": 0,
      "outOfFrame": 1,
      "fitFailed": 0,
      "orientationVote": 10
    },
    "rejectedOutliers": {
      "palmOrientationSpikes": 0,
      "scaleOutliers": 8,
      "jointChannelOutliers": 280
    },
    "states": {
      "tracked": 808,
      "interpolated": 22,
      "held": 24,
      "fallback": 24,
      "absent": 4
    },
    "missingHandIntervals": 8,
    "interpolatedIntervals": 17,
    "uncertainIntervals": [
      [
        0.133,
        0.333
      ],
      [
        5.133,
        5.467
      ],
      [
        18.8,
        18.967
      ],
      [
        19,
        19.367
      ],
      [
        19.4,
        19.4
      ],
      [
        29.033,
        29.2
      ],
      [
        29.233,
        29.367
      ]
    ]
  },
  "face": {
    "validSlots": 880,
    "headSpikesRejected": 0,
    "featureOutliersRejected": 17
  }
}
```