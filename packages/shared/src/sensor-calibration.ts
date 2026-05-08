/**
 * Idle-baseline calibration shared contract (issue #494).
 *
 * Accelerometer characteristics vary significantly by phone model,
 * mounting position, and case (`docs/ML_MODEL_SPEC.md` §6.2). The
 * mobile client captures the first ~30 s of a ride with the bike
 * stationary, computes per-axis mean and std, then subtracts the per-
 * axis mean from raw samples before magnitude computation in the
 * downstream feature pipeline. The same payload is shipped to the
 * backend so it can sanity-check the values and persist them with the
 * ride for the training pipeline to consume per-rider.
 *
 * This module owns:
 *
 *   - the {@link CalibrationPayload} interface that flows mobile → DTO →
 *     entity (one source of truth so a renamed field surfaces as a
 *     compile error in every consumer),
 *   - the {@link CALIBRATION_*} thresholds the backend uses to flag a
 *     suspicious upload as `calibration_quality: 'poor'`,
 *   - {@link classifyCalibrationQuality} so the same heuristic runs in
 *     unit tests on both ends of the wire without drift.
 */

/**
 * Calibration window minimum acceptable duration. Matches the spec
 * (`docs/ML_MODEL_SPEC.md` §6.2): the idle window may be truncated to
 * whatever was captured if the rider starts moving early, but anything
 * shorter than ~5 s of stationary samples is too noisy to use as a
 * baseline. The mobile flow drops the window entirely if it can't reach
 * the floor; the backend rejects calibrations whose `sample_count`
 * implies < 5 s of capture (see {@link CALIBRATION_MIN_SAMPLES}).
 */
export const CALIBRATION_MIN_SECONDS = 5;

/**
 * Target calibration window duration. The capture stops as soon as the
 * rider starts moving (truncating to whatever was captured) or after
 * this many seconds elapse, whichever comes first.
 */
export const CALIBRATION_TARGET_SECONDS = 30;

/**
 * Maximum allowed per-axis std (m/s²) for a "good" calibration window.
 * A stationary phone on a stationary bike with the engine running shows
 * typical per-axis std in the 0.05–0.15 m/s² range; a value above this
 * threshold means the capture was contaminated by motion (rider rolled
 * the bike, leaned on it, fired the throttle) and the inferred bias is
 * unreliable. Used by the backend's quality classifier — any axis above
 * this floor flips `calibration_quality` to `'poor'` and the training
 * pipeline can choose to drop rows from that ride.
 *
 * Threshold matches `docs/ML_MODEL_SPEC.md` §6.2 acceptance criteria.
 */
export const CALIBRATION_STATIONARY_STD_LIMIT = 0.5;

/**
 * Reference gravity magnitude (m/s²). Real-world variation across
 * Earth's surface sits in roughly 9.78–9.83 m/s²; we use the standard
 * value as the centre of the plausibility window in
 * {@link classifyCalibrationQuality}.
 */
export const CALIBRATION_GRAVITY_MS2 = 9.81;

/**
 * Maximum tolerated deviation between a calibration's mean-vector
 * magnitude and {@link CALIBRATION_GRAVITY_MS2} for a "good" tag
 * (m/s²). For a stationary phone, ‖mean‖ has to land near gravity by
 * physics — anything else means either:
 *
 *   - the capture was non-stationary (the IMU never reaches the
 *     gravity-only steady state),
 *   - the device is fundamentally miscalibrated (sensor scale-factor
 *     error well beyond typical 1–2% MEMS bounds), or
 *   - a buggy / malicious client fabricated values to nudge
 *     downstream training in a controlled direction.
 *
 * 2.0 m/s² is generous enough to absorb realistic scale-factor error
 * (~5 %) plus mount / engine-vibration noise, yet tight enough to
 * reject obvious garbage like `axis_mean_x: 1e6`. Trusting only the
 * std + sample-count gates would let physically impossible means slip
 * through as `'good'`, and downstream pipelines that filter out only
 * `'poor'` rows would happily subtract an attacker-controlled bias.
 */
export const CALIBRATION_GRAVITY_TOLERANCE_MS2 = 2.0;

/** Sample rate we assume for translating duration ↔ sample-count. */
export const CALIBRATION_SAMPLE_RATE_HZ = 50;

/** Minimum sample count for a usable calibration window. */
export const CALIBRATION_MIN_SAMPLES =
  CALIBRATION_MIN_SECONDS * CALIBRATION_SAMPLE_RATE_HZ;

/**
 * Per-axis statistics for the idle calibration window. One value per
 * axis, captured at the start of a ride. Sent on every
 * `POST /sensor/upload` batch (a single ride may upload across
 * multiple batches via the offline queue) so the backend can persist a
 * stable per-ride baseline regardless of which batch lands first.
 */
export interface CalibrationPayload {
  /** Mean accelerometer X (m/s²) over the calibration window. */
  axis_mean_x: number;
  /** Mean accelerometer Y (m/s²) over the calibration window. */
  axis_mean_y: number;
  /** Mean accelerometer Z (m/s²) over the calibration window. */
  axis_mean_z: number;
  /** Std accelerometer X (m/s²) over the calibration window. */
  axis_std_x: number;
  /** Std accelerometer Y (m/s²) over the calibration window. */
  axis_std_y: number;
  /** Std accelerometer Z (m/s²) over the calibration window. */
  axis_std_z: number;
  /** Number of samples that contributed to the mean / std. */
  sample_count: number;
  /**
   * `true` when the rider started moving before the full
   * {@link CALIBRATION_TARGET_SECONDS} elapsed and the window was
   * truncated. Backend uses this as a soft signal — truncation alone
   * doesn't disqualify the calibration, but combined with a high std
   * it's a strong "rider didn't sit still" cue.
   */
  truncated: boolean;
}

/** Classification of how trustworthy a calibration window is. */
export type CalibrationQuality = "good" | "poor";

/**
 * Server-side quality classification. Returns `"poor"` when:
 *
 *   - any per-axis std exceeds {@link CALIBRATION_STATIONARY_STD_LIMIT}
 *     (capture contaminated by motion), OR
 *   - the sample count is below {@link CALIBRATION_MIN_SAMPLES} (rider
 *     started moving before the floor of ~5 s of stationary samples
 *     was reached — anything shorter is too noisy to use as a bias),
 *   - any numeric field (mean, std, OR `sample_count`) is non-finite
 *     — a malicious or buggy client could otherwise ship a `NaN`
 *     `sample_count` (the DTO's `@IsInt()` decorator stops most of
 *     these at the HTTP boundary, but the shared classifier is the
 *     canonical validator and runs on both ends of the wire, so
 *     defence-in-depth here means a compromised pre-DTO path can't
 *     bypass the count gate via `NaN < N === false`),
 *   - the mean-vector magnitude is more than
 *     {@link CALIBRATION_GRAVITY_TOLERANCE_MS2} away from
 *     {@link CALIBRATION_GRAVITY_MS2} — for a stationary phone the
 *     mean has to land near gravity by physics, so values far outside
 *     that window are either non-stationary captures or fabricated
 *     payloads. Trusting the std gate alone would let a buggy /
 *     malicious client ship `axis_mean_x: 1e6` with 0 std and have
 *     it persist as a "trusted" calibration.
 *
 * Otherwise `"good"`.
 *
 * Lives in `@tarmoto/shared` so the same call runs on both ends of the
 * wire — backend uses it during upload validation, mobile can use it
 * to surface "calibration captured" / "calibration looks off" UX and
 * self-test ahead of upload.
 */
export function classifyCalibrationQuality(
  payload: CalibrationPayload,
): CalibrationQuality {
  const finite = [
    payload.axis_mean_x,
    payload.axis_mean_y,
    payload.axis_mean_z,
    payload.axis_std_x,
    payload.axis_std_y,
    payload.axis_std_z,
    payload.sample_count,
  ].every(Number.isFinite);
  if (!finite) return "poor";
  if (payload.sample_count < CALIBRATION_MIN_SAMPLES) return "poor";
  if (
    payload.axis_std_x > CALIBRATION_STATIONARY_STD_LIMIT ||
    payload.axis_std_y > CALIBRATION_STATIONARY_STD_LIMIT ||
    payload.axis_std_z > CALIBRATION_STATIONARY_STD_LIMIT
  ) {
    return "poor";
  }
  // Plausibility check on the mean vector magnitude. A stationary
  // accelerometer reads gravity, so ‖mean‖ ≈ g by physics. Reject
  // captures whose mean lands wildly outside the plausible window —
  // catches both non-stationary windows (the IMU never settles to
  // pure gravity) and fabricated payloads (a malicious client
  // shipping `axis_mean_x: 1e6` with 0 std would otherwise pass the
  // std + sample-count gates above).
  const meanMagnitude = Math.sqrt(
    payload.axis_mean_x * payload.axis_mean_x +
      payload.axis_mean_y * payload.axis_mean_y +
      payload.axis_mean_z * payload.axis_mean_z,
  );
  if (
    Math.abs(meanMagnitude - CALIBRATION_GRAVITY_MS2) >
    CALIBRATION_GRAVITY_TOLERANCE_MS2
  ) {
    return "poor";
  }
  return "good";
}
