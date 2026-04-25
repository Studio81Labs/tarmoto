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
 */
export const MODEL_VERSION = "rsc-v1.0.0";

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
 * Feature vector ordering fed to the model. Adding a feature is a
 * model-version-bumping change.
 */
export const INPUT_FEATURES = [
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

export interface MlClassification {
  quality_class: QualityClass;
  quality_score: number;
  surface_type: SurfaceType;
  confidence: number;
  model_version: string;
}

/** Minimal interface we actually use from `react-native-fast-tflite`. */
interface TFLiteModelLike {
  runSync(inputs: Float32Array[]): Float32Array[] | number[][];
}

type ModelLoader = () => Promise<TFLiteModelLike>;

let loader: ModelLoader = defaultLoader;
let model: TFLiteModelLike | null = null;
let loadPromise: Promise<TFLiteModelLike | null> | null = null;
let loadFailed = false;

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
    | number
    | undefined;
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
  let raw: Float32Array[] | number[][];
  try {
    raw = model.runSync([input]);
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

  const parsed = parseModelOutput(raw);
  if (!parsed) return null;
  return parsed;
}

/** Build the 11-D float input vector in the order declared by `INPUT_FEATURES`. */
export function featuresToInputVector(features: WindowFeatures): Float32Array {
  const out = new Float32Array(INPUT_FEATURES.length);
  for (let i = 0; i < INPUT_FEATURES.length; i++) {
    out[i] = features[INPUT_FEATURES[i]] ?? 0;
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
    qualityProbs = sliceProbs(raw[0], QUALITY_LABELS.length);
    surfaceProbs = sliceProbs(raw[1], SURFACE_LABELS.length);
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
    ((qualityProbs[qualityIdx] + surfaceProbs[surfaceIdx]) / 2) * 100;

  return {
    quality_class: QUALITY_LABELS[qualityIdx],
    quality_score: Math.round(clamp(qualityScore, 0.5, 5.0) * 10) / 10,
    surface_type: SURFACE_LABELS[surfaceIdx],
    confidence: Math.round(clamp(confidence, 0, 100)),
    model_version: MODEL_VERSION,
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
    if (values[i] > values[best]) best = i;
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

/** Used by the upload path so the backend can tag rows by classifier version. */
export function getActiveModelVersion(): string | null {
  return isReady() ? MODEL_VERSION : null;
}

// ── Test hooks ────────────────────────────────────────────────────────
// Replace the loader and reset latched state. Not exported from the
// service barrel — tests import these directly.

export function __setLoaderForTest(next: ModelLoader | null): void {
  loader = next ?? defaultLoader;
  model = null;
  loadPromise = null;
  loadFailed = false;
}

export function __resetForTest(): void {
  model = null;
  loadPromise = null;
  loadFailed = false;
  loader = defaultLoader;
}
