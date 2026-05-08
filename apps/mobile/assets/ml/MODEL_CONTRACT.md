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

A single 1×21 float32 tensor in this exact feature order (v1.1, issue
#492 — adds the seven FFT spectral features, gyro pitch/roll variances
and GPS-derived longitudinal acceleration on top of the v1.0 layout):

| idx | feature                     | unit      | source                                |
| --- | --------------------------- | --------- | ------------------------------------- |
| 0   | `rms`                       | m/s²      | accel-magnitude minus gravity         |
| 1   | `std`                       | m/s²      | std dev of deviation                  |
| 2   | `peak_to_peak`              | m/s²      | max − min of deviation                |
| 3   | `crest_factor`              | —         | max / rms                             |
| 4   | `zero_crossing_rate`        | 1/s       | zero crossings / window               |
| 5   | `percentile_95`             | m/s²      | 95th percentile of deviation          |
| 6   | `kurtosis`                  | —         | 4th moment / std⁴ − 3                 |
| 7   | `skewness`                  | —         | 3rd moment / std³                     |
| 8   | `spectral_centroid`         | Hz        | Σ(f·P) / Σ(P) on power spectrum       |
| 9   | `spectral_energy_low`       | (m/s²)²·s | Σ\|X\|² in 0–5 Hz band                |
| 10  | `spectral_energy_mid`       | (m/s²)²·s | Σ\|X\|² in 5–15 Hz band               |
| 11  | `spectral_energy_high`      | (m/s²)²·s | Σ\|X\|² in 15–25 Hz band              |
| 12  | `dominant_frequency`        | Hz        | argmax of power spectrum (skip DC)    |
| 13  | `spectral_entropy`          | —         | normalised Shannon entropy of P(f)    |
| 14  | `band_ratio_high_low`       | —         | spectral_energy_high / …\_low         |
| 15  | `gyro_rms`                  | rad/s     | gyroscope magnitude rms               |
| 16  | `gyro_pitch_var`            | (rad/s)²  | variance of gy across window          |
| 17  | `gyro_roll_var`             | (rad/s)²  | variance of gx across window          |
| 18  | `speed_kmh`                 | km/h      | most recent GPS speed                 |
| 19  | `speed_normalized_rms`      | m/s²      | rms / (speed_kmh / 50) when >10 km/h  |
| 20  | `acceleration_longitudinal` | m/s²      | (Δ GPS speed m/s) / window step (1 s) |

The window length is 100 samples at 50 Hz (2 s, 50% overlap) — see
`SensorService.extractFeatures` for the canonical implementation.

The FFT helper (`apps/mobile/src/services/fft.ts`) subtracts the mean,
applies a Hann window and zero-pads to the next power of two (128 for
the canonical 100-sample window) before transforming. Bins above 25 Hz
are excluded from every spectral feature so noise above the spec's
analysis ceiling can't bias the centroid / entropy.

### Legacy v1.0 input (fallback)

Builds that still ship the v1.0 11-feature `.tflite` artifact can opt
into the legacy contract via `setUseLegacyFeatureVector(true)` at app
start. The legacy ordering is `LEGACY_INPUT_FEATURES` in
`mlClassifier.ts` (idx 0…10 of the table above with the spectral / new
gyro / longitudinal-accel rows removed). Surface readings produced
under the legacy toggle carry `model_version = "rsc-v1.0.0"`.

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
