/**
 * Lean-angle estimator (US-19).
 *
 * Implements a complementary filter on accelerometer + gyroscope data
 * to track the rider's roll about the bike's longitudinal (forward)
 * axis. The filter combines two orientations:
 *
 *   - Accelerometer roll, derived per-sample from gravity:
 *       roll = atan2(ay, az)
 *     This is drift-free but noisy under bumps and acceleration.
 *
 *   - Gyroscope-integrated roll:
 *       prev + gyroX * dt
 *     This is smooth but drifts because of gyro bias.
 *
 *   - Complementary blend with `alpha = 0.98`:
 *       roll = alpha * (prev + gyroX * dt) + (1 - alpha) * accelRoll
 *     Most of the signal comes from the gyro (responsive, lag-free) and
 *     the accelerometer slowly pulls the estimate back to vertical.
 *
 * Phone-frame note: the filter expects the sensor frame to be aligned
 * with the bike — Y to the right, Z up, X forward. The phone's mounting
 * orientation rarely matches that exactly, so a calibration offset is
 * captured at ride start (and on demand) and subtracted from every
 * subsequent reading. The offset isn't applied to the gyro stream —
 * gyro X is still the rate of change of roll regardless of how the
 * phone is mounted around the longitudinal axis.
 */

const DEG_PER_RAD = 180 / Math.PI;
const DEFAULT_ALPHA = 0.98;
const MAX_DT_S = 0.5;
const CALIBRATION_WINDOW_MS = 1500;
const CALIBRATION_MIN_SAMPLES = 20;
const GYRO_REST_THRESHOLD_RAD_S = 0.35;
/**
 * Maximum allowed deviation of accelerometer magnitude from gravity
 * during calibration sampling (m/s²). Rejecting samples that fall
 * outside `g ± ACCEL_REST_TOLERANCE` keeps a calibration off-limits
 * during braking, acceleration, or cornering, where the accelerometer
 * is reading more than just gravity and the inferred roll would bake
 * in the bias permanently. ~1.0 m/s² (~0.1 g) is generous enough to
 * tolerate idle engine vibration and a wobbly mount but tight enough
 * to reject a brisk pull-away.
 */
const ACCEL_REST_TOLERANCE_MS2 = 1.0;
const GRAVITY_MS2 = 9.81;

export interface OrientationSample {
  /** Accelerometer X (m/s²). Forward axis — unused by roll math. */
  ax: number;
  /** Accelerometer Y (m/s²). Lateral axis. */
  ay: number;
  /** Accelerometer Z (m/s²). Up axis. */
  az: number;
  /** Gyroscope X (rad/s). Rate of roll about the bike's forward axis. */
  gx: number;
  /**
   * Gyroscope Y (rad/s). Pitch rate. Optional so synthetic test
   * streams that only care about roll don't have to plumb it.
   */
  gy?: number;
  /**
   * Gyroscope Z (rad/s). Yaw rate. Optional so synthetic test
   * streams that only care about roll don't have to plumb it.
   */
  gz?: number;
  /** Sample timestamp in milliseconds. */
  t: number;
}

export interface CalibrationStats {
  /** Number of samples that contributed to the offset. */
  samples: number;
  /** Inferred zero-lean accelerometer roll (degrees). */
  offsetDeg: number;
}

/**
 * Streaming complementary filter. One instance per ride: `start()` to
 * reset, then `update(...)` per sample to get the current roll. Pure
 * state — no React, no native modules — so the unit tests can drive it
 * with synthetic sample streams.
 */
export class LeanAngleFilter {
  private alpha: number;
  private rollDeg = 0;
  private lastT: number | null = null;
  private offsetDeg = 0;
  private offsetLockedSamples = 0;
  private calibrating = false;
  private calibrationStartT: number | null = null;
  private calibrationSum = 0;
  private calibrationCount = 0;

  constructor(alpha: number = DEFAULT_ALPHA) {
    this.alpha = alpha;
  }

  /**
   * Reset all filter state. Called at ride start so a previous ride's
   * accumulated drift / offset doesn't leak in. `beginCalibration()`
   * is invoked here so the first ~1.5 s of upright readings auto-set
   * the zero-lean offset without the rider needing to tap anything.
   */
  start(): void {
    this.rollDeg = 0;
    this.lastT = null;
    this.offsetDeg = 0;
    this.offsetLockedSamples = 0;
    this.beginCalibration();
  }

  /**
   * Begin a fresh calibration window. The next ~1.5 s of low-rotation
   * samples will be averaged into a new accelerometer-roll offset that
   * subtracts from future readings. Surfaced as `recalibrate()` from
   * the live HUD so a rider whose first-ride defaults look off can
   * stop, sit upright, and re-zero without ending the ride.
   */
  beginCalibration(): void {
    this.calibrating = true;
    this.calibrationStartT = null;
    this.calibrationSum = 0;
    this.calibrationCount = 0;
  }

  /**
   * Whether the filter is currently averaging readings into a new
   * offset. Surfaced so the HUD can grey out the metric while the
   * first second of a ride streams in.
   */
  isCalibrating(): boolean {
    return this.calibrating;
  }

  /** Current zero-lean offset in degrees (signed). */
  getOffsetDeg(): number {
    return this.offsetDeg;
  }

  /**
   * Update the filter with a single sample. Returns the roll-corrected
   * lean angle in **degrees** (signed; positive = right lean).
   *
   * Calibration samples are folded into the running offset average and
   * report `0` so the UI doesn't render a transient pre-calibration
   * value. After `CALIBRATION_WINDOW_MS` have elapsed (and at least
   * `CALIBRATION_MIN_SAMPLES` were captured) the offset is locked in
   * and subsequent samples report the corrected value.
   */
  update(sample: OrientationSample): number {
    const accelRollDeg = computeAccelRollDeg(sample.ay, sample.az);

    if (this.calibrating) {
      const calibrated = this.tryCalibrationSample(sample, accelRollDeg);
      if (!calibrated) {
        // Still gathering — don't advance the gyro-integrated estimate
        // either; the rider may not be moving, and integrating the
        // gyro from `t = 0` would inject a phantom roll once the
        // offset locks in.
        this.lastT = sample.t;
        this.rollDeg = 0;
        return 0;
      }
      // Calibration just locked in on this very sample. Drop `lastT`
      // so the seed-on-first-sample branch below runs and the filter
      // doesn't blend a stale `rollDeg = 0` against a post-calibration
      // 25°-corner reading — that integration would converge to the
      // truth only after ~5 s, leaving the rider's lean badly under-
      // reported through the rest of the corner.
      this.lastT = null;
    }

    if (this.lastT === null || this.offsetLockedSamples === 0) {
      // First post-calibration sample. Seed with the (offset-corrected)
      // accelerometer angle so we don't integrate from zero through a
      // 30°-leaning corner the rider entered straight after start.
      this.rollDeg = accelRollDeg - this.offsetDeg;
      this.lastT = sample.t;
      this.offsetLockedSamples = 1;
      return this.rollDeg;
    }

    let dtMs = sample.t - this.lastT;
    if (dtMs <= 0) dtMs = 20; // Reuse the 50 Hz cadence on jitter / clock skew.
    if (dtMs > MAX_DT_S * 1000) dtMs = MAX_DT_S * 1000;
    const dtS = dtMs / 1000;
    this.lastT = sample.t;

    const gyroDeg = sample.gx * DEG_PER_RAD;
    const corrected = accelRollDeg - this.offsetDeg;
    this.rollDeg =
      this.alpha * (this.rollDeg + gyroDeg * dtS) +
      (1 - this.alpha) * corrected;

    this.offsetLockedSamples += 1;
    return this.rollDeg;
  }

  /**
   * Force-end the calibration window and apply whatever samples have
   * been gathered so far. Used by the HUD's "Calibrate" button: the
   * tap itself is the rider's signal that they're upright now.
   * Returns the new offset stats so the caller can decide whether to
   * surface a "calibrated" toast.
   */
  finishCalibration(): CalibrationStats {
    if (!this.calibrating) {
      return { samples: 0, offsetDeg: this.offsetDeg };
    }
    if (this.calibrationCount > 0) {
      this.offsetDeg = this.calibrationSum / this.calibrationCount;
    }
    const stats: CalibrationStats = {
      samples: this.calibrationCount,
      offsetDeg: this.offsetDeg,
    };
    this.calibrating = false;
    this.calibrationStartT = null;
    this.calibrationSum = 0;
    this.calibrationCount = 0;
    return stats;
  }

  private tryCalibrationSample(
    sample: OrientationSample,
    accelRollDeg: number,
  ): boolean {
    if (this.calibrationStartT === null) {
      this.calibrationStartT = sample.t;
    }

    // Only bank samples taken while the bike is reasonably still — a
    // calibration captured mid-corner would lock in a permanent bias.
    //
    // Two gates, both required:
    //
    //   1. 3-axis gyro magnitude < ~20 deg/s. Bikes that are yawing
    //      (turning while upright) or pitching (braking, acceleration)
    //      can have a near-zero `gx` while the accelerometer is
    //      nonetheless reporting more than just gravity. Gating on the
    //      full gyro vector catches that. `gy` / `gz` are optional on
    //      `OrientationSample` (test fixtures that only care about
    //      roll don't plumb them); fall back to the roll-axis-only
    //      check when they're absent.
    //
    //   2. Accelerometer magnitude close to g. Centripetal acceleration
    //      from a yaw turn and linear acceleration from braking both
    //      corrupt the gravity vector even when the gyro reports near
    //      zero. Rejecting samples where `||a|| - g| > 1 m/s²` keeps
    //      those out of the calibration average regardless of what
    //      the gyro is doing.
    //
    // The thresholds are deliberately generous so an idling bike with
    // engine vibration and a slightly off-axis mount still captures
    // enough samples to lock in the offset before the window closes.
    const gx = sample.gx;
    const gy = sample.gy ?? 0;
    const gz = sample.gz ?? 0;
    const gyroMag = Math.sqrt(gx * gx + gy * gy + gz * gz);
    const accelMag = Math.sqrt(
      sample.ax * sample.ax + sample.ay * sample.ay + sample.az * sample.az,
    );
    const accelOk = Math.abs(accelMag - GRAVITY_MS2) < ACCEL_REST_TOLERANCE_MS2;
    if (gyroMag < GYRO_REST_THRESHOLD_RAD_S && accelOk) {
      this.calibrationSum += accelRollDeg;
      this.calibrationCount += 1;
    }

    const elapsed = sample.t - this.calibrationStartT;
    if (
      elapsed >= CALIBRATION_WINDOW_MS &&
      this.calibrationCount >= CALIBRATION_MIN_SAMPLES
    ) {
      this.finishCalibration();
      return true;
    }
    if (elapsed >= CALIBRATION_WINDOW_MS * 2) {
      // Window dragged on — the rider may be moving the whole time
      // (e.g. they hit Start mid-roll). Lock in whatever we have so
      // the rest of the ride doesn't run uncalibrated. Even with zero
      // samples we still flip out of calibrating mode (offset stays
      // 0, the bike-frame heuristic of `atan2(ay, az)` is accurate
      // enough on a typical mount that not calibrating is better than
      // never tracking lean).
      this.finishCalibration();
      return true;
    }
    return false;
  }
}

/**
 * Accelerometer-only roll (degrees, signed) about the longitudinal
 * (X) axis. Exported for tests and for consumers that want the raw
 * angle without the filter's gyro integration.
 */
export function computeAccelRollDeg(ay: number, az: number): number {
  // atan2 handles the upside-down case (az < 0) cleanly — no need for
  // a quadrant fix. Returns ±180° at the edges.
  return Math.atan2(ay, az) * DEG_PER_RAD;
}
