/**
 * Sensor service classification path (US-3).
 *
 * Two behaviours that have to stay correct as the v0 RMS heuristic
 * gives way to the TF Lite model:
 *
 *   1. When the ML classifier returns a result, the sensor service
 *      hands its labels and `model_version` straight through to the
 *      caller (no silent re-classification, no dropped fields).
 *   2. When the ML classifier returns `null` (model not loaded, load
 *      failed, or runtime error) the v0 heuristic still produces a
 *      label so a missing model never costs the rider a contribution.
 *
 * `react-native-sensors` is mocked so we can drive the service without
 * hitting the native bridge.
 */

jest.mock("react-native-sensors", () => ({
  __esModule: true,
  accelerometer: { subscribe: jest.fn() },
  gyroscope: { subscribe: jest.fn() },
  setUpdateIntervalForType: jest.fn(),
  SensorTypes: { accelerometer: "accelerometer", gyroscope: "gyroscope" },
}));

import { sensorService, type WindowFeatures } from "../sensors";
import * as mlClassifier from "../mlClassifier";

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
    timestamp: 0,
    ...overrides,
  };
}

// `classify` is private; we go through the prototype to keep the test
// honest about what it's exercising rather than reaching into the
// classifier module directly.
function callClassify(features: WindowFeatures) {
  return (
    sensorService as unknown as {
      classify(f: WindowFeatures): {
        quality_class: string;
        quality_score: number;
        surface_type: string;
        rms: number;
        confidence: number;
        model_version: string | null;
      };
    }
  ).classify(features);
}

/**
 * Drive the private `extractFeatures` directly with a synthetic 100-
 * sample window. Lets us pin behaviour of the new spectral / gyro /
 * longitudinal-accel features without spinning up the rxjs sensor
 * stream.
 */
type Reading = {
  t: number;
  ax: number;
  ay: number;
  az: number;
  gx?: number;
  gy?: number;
  gz?: number;
};

function callExtract(window: Reading[]): WindowFeatures {
  return (
    sensorService as unknown as {
      extractFeatures(w: Reading[]): WindowFeatures;
    }
  ).extractFeatures(window);
}

const SAMPLE_RATE_HZ = 50;

function makeStaticWindow(): Reading[] {
  // 100 samples at exactly 1 g — feature extraction subtracts gravity
  // so the deviation signal is zero.
  return Array.from({ length: 100 }, (_, i) => ({
    t: i * 20,
    ax: 0,
    ay: 0,
    az: 9.81,
    gx: 0,
    gy: 0,
    gz: 0,
  }));
}

function makeVibratingWindow(freqHz: number, amplitude: number): Reading[] {
  // 100 samples of a sine on the Z axis on top of gravity. The
  // deviation = |mag - 9.81| modulates at the input frequency.
  return Array.from({ length: 100 }, (_, i) => ({
    t: i * 20,
    ax: 0,
    ay: 0,
    az:
      9.81 + amplitude * Math.sin((2 * Math.PI * freqHz * i) / SAMPLE_RATE_HZ),
    gx: 0.1 * Math.sin((2 * Math.PI * freqHz * i) / SAMPLE_RATE_HZ),
    gy: 0.05 * Math.cos((2 * Math.PI * freqHz * i) / SAMPLE_RATE_HZ),
    gz: 0,
  }));
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe("sensorService.classify — ML branch", () => {
  it("returns the ML labels and model_version when the classifier is ready", () => {
    jest.spyOn(mlClassifier, "classify").mockReturnValue({
      quality_class: "good",
      quality_score: 3.7,
      surface_type: "cobblestone",
      confidence: 75,
      model_version: "rsc-v1.0.0",
    });

    const out = callClassify(makeFeatures({ rms: 5, speed_normalized_rms: 5 }));

    expect(out.quality_class).toBe("good");
    expect(out.quality_score).toBe(3.7);
    expect(out.surface_type).toBe("cobblestone");
    expect(out.confidence).toBe(75);
    expect(out.model_version).toBe("rsc-v1.0.0");
    // RMS still comes from the raw feature (not the speed-normalised
    // value the heuristic uses for thresholding) — the backend stores
    // this verbatim.
    expect(out.rms).toBe(5);
  });
});

describe("sensorService.classify — heuristic fallback", () => {
  beforeEach(() => {
    jest.spyOn(mlClassifier, "classify").mockReturnValue(null);
  });

  it("classifies a smooth ride as excellent with model_version=null", () => {
    const out = callClassify(makeFeatures({ speed_normalized_rms: 0.5 }));
    expect(out.quality_class).toBe("excellent");
    expect(out.model_version).toBeNull();
  });

  it("escalates classes monotonically as RMS rises", () => {
    const samples = [
      { rms: 0.5, expected: "excellent" },
      { rms: 2.0, expected: "good" },
      { rms: 4.0, expected: "fair" },
      { rms: 7.0, expected: "poor" },
      { rms: 12.0, expected: "very_poor" },
    ];

    for (const { rms, expected } of samples) {
      const out = callClassify(makeFeatures({ speed_normalized_rms: rms }));
      expect(out.quality_class).toBe(expected);
    }
  });

  it("infers gravel from high zero-crossing-rate and elevated RMS", () => {
    const out = callClassify(
      makeFeatures({ speed_normalized_rms: 4, zero_crossing_rate: 0.5 }),
    );
    expect(out.surface_type).toBe("gravel");
  });

  it("infers cobblestone from a high crest factor", () => {
    const out = callClassify(
      makeFeatures({ speed_normalized_rms: 4, crest_factor: 6 }),
    );
    expect(out.surface_type).toBe("cobblestone");
  });

  it("defaults to 'unknown' when the heuristic can't separate the surface", () => {
    // The heuristic only reliably separates gravel and cobblestone —
    // claiming 'asphalt' for anything that isn't those two would
    // poison the backend's surface aggregations with low-confidence
    // labels. 'unknown' lets the backend choose to drop the field.
    const out = callClassify(
      makeFeatures({
        speed_normalized_rms: 0.5,
        zero_crossing_rate: 0.05,
        crest_factor: 1.5,
      }),
    );
    expect(out.surface_type).toBe("unknown");
  });

  it("uses a higher confidence above 20 km/h", () => {
    const slow = callClassify(makeFeatures({ speed_kmh: 5 }));
    const fast = callClassify(makeFeatures({ speed_kmh: 50 }));
    expect(fast.confidence).toBeGreaterThan(slow.confidence);
  });
});

describe("sensorService.tagSurface (research issue #7)", () => {
  // The service is a singleton — ensure recording is stopped between
  // specs so a buffered tag from one test doesn't bleed into the next.
  afterEach(() => {
    if (sensorService.recording) {
      sensorService.stop();
    }
  });

  it("returns null when recording isn't active so a stray tap is dropped", () => {
    expect(sensorService.tagSurface("cobblestone")).toBeNull();
    expect(sensorService.getTagEvents()).toEqual([]);
  });

  it("buffers tags during a ride and emits them on stop()", () => {
    sensorService.start(() => undefined);
    const a = sensorService.tagSurface("smooth_asphalt");
    const b = sensorService.tagSurface("pothole");

    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a!.label).toBe("smooth_asphalt");
    expect(b!.label).toBe("pothole");
    expect(sensorService.getTagEvents()).toHaveLength(2);

    const { tagEvents } = sensorService.stop();
    expect(tagEvents).toHaveLength(2);
    expect(tagEvents.map((e) => e.label)).toEqual([
      "smooth_asphalt",
      "pothole",
    ]);

    // After stop the buffer is cleared so the next ride starts clean.
    expect(sensorService.getTagEvents()).toEqual([]);
  });

  it("omits lat/lng from tags fired before the first GPS fix", () => {
    sensorService.start(() => undefined);
    const event = sensorService.tagSurface("gravel");

    expect(event).not.toBeNull();
    expect(event!.lat).toBeUndefined();
    expect(event!.lng).toBeUndefined();
  });

  it("caps the tag buffer at MAX_TAG_EVENTS_PER_UPLOAD by trimming oldest taps", () => {
    // Regression: without the cap, a long labelling ride that exceeds
    // the backend DTO's @ArrayMaxSize(500) would produce a payload the
    // backend rejects with HTTP 400, and the offline queue treats 4xx
    // as non-retriable — so the entire upload (tags AND readings)
    // gets dropped. The client-side cap keeps the most-recent 500
    // taps so the upload always validates.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { MAX_TAG_EVENTS_PER_UPLOAD } =
      require("@tarmoto/shared") as typeof import("@tarmoto/shared");

    sensorService.start(() => undefined);
    for (let i = 0; i < MAX_TAG_EVENTS_PER_UPLOAD + 5; i++) {
      sensorService.tagSurface("smooth_asphalt");
    }

    expect(sensorService.getTagEvents()).toHaveLength(
      MAX_TAG_EVENTS_PER_UPLOAD,
    );
  });

  it("preserves a real 0° GPS fix instead of dropping it as falsy", () => {
    // Regression: a previous version used `this.currentLat || undefined`
    // which silently dropped the equator (lat 0) and the prime meridian
    // (lng 0). The fix gates on a `hasGpsFix` flag set inside
    // `updateLocation`, so a real 0° reading is preserved verbatim.
    sensorService.start(() => undefined);
    sensorService.updateLocation(0, 0, 25);
    const event = sensorService.tagSurface("rough_asphalt");

    expect(event).not.toBeNull();
    expect(event!.lat).toBe(0);
    expect(event!.lng).toBe(0);
  });
});

describe("sensorService.extractFeatures — spectral + gyro + longitudinal (issue #492)", () => {
  // The service is a singleton; ensure recording state and the
  // previous-speed cache are reset between specs so the
  // `acceleration_longitudinal` feature has a clean baseline.
  beforeEach(() => {
    if (sensorService.recording) sensorService.stop();
    // start/stop primes the previousSpeedMs reset path.
    sensorService.start(() => undefined);
  });
  afterEach(() => {
    if (sensorService.recording) sensorService.stop();
  });

  it("populates every WindowFeatures field", () => {
    const features = callExtract(makeStaticWindow());
    // Every key the v1.1 contract expects must be present so the
    // feature vector packer doesn't end up packing `undefined → 0`.
    const expectedKeys: (keyof WindowFeatures)[] = [
      "rms",
      "std",
      "peak_to_peak",
      "crest_factor",
      "zero_crossing_rate",
      "percentile_95",
      "kurtosis",
      "skewness",
      "spectral_centroid",
      "spectral_energy_low",
      "spectral_energy_mid",
      "spectral_energy_high",
      "dominant_frequency",
      "spectral_entropy",
      "band_ratio_high_low",
      "gyro_rms",
      "gyro_pitch_var",
      "gyro_roll_var",
      "speed_kmh",
      "speed_normalized_rms",
      "acceleration_longitudinal",
      "max_abs_lean_deg",
      "timestamp",
    ];
    for (const key of expectedKeys) {
      expect(features).toHaveProperty(key);
      expect(typeof features[key]).toBe("number");
    }
  });

  it("emits zeros for spectral features on a quiet (1 g) window", () => {
    const features = callExtract(makeStaticWindow());
    expect(features.spectral_energy_low).toBe(0);
    expect(features.spectral_energy_mid).toBe(0);
    expect(features.spectral_energy_high).toBe(0);
    expect(features.dominant_frequency).toBe(0);
    expect(features.spectral_entropy).toBe(0);
  });

  it("places a 5 Hz vertical vibration in the mid spectral band", () => {
    // The feature extractor takes `|mag - g|` (a half-wave rectifier
    // on the sine), which doubles the dominant frequency: a 5 Hz input
    // shows up as a ~10 Hz bump in the deviation signal — squarely in
    // the spec's mid band (5–15 Hz, road texture).
    const features = callExtract(makeVibratingWindow(5, 1.5));
    expect(features.dominant_frequency).toBeGreaterThan(8);
    expect(features.dominant_frequency).toBeLessThan(12);
    expect(features.spectral_energy_mid).toBeGreaterThan(
      features.spectral_energy_low,
    );
    expect(features.spectral_energy_mid).toBeGreaterThan(
      features.spectral_energy_high,
    );
  });

  it("computes gyro_pitch_var / gyro_roll_var from gy / gx samples", () => {
    const features = callExtract(makeVibratingWindow(10, 1.0));
    // Roll signal in the synthetic window has 2× the amplitude of
    // pitch so its variance must be larger.
    expect(features.gyro_roll_var).toBeGreaterThan(features.gyro_pitch_var);
    expect(features.gyro_pitch_var).toBeGreaterThan(0);
  });

  it("computes acceleration_longitudinal from the GPS speed delta", () => {
    // First window: previousSpeed is null so the feature is forced to
    // 0 — the runtime can't fabricate a delta against an undefined
    // baseline.
    sensorService.updateLocation(0, 0, 36); // 36 km/h = 10 m/s
    const first = callExtract(makeStaticWindow());
    expect(first.acceleration_longitudinal).toBe(0);

    // Second window after a step from 10 → 13 m/s in 1 s of window
    // step → +3 m/s² (modest acceleration). The window step is
    // WINDOW_STEP / SAMPLE_RATE_HZ = 50 / 50 = 1 s.
    sensorService.updateLocation(0, 0, 46.8); // 13 m/s
    const second = callExtract(makeStaticWindow());
    expect(second.acceleration_longitudinal).toBeCloseTo(3, 5);

    // Braking → negative longitudinal acceleration.
    sensorService.updateLocation(0, 0, 36);
    const third = callExtract(makeStaticWindow());
    expect(third.acceleration_longitudinal).toBeCloseTo(-3, 5);
  });
});
