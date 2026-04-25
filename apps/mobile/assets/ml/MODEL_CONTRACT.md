# Road-surface classifier — runtime contract

This folder hosts the on-device TensorFlow Lite artifact consumed by
`apps/mobile/src/services/mlClassifier.ts` (US-3). The runtime is
model-agnostic as long as a new artifact respects the contract below.
Bumping any field marked **breaking** also requires bumping
`MODEL_VERSION` in `mlClassifier.ts` so the backend can deprecate older
rows.

## File

- `road-surface-classifier.tflite` — float32 TFLite flatbuffer, bundled
  via `react-native.config.js` (`assets: ['./assets/ml']`). Android
  treats it as a non-compressed asset (declared in
  `app/build.gradle`'s `aaptOptions { noCompress 'tflite' }`) so the
  native loader can mmap it without a copy.

## Input (breaking)

A single 1×11 float32 tensor in this exact feature order:

| idx | feature                | unit  | source                             |
| --- | ---------------------- | ----- | ---------------------------------- |
| 0   | `rms`                  | m/s²  | accel-magnitude minus gravity      |
| 1   | `std`                  | m/s²  | std dev of deviation               |
| 2   | `peak_to_peak`         | m/s²  | max − min of deviation             |
| 3   | `crest_factor`         | —     | max / rms                          |
| 4   | `zero_crossing_rate`   | 1/s   | zero crossings / window            |
| 5   | `percentile_95`        | m/s²  | 95th percentile of deviation       |
| 6   | `kurtosis`             | —     | 4th moment / std⁴ − 3              |
| 7   | `skewness`             | —     | 3rd moment / std³                  |
| 8   | `gyro_rms`             | rad/s | gyroscope magnitude rms            |
| 9   | `speed_kmh`            | km/h  | most recent GPS speed              |
| 10  | `speed_normalized_rms` | m/s²  | rms / (speed_kmh / 50) when >10kmh |

The window length is 100 samples at 50 Hz (2 s, 50% overlap) — see
`SensorService.extractFeatures` for the canonical implementation.

## Output (breaking)

Two float32 softmax tensors (or a single 1×10 concat tensor — both are
accepted to keep the runtime tolerant of small training-pipeline
tweaks):

- `quality` — length 5, ordered `[excellent, good, fair, poor, very_poor]`
- `surface` — length 5, ordered `[asphalt, concrete, cobblestone, gravel, dirt]`

Each tensor must sum to ≈1 (softmax). The runtime takes argmax for the
class label and uses probability mass for the score and confidence:

- `quality_score = Σ p_i · (5 − i)` (clamped to `[0.5, 5.0]`)
- `confidence = mean(p_quality_argmax, p_surface_argmax) · 100`

## Versioning

`MODEL_VERSION` (e.g. `rsc-v1.0.0`) is sent as `model_version` on every
`POST /sensor/upload` payload. The backend persists it on each
`surface_readings` row so retraining or label-order changes can be
rolled back without re-deriving aggregations from scratch.

A missing/`null` `model_version` on an upload means the v0 RMS
heuristic in `sensors.ts#classifyHeuristic` produced the labels
(typically because the model failed to load on that device).

## Where the artifact comes from

The trained file is produced by the data-science pipeline tracked in
research issue #7 (RMS validation across 3+ phone models, 5 road
types). Until that lands, the committed `road-surface-classifier.tflite`
in this folder is an intentional non-flatbuffer placeholder — metro
still bundles it (so `require(...)` and the build succeed), the
native loader rejects it as invalid, and `mlClassifier.warmup()`
latches `loadFailed`, logs one warning, and the app falls back to the
v0 RMS heuristic in `sensors.ts#classifyHeuristic`. Replacing the
placeholder with the trained artifact is a binary swap — no code
changes required.
