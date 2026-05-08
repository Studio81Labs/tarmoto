/**
 * Idle-baseline calibrator (issue #494).
 *
 * The calibrator captures the first ~30 s of stationary samples at
 * ride start and yields per-axis mean/std. Three failure modes the
 * tests have to keep correct as the calibrator evolves:
 *
 *   1. Natural close after the target window (rider sat still the
 *      whole time) — captures the full sample count, `truncated:false`.
 *   2. Early truncation (rider started moving) AFTER the minimum
 *      sample-count floor — captures whatever was banked, sets
 *      `truncated:true`.
 *   3. Sub-floor truncation (rider started moving before the floor) —
 *      yields no snapshot at all; the consumer ships the readings
 *      without a calibration block.
 */

import {
  CALIBRATION_MIN_SECONDS,
  CALIBRATION_TARGET_SECONDS,
} from "@tarmoto/shared";
import {
  IdleBaselineCalibrator,
  type CalibrationSample,
} from "../idleBaselineCalibrator";

const SAMPLE_INTERVAL_MS = 20; // 50 Hz

function makeStationarySample(
  i: number,
  speedMs = 0,
  bias = { x: 0.05, y: -0.02, z: 9.79 },
): CalibrationSample {
  return {
    t: i * SAMPLE_INTERVAL_MS,
    ax: bias.x,
    ay: bias.y,
    az: bias.z,
    speedMs,
  };
}

function feedSamples(
  cal: IdleBaselineCalibrator,
  count: number,
  speedMs = 0,
): boolean {
  let done = false;
  for (let i = 0; i < count; i += 1) {
    done = cal.push(makeStationarySample(i, speedMs)) || done;
    if (done) break;
  }
  return done;
}

describe("IdleBaselineCalibrator", () => {
  it("captures the full target window and reports a non-truncated snapshot", () => {
    const cal = new IdleBaselineCalibrator();
    const targetSamples = CALIBRATION_TARGET_SECONDS * 50;

    // Feed exactly the target window. The calibrator closes on the
    // sample at `t = target * 1000` (the comparison is `>=`).
    let done = false;
    for (let i = 0; i <= targetSamples; i += 1) {
      done = cal.push(makeStationarySample(i)) || done;
      if (done) break;
    }

    expect(done).toBe(true);
    const snapshot = cal.snapshot();
    expect(snapshot).not.toBeNull();
    expect(snapshot!.payload.truncated).toBe(false);
    // Per-axis mean should land on the bias used by `makeStationarySample`.
    expect(snapshot!.payload.axis_mean_x).toBeCloseTo(0.05, 5);
    expect(snapshot!.payload.axis_mean_y).toBeCloseTo(-0.02, 5);
    expect(snapshot!.payload.axis_mean_z).toBeCloseTo(9.79, 5);
    // Std is zero on a perfectly constant input.
    expect(snapshot!.payload.axis_std_x).toBeCloseTo(0, 5);
    expect(snapshot!.payload.axis_std_y).toBeCloseTo(0, 5);
    expect(snapshot!.payload.axis_std_z).toBeCloseTo(0, 5);
  });

  it("truncates at the minimum floor when the rider starts moving early", () => {
    const cal = new IdleBaselineCalibrator();
    // Feed more than the floor's worth of stationary samples so the
    // truncation-after-floor branch fires when the speed flips.
    const aboveFloorSamples = (CALIBRATION_MIN_SECONDS + 2) * 50;
    let done = false;
    for (let i = 0; i < aboveFloorSamples; i += 1) {
      // First N samples stationary, then the rider starts moving.
      const moving = i >= (CALIBRATION_MIN_SECONDS + 1) * 50 ? 5.0 : 0;
      done = cal.push(makeStationarySample(i, moving)) || done;
      if (done) break;
    }
    expect(done).toBe(true);
    const snapshot = cal.snapshot();
    expect(snapshot).not.toBeNull();
    expect(snapshot!.payload.truncated).toBe(true);
    expect(snapshot!.payload.sample_count).toBeGreaterThanOrEqual(
      CALIBRATION_MIN_SECONDS * 50,
    );
  });

  it("yields no snapshot when the rider moves before the minimum floor", () => {
    const cal = new IdleBaselineCalibrator();
    // Rider starts moving on the very first sample → never settles.
    let done = false;
    for (let i = 0; i < 50; i += 1) {
      done = cal.push(makeStationarySample(i, 5.0)) || done;
      if (done) break;
    }
    expect(done).toBe(true);
    expect(cal.snapshot()).toBeNull();
  });

  it("computes std from non-constant samples", () => {
    // Inject a tiny oscillation — std should equal the population std.
    const cal = new IdleBaselineCalibrator();
    const targetSamples = CALIBRATION_TARGET_SECONDS * 50;
    for (let i = 0; i <= targetSamples; i += 1) {
      const wobble = 0.1 * (i % 2 === 0 ? 1 : -1);
      cal.push({
        t: i * SAMPLE_INTERVAL_MS,
        ax: wobble,
        ay: 0,
        az: 9.81,
        speedMs: 0,
      });
    }
    const snapshot = cal.snapshot();
    expect(snapshot).not.toBeNull();
    // Mean of a balanced ±0.1 alternation is ~0; with one extra
    // sample (an even count is trivially balanced) the mean tends to 0.
    expect(snapshot!.payload.axis_mean_x).toBeCloseTo(0, 1);
    // Population std of {-0.1, +0.1} is exactly 0.1.
    expect(snapshot!.payload.axis_std_x).toBeCloseTo(0.1, 1);
  });

  it("force-finalize yields a snapshot when the floor was reached early", () => {
    // Simulates the ride-stop flow tearing the calibrator down before
    // the natural close — the consumer still gets whatever samples
    // were banked, subject to the floor.
    const cal = new IdleBaselineCalibrator();
    feedSamples(cal, (CALIBRATION_MIN_SECONDS + 1) * 50);
    expect(cal.isDone()).toBe(false);

    const snapshot = cal.finalize();
    expect(snapshot).not.toBeNull();
    expect(snapshot!.payload.truncated).toBe(true);
    expect(snapshot!.payload.sample_count).toBeGreaterThanOrEqual(
      CALIBRATION_MIN_SECONDS * 50,
    );
  });

  it("force-finalize yields no snapshot when below the floor", () => {
    const cal = new IdleBaselineCalibrator();
    feedSamples(cal, (CALIBRATION_MIN_SECONDS - 1) * 50);
    const snapshot = cal.finalize();
    expect(snapshot).toBeNull();
  });

  it("treats absent speed as not-moving (pre-GPS-fix calibration)", () => {
    // The accelerometer stream can fire before the location service
    // has delivered the first fix. Missing speed must NOT abort the
    // calibration — a stationary phone with no GPS lock should still
    // produce a clean baseline.
    const cal = new IdleBaselineCalibrator();
    const targetSamples = CALIBRATION_TARGET_SECONDS * 50;
    for (let i = 0; i <= targetSamples; i += 1) {
      cal.push({
        t: i * SAMPLE_INTERVAL_MS,
        ax: 0,
        ay: 0,
        az: 9.81,
        // speedMs intentionally absent
      });
    }
    expect(cal.snapshot()).not.toBeNull();
  });

  it("ignores samples after the window has closed", () => {
    const cal = new IdleBaselineCalibrator();
    feedSamples(cal, CALIBRATION_TARGET_SECONDS * 50 + 1);
    const before = cal.snapshot();
    // Push samples that would otherwise wildly skew the mean.
    for (let i = 0; i < 100; i += 1) {
      cal.push({
        t: 60_000 + i * SAMPLE_INTERVAL_MS,
        ax: 50,
        ay: 50,
        az: 50,
        speedMs: 0,
      });
    }
    expect(cal.snapshot()).toEqual(before);
  });

  it("tags a quiet calibration window as good", () => {
    // Stationary phone with the canonical bias produces zero per-axis
    // std. The calibrator's quality field has to land on `'good'` so
    // feature extraction applies the bias subtraction.
    const cal = new IdleBaselineCalibrator();
    feedSamples(cal, CALIBRATION_TARGET_SECONDS * 50 + 1);
    expect(cal.snapshot()?.quality).toBe("good");
  });

  it("tags a noisy calibration window as poor (regression for pre-fix moving start)", () => {
    // Pre-#494-followup: when the rider starts moving before the
    // first GPS fix, `speedMs` arrives as `undefined` and the
    // calibrator can complete from contaminated samples — the
    // backend rejects the upload as 'poor', but the mobile pipeline
    // would otherwise apply the bad bias for the rest of the ride.
    // Caching the quality on the snapshot lets `extractFeatures`
    // bypass it.
    //
    // Drive a wildly oscillating accelerometer with no speed signal;
    // the std on every axis will exceed the stationary threshold
    // (0.5 m/s²), so the snapshot must come out tagged 'poor'.
    const cal = new IdleBaselineCalibrator();
    const targetSamples = CALIBRATION_TARGET_SECONDS * 50;
    for (let i = 0; i <= targetSamples; i += 1) {
      const sign = i % 2 === 0 ? 1 : -1;
      cal.push({
        t: i * SAMPLE_INTERVAL_MS,
        ax: 1.5 * sign,
        ay: 1.5 * sign,
        az: 9.81 + 1.5 * sign,
        // speedMs intentionally absent (pre-fix) — the calibrator
        // can't gate on movement so the window completes anyway.
      });
    }
    const snap = cal.snapshot();
    expect(snap).not.toBeNull();
    expect(snap!.quality).toBe("poor");
  });
});
