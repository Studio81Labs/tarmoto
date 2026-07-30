/**
 * `sys_accel_collection` defense-in-depth on the sensor service.
 *
 * RideActiveScreen already gates the ride-start call, but `sensorService` is a
 * singleton with other potential callers, so `start()` itself refuses to
 * subscribe when the operator kill switch is force-disabled. This guarantees
 * the raw 50Hz accelerometer/gyro streams never spin up while the switch is off,
 * regardless of call site. The common path (switch ON) must be unaffected.
 */

jest.mock("react-native-sensors", () => ({
  __esModule: true,
  accelerometer: { subscribe: jest.fn(() => ({ unsubscribe: jest.fn() })) },
  gyroscope: { subscribe: jest.fn(() => ({ unsubscribe: jest.fn() })) },
  setUpdateIntervalForType: jest.fn(),
  SensorTypes: { accelerometer: "accelerometer", gyroscope: "gyroscope" },
}));

jest.mock("../systemSwitchCache", () => ({
  isSystemSwitchEnabled: jest.fn(),
}));

import { accelerometer, gyroscope } from "react-native-sensors";
import { isSystemSwitchEnabled } from "../systemSwitchCache";
import { sensorService, type WindowFeatures } from "../sensors";
import * as mlClassifier from "../mlClassifier";

const mockedIsEnabled = isSystemSwitchEnabled as jest.MockedFunction<
  typeof isSystemSwitchEnabled
>;
// Cast through `unknown` (as sensors.test.ts does) so we don't reference the
// deprecated rxjs `subscribe` overload the lint rule flags.
const accelSubscribe = (accelerometer as unknown as { subscribe: jest.Mock })
  .subscribe;
const gyroSubscribe = (gyroscope as unknown as { subscribe: jest.Mock })
  .subscribe;

describe("sensorService.start — sys_accel_collection gate", () => {
  afterEach(() => {
    if (sensorService.recording) sensorService.stop();
    accelSubscribe.mockClear();
    gyroSubscribe.mockClear();
    mockedIsEnabled.mockReset();
  });

  it("does not subscribe to the sensor streams when the switch is force-disabled", () => {
    mockedIsEnabled.mockReturnValue(false);

    sensorService.start(() => undefined);

    expect(mockedIsEnabled).toHaveBeenCalledWith("sys_accel_collection");
    expect(sensorService.recording).toBe(false);
    expect(accelSubscribe).not.toHaveBeenCalled();
    expect(gyroSubscribe).not.toHaveBeenCalled();
  });

  it("subscribes normally when the switch is enabled", () => {
    mockedIsEnabled.mockReturnValue(true);

    sensorService.start(() => undefined);

    expect(sensorService.recording).toBe(true);
    expect(accelSubscribe).toHaveBeenCalledTimes(1);
    expect(gyroSubscribe).toHaveBeenCalledTimes(1);
  });
});

/**
 * `sys_surface_ml_classification` gate on the per-window classifier. When the
 * operator force-disables the switch, `classify()` must skip the TF Lite model
 * entirely and fall through to the RMS heuristic, so a misbehaving model
 * release can be killed without an app update while rides keep classifying.
 */
function makeMlGateFeatures(rms: number): WindowFeatures {
  return {
    rms,
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
    speed_normalized_rms: rms,
    acceleration_longitudinal: 0,
    max_abs_lean_deg: 0,
    timestamp: 0,
  };
}

function callClassify(features: WindowFeatures) {
  return (
    sensorService as unknown as {
      classify(f: WindowFeatures): { model_version: string | null };
    }
  ).classify(features);
}

describe("sensorService.classify — sys_surface_ml_classification gate", () => {
  beforeEach(() => {
    // These tests drive the private `classify()` directly (no start()), so
    // reset the session marker the singleton carries between rides.
    (
      sensorService as unknown as { sessionModelVersion: string | null }
    ).sessionModelVersion = null;
  });
  afterEach(() => {
    jest.restoreAllMocks();
    mockedIsEnabled.mockReset();
  });

  it("skips the ML model and uses the heuristic when the switch is force-disabled", () => {
    mockedIsEnabled.mockReturnValue(false);
    const classifySpy = jest.spyOn(mlClassifier, "classify");
    const warmupSpy = jest
      .spyOn(mlClassifier, "warmup")
      .mockResolvedValue(false);

    const out = callClassify(makeMlGateFeatures(0.5));

    expect(mockedIsEnabled).toHaveBeenCalledWith(
      "sys_surface_ml_classification",
    );
    expect(classifySpy).not.toHaveBeenCalled();
    // Disabled → never even attempt to load the model.
    expect(warmupSpy).not.toHaveBeenCalled();
    // Heuristic result → no model version attached.
    expect(out.model_version).toBeNull();
  });

  it("consults the ML model when the switch is enabled and the model is ready", () => {
    mockedIsEnabled.mockReturnValue(true);
    jest.spyOn(mlClassifier, "isReady").mockReturnValue(true);
    const warmupSpy = jest
      .spyOn(mlClassifier, "warmup")
      .mockResolvedValue(true);
    const classifySpy = jest.spyOn(mlClassifier, "classify").mockReturnValue({
      quality_class: "good",
      quality_score: 3.7,
      surface_type: "cobblestone",
      confidence: 75,
      model_version: "rsc-v1.0.0",
    });

    const out = callClassify(makeMlGateFeatures(5));

    expect(classifySpy).toHaveBeenCalledTimes(1);
    // Already loaded → no redundant warmup.
    expect(warmupSpy).not.toHaveBeenCalled();
    expect(out.model_version).toBe("rsc-v1.0.0");
  });

  it("reports no session model version when a ready model is gated off for the whole ride", () => {
    // Codex P2: the batch marker (`client_model_version`) must reflect ACTUAL
    // per-ride ML use, not mere model readiness. A model warmed by an earlier
    // ride stays `isReady()`, but if the switch is off this ride, no window
    // uses it — the uploaded marker must be null, not the model version.
    mockedIsEnabled.mockReturnValue(false);
    jest.spyOn(mlClassifier, "isReady").mockReturnValue(true);
    const classifySpy = jest.spyOn(mlClassifier, "classify").mockReturnValue({
      quality_class: "good",
      quality_score: 3.7,
      surface_type: "cobblestone",
      confidence: 75,
      model_version: "rsc-v1.0.0",
    });

    callClassify(makeMlGateFeatures(0.5));

    expect(classifySpy).not.toHaveBeenCalled();
    expect(sensorService.getSessionModelVersion()).toBeNull();
  });

  it("reports the model version once a window actually classified with ML", () => {
    mockedIsEnabled.mockReturnValue(true);
    jest.spyOn(mlClassifier, "isReady").mockReturnValue(true);
    jest.spyOn(mlClassifier, "classify").mockReturnValue({
      quality_class: "good",
      quality_score: 3.7,
      surface_type: "cobblestone",
      confidence: 75,
      model_version: "rsc-v1.0.0",
    });

    callClassify(makeMlGateFeatures(5));

    expect(sensorService.getSessionModelVersion()).toBe("rsc-v1.0.0");
  });

  it("kicks a warmup when the switch is flipped on mid-ride and the model is not yet loaded", () => {
    // Simulates the off→on transition: start() skipped warmup while the switch
    // was off, so the model is unloaded. The per-window path must trigger the
    // load so subsequent windows can use ML instead of the heuristic forever.
    mockedIsEnabled.mockReturnValue(true);
    jest.spyOn(mlClassifier, "isReady").mockReturnValue(false);
    const warmupSpy = jest
      .spyOn(mlClassifier, "warmup")
      .mockResolvedValue(true);
    // Model not ready yet → this window still falls back to the heuristic.
    jest.spyOn(mlClassifier, "classify").mockReturnValue(null);

    const out = callClassify(makeMlGateFeatures(0.5));

    expect(warmupSpy).toHaveBeenCalledTimes(1);
    expect(out.model_version).toBeNull();
  });
});
