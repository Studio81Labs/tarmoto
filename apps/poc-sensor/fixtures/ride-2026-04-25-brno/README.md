# Ride fixture — 2026-04-25, near Brno (CZ)

A real motorcycle ride captured by the Tarmoto PoC sensor app, with **rider-validated ground-truth road quality labels** added after the ride. Useful as a reference dataset for tuning the classifier and as a regression fixture once the production sensor pipeline lands in `apps/mobile/`.

## Files

| File           | Notes                                                                                                                  |
| -------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `raw.csv`      | 6,380 raw accelerometer + GPS samples; **immutable, do not modify**                                                    |
| `ride.json`    | Full ride export with metadata, tag events, and segments — enriched with `truth_quality` + `truth_context` per segment |
| `segments.csv` | Segment-level summary with both PoC sensor classification and rider-validated truth                                    |

## Recording context

|                              |                                                                         |
| ---------------------------- | ----------------------------------------------------------------------- |
| Date                         | 2026-04-25 11:40 UTC                                                    |
| Region                       | South Moravia, near Brno, Czech Republic                                |
| App                          | Tarmoto PoC v0.2.0 (Vite + React, run in Mobile Safari)                 |
| Device                       | iPhone, iOS 18.7, Safari 26.4                                           |
| Wall-clock duration          | 3.7 hours                                                               |
| Distance recorded by PoC     | only 1.4 km across 13 segments — see "Why so little was captured" below |
| Tag events captured mid-ride | 2 (`rough` and `smooth`)                                                |

## Segment clusters

Segments fall into three clusters separated by long gaps where the PoC stopped recording:

| Cluster | Segments | Time                | RMS range   | Sensor verdict         | Rider-validated truth                       |
| ------- | -------- | ------------------- | ----------- | ---------------------- | ------------------------------------------- |
| **A**   | 0–2      | 11:40:50 → 11:40:58 | 2.16 – 2.94 | `good` × 3             | `average` (rider chose clean line)          |
| **B**   | 3–5      | 11:57:51 → 11:58:06 | 1.76 – 5.78 | `good`, `fair`, `poor` | seg 3: `unknown`, seg 4–5: `rough`          |
| **C**   | 6–12     | 12:06:29 → 12:06:53 | 3.27 – 4.77 | `fair` × 7             | `average` (wavy / patched, rider held line) |

## Key calibration findings

1. **Line choice moves RMS by ~1.0 on the same road.** Cluster A and Cluster C are the **same road type** per the rider, but RMS means differ ~50 % (2.50 vs 3.77). The only difference: in A the rider was actively dodging defects; in C the rider held a straight line through small waves and patches. **A classifier looking at RMS alone cannot distinguish "good road" from "good rider on average road".** Production classifier should consider averaging across many riders/passes for the same GPS bucket, or label per-segment using the worst (not mean) RMS observed.

2. **Mid-ride tags are imprecise.** The rider stopped to press `rough` on segment 3 — but seg 3 (RMS 1.76) was actually the smoothest segment in the ride. The actually-rough surface starts at seg 4 (RMS 3.63) and peaks at seg 5 (RMS 5.78). Implication: tag UX needs a "this is rough _now_" model that auto-attaches the tag to the next 100–500 m, not the segment containing the button press.

3. **`smooth` / `rough` are relative, not absolute.** Cluster C was tagged `smooth` because it followed the rough stretch — but in absolute terms it's an average wavy country road. Production app should use absolute labels (`excellent / good / average / poor / bad`) or capture quick rider intent the app translates.

4. **Current PoC thresholds blur the road-type distinction.** Real PoC thresholds are `< 1.5 excellent`, `< 3 good`, `< 5.5 fair`, `< 9 poor` (see `apps/poc-sensor/src/PocSensor.tsx` `classify()`). Distribution on this ride: **4 `good`, 8 `fair`, 1 `poor`, 0 `excellent`**. Cluster A is all `good`, cluster C is all `fair`, but per ground truth they are the **same road type** — the difference is rider line choice. The PoC classifier inherits the line-choice noise as a class-boundary error.

   Suggested rebalance based on this dataset:

   | New tier    | RMS       | This ride                                                         |
   | ----------- | --------- | ----------------------------------------------------------------- |
   | `excellent` | < 1.8     | seg 3 (1.76) — but rider was stopped, not actually excellent road |
   | `good`      | 1.8 – 3.0 | cluster A: segs 0–2 (2.16–2.94)                                   |
   | `average`   | 3.0 – 4.5 | seg 4 (3.63) + cluster C minus seg 11: segs 6–10, 12 (3.27–3.93)  |
   | `poor`      | 4.5 – 5.5 | seg 11 (4.77)                                                     |
   | `bad`       | > 5.5     | seg 5 (5.78)                                                      |

   Treat these as a starting hypothesis from one ride / one rider / one bike. Validate on more rides before locking in. Note that seg 3's low RMS comes from the rider being stopped — a real classifier needs a "stationary" guard so stops don't masquerade as excellent road.

## Why so little was captured (1.4 km / 3.7 h)

The PoC runs as a web app in Mobile Safari, which loses sensor + GPS access whenever:

- the screen locks (iOS suspends the tab within seconds)
- the user switches apps or pulls the notification shade
- Safari reclaims the tab under memory pressure

The two large gaps (17 min between cluster A and B, 8 min between B and C) align with phone locks the rider mentioned. Mitigations belong in the production native app (`apps/mobile/`):

- foreground service / background location task with persistent sensor session
- OS-level wake lock
- sensor permission survives backgrounding
- mid-ride tag UI operable without unlocking (large targets, ride-mode brightness, voice tags, or hardware-button gestures)

## Ground-truth methodology

Tags were assigned by the rider after reviewing each segment's GPS coordinates on a map (Google Maps + memory of the actual ride):

- `truth_quality` — what the road actually was, independent of how the rider rode
- `truth_context` — notes that explain sensor reading anomalies (line choice, stopping, etc.)

The original mid-ride `road_tag` field is **preserved unchanged** in `ride.json` for traceability — to study the gap between rider's prospective tagging and post-ride truth.

## Caveats — read before using

- **n = 1 ride, 1 rider, 1 bike, 1 phone position.** Do not derive global thresholds from this alone.
- **No GPS speed normalization.** Higher speed → higher baseline RMS even on the same road. Future fixtures should record speed bands.
- **Phone mounting not characterized.** Hard-mount vs tank bag vs jacket pocket changes the accelerometer signal substantially.
- **Sample is geographically narrow** — South Moravia rural roads, no highway, no cobble, no gravel.

## How to use this fixture

- **Classifier dev**: feed `raw.csv` through your candidate classifier, compute RMS per segment, map to a class, compare against `segments.csv:truth_quality`. Track precision/recall per class.
- **Threshold tuning**: cluster A and C represent the **same road type** in ground truth — any classifier that puts them in different tiers is over-fitting to rider behavior.
- **UX work**: the segment-3 misattribution is a textbook case for redesigning the in-ride tag flow.
