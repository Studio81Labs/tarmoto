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

import { accelerometer, gyroscope } from "react-native-sensors";
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
      "device_family_iphone_pro",
      "device_family_iphone_standard",
      "device_family_pixel",
      "device_family_samsung_galaxy_s",
      "device_family_other",
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

  it("places a 10 Hz vertical vibration in the mid spectral band", () => {
    // The FFT pass receives the SIGNED deviation `mag − g`, so an
    // input at 10 Hz is preserved at ~10 Hz (it's not rectified —
    // that would alias high-band content off the 25 Hz Nyquist).
    // 10 Hz lands squarely in the mid band (5–15 Hz, road texture).
    const features = callExtract(makeVibratingWindow(10, 1.5));
    expect(features.dominant_frequency).toBeGreaterThan(8);
    expect(features.dominant_frequency).toBeLessThan(12);
    expect(features.spectral_energy_mid).toBeGreaterThan(
      features.spectral_energy_low,
    );
    expect(features.spectral_energy_mid).toBeGreaterThan(
      features.spectral_energy_high,
    );
  });

  it("places a 20 Hz vertical vibration in the high spectral band (no aliasing)", () => {
    // Regression for the rectification bug flagged on PR #502: with
    // |mag − g| as the FFT input, a 20 Hz vibration would have shown
    // up at ~10 Hz (frequency doubling pushed past Nyquist and
    // reflected back). The signed-deviation fix preserves it in the
    // high band — exactly where the model needs it for gravel/fine-
    // texture discrimination.
    const features = callExtract(makeVibratingWindow(20, 1.5));
    expect(features.dominant_frequency).toBeGreaterThanOrEqual(15);
    expect(features.dominant_frequency).toBeLessThan(25);
    expect(features.spectral_energy_high).toBeGreaterThan(
      features.spectral_energy_low,
    );
    expect(features.spectral_energy_high).toBeGreaterThan(
      features.spectral_energy_mid,
    );
  });

  it("computes gyro_pitch_var / gyro_roll_var from gy / gx samples", () => {
    const features = callExtract(makeVibratingWindow(10, 1.0));
    // Roll signal in the synthetic window has 2× the amplitude of
    // pitch so its variance must be larger.
    expect(features.gyro_roll_var).toBeGreaterThan(features.gyro_pitch_var);
    expect(features.gyro_pitch_var).toBeGreaterThan(0);
  });

  it("packs the device family one-hot from the model passed to start() (issue #494)", () => {
    if (sensorService.recording) sensorService.stop();
    sensorService.start(() => undefined, "iPhone 15 Pro");
    const features = callExtract(makeStaticWindow());
    expect(features.device_family_iphone_pro).toBe(1);
    expect(features.device_family_iphone_standard).toBe(0);
    expect(features.device_family_pixel).toBe(0);
    expect(features.device_family_samsung_galaxy_s).toBe(0);
    expect(features.device_family_other).toBe(0);
    expect(sensorService.getDeviceFamily()).toBe("iphone_pro");
  });

  it("falls back to the 'other' bucket when no device model is supplied", () => {
    if (sensorService.recording) sensorService.stop();
    sensorService.start(() => undefined);
    const features = callExtract(makeStaticWindow());
    expect(features.device_family_other).toBe(1);
    expect(features.device_family_iphone_pro).toBe(0);
    expect(sensorService.getDeviceFamily()).toBe("other");
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

/**
 * Wires the 22 Hz Butterworth low-pass into the live ingest path
 * (issue #493). The filter has to actually run on every accel/gyro
 * tick before the sample lands in the upload buffer — the unit-level
 * `sensorsFilter.test.ts` covers the math; this spec covers the
 * plumbing.
 */
describe("sensorService — sensor pre-processing filter (issue #493)", () => {
  type AccelTick = { x: number; y: number; z: number; timestamp: number };
  type AccelCallback = (tick: AccelTick) => void;
  type GyroTick = { x: number; y: number; z: number };
  type GyroCallback = (tick: GyroTick) => void;

  const accelMock = accelerometer as unknown as {
    subscribe: jest.Mock<{ unsubscribe: () => void }, [AccelCallback]>;
  };
  const gyroMock = gyroscope as unknown as {
    subscribe: jest.Mock<{ unsubscribe: () => void }, [GyroCallback]>;
  };

  afterEach(() => {
    if (sensorService.recording) sensorService.stop();
    accelMock.subscribe.mockReset();
    gyroMock.subscribe.mockReset();
  });

  it("low-pass filters ax/ay/az before the sample lands in rawReadings", () => {
    // Drive the mocked accelerometer with a step input from rest. A
    // 4th-order Butterworth low-pass has a non-zero settling time, so
    // the very first sample of a step from 0 → 9.81 must come out
    // *below* 9.81 — that's the filter doing its job. Without the
    // filter the first reading would land at 9.81 immediately.
    let capturedAccel: AccelCallback | null = null;
    accelMock.subscribe.mockImplementation((cb) => {
      capturedAccel = cb;
      return { unsubscribe: () => undefined };
    });
    gyroMock.subscribe.mockImplementation(() => ({
      unsubscribe: () => undefined,
    }));
    sensorService.start(() => undefined);
    expect(capturedAccel).not.toBeNull();

    capturedAccel!({ x: 0, y: 0, z: 9.81, timestamp: 1 });
    const { readings } = sensorService.stop();
    expect(readings).toHaveLength(1);
    // First sample of a step on Z must be attenuated — the filter's
    // initial response to a unit step is well below the steady value.
    expect(readings[0].az).toBeLessThan(9.81);
    expect(readings[0].az).toBeGreaterThan(0);
    // X and Y were zero on input AND the filter started from zero
    // state, so the output stays at zero.
    expect(readings[0].ax).toBe(0);
    expect(readings[0].ay).toBe(0);
  });

  it("filter state persists across windows so DC settles to its input", () => {
    // Feed a constant input long enough for the filter to settle.
    // Once settled, the output equals the input (DC gain = 1) — that
    // also verifies coefficients aren't being recomputed per call,
    // since recomputation would re-zero state taps every sample.
    let capturedAccel: AccelCallback | null = null;
    accelMock.subscribe.mockImplementation((cb) => {
      capturedAccel = cb;
      return { unsubscribe: () => undefined };
    });
    gyroMock.subscribe.mockImplementation(() => ({
      unsubscribe: () => undefined,
    }));
    sensorService.start(() => undefined);

    // 200 samples (4 s at 50 Hz) is well past the filter's ~50-sample
    // settling time.
    for (let i = 0; i < 200; i++) {
      capturedAccel!({ x: 0, y: 0, z: 9.81, timestamp: i });
    }
    const { readings } = sensorService.stop();
    const last = readings[readings.length - 1];
    expect(last.az).toBeCloseTo(9.81, 6);
  });

  it("filters gx/gy/gz on the gyro stream", () => {
    let capturedAccel: AccelCallback | null = null;
    let capturedGyro: GyroCallback | null = null;
    accelMock.subscribe.mockImplementation((cb) => {
      capturedAccel = cb;
      return { unsubscribe: () => undefined };
    });
    gyroMock.subscribe.mockImplementation((cb) => {
      capturedGyro = cb;
      return { unsubscribe: () => undefined };
    });
    sensorService.start(() => undefined);

    // Push one accel sample so there's a "last reading" for the gyro
    // tick to attach to, then a single gyro step.
    capturedAccel!({ x: 0, y: 0, z: 9.81, timestamp: 1 });
    capturedGyro!({ x: 1, y: 0, z: 0 });

    const { readings } = sensorService.stop();
    expect(readings).toHaveLength(1);
    // Gyro x of 1 rad/s through a freshly-reset filter — its first-
    // sample output is well below 1 (filter is settling).
    expect(readings[0].gx).toBeDefined();
    expect(readings[0].gx).toBeLessThan(1);
    expect(readings[0].gx).toBeGreaterThanOrEqual(0);
  });

  it("resets filter state on each start() so a previous ride doesn't leak", () => {
    // Run a ride, drive the filter to a steady non-zero state, stop,
    // start again, feed zeros — the very first output sample must be
    // exactly zero. If state leaked across rides it would bleed into
    // the new ride's first windows.
    let capturedAccel: AccelCallback | null = null;
    accelMock.subscribe.mockImplementation((cb) => {
      capturedAccel = cb;
      return { unsubscribe: () => undefined };
    });
    gyroMock.subscribe.mockImplementation(() => ({
      unsubscribe: () => undefined,
    }));

    sensorService.start(() => undefined);
    for (let i = 0; i < 200; i++) {
      capturedAccel!({ x: 1.5, y: -0.3, z: 9.81, timestamp: i });
    }
    sensorService.stop();

    sensorService.start(() => undefined);
    capturedAccel!({ x: 0, y: 0, z: 0, timestamp: 0 });
    const { readings } = sensorService.stop();
    expect(readings[0].ax).toBe(0);
    expect(readings[0].ay).toBe(0);
    expect(readings[0].az).toBe(0);
  });

  it("delivers unfiltered axes to subscribeReadings listeners (US-12)", () => {
    // Regression: the 22 Hz low-pass must not reach the crash
    // detector path. CrashDetector's 4 g / 100 ms thresholds are
    // tuned against the raw 50 Hz stream; the IIR edge response
    // attenuates the first samples of a step from rest, so a near-
    // threshold impact run through the filter could fail the
    // sustained-spike check and miss the alert. The listener payload
    // must carry the bridge's literal ax/ay/az values.
    let capturedAccel: AccelCallback | null = null;
    accelMock.subscribe.mockImplementation((cb) => {
      capturedAccel = cb;
      return { unsubscribe: () => undefined };
    });
    gyroMock.subscribe.mockImplementation(() => ({
      unsubscribe: () => undefined,
    }));

    const listenerSamples: { ax: number; ay: number; az: number }[] = [];
    const unsubscribe = sensorService.subscribeReadings((r) => {
      listenerSamples.push({ ax: r.ax, ay: r.ay, az: r.az });
    });

    sensorService.start(() => undefined);
    // Step from rest — filter is settling, so buffered az is below
    // 9.81. Listener must still see the raw 9.81 verbatim.
    capturedAccel!({ x: 0, y: 0, z: 9.81, timestamp: 1 });
    capturedAccel!({ x: 1.0, y: -2.0, z: 9.81, timestamp: 2 });

    const { readings } = sensorService.stop();
    unsubscribe();

    expect(listenerSamples).toHaveLength(2);
    expect(listenerSamples[0]).toEqual({ ax: 0, ay: 0, az: 9.81 });
    expect(listenerSamples[1]).toEqual({ ax: 1.0, ay: -2.0, az: 9.81 });
    // Buffered (filtered) reading is still attenuated for the same
    // tick — proves the listener received raw, not filtered.
    expect(readings[0].az).toBeLessThan(9.81);
  });

  it("delivers raw axes to listeners even after the filter has settled", () => {
    // The unfiltered/listener split shouldn't depend on filter state.
    // After 200 samples of constant input the filter has converged,
    // but the listener must still see the bridge's literal value on
    // the next tick (regression against accidentally feeding the
    // filtered reading to listeners once the difference is small).
    let capturedAccel: AccelCallback | null = null;
    accelMock.subscribe.mockImplementation((cb) => {
      capturedAccel = cb;
      return { unsubscribe: () => undefined };
    });
    gyroMock.subscribe.mockImplementation(() => ({
      unsubscribe: () => undefined,
    }));

    const listenerSamples: { ax: number; ay: number; az: number }[] = [];
    const unsubscribe = sensorService.subscribeReadings((r) => {
      listenerSamples.push({ ax: r.ax, ay: r.ay, az: r.az });
    });

    sensorService.start(() => undefined);
    for (let i = 0; i < 200; i++) {
      capturedAccel!({ x: 0, y: 0, z: 9.81, timestamp: i });
    }
    // Sharp impulse on the next tick — listener must report 50 verbatim.
    capturedAccel!({ x: 0, y: 0, z: 50, timestamp: 200 });

    sensorService.stop();
    unsubscribe();

    expect(listenerSamples[200]).toEqual({ ax: 0, ay: 0, az: 50 });
  });

  it("feeds the same low-pass-filtered axes to the idle-baseline calibrator (issue #494)", () => {
    // Regression: the calibrator and `extractFeatures` have to operate
    // in the SAME signal domain so the per-axis bias subtraction lines
    // up. Feeding raw axes to the calibrator while subtracting the
    // resulting mean from filtered axes inflates the captured std
    // (raw noise > filtered noise) and would unnecessarily flip valid
    // stationary captures to `'poor'` via the std gate.
    //
    // Pin the wiring filter-coefficient-agnostic: drive a step input
    // (0 → 9.81) so the filter's transient is non-zero in the early
    // samples (`reading.az < 9.81` until the IIR settles). The
    // calibrator's per-axis mean MUST match the mean of the
    // post-filter readings exactly — that proves both consumers
    // pulled from the same filter output. If the calibrator were
    // still reading raw, its mean would equal 9.81 verbatim
    // (no transient) while the readings mean would land below 9.81.
    let capturedAccel: AccelCallback | null = null;
    accelMock.subscribe.mockImplementation((cb) => {
      capturedAccel = cb;
      return { unsubscribe: () => undefined };
    });
    gyroMock.subscribe.mockImplementation(() => ({
      unsubscribe: () => undefined,
    }));

    sensorService.start(() => undefined);
    expect(capturedAccel).not.toBeNull();

    const targetSamples = 30 * 50; // 30 s @ 50 Hz — full calibration window
    for (let i = 0; i <= targetSamples; i += 1) {
      // Step from rest at i=0; constant 9.81 thereafter so the filter
      // transient sits entirely within the calibration window.
      capturedAccel!({
        x: 0,
        y: 0,
        z: 9.81,
        timestamp: i * 20,
      });
    }

    const { readings, calibration } = sensorService.stop();
    expect(calibration).not.toBeNull();

    // The first few readings are below 9.81 because the 4th-order
    // Butterworth has non-zero settling time — that asymmetry is what
    // distinguishes filtered from raw.
    expect(readings[0].az).toBeLessThan(9.81);

    // The calibrator's per-axis mean must equal the mean of the
    // post-filter readings to numerical precision. Anything else
    // means the two paths sourced different signals.
    const expectedMean =
      readings.reduce((s, r) => s + r.az, 0) / readings.length;
    expect(calibration!.axis_mean_z).toBeCloseTo(expectedMean, 6);
  });
});

describe("sensorService idle-baseline calibration (issue #494)", () => {
  /**
   * Helper that drives the sensor service's accelerometer pipeline by
   * directly poking the `calibrator` private member. This sidesteps
   * the rxjs subscription machinery (mocked above) while still
   * exercising the feature pipeline's calibration-aware code path —
   * the same calibrator instance is consulted from `extractFeatures`.
   */
  function pokeCalibrator(
    samples: {
      ax: number;
      ay: number;
      az: number;
      t: number;
      speedMs?: number;
    }[],
  ) {
    const cal = (
      sensorService as unknown as {
        calibrator: { push(s: unknown): boolean } | null;
      }
    ).calibrator;
    if (!cal) throw new Error("calibrator missing — start() not called?");
    for (const s of samples) cal.push(s);
  }

  function callExtract(window: Reading[]): WindowFeatures {
    return (
      sensorService as unknown as {
        extractFeatures(w: Reading[]): WindowFeatures;
      }
    ).extractFeatures(window);
  }

  beforeEach(() => {
    if (sensorService.recording) sensorService.stop();
    sensorService.start(() => undefined, "iPhone 15");
  });
  afterEach(() => {
    if (sensorService.recording) sensorService.stop();
  });

  it("uses the calibrated rest magnitude in place of 9.81 for scalar deviations", () => {
    // The v1.1 model contract is `|a| − rest` (signed) for the FFT
    // and `abs(|a| − rest)` for the time-domain features. With a
    // good calibration we substitute the captured `||bias||` for the
    // literal 9.81 — that absorbs per-rider MEMS scale-factor error
    // without changing the model's input distribution.
    //
    // Drive the calibrator with a stationary phone whose total accel
    // magnitude is 9.4 (not the canonical 9.81 — typical for a
    // device with ~4 % scale-factor error). A window of identical
    // samples taken AFTER the calibration window should land at
    // ~0 deviation: the rest magnitude is also 9.4 and `|a| − rest = 0`.
    // Without calibration the same window would land at
    // |9.4 − 9.81| = 0.41, so the test would fail in a regression
    // that restored the literal 9.81 baseline.
    const ax = 0;
    const ay = 1.0;
    const az = Math.sqrt(9.4 * 9.4 - ay * ay); // gives ‖(0, 1, az)‖ = 9.4
    const stationarySamples: {
      ax: number;
      ay: number;
      az: number;
      t: number;
      speedMs: number;
    }[] = [];
    for (let i = 0; i <= 1500; i += 1) {
      stationarySamples.push({ ax, ay, az, t: i * 20, speedMs: 0 });
    }
    pokeCalibrator(stationarySamples);

    expect(sensorService.getCalibration()).not.toBeNull();

    const window: Reading[] = Array.from({ length: 100 }, (_, i) => ({
      t: 30_000 + i * 20,
      ax,
      ay,
      az,
      gx: 0,
      gy: 0,
      gz: 0,
    }));
    const features = callExtract(window);
    expect(features.rms).toBeCloseTo(0, 3);
    expect(features.std).toBeCloseTo(0, 3);
  });

  it("keeps the v1.1 inference contract intact for orthogonal vibrations", () => {
    // Regression: an earlier revision applied per-axis bias
    // subtraction to the time-domain features (`||a − bias||`),
    // which inflated RMS for vibrations perpendicular to gravity
    // because the orthogonal vibration lands fully in the residual
    // vector while the SCALAR deviation `|a| − ||bias||` stays
    // small (gravity magnitude is invariant under a perpendicular
    // rotation). That shift would push the v1.1 model out of
    // distribution. This test pins the scalar contract: calibrate
    // on a stationary 9.81 capture, then feed a window where
    // gravity stays on Z but a 1 m/s² wobble lands on Y. RMS must
    // approach the SCALAR amplitude (≈ 0.05 m/s²: `√(9.81² + 1²) ≈
    // 9.86`, deviation ≈ 0.05) — not the orthogonal vibration's
    // 0.71 raw amplitude that a residual-vector contract would
    // produce.
    const stationarySamples: {
      ax: number;
      ay: number;
      az: number;
      t: number;
      speedMs: number;
    }[] = [];
    for (let i = 0; i <= 1500; i += 1) {
      stationarySamples.push({
        ax: 0,
        ay: 0,
        az: 9.81,
        t: i * 20,
        speedMs: 0,
      });
    }
    pokeCalibrator(stationarySamples);
    expect(sensorService.getCalibration()).not.toBeNull();

    // Lateral wobble: 1 m/s² oscillation on Y, gravity still on Z.
    const window: Reading[] = Array.from({ length: 100 }, (_, i) => ({
      t: 30_000 + i * 20,
      ax: 0,
      ay: i % 2 === 0 ? 1.0 : -1.0,
      az: 9.81,
      gx: 0,
      gy: 0,
      gz: 0,
    }));
    const features = callExtract(window);
    // Scalar contract: |√(0² + 1² + 9.81²) − 9.81| ≈ |9.861 − 9.81|
    //                 = 0.051
    expect(features.rms).toBeLessThan(0.1);
    // The residual-vector contract would have produced rms ≈ 1.0.
    // Pin a tight upper bound that the residual-vector regression
    // would fail decisively.
    expect(features.rms).toBeGreaterThan(0);
  });

  it("falls back to the (mag − 9.81) contract before calibration completes", () => {
    // Without a calibration snapshot the feature pipeline must keep
    // its historical contract so the v1.1 model and heuristic
    // thresholds stay aligned. A static window at exactly 1g still
    // produces ~0 deviation under either contract — but a window
    // containing a 9.0 g reading (no calibration yet) should produce
    // an obvious non-zero deviation.
    expect(sensorService.getCalibration()).toBeNull();

    const window: Reading[] = Array.from({ length: 100 }, (_, i) => ({
      t: i * 20,
      ax: 0,
      ay: 0,
      az: 9.0, // 0.81 m/s² below gravity
      gx: 0,
      gy: 0,
      gz: 0,
    }));
    const features = callExtract(window);
    // |9.0 - 9.81| = 0.81; rms of a constant signal == |signal|.
    expect(features.rms).toBeCloseTo(0.81, 2);
  });

  it("stop() returns the calibration payload alongside readings and tags", () => {
    const stationarySamples: {
      ax: number;
      ay: number;
      az: number;
      t: number;
      speedMs: number;
    }[] = [];
    for (let i = 0; i <= 1500; i += 1) {
      stationarySamples.push({
        ax: 0.05,
        ay: -0.02,
        az: 9.79,
        t: i * 20,
        speedMs: 0,
      });
    }
    pokeCalibrator(stationarySamples);

    const { calibration } = sensorService.stop();
    expect(calibration).not.toBeNull();
    expect(calibration!.axis_mean_x).toBeCloseTo(0.05, 4);
    expect(calibration!.axis_mean_y).toBeCloseTo(-0.02, 4);
    expect(calibration!.axis_mean_z).toBeCloseTo(9.79, 4);
    expect(calibration!.truncated).toBe(false);
    // Sample count includes the boundary sample (i = 1500).
    expect(calibration!.sample_count).toBeGreaterThanOrEqual(1500);
  });

  it("stop() returns null calibration when the rider never sat still long enough", () => {
    // Push exactly one sample with non-zero speed → the calibrator
    // abandons the window without producing a snapshot.
    pokeCalibrator([{ ax: 0, ay: 0, az: 9.81, t: 0, speedMs: 5 }]);
    const { calibration } = sensorService.stop();
    expect(calibration).toBeNull();
  });

  it("falls back to the (mag − 9.81) contract when the captured calibration is poor", () => {
    // Regression: a rider who starts moving before the first GPS fix
    // can produce a calibration window from contaminated samples
    // (`speedMs: undefined` lets the calibrator complete on motion).
    // The backend tags such uploads `'poor'`, but the on-device
    // feature pipeline would otherwise pin the bad bias for the
    // whole ride. Gate on the cached snapshot quality so a poor
    // window falls back to the historical (mag − 9.81) contract
    // until a good calibration is captured.
    const noisySamples: {
      ax: number;
      ay: number;
      az: number;
      t: number;
    }[] = [];
    for (let i = 0; i <= 1500; i += 1) {
      const sign = i % 2 === 0 ? 1 : -1;
      noisySamples.push({
        ax: 1.5 * sign,
        ay: 1.5 * sign,
        az: 9.81 + 1.5 * sign,
        t: i * 20,
        // speedMs intentionally absent so the calibrator doesn't
        // self-truncate on movement.
      });
    }
    pokeCalibrator(noisySamples);

    // The captured calibration is uploaded so the backend can persist
    // the 'poor' tag for analytics — that part stays the same.
    expect(sensorService.getCalibration()).not.toBeNull();

    // Feature extraction on a static 1g window must use the
    // pre-calibration fallback (mag − 9.81 ≈ 0), NOT the contaminated
    // bias (which would skew the residual into a non-zero rms).
    const window: Reading[] = Array.from({ length: 100 }, (_, i) => ({
      t: 30_000 + i * 20,
      ax: 0,
      ay: 0,
      az: 9.81,
      gx: 0,
      gy: 0,
      gz: 0,
    }));
    const features = callExtract(window);
    expect(features.rms).toBeCloseTo(0, 3);
  });
});
