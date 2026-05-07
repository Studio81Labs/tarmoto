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
    gyro_rms: 0.2,
    speed_kmh: 30,
    speed_normalized_rms: 1.0,
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
