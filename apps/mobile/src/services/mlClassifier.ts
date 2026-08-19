/**
 * On-device road-surface classifier (US-3).
 *
 * Wraps the bundled TensorFlow Lite model that takes the 11-feature window
 * vector emitted by `sensors.ts` and returns:
 *
 *   - quality_class  ∈ excellent | good | fair | poor | very_poor
 *   - quality_score  ∈ [0.5, 5.0] (softmax-weighted, mirrors PoC scoring)
 *   - surface_type   ∈ asphalt | concrete | cobblestone | gravel | dirt
 *   - confidence     ∈ [0, 100] (softmax probability of the picked class
 *                                — averaged across the two heads)
 *
 * Model file lives at `assets/ml/road-surface-classifier.tflite` (bundled
 * via `react-native.config.js`). The actual artifact is produced by the
 * training pipeline tracked in research issue #7 — the runtime here is
 * model-agnostic as long as the input/output shape matches the contract
 * documented at the top of `assets/ml/MODEL_CONTRACT.md`.
 *
 * The wrapper is intentionally permissive: any failure (missing native
 * module, missing asset, parse error, mismatched output shape) is logged
 * once and the classifier returns `null`, which the caller in `sensors.ts`
 * uses as the trigger to fall back to the v0 RMS heuristic. We never
 * throw out of `classify()` so a model regression can't crash a ride.
 */
import type { QualityClass, SurfaceType } from "@/types";
import type { WindowFeatures } from "./sensors";

/**
 * Bumped when the bundled model artifact changes (re-training, new
 * features, new label order). Backend stores this on each surface
 * reading so a future deprecation step can ignore rows produced by an
 * older classifier.
 *
 * `rsc-v1.1.0` (issue #492) introduces the expanded 21-feature vector:
 * the seven FFT spectral features from `ML_MODEL_SPEC.md` §3.3, the
 * gyro pitch/roll variances, and the GPS-derived longitudinal
 * acceleration. The runtime ALSO ships with a legacy-feature-vector
 * fallback toggle (`setUseLegacyFeatureVector`) so a build that still
 * carries the v1.0 11-feature `.tflite` artifact can continue running
 * the old contract until the retrained model is bundled — without
 * forcing the entire app to fall back to the heuristic.
 */
export const MODEL_VERSION = "rsc-v1.1.0";

/**
 * Legacy classifier identifier — emitted on each window when
 * `setUseLegacyFeatureVector(true)` is in effect. Kept distinct from
 * `MODEL_VERSION` so the backend can tell which feature contract a
 * row was produced under without parsing semver.
 */
export const LEGACY_MODEL_VERSION = "rsc-v1.0.0";

/**
 * Output label order — must match the trained model's softmax heads.
 * Keep aligned with `docs/specs/tarmoto-product-spec.md` §3.1 (PRD) and
 * the training pipeline's `labels.json`. Index 0 is the best surface /
 * quality, index 4 is the worst — this lets us derive a 5..1 quality
 * score by argmax with no extra mapping table.
 */
export const QUALITY_LABELS: readonly QualityClass[] = [
  "excellent",
  "good",
  "fair",
  "poor",
  "very_poor",
];

export const SURFACE_LABELS: readonly Exclude<SurfaceType, "unknown">[] = [
  "asphalt",
  "concrete",
  "cobblestone",
  "gravel",
  "dirt",
];

/**
 * v1.0 (legacy) feature vector — 11 entries, time-domain + gyro RMS +
 * GPS speed. Kept exported so a build that still ships the v1.0
 * `.tflite` artifact can opt into the legacy contract via
 * `setUseLegacyFeatureVector(true)` without re-introducing the old
 * vector inline.
 */
export const LEGACY_INPUT_FEATURES = [
  "rms",
  "std",
  "peak_to_peak",
  "crest_factor",
  "zero_crossing_rate",
  "percentile_95",
  "kurtosis",
  "skewness",
  "gyro_rms",
  "speed_kmh",
  "speed_normalized_rms",
] as const;

/**
 * v1.1 feature vector ordering fed to the model (issue #492). Order
 * MUST match the trained model's input tensor — adding, removing or
 * reordering a feature is a `MODEL_VERSION`-bumping change. The
 * canonical implementation that produces these values lives in
 * `SensorService.extractFeatures` (see `sensors.ts`); the layout is
 * also documented in `apps/mobile/assets/ml/MODEL_CONTRACT.md`.
 */
export const INPUT_FEATURES = [
  // Time-domain (8)
  "rms",
  "std",
  "peak_to_peak",
  "crest_factor",
  "zero_crossing_rate",
  "percentile_95",
  "kurtosis",
  "skewness",
  // Frequency-domain (7) — `docs/ML_MODEL_SPEC.md` §3.3
  "spectral_centroid",
  "spectral_energy_low",
  "spectral_energy_mid",
  "spectral_energy_high",
  "dominant_frequency",
  "spectral_entropy",
  "band_ratio_high_low",
  // Gyroscope (3)
  "gyro_rms",
  "gyro_pitch_var",
  "gyro_roll_var",
  // GPS context (3)
  "speed_kmh",
  "speed_normalized_rms",
  "acceleration_longitudinal",
] as const;

export interface MlClassification {
  quality_class: QualityClass;
  quality_score: number;
  surface_type: SurfaceType;
  confidence: number;
  model_version: string;
}

/**
 * Minimal interface we actually use from `react-native-fast-tflite` v3.
 *
 * v3 changed `runSync` to take and return `ArrayBuffer[]` (rather than
 * typed arrays directly). Callers wrap their input in
 * `Float32Array(...).buffer` and view each output buffer as a
 * `Float32Array` to read float scores. We keep this interface narrow
 * so swapping the native binding for a future version means updating
 * one shape, not the entire module.
 */
interface TFLiteModelLike {
  runSync(inputs: ArrayBuffer[]): ArrayBuffer[];
}

type ModelLoader = () => Promise<TFLiteModelLike>;

let loader: ModelLoader = defaultLoader;
let model: TFLiteModelLike | null = null;
let loadPromise: Promise<TFLiteModelLike | null> | null = null;
let loadFailed = false;
/**
 * Feature-flag toggle for the legacy 11-feature vector. Defaults to
 * `false` (current v1.1 contract). When the bundled `.tflite` artifact
 * is still on the v1.0 contract — typically because retraining hasn't
 * shipped yet — flip this to `true` BEFORE `warmup()` so inference
 * doesn't latch off on an output-shape mismatch. The runtime tags
 * each window with `LEGACY_MODEL_VERSION` while the toggle is on.
 */
let useLegacyFeatureVector = false;

/**
 * Toggle the legacy 11-feature vector path. Intended for build-time /
 * remote-config wiring: call once before `warmup()` runs. Calling
 * mid-session is supported (the next `classify()` will use the new
 * setting) but will likely cause an inference failure on the current
 * model — the `.tflite` artifact is loaded for one specific contract.
 */
export function setUseLegacyFeatureVector(enabled: boolean): void {
  useLegacyFeatureVector = enabled;
}

export function isUsingLegacyFeatureVector(): boolean {
  return useLegacyFeatureVector;
}

/**
 * Active feature-vector ordering — either the v1.1 default or the
 * legacy v1.0 list when the feature flag is on. Exposed as a function
 * (rather than a re-exported const) so callers always observe the
 * current toggle state without restarting the module.
 */
export function activeInputFeatures(): readonly (keyof WindowFeatures)[] {
  return useLegacyFeatureVector ? LEGACY_INPUT_FEATURES : INPUT_FEATURES;
}

function activeModelVersion(): string {
  return useLegacyFeatureVector ? LEGACY_MODEL_VERSION : MODEL_VERSION;
}

async function defaultLoader(): Promise<TFLiteModelLike> {
  // Lazy require so jest (no native binding, no asset resolver) can swap
  // the loader via `__setLoaderForTest` without paying the import cost.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const tflite = require("react-native-fast-tflite") as {
    loadTensorflowModel: (
      asset: { url: string } | number,
    ) => Promise<TFLiteModelLike>;
  };

  // Metro turns a `require('./foo.tflite')` into an asset registry
  // number; on the native side `react-native-fast-tflite` resolves that
  // to the bundled file. The require is wrapped because in dev builds
  // without the asset present, metro returns `undefined` rather than
  // throwing — we want a single failure mode either way.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const asset = require("../../assets/ml/road-surface-classifier.tflite") as
    number | undefined;
  if (asset === undefined || asset === null) {
    throw new Error("Model asset not bundled");
  }
  return tflite.loadTensorflowModel(asset);
}

/**
 * Pre-load the model. Safe to call repeatedly — concurrent calls share
 * a single in-flight promise and a failed load latches so we don't spam
 * the logger on every window. Returns `true` when the model is ready.
 */
export async function warmup(): Promise<boolean> {
  if (model) return true;
  if (loadFailed) return false;
  if (!loadPromise) {
    loadPromise = loader()
      .then((m) => {
        model = m;
        return m;
      })
      .catch((error: unknown) => {
        loadFailed = true;
        // Single warning per app launch — repeated failures during
        // continuous riding would otherwise flood the device log.
        console.warn(
          "[MlClassifier] TF Lite road-surface model unavailable, " +
            "falling back to heuristic:",
          error,
        );
        return null;
      })
      .finally(() => {
        loadPromise = null;
      });
  }
  const result = await loadPromise;
  return result !== null;
}

/**
 * Run inference on one window. Returns `null` when the model isn't
 * available (load not finished, load failed, or output shape didn't
 * match) so the caller can use the v0 heuristic instead.
 */
export function classify(features: WindowFeatures): MlClassification | null {
  if (!model || loadFailed) return null;

  const input = featuresToInputVector(features);
  let raw: ArrayBuffer[];
  try {
    // v3 of `react-native-fast-tflite` takes ArrayBuffers, not typed
    // arrays. `Float32Array.buffer` is the underlying buffer; using a
    // freshly-allocated typed array (as `featuresToInputVector` does)
    // means byteOffset is 0 and the backing store is always a plain
    // ArrayBuffer (never SharedArrayBuffer in RN), so the cast below
    // is sound — TypeScript's `Float32Array.buffer` is typed as the
    // wider `ArrayBufferLike` to allow SharedArrayBuffer in browser
    // contexts that we don't hit here.
    raw = model.runSync([input.buffer as ArrayBuffer]);
  } catch (error) {
    // A runtime inference failure (e.g. tensor shape mismatch caused by
    // a bad model file) shouldn't bring down the ride. Latch the
    // failure flag so we stop calling into a busted runtime and the
    // caller falls through to the heuristic for the rest of the
    // session.
    loadFailed = true;
    model = null;
    console.warn(
      "[MlClassifier] TF Lite inference failed, disabling model for this session:",
      error,
    );
    return null;
  }

  // v3 returns ArrayBuffers — view each as a float tensor before
  // handing to the parser. `parseModelOutput` keeps its
  // typed-array/number-array signature so it stays trivial to
  // unit-test without faking the native I/O.
  const tensors = raw.map((buf) => new Float32Array(buf));
  const parsed = parseModelOutput(tensors);
  if (!parsed) {
    // Output shape mismatch is deterministic — the model file itself
    // is wrong (or the contract drifted). Latch the failure so we
    // don't pay for `runSync` + `parseModelOutput` on every subsequent
    // window for the rest of the ride; the caller uses the v0
    // heuristic from here on out. Same one-warning policy as the load
    // path so a long ride doesn't flood the device log.
    loadFailed = true;
    model = null;
    console.warn(
      "[MlClassifier] TF Lite output shape didn't match contract, " +
        "disabling model for this session",
    );
    return null;
  }
  return parsed;
}

/**
 * Build the float input vector in the order declared by the active
 * feature contract (`INPUT_FEATURES` by default, or
 * `LEGACY_INPUT_FEATURES` when `setUseLegacyFeatureVector(true)` is in
 * effect). Width is 21 on the v1.1 contract, 11 on the legacy one.
 */
export function featuresToInputVector(features: WindowFeatures): Float32Array {
  const order = activeInputFeatures();
  const out = new Float32Array(order.length);
  for (let i = 0; i < order.length; i++) {
    const key = order[i];
    if (key === undefined) continue;
    out[i] = features[key] ?? 0;
  }
  return out;
}

/**
 * Parse the model's two softmax heads. Accepts either:
 *
 *   - two separate output tensors `[quality(5), surface(5)]`
 *   - one concatenated tensor `[quality(5)|surface(5)]` of length 10
 *
 * to keep this resilient to small training-pipeline tweaks. Anything
 * else returns `null` so the caller falls back.
 */
export function parseModelOutput(
  raw: Float32Array[] | number[][],
): MlClassification | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;

  let qualityProbs: number[] | null = null;
  let surfaceProbs: number[] | null = null;

  if (raw.length >= 2) {
    const qualityTensor = raw[0];
    const surfaceTensor = raw[1];
    if (qualityTensor === undefined || surfaceTensor === undefined) return null;
    qualityProbs = sliceProbs(qualityTensor, QUALITY_LABELS.length);
    surfaceProbs = sliceProbs(surfaceTensor, SURFACE_LABELS.length);
  } else {
    const joined = Array.from(raw[0] as ArrayLike<number>);
    if (joined.length === QUALITY_LABELS.length + SURFACE_LABELS.length) {
      qualityProbs = joined.slice(0, QUALITY_LABELS.length);
      surfaceProbs = joined.slice(QUALITY_LABELS.length);
    }
  }

  if (!qualityProbs || !surfaceProbs) return null;

  const qualityIdx = argmax(qualityProbs);
  const surfaceIdx = argmax(surfaceProbs);

  // Softmax-weighted score: e.g. a 70%-good / 30%-fair window yields
  // 4 * 0.7 + 3 * 0.3 = 3.7 — smoother than argmax-only and mirrors the
  // server aggregator's per-class weighting.
  const qualityScore = qualityProbs.reduce(
    (sum, prob, idx) => sum + prob * (QUALITY_LABELS.length - idx),
    0,
  );

  // Confidence = mean of the two head probabilities. Either head being
  // unsure should pull it down; using the min would be too pessimistic
  // on roads where surface and quality genuinely don't agree.
  const confidence =
    (((qualityProbs[qualityIdx] ?? 0) + (surfaceProbs[surfaceIdx] ?? 0)) / 2) *
    100;

  const qualityClass = QUALITY_LABELS[qualityIdx];
  const surfaceType = SURFACE_LABELS[surfaceIdx];
  if (qualityClass === undefined || surfaceType === undefined) return null;

  return {
    quality_class: qualityClass,
    quality_score: Math.round(clamp(qualityScore, 0.5, 5.0) * 10) / 10,
    surface_type: surfaceType,
    confidence: Math.round(clamp(confidence, 0, 100)),
    model_version: activeModelVersion(),
  };
}

function sliceProbs(
  tensor: Float32Array | number[],
  expected: number,
): number[] | null {
  const arr = Array.from(tensor as ArrayLike<number>);
  if (arr.length !== expected) return null;
  return arr;
}

function argmax(values: number[]): number {
  let best = 0;
  for (let i = 1; i < values.length; i++) {
    const current = values[i];
    const bestValue = values[best];
    if (current === undefined) continue;
    if (bestValue === undefined || current > bestValue) best = i;
  }
  return best;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** Whether the model is currently loaded (not just attempted). */
export function isReady(): boolean {
  return model !== null && !loadFailed;
}

/**
 * Returns `MODEL_VERSION` when the bundled classifier is loaded and
 * healthy, or `null` when the heuristic fallback is in effect.
 *
 * Intended for callers that need to tag a *batch* — e.g. the upload
 * payload's `client_model_version`, or telemetry — without inspecting
 * each per-window `MlClassification.model_version`. The mobile sensor
 * pipeline tags each window individually instead, but a future
 * batch-level helper (e.g. when Settings exposes a "force fallback"
 * toggle) will route through this helper.
 */
export function getActiveModelVersion(): string | null {
  return isReady() ? activeModelVersion() : null;
}

// ── Test hooks ────────────────────────────────────────────────────────
// Replace the loader and reset latched state. Not exported from the
// service barrel — tests import these directly.

export function __setLoaderForTest(next: ModelLoader | null): void {
  loader = next ?? defaultLoader;
  model = null;
  loadPromise = null;
  loadFailed = false;
  useLegacyFeatureVector = false;
}

export function __resetForTest(): void {
  model = null;
  loadPromise = null;
  loadFailed = false;
  loader = defaultLoader;
  useLegacyFeatureVector = false;
}
