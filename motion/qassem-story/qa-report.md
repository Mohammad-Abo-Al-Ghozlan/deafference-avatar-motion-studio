# Motion QA report — qassem-story

Verdict: **PASS**

| Check | Result |
|---|---|
| Frames / fps / duration | 5794 / 30 / 193.1s (missing 0) |
| Timestamps monotonic, mapping complete | true, true |
| NaN/Inf values | 0 |
| Max quaternion norm error | 8.82e-7 |
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
| Fast continuous wrist motion (>3.6 m/s) | 1 frames, max 0.123 m/frame; source cross-check: 1/1 explained by source motion (avatar/source step ratio <= 2.5) |
| Max wrist speed | 3.68 m/s |
| Max bone-length error | 8.88e-16 m |

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
    141.3
  ],
  "wristFlex": [
    -70,
    78.1
  ],
  "wristDev": [
    -39.9,
    28
  ],
  "wristTwist": [
    -99.9,
    99.2
  ],
  "fingerTwist": 0,
  "hingeOffAxis": 0
}
```

## Temporal (per bone class)

| Class | Max step (°/frame) | worst bone | p99.9 step | Max ang. velocity (°/s) | p99.9 ang. accel (°/s²) | One-frame spikes |
|---|---|---|---|---|---|---|
| trunk | 2.87 | head | 2.51 | 86 | 961 | 0 |
| face | 24.45 | eyelid_r | 16.87 | 734 | 13366 | 0 |
| arm | 25.85 | upperarm_r | 22.55 | 775 | 10227 | 0 |
| wrist | 35.31 | hand_r | 25.94 | 1059 | 14482 | 0 |
| finger | 29.68 | thumb_01_l | 25.6 | 890 | 16407 | 0 |

## Fast wrist motion vs source

| Frame | t (s) | Side | Hand state | Avatar step (m) | Source wrist step (m) | Source hand-centre step (m) | Source image-plane step (m) | Ratio |
|---|---|---|---|---|---|---|---|---|
| 4869 | 162.3 | right | tracked | 0.1226 | 0.0808 | 0.1004 | 0.0731 | 1.22 |

## Tracking and cleaning

```json
{
  "processedFrames": 5794,
  "decodedSourceFrames": 5761,
  "droppedSourceSlots": 33,
  "duplicateTrackerFrames": 0,
  "identityCorrections": {
    "swaps": 1,
    "duplicatesDropped": 13,
    "relabelled": 0
  },
  "left": {
    "detectedSlots": 1615,
    "acceptedFits": 1534,
    "rejectedFits": 81,
    "rejectReasons": {
      "palmError": 0,
      "digitError": 0,
      "outOfFrame": 6,
      "fitFailed": 0,
      "orientationVote": 75
    },
    "rejectedOutliers": {
      "palmOrientationSpikes": 0,
      "scaleOutliers": 53,
      "jointChannelOutliers": 944
    },
    "states": {
      "tracked": 1481,
      "interpolated": 241,
      "held": 458,
      "fallback": 1117,
      "absent": 2497
    },
    "missingHandIntervals": 219,
    "interpolatedIntervals": 88,
    "uncertainIntervals": [
      [
        4.033,
        4.233
      ],
      [
        5.3,
        5.467
      ],
      [
        5.5,
        5.933
      ],
      [
        6.967,
        7.167
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
        9.367,
        9.567
      ],
      [
        10.067,
        10.233
      ],
      [
        10.267,
        10.7
      ],
      [
        11.2,
        11.4
      ],
      [
        11.533,
        11.7
      ],
      [
        11.733,
        12.367
      ],
      [
        12.433,
        12.6
      ],
      [
        12.633,
        13.067
      ],
      [
        13.5,
        13.7
      ],
      [
        13.967,
        14.133
      ],
      [
        14.167,
        14.6
      ],
      [
        15.4,
        15.6
      ],
      [
        16.1,
        16.267
      ],
      [
        16.3,
        16.733
      ],
      [
        17.067,
        17.267
      ],
      [
        17.4,
        17.567
      ],
      [
        17.6,
        18.033
      ],
      [
        18.367,
        18.567
      ],
      [
        18.633,
        19.033
      ],
      [
        19.233,
        19.4
      ],
      [
        19.433,
        20.067
      ],
      [
        20.8,
        20.967
      ],
      [
        21,
        21.433
      ],
      [
        21.633,
        21.833
      ],
      [
        22.133,
        22.3
      ],
      [
        22.333,
        22.767
      ],
      [
        23.333,
        23.533
      ],
      [
        23.6,
        23.767
      ],
      [
        23.8,
        24.233
      ],
      [
        24.933,
        25.133
      ],
      [
        25.567,
        25.733
      ],
      [
        25.767,
        26.433
      ],
      [
        28.6,
        28.767
      ],
      [
        28.8,
        29.233
      ],
      [
        30.267,
        30.467
      ],
      [
        30.867,
        31.033
      ],
      [
        31.067,
        31.5
      ],
      [
        33.1,
        33.3
      ],
      [
        33.8,
        33.967
      ],
      [
        34,
        34.433
      ],
      [
        37.267,
        37.467
      ],
      [
        39.8,
        39.967
      ],
      [
        40,
        40.6
      ],
      [
        41.333,
        41.5
      ],
      [
        41.533,
        41.633
      ],
      [
        41.667,
        41.8
      ],
      [
        43.933,
        44.1
      ],
      [
        44.133,
        44.167
      ],
      [
        44.2,
        44.367
      ],
      [
        49.7,
        49.867
      ],
      [
        49.9,
        50.333
      ],
      [
        50.7,
        50.9
      ],
      [
        52.1,
        52.267
      ],
      [
        52.3,
        52.667
      ],
      [
        52.7,
        52.7
      ],
      [
        54.3,
        54.467
      ],
      [
        54.5,
        54.933
      ],
      [
        56.5,
        56.7
      ],
      [
        57.267,
        57.433
      ],
      [
        57.467,
        57.767
      ],
      [
        57.8,
        57.833
      ],
      [
        61.167,
        61.333
      ],
      [
        61.367,
        61.9
      ],
      [
        66.133,
        66.3
      ],
      [
        66.333,
        66.767
      ],
      [
        68.167,
        68.333
      ],
      [
        68.367,
        68.8
      ],
      [
        70.433,
        70.633
      ],
      [
        71.567,
        71.733
      ],
      [
        71.767,
        72.267
      ],
      [
        72.6,
        72.767
      ],
      [
        72.8,
        73.233
      ],
      [
        75.867,
        76.067
      ],
      [
        76.533,
        76.7
      ],
      [
        76.733,
        77.167
      ],
      [
        77.467,
        77.667
      ],
      [
        78.267,
        78.433
      ],
      [
        78.467,
        78.9
      ],
      [
        81.033,
        81.233
      ],
      [
        82.1,
        82.267
      ],
      [
        82.3,
        82.733
      ],
      [
        84.167,
        84.367
      ],
      [
        85,
        85.167
      ],
      [
        85.2,
        85.633
      ],
      [
        88.767,
        88.967
      ],
      [
        90.233,
        90.4
      ],
      [
        90.433,
        90.867
      ],
      [
        91.1,
        91.3
      ],
      [
        91.867,
        92.033
      ],
      [
        92.067,
        92.733
      ],
      [
        92.833,
        93
      ],
      [
        93.033,
        93.467
      ],
      [
        94.2,
        94.4
      ],
      [
        95.6,
        95.767
      ],
      [
        95.8,
        96.233
      ],
      [
        96.467,
        96.667
      ],
      [
        97.2,
        97.367
      ],
      [
        97.4,
        97.833
      ],
      [
        98.9,
        99.067
      ],
      [
        99.1,
        99.533
      ],
      [
        108.3,
        108.5
      ],
      [
        109.567,
        109.733
      ],
      [
        109.767,
        110.067
      ],
      [
        110.1,
        110.133
      ],
      [
        111.267,
        111.433
      ],
      [
        111.467,
        111.9
      ],
      [
        116.133,
        116.333
      ],
      [
        116.533,
        116.7
      ],
      [
        116.733,
        117.167
      ],
      [
        120.467,
        120.667
      ],
      [
        121.333,
        121.5
      ],
      [
        121.533,
        121.967
      ],
      [
        123.1,
        123.3
      ],
      [
        123.933,
        124.1
      ],
      [
        124.133,
        124.567
      ],
      [
        125,
        125.2
      ],
      [
        126.8,
        126.967
      ],
      [
        127,
        127.433
      ],
      [
        128.233,
        128.433
      ],
      [
        129.8,
        129.967
      ],
      [
        130,
        130.1
      ],
      [
        130.133,
        130.267
      ],
      [
        130.933,
        131.2
      ],
      [
        132.733,
        133.1
      ],
      [
        133.933,
        134.233
      ],
      [
        134.433,
        134.833
      ],
      [
        136.233,
        136.4
      ],
      [
        136.433,
        136.867
      ],
      [
        139.867,
        140.067
      ],
      [
        140.467,
        140.633
      ],
      [
        140.667,
        141.1
      ],
      [
        143.1,
        143.3
      ],
      [
        144.1,
        144.267
      ],
      [
        144.3,
        144.6
      ],
      [
        144.633,
        144.667
      ],
      [
        145.1,
        145.267
      ],
      [
        145.3,
        145.733
      ],
      [
        158,
        158.2
      ],
      [
        158.6,
        158.767
      ],
      [
        158.8,
        159.233
      ],
      [
        162.4,
        162.6
      ],
      [
        162.7,
        162.867
      ],
      [
        162.9,
        163.333
      ],
      [
        163.433,
        163.633
      ],
      [
        163.7,
        163.867
      ],
      [
        163.9,
        164.333
      ],
      [
        164.433,
        164.633
      ],
      [
        164.767,
        164.933
      ],
      [
        164.967,
        165.4
      ],
      [
        167.067,
        167.267
      ],
      [
        167.767,
        167.933
      ],
      [
        167.967,
        168.4
      ],
      [
        170.133,
        170.333
      ],
      [
        171.267,
        171.433
      ],
      [
        171.467,
        171.9
      ],
      [
        172.533,
        172.733
      ],
      [
        173.133,
        173.3
      ],
      [
        173.333,
        173.767
      ],
      [
        179.6,
        179.8
      ],
      [
        180.267,
        180.433
      ],
      [
        180.467,
        180.9
      ],
      [
        182.2,
        182.4
      ],
      [
        182.933,
        183.3
      ],
      [
        183.9,
        184.067
      ],
      [
        184.1,
        184.533
      ],
      [
        188.6,
        188.8
      ],
      [
        190.267,
        190.633
      ],
      [
        192.3,
        192.467
      ],
      [
        192.5,
        192.933
      ]
    ]
  },
  "right": {
    "detectedSlots": 4805,
    "acceptedFits": 4646,
    "rejectedFits": 159,
    "rejectReasons": {
      "palmError": 2,
      "digitError": 1,
      "outOfFrame": 52,
      "fitFailed": 0,
      "orientationVote": 104
    },
    "rejectedOutliers": {
      "palmOrientationSpikes": 3,
      "scaleOutliers": 80,
      "jointChannelOutliers": 2306
    },
    "states": {
      "tracked": 4563,
      "interpolated": 586,
      "held": 338,
      "fallback": 266,
      "absent": 41
    },
    "missingHandIntervals": 80,
    "interpolatedIntervals": 209,
    "uncertainIntervals": [
      [
        0.333,
        0.533
      ],
      [
        6.7,
        6.967
      ],
      [
        7.833,
        8
      ],
      [
        8.033,
        8.467
      ],
      [
        8.7,
        8.9
      ],
      [
        10.3,
        10.467
      ],
      [
        10.5,
        10.967
      ],
      [
        14.733,
        14.9
      ],
      [
        14.933,
        15.033
      ],
      [
        15.067,
        15.2
      ],
      [
        17.933,
        18.1
      ],
      [
        18.133,
        18.367
      ],
      [
        18.4,
        18.467
      ],
      [
        19.233,
        19.4
      ],
      [
        19.433,
        19.667
      ],
      [
        19.7,
        19.767
      ],
      [
        22.333,
        22.5
      ],
      [
        22.533,
        22.7
      ],
      [
        22.733,
        22.833
      ],
      [
        31.3,
        31.467
      ],
      [
        31.5,
        32.1
      ],
      [
        41.267,
        41.433
      ],
      [
        41.467,
        41.567
      ],
      [
        41.6,
        41.733
      ],
      [
        44.567,
        44.833
      ],
      [
        52.1,
        52.4
      ],
      [
        55.1,
        55.267
      ],
      [
        55.3,
        55.833
      ],
      [
        73.567,
        73.9
      ],
      [
        82.6,
        82.933
      ],
      [
        85.867,
        86.033
      ],
      [
        86.067,
        86.233
      ],
      [
        86.267,
        86.367
      ],
      [
        90.633,
        90.967
      ],
      [
        92.967,
        93.133
      ],
      [
        93.167,
        93.667
      ],
      [
        94.8,
        94.967
      ],
      [
        95,
        95.033
      ],
      [
        95.067,
        95.233
      ],
      [
        106.567,
        106.733
      ],
      [
        106.767,
        106.867
      ],
      [
        106.9,
        107.033
      ],
      [
        109.233,
        109.6
      ],
      [
        110.967,
        111.233
      ],
      [
        118.3,
        118.467
      ],
      [
        118.5,
        119.167
      ],
      [
        123.7,
        124.1
      ],
      [
        133.867,
        134.033
      ],
      [
        134.067,
        134.3
      ],
      [
        134.333,
        134.4
      ],
      [
        140.467,
        140.633
      ],
      [
        140.667,
        141.3
      ],
      [
        147.467,
        147.8
      ],
      [
        148.333,
        148.7
      ],
      [
        152.333,
        152.5
      ],
      [
        152.533,
        152.833
      ],
      [
        152.867,
        152.9
      ],
      [
        152.967,
        153.133
      ],
      [
        153.167,
        153.333
      ],
      [
        153.367,
        153.467
      ],
      [
        171.133,
        171.3
      ],
      [
        171.333,
        171.767
      ],
      [
        172.467,
        172.667
      ],
      [
        172.933,
        173.233
      ],
      [
        179.3,
        179.6
      ],
      [
        180.033,
        180.367
      ],
      [
        180.8,
        180.967
      ],
      [
        181,
        181.233
      ],
      [
        181.267,
        181.333
      ],
      [
        184.033,
        184.2
      ],
      [
        184.233,
        184.667
      ],
      [
        184.8,
        185
      ],
      [
        192.033,
        192.333
      ],
      [
        192.4,
        192.567
      ],
      [
        192.6,
        193.033
      ]
    ]
  },
  "face": {
    "validSlots": 5754,
    "headSpikesRejected": 0,
    "featureOutliersRejected": 77
  }
}
```

## Before (legacy solver) vs after

| Metric | Before | After |
|---|---|---|
| Reverse-bend frames PIP | 354 | 0 |
| Reverse-bend frames DIP | 124 | 0 |
| PIP range violations | 2229 | 0 |
| DIP range violations | 124 | 0 |
| MCP range violations | 0 | 0 |
| Finger twist frames | 0 | 0 |
| Max finger twist (°) | 2.64 | 0 |
| Finger-order reversals | 0 | 0 |
| Fingertip-palm penetration | 0 | 0 |
| Wrist deviation violations | 651 | 0 |
| Wrist flexion violations | 567 | 0 |
| Wrist twist violations | 621 | 0 |
| Elbow hyperextension frames | 0 | 0 |
| Rest resets while tracked | 0 | 0 |
| Wrist teleports (impulsive) | 8 | 0 |
| Fast wrist motion frames | 131 | 1 |
| Max wrist speed (m/s) | 12.09 | 3.68 |
| finger max step (°/frame) | 42.49 | 29.68 |
| finger one-frame spikes | 0 | 0 |
| wrist max step (°/frame) | 70.54 | 35.31 |
| wrist one-frame spikes | 8 | 0 |
| arm max step (°/frame) | 48.63 | 25.85 |
| arm one-frame spikes | 0 | 0 |