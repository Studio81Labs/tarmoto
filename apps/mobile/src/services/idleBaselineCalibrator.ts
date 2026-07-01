/**
 * Idle-baseline calibration capture (issue #494).
 *
 * Accelerometer characteristics vary significantly by phone model,
 * mounting position and case (`docs/ML_MODEL_SPEC.md` §6.2). Without
 * an explicit per-rider baseline two riders on the same road with
 * different phones produce different RMS distributions and the model
 * learns "this is a noisy device" rather than "this is a rough road".
 *
 * The fix is a calibration window at the start of every ride:
 *
 *   1. The first {@link CALIBRATION_TARGET_SECONDS} of accelerometer
 *      samples are captured while the bike is stationary.
 *   2. Per-axis mean and std are computed from those samples.
 *   3. Subsequent feature extraction subtracts the per-axis mean from
 *      raw samples *before* magnitude computation — anything left in
 *      the residual is genuine vibration, not gravity components or
 *      device bias.
 *   4. The same payload is shipped to the backend so the server can
 *      validate the calibration looks sane and persist it on the
 *      ride row for the training pipeline to consume per-rider.
 *
 * If the rider starts moving early the window is truncated to whatever
 * was captured (with a {@link CALIBRATION_MIN_SECONDS} floor) and a
 * `truncated` flag rides on the upload so analytics can down-weight
 * rough-start rides. If the rider never sits still long enough to
 * clear the floor the calibrator yields no payload at all and the
 * uploader sends the readings without a calibration block — the
 * backend treats that as `calibration_quality: null` and the training
 * pipeline can choose to drop or include those rows.
 *
 * Pure state — no React, no native modules — so the unit tests can
 * drive it with synthetic sample streams.
 */

import {
  CALIBRATION_MIN_SAMPLES,
  CALIBRATION_MIN_SECONDS,
  CALIBRATION_TARGET_SECONDS,
  classifyCalibrationQuality,
  type CalibrationPayload,
  type CalibrationQuality,
} from "@tarmoto/shared";

/**
 * Speed (m/s) above which we consider the rider to have started
 * moving. ~0.5 m/s ≈ 1.8 km/h — well below walking pace so a rider
 * push-walking the bike out of a parking lot still triggers the early
 * truncation. The GPS sensor noise floor at low speed sits around
 * 0.3 m/s, so this gate stays comfortably above false positives.
 */
const MOVEMENT_SPEED_THRESHOLD_MS = 0.5;

interface AxisStats {
  /** Per-axis sum (used for the running mean). */
  sumX: number;
  sumY: number;
  sumZ: number;
  /** Per-axis sum of squares (used for the running variance). */
  sumSqX: number;
  sumSqY: number;
  sumSqZ: number;
  count: number;
}

function emptyStats(): AxisStats {
  return {
    sumX: 0,
    sumY: 0,
    sumZ: 0,
    sumSqX: 0,
    sumSqY: 0,
    sumSqZ: 0,
    count: 0,
  };
}

export interface CalibrationSample {
  ax: number;
  ay: number;
  az: number;
  /** Sample timestamp in milliseconds. */
  t: number;
  /**
   * GPS speed in m/s at the time of the sample. Optional because the
   * accelerometer stream can fire before the location service has
   * delivered a fix; missing speed is treated as "not moving" so a
   * pre-fix calibration can still complete on a stationary phone.
   */
  speedMs?: number | undefined;
}

export interface CalibrationSnapshot {
  payload: CalibrationPayload;
  /** Per-axis mean — exposed separately so feature extraction can
   *  subtract bias without re-deriving from the payload. */
  meanX: number;
  meanY: number;
  meanZ: number;
  /**
   * Server-equivalent quality classification of the captured window
   * (issue #494). Cached at finalise time so the feature pipeline
   * doesn't re-classify on every window.
   *
   * Feature extraction MUST gate on `'good'` — a `'poor'` snapshot
   * (axis std above the stationary threshold, or sub-floor sample
   * count) reflects motion contamination and applying its bias would
   * skew the bias-subtraction in the wrong direction for the entire
   * ride. The snapshot is still uploaded so the backend can persist
   * the `'poor'` tag for analytics; the mobile pipeline simply falls
   * back to the (mag − 9.81) contract until a good calibration is
   * captured (which never happens on the same ride — calibration is
   * one-shot per ride — but a future re-calibrate trigger could
   * produce one).
   */
  quality: CalibrationQuality;
}

/**
 * Streaming idle-baseline calibrator. One instance per ride: feed
 * every accelerometer sample to {@link push}; once the calibrator
 * reports `done`, read the payload via {@link snapshot}.
 */
export class IdleBaselineCalibrator {
  private startedAt: number | null = null;
  private stats: AxisStats = emptyStats();
  private finished = false;
  private snap: CalibrationSnapshot | null = null;

  /**
   * Push one accelerometer sample. Returns `true` when the calibration
   * window has closed on this sample (either the target duration was
   * reached or the rider started moving). Subsequent calls are no-ops.
   */
  push(sample: CalibrationSample): boolean {
    if (this.finished) return true;

    if (this.startedAt === null) {
      this.startedAt = sample.t;
    }
    const elapsedMs = sample.t - this.startedAt;
    const targetMs = CALIBRATION_TARGET_SECONDS * 1000;
    const minMs = CALIBRATION_MIN_SECONDS * 1000;

    const moving =
      sample.speedMs !== undefined &&
      sample.speedMs > MOVEMENT_SPEED_THRESHOLD_MS;

    // Always tally THIS sample if we're still inside the target
    // window — even if the rider just started moving on this very
    // sample, the sample itself is taken at the moment of the start
    // and is still mostly stationary. The cutoff below decides
    // whether to close the window on the NEXT sample.
    if (elapsedMs <= targetMs) {
      this.stats.sumX += sample.ax;
      this.stats.sumY += sample.ay;
      this.stats.sumZ += sample.az;
      this.stats.sumSqX += sample.ax * sample.ax;
      this.stats.sumSqY += sample.ay * sample.ay;
      this.stats.sumSqZ += sample.az * sample.az;
      this.stats.count += 1;
    }

    // Close conditions:
    //   - target window elapsed (capture the full 30 s of samples)
    //   - rider started moving AND we have at least the minimum
    //     window's worth of samples (truncate at the floor)
    if (elapsedMs >= targetMs) {
      this.finalise(false);
      return true;
    }
    if (moving && elapsedMs >= minMs) {
      this.finalise(true);
      return true;
    }
    if (moving && elapsedMs < minMs) {
      // Rider never sat still long enough — abandon the calibration.
      // Marking finished without a snapshot lets the consumer ship
      // the readings WITHOUT a calibration block; the backend treats
      // that as `calibration_quality: null`.
      this.finished = true;
      this.snap = null;
      return true;
    }
    return false;
  }

  /**
   * Force-end the calibration window with whatever samples have been
   * collected so far. Used when the ride is stopping before the window
   * closed naturally (rider tapped Stop within the first 30 s) — the
   * floor still applies, so calibrations shorter than the minimum
   * sample count yield no snapshot.
   *
   * A forced finalisation always reports `truncated: true` when it
   * does produce a snapshot — the window closed before the target
   * elapsed, by definition.
   */
  finalize(): CalibrationSnapshot | null {
    if (!this.finished) {
      this.finalise(true);
    }
    return this.snap;
  }

  /** Whether the calibration window has closed. */
  isDone(): boolean {
    return this.finished;
  }

  /**
   * Snapshot of the captured calibration. `null` when:
   *
   *   - the window hasn't closed yet
   *   - the rider started moving before the minimum sample-count floor
   *
   * In both cases the consumer should upload the readings without a
   * calibration block (or, in the second case, without one for the
   * remainder of the ride).
   */
  snapshot(): CalibrationSnapshot | null {
    return this.snap;
  }

  private finalise(truncated: boolean): void {
    this.finished = true;
    if (this.stats.count < CALIBRATION_MIN_SAMPLES) {
      this.snap = null;
      return;
    }
    const n = this.stats.count;
    const meanX = this.stats.sumX / n;
    const meanY = this.stats.sumY / n;
    const meanZ = this.stats.sumZ / n;
    // Unbiased? No — the calibration is descriptive of the samples we
    // captured, not an inference about a wider population. Use the
    // population variance (divide by n) so a single-sample window
    // would still produce a defined std (0 in that case), matching
    // the convention the backend's validation thresholds were tuned
    // against.
    const varX = Math.max(0, this.stats.sumSqX / n - meanX * meanX);
    const varY = Math.max(0, this.stats.sumSqY / n - meanY * meanY);
    const varZ = Math.max(0, this.stats.sumSqZ / n - meanZ * meanZ);

    const payload: CalibrationPayload = {
      axis_mean_x: meanX,
      axis_mean_y: meanY,
      axis_mean_z: meanZ,
      axis_std_x: Math.sqrt(varX),
      axis_std_y: Math.sqrt(varY),
      axis_std_z: Math.sqrt(varZ),
      sample_count: n,
      truncated,
    };
    // Cache the same `'good'` / `'poor'` decision the backend will
    // make so feature extraction can bypass a contaminated bias.
    // Reuses the shared classifier so the gate stays in lockstep
    // with the server-side validation thresholds.
    this.snap = {
      meanX,
      meanY,
      meanZ,
      payload,
      quality: classifyCalibrationQuality(payload),
    };
  }
}
