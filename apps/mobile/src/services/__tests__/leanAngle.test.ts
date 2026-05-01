/**
 * Lean-angle complementary filter (US-19).
 *
 * The filter has to be correct on three things:
 *
 *   1. Calibration — the first ~1.5 s of upright-bike samples should
 *      be averaged into the offset and subtracted from later readings.
 *      Otherwise a rider whose phone hangs slightly tilted on the
 *      mount would see a perpetual 5°-10° "lean" while sitting still.
 *   2. Steady-state lean — once calibrated, a sustained 25° lean
 *      should be reported as ~25°. Drift up to ~2° is acceptable
 *      because the gyro stream isn't bias-corrected, but the bias
 *      shouldn't grow without bound during a corner.
 *   3. Pre-calibration samples should report 0 (and the
 *      `isCalibrating()` flag should stay true) so the HUD's grey-out
 *      affordance doesn't flicker on the first second of the ride.
 *
 * Synthetic samples are pure data — no react-native, no native
 * sensors — so the tests run in a vanilla Node environment.
 */

import {
  computeAccelRollDeg,
  LeanAngleFilter,
  type OrientationSample,
} from "../leanAngle";

const G = 9.81;

function uprightSamples(durationMs: number, startMs = 0): OrientationSample[] {
  const samples: OrientationSample[] = [];
  for (let t = startMs; t < startMs + durationMs; t += 20) {
    samples.push({ ax: 0, ay: 0, az: G, gx: 0, t });
  }
  return samples;
}

function leanSamples(
  durationMs: number,
  rollDeg: number,
  startMs = 0,
): OrientationSample[] {
  const rad = (rollDeg * Math.PI) / 180;
  const samples: OrientationSample[] = [];
  for (let t = startMs; t < startMs + durationMs; t += 20) {
    samples.push({
      ax: 0,
      // Static body — gravity vector projected onto the bike frame.
      ay: G * Math.sin(rad),
      az: G * Math.cos(rad),
      gx: 0,
      t,
    });
  }
  return samples;
}

describe("computeAccelRollDeg", () => {
  it("reports zero degrees when az = g and ay = 0", () => {
    expect(computeAccelRollDeg(0, G)).toBeCloseTo(0, 5);
  });

  it("reports +30° when the bike is leaned right by 30°", () => {
    const rad = (30 * Math.PI) / 180;
    const ay = G * Math.sin(rad);
    const az = G * Math.cos(rad);
    expect(computeAccelRollDeg(ay, az)).toBeCloseTo(30, 1);
  });

  it("reports -45° for a left lean", () => {
    const rad = (-45 * Math.PI) / 180;
    const ay = G * Math.sin(rad);
    const az = G * Math.cos(rad);
    expect(computeAccelRollDeg(ay, az)).toBeCloseTo(-45, 1);
  });
});

describe("LeanAngleFilter.start + calibration", () => {
  it("reports 0 and stays in `isCalibrating` while the calibration window is open", () => {
    const filter = new LeanAngleFilter();
    filter.start();

    const lean = filter.update({ ax: 0, ay: 0, az: G, gx: 0, t: 0 });
    expect(lean).toBe(0);
    expect(filter.isCalibrating()).toBe(true);
  });

  it("locks in a tilted-mount offset after the calibration window so subsequent steady samples report ~0°", () => {
    const filter = new LeanAngleFilter();
    filter.start();

    // Mount is tilted 8° to the right relative to bike vertical for
    // the entire ride. After calibration the filter should subtract
    // that out, so a still-upright bike reads ~0°.
    const tilt = 8;
    const samples = leanSamples(2000, tilt);
    let last = 0;
    for (const s of samples) {
      last = filter.update(s);
    }

    expect(filter.isCalibrating()).toBe(false);
    expect(last).toBeCloseTo(0, 0);
  });

  it("finishCalibration() locks in the current average even before the window elapses", () => {
    const filter = new LeanAngleFilter();
    filter.start();

    // Tap "Calibrate" with the bike sitting at +5°: take a few
    // samples, then call finishCalibration. The next non-calibrating
    // update should reflect the +5° offset baked in.
    for (const s of leanSamples(500, 5)) {
      filter.update(s);
    }
    const stats = filter.finishCalibration();
    expect(stats.samples).toBeGreaterThan(10);
    expect(stats.offsetDeg).toBeCloseTo(5, 0);
    expect(filter.isCalibrating()).toBe(false);
  });
});

describe("LeanAngleFilter.update — corner reporting", () => {
  it("tracks a sustained 25° corner within 2° of truth", () => {
    const filter = new LeanAngleFilter();
    filter.start();

    // Settle calibration first.
    for (const s of uprightSamples(2000)) filter.update(s);

    // A real motorcycle rolls into a corner — the gyro reports the
    // angular rate during the 0→25° transient and goes quiet once
    // the rider holds the lean. Feed both phases so the
    // complementary filter can integrate the gyro transient (fast,
    // ~28°) and then the accel correction at hold can pull any
    // residual bias out (slow, but it has time over 2 s).
    const rampMs = 500;
    const finalDeg = 25;
    const rateRadS = ((finalDeg / (rampMs / 1000)) * Math.PI) / 180;
    let last = 0;
    for (let t = 2000; t < 2000 + rampMs; t += 20) {
      const progress = (t - 2000) / rampMs;
      const deg = progress * finalDeg;
      const rad = (deg * Math.PI) / 180;
      last = filter.update({
        ax: 0,
        ay: G * Math.sin(rad),
        az: G * Math.cos(rad),
        gx: rateRadS,
        t,
      });
    }
    for (const s of leanSamples(1500, finalDeg, 2000 + rampMs)) {
      last = filter.update(s);
    }
    expect(Math.abs(last - finalDeg)).toBeLessThan(2);
  });

  it("integrates the gyro stream when the rider is rolling into a corner", () => {
    const filter = new LeanAngleFilter();
    filter.start();
    for (const s of uprightSamples(2000)) filter.update(s);

    // Synthetic roll-in: gravity vector follows a 0→30° ramp over
    // 600 ms while the gyro reports the matching rate (0.873 rad/s
    // ≈ 50 deg/s). Both streams agree, so the filter should track
    // the truth tightly.
    const samples: OrientationSample[] = [];
    const rampMs = 600;
    const finalDeg = 30;
    const startT = 2000;
    for (let t = startT; t < startT + rampMs; t += 20) {
      const progress = (t - startT) / rampMs;
      const deg = progress * finalDeg;
      const rad = (deg * Math.PI) / 180;
      samples.push({
        ax: 0,
        ay: G * Math.sin(rad),
        az: G * Math.cos(rad),
        gx: ((finalDeg / (rampMs / 1000)) * Math.PI) / 180,
        t,
      });
    }

    let last = 0;
    for (const s of samples) last = filter.update(s);
    expect(Math.abs(last - finalDeg)).toBeLessThan(3);
  });

  it("clamps a runaway dt so a missed sample doesn't blow up the integration", () => {
    const filter = new LeanAngleFilter();
    filter.start();
    for (const s of uprightSamples(2000)) filter.update(s);

    // Skip a full 3-second gap (e.g. screen sleep). The next sample
    // arrives with the bike still upright and the gyro reporting
    // 1 rad/s. A naive integrator would jump by ~172° (1 rad/s × 3 s
    // × 180/π); the MAX_DT_S clamp keeps the gyro contribution to
    // at most 0.5 s × 1 rad/s ≈ 28.6°, which after blending with the
    // 0° accel correction lands ~28°.
    const lean = filter.update({
      ax: 0,
      ay: 0,
      az: G,
      gx: 1,
      t: 5000,
    });
    expect(Math.abs(lean)).toBeLessThan(30);
  });
});

describe("LeanAngleFilter.beginCalibration", () => {
  it("re-enters calibration so a fresh offset can be captured mid-ride", () => {
    const filter = new LeanAngleFilter();
    filter.start();
    for (const s of uprightSamples(2000)) filter.update(s);
    expect(filter.isCalibrating()).toBe(false);

    filter.beginCalibration();
    expect(filter.isCalibrating()).toBe(true);

    // Bike is now tilted 12° in the new mount orientation. Once the
    // window closes, that should be the new "zero".
    const tilt = 12;
    for (const s of leanSamples(2000, tilt, 2000)) {
      filter.update(s);
    }
    const last = filter.update({
      ax: 0,
      ay: G * Math.sin((tilt * Math.PI) / 180),
      az: G * Math.cos((tilt * Math.PI) / 180),
      gx: 0,
      t: 4500,
    });

    expect(filter.isCalibrating()).toBe(false);
    expect(last).toBeCloseTo(0, 0);
  });
});
