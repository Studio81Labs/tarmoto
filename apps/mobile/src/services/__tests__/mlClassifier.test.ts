/**
 * On-device road-surface classifier (US-3).
 *
 * Covers the three failure modes the runtime has to handle without
 * crashing a ride:
 *   - happy path: model loaded → label/score/confidence derived
 *     from the softmax output
 *   - load failure: missing asset / native module → graceful null so
 *     the caller falls back to the heuristic
 *   - inference failure: bad tensor shape mid-session → latched off
 *     so subsequent windows don't keep crashing the runtime
 */

import * as mlClassifier from "../mlClassifier";
import {
  __resetForTest,
  __setLoaderForTest,
  activeInputFeatures,
  classify,
  featuresToInputVector,
  getActiveModelVersion,
  isReady,
  INPUT_FEATURES,
  isUsingLegacyFeatureVector,
  LEGACY_INPUT_FEATURES,
  LEGACY_MODEL_VERSION,
  MODEL_VERSION,
  parseModelOutput,
  QUALITY_LABELS,
  setUseLegacyFeatureVector,
  SURFACE_LABELS,
  warmup,
} from "../mlClassifier";
import type { WindowFeatures } from "../sensors";

function makeFeatures(overrides: Partial<WindowFeatures> = {}): WindowFeatures {
  return {
    rms: 1.0,
    std: 0.5,
    peak_to_peak: 2.0,
    crest_factor: 2.0,
    zero_crossing_rate: 0.1,
    percentile_95: 1.5,
    kurtosis: 0.0,
    skewness: 0.0,
    device_family_iphone_pro: 0,
    device_family_iphone_standard: 0,
    device_family_pixel: 0,
    device_family_samsung_galaxy_s: 0,
    device_family_other: 1,
    spectral_centroid: 0,
    spectral_energy_low: 0,
    spectral_energy_mid: 0,
    spectral_energy_high: 0,
    dominant_frequency: 0,
    spectral_entropy: 0,
    band_ratio_high_low: 0,
    gyro_rms: 0.2,
    gyro_pitch_var: 0,
    gyro_roll_var: 0,
    speed_kmh: 30,
    speed_normalized_rms: 1.0,
    acceleration_longitudinal: 0,
    max_abs_lean_deg: 0,
    timestamp: 1_700_000_000_000,
    ...overrides,
  };
}

/**
 * Minimal stand-in for a TFLite model that returns whatever the test
 * pre-stages. Mirrors the `react-native-fast-tflite` v3 contract:
 * `runSync` takes `ArrayBuffer[]` and returns `ArrayBuffer[]`. Tests
 * stage Float32Arrays for ergonomics and we hand back their backing
 * buffers — the production code wraps each output buffer in a
 * Float32Array view before parsing.
 */
function makeMockModel(
  outputs: Float32Array[] | (() => Float32Array[]) | Error,
) {
  return {
    runSync: jest.fn((_inputs: ArrayBuffer[]): ArrayBuffer[] => {
      if (outputs instanceof Error) throw outputs;
      const tensors = typeof outputs === "function" ? outputs() : outputs;
      // `Float32Array.buffer` is typed as the wider `ArrayBufferLike`
      // to allow SharedArrayBuffer; the freshly-allocated arrays we
      // build in tests are always backed by plain ArrayBuffer.
      return tensors.map((t) => t.buffer as ArrayBuffer);
    }),
  };
}

function softmax(values: number[]): Float32Array {
  const max = Math.max(...values);
  const exp = values.map((v) => Math.exp(v - max));
  const sum = exp.reduce((s, v) => s + v, 0);
  return new Float32Array(exp.map((v) => v / sum));
}

beforeEach(() => {
  __resetForTest();
  jest.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  __resetForTest();
  jest.restoreAllMocks();
});

describe("mlClassifier — label tables", () => {
  it("exposes the 5 PRD quality classes in order", () => {
    expect(QUALITY_LABELS).toEqual([
      "excellent",
      "good",
      "fair",
      "poor",
      "very_poor",
    ]);
  });

  it("exposes the 5 PRD surface types in order", () => {
    // PRD §3.1: asphalt / concrete / cobblestone / gravel / dirt.
    expect(SURFACE_LABELS).toEqual([
      "asphalt",
      "concrete",
      "cobblestone",
      "gravel",
      "dirt",
    ]);
  });

  it("declares the 21-D v1.1 input vector matching WindowFeatures keys", () => {
    // v1.1 contract (issue #492) — 8 time-domain + 7 spectral + 3
    // gyro + 3 GPS-context features. Keep this assertion strict so a
    // contract change can't slip in without a model-version bump.
    expect(INPUT_FEATURES).toHaveLength(21);
    const features = makeFeatures();
    for (const key of INPUT_FEATURES) {
      expect(features).toHaveProperty(key);
    }
  });

  it("includes the seven spec-mandated FFT features", () => {
    // ML_MODEL_SPEC.md §3.3 — the safety-relevant frequency-domain
    // features. A regression that drops one of these would silently
    // disable surface-type discrimination (cobblestone vs gravel).
    expect(INPUT_FEATURES).toEqual(
      expect.arrayContaining([
        "spectral_centroid",
        "spectral_energy_low",
        "spectral_energy_mid",
        "spectral_energy_high",
        "dominant_frequency",
        "spectral_entropy",
        "band_ratio_high_low",
      ]),
    );
  });

  it("keeps the legacy 11-D vector available for v1.0 fallback", () => {
    expect(LEGACY_INPUT_FEATURES).toHaveLength(11);
    expect(LEGACY_INPUT_FEATURES).toEqual([
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
    ]);
  });

  it("bumps MODEL_VERSION to rsc-v1.1.x and keeps a v1.0 alias", () => {
    expect(MODEL_VERSION).toMatch(/^rsc-v1\.1\./);
    expect(LEGACY_MODEL_VERSION).toBe("rsc-v1.0.0");
  });
});

describe("featuresToInputVector", () => {
  it("packs features into a Float32Array in the declared order", () => {
    const features = makeFeatures({
      rms: 1.1,
      gyro_rms: 0.7,
      speed_kmh: 42,
      spectral_centroid: 7.5,
      acceleration_longitudinal: -1.25,
    });
    const vec = featuresToInputVector(features);
    expect(vec).toBeInstanceOf(Float32Array);
    expect(vec).toHaveLength(INPUT_FEATURES.length);
    expect(vec[INPUT_FEATURES.indexOf("rms")]).toBeCloseTo(1.1, 5);
    expect(vec[INPUT_FEATURES.indexOf("gyro_rms")]).toBeCloseTo(0.7, 5);
    expect(vec[INPUT_FEATURES.indexOf("speed_kmh")]).toBeCloseTo(42, 5);
    expect(vec[INPUT_FEATURES.indexOf("spectral_centroid")]).toBeCloseTo(
      7.5,
      5,
    );
    expect(
      vec[INPUT_FEATURES.indexOf("acceleration_longitudinal")],
    ).toBeCloseTo(-1.25, 5);
  });
});

describe("setUseLegacyFeatureVector (v1.0 fallback)", () => {
  it("defaults to the v1.1 vector / version", () => {
    expect(isUsingLegacyFeatureVector()).toBe(false);
    expect(activeInputFeatures()).toBe(INPUT_FEATURES);
  });

  it("packs the 11-D legacy vector when the flag is on", () => {
    setUseLegacyFeatureVector(true);
    expect(isUsingLegacyFeatureVector()).toBe(true);
    expect(activeInputFeatures()).toBe(LEGACY_INPUT_FEATURES);

    const vec = featuresToInputVector(makeFeatures({ rms: 2.5 }));
    expect(vec).toHaveLength(LEGACY_INPUT_FEATURES.length);
    expect(vec[LEGACY_INPUT_FEATURES.indexOf("rms")]).toBeCloseTo(2.5, 5);
  });

  it("tags inference output with LEGACY_MODEL_VERSION when the flag is on", async () => {
    const quality = new Float32Array([0.0, 0.7, 0.3, 0.0, 0.0]);
    const surface = new Float32Array([0.05, 0.05, 0.8, 0.05, 0.05]);
    const model = makeMockModel([quality, surface]);
    __setLoaderForTest(async () => model);
    await warmup();

    setUseLegacyFeatureVector(true);
    const result = classify(makeFeatures());
    expect(result).not.toBeNull();
    expect(result!.model_version).toBe(LEGACY_MODEL_VERSION);
    expect(getActiveModelVersion()).toBe(LEGACY_MODEL_VERSION);

    // runSync received the 11-feature buffer, not the 21-feature one.
    const inputs = model.runSync.mock.calls[0]?.[0];
    expect(inputs?.[0]?.byteLength).toBe(LEGACY_INPUT_FEATURES.length * 4);
  });
});

describe("parseModelOutput", () => {
  it("returns null on an empty output", () => {
    expect(parseModelOutput([])).toBeNull();
  });

  it("returns null when an output tensor has the wrong arity", () => {
    // 4-D quality / 5-D surface — should refuse rather than guess.
    expect(
      parseModelOutput([
        new Float32Array([0.1, 0.2, 0.3, 0.4]),
        new Float32Array([0.2, 0.2, 0.2, 0.2, 0.2]),
      ]),
    ).toBeNull();
  });

  it("parses two-tensor output into argmax labels and weighted score", () => {
    // Quality leans 'good' with some 'fair' mass → score ≈ 4*0.7+3*0.3 = 3.7
    const quality = new Float32Array([0.0, 0.7, 0.3, 0.0, 0.0]);
    // Surface leans cobblestone (index 2)
    const surface = new Float32Array([0.05, 0.05, 0.8, 0.05, 0.05]);
    const out = parseModelOutput([quality, surface]);

    expect(out).not.toBeNull();
    expect(out!.quality_class).toBe("good");
    expect(out!.surface_type).toBe("cobblestone");
    expect(out!.quality_score).toBeCloseTo(3.7, 1);
    // Confidence = mean of the two argmax probabilities * 100.
    expect(out!.confidence).toBe(Math.round(((0.7 + 0.8) / 2) * 100));
    expect(out!.model_version).toBe(MODEL_VERSION);
  });

  it("clamps the quality score to [0.5, 5.0]", () => {
    // A degenerate distribution that puts mass beyond the label range
    // shouldn't leak through — this is defence against a pathological
    // model output.
    const quality = new Float32Array([2.0, 0.0, 0.0, 0.0, 0.0]);
    const surface = new Float32Array([1.0, 0.0, 0.0, 0.0, 0.0]);
    const out = parseModelOutput([quality, surface]);
    expect(out!.quality_score).toBeLessThanOrEqual(5.0);
    expect(out!.quality_score).toBeGreaterThanOrEqual(0.5);
  });

  it("parses a single 10-D concatenated tensor as quality||surface", () => {
    const concat = new Float32Array([
      0.0,
      0.0,
      0.0,
      1.0,
      0.0, // quality → poor
      0.0,
      0.0,
      0.0,
      0.0,
      1.0, // surface → dirt
    ]);
    const out = parseModelOutput([concat]);
    expect(out).not.toBeNull();
    expect(out!.quality_class).toBe("poor");
    expect(out!.surface_type).toBe("dirt");
  });

  it("returns null for a single tensor of unexpected length", () => {
    const concat = new Float32Array([0.5, 0.5]);
    expect(parseModelOutput([concat])).toBeNull();
  });
});

describe("warmup + classify integration", () => {
  it("uses the model's softmax output once warmed up", async () => {
    const quality = softmax([0.1, 2.0, 0.5, 0.2, 0.1]); // → good
    const surface = softmax([2.0, 0.1, 0.1, 0.1, 0.1]); // → asphalt
    const model = makeMockModel([quality, surface]);
    __setLoaderForTest(async () => model);

    const ready = await warmup();
    expect(ready).toBe(true);
    expect(isReady()).toBe(true);

    const result = classify(makeFeatures());
    expect(result).not.toBeNull();
    expect(result!.quality_class).toBe("good");
    expect(result!.surface_type).toBe("asphalt");
    expect(result!.confidence).toBeGreaterThan(0);
    expect(result!.model_version).toBe(MODEL_VERSION);
    expect(model.runSync).toHaveBeenCalledTimes(1);
    expect(getActiveModelVersion()).toBe(MODEL_VERSION);
  });

  it("hands runSync an ArrayBuffer, matching the v3 native contract", async () => {
    // Regression: react-native-fast-tflite v3 takes/returns
    // `ArrayBuffer[]`, not typed arrays. v1/v2 accepted Float32Arrays
    // directly — pinning this test means a future binding bump that
    // changes the shape can't silently break inference (which would
    // latch the model off and disable ML for the whole session).
    const quality = softmax([2.0, 0.1, 0.1, 0.1, 0.1]);
    const surface = softmax([0.1, 0.1, 0.1, 2.0, 0.1]);
    const model = makeMockModel([quality, surface]);
    __setLoaderForTest(async () => model);
    await warmup();

    classify(makeFeatures({ rms: 1.7 }));

    expect(model.runSync).toHaveBeenCalledTimes(1);
    const inputs = model.runSync.mock.calls[0]?.[0];
    expect(Array.isArray(inputs)).toBe(true);
    expect(inputs).toHaveLength(1);
    // `instanceof ArrayBuffer` is unreliable across jest realms (the
    // ArrayBuffer constructor in the source file's realm differs from
    // the test's). Compare by tag + size instead — both checks would
    // fail if the production code ever reverted to passing a typed
    // array directly (a Float32Array reports `[object Float32Array]`
    // and its byteLength is 4× the element count anyway).
    expect(Object.prototype.toString.call(inputs?.[0])).toBe(
      "[object ArrayBuffer]",
    );
    expect(inputs?.[0]?.byteLength).toBe(INPUT_FEATURES.length * 4);
  });

  it("returns null and stays unready when the loader rejects", async () => {
    // Mirrors the missing-asset / missing-native-module case on a
    // device where the v1 model wasn't bundled. The caller falls back
    // to the heuristic without crashing.
    __setLoaderForTest(async () => {
      throw new Error("Model asset not bundled");
    });

    const ready = await warmup();
    expect(ready).toBe(false);
    expect(isReady()).toBe(false);
    expect(classify(makeFeatures())).toBeNull();
    expect(getActiveModelVersion()).toBeNull();
    // Single warning per session — repeated load attempts must not
    // re-log because that would flood the device log on a long ride.
    expect(console.warn).toHaveBeenCalledTimes(1);

    // A second warmup() while latched-off should NOT retry the loader.
    const ready2 = await warmup();
    expect(ready2).toBe(false);
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it("dedupes concurrent warmups", async () => {
    const loader = jest.fn(async () =>
      makeMockModel([softmax([1, 0, 0, 0, 0]), softmax([1, 0, 0, 0, 0])]),
    );
    __setLoaderForTest(loader);

    await Promise.all([warmup(), warmup(), warmup()]);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("returns null and disables itself when inference throws mid-session", async () => {
    const model = makeMockModel(new Error("tensor shape mismatch"));
    __setLoaderForTest(async () => model);
    await warmup();

    expect(classify(makeFeatures())).toBeNull();
    // Latched off — caller switches to heuristic for the rest of the
    // session and we don't keep calling into a busted runtime.
    expect(isReady()).toBe(false);
    expect(getActiveModelVersion()).toBeNull();

    // Subsequent classify calls short-circuit without invoking runSync.
    expect(classify(makeFeatures())).toBeNull();
    expect(model.runSync).toHaveBeenCalledTimes(1);
  });

  it("latches off when the model output shape doesn't match the contract", async () => {
    // Output-shape mismatches are deterministic — the model file is
    // wrong. Latching avoids paying for `runSync` + `parseModelOutput`
    // on every subsequent window for the rest of the ride.
    const model = makeMockModel([
      new Float32Array([0.25, 0.25, 0.25, 0.25]),
      new Float32Array([0.2, 0.2, 0.2, 0.2, 0.2]),
    ]);
    __setLoaderForTest(async () => model);
    await warmup();

    expect(classify(makeFeatures())).toBeNull();
    // Classifier disables itself; subsequent calls short-circuit
    // without invoking the runtime — the caller falls through to the
    // heuristic for the rest of the session.
    expect(isReady()).toBe(false);
    expect(getActiveModelVersion()).toBeNull();

    expect(classify(makeFeatures())).toBeNull();
    expect(model.runSync).toHaveBeenCalledTimes(1);
  });
});

describe("module surface", () => {
  it("re-exports MODEL_VERSION as a stable string", () => {
    expect(typeof mlClassifier.MODEL_VERSION).toBe("string");
    expect(mlClassifier.MODEL_VERSION).toMatch(/^[A-Za-z0-9._-]+$/);
  });
});
