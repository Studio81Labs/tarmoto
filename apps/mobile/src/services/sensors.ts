/**
 * Tarmoto Sensor Service
 * Manages accelerometer and gyroscope data collection.
 * Handles feature extraction and on-device classification.
 */

import {
  accelerometer,
  gyroscope,
  setUpdateIntervalForType,
  SensorTypes,
} from "react-native-sensors";
import { Subscription } from "rxjs";
import type { SensorReading, QualityClass, SurfaceType } from "@/types";
import {
  MAX_TAG_EVENTS_PER_UPLOAD,
  encodeDeviceFamily,
  oneHotDeviceFamily,
  type CalibrationPayload,
  type DeviceFamily,
  type RideTagEvent,
  type SurfaceLabel,
} from "@tarmoto/shared";
import * as mlClassifier from "./mlClassifier";
import { LeanAngleFilter, type CalibrationStats } from "./leanAngle";
import { computeSpectralFeatures } from "./fft";
import { LowPassFilter } from "./sensorsFilter";
import { IdleBaselineCalibrator } from "./idleBaselineCalibrator";
import { isSystemSwitchEnabled } from "./systemSwitchCache";

const SAMPLE_RATE_MS = 20; // 50Hz
const SAMPLE_RATE_HZ = 50;
const WINDOW_SIZE = 100; // 2 seconds at 50Hz
const WINDOW_STEP = 50; // 50% overlap = 1 second step
/**
 * Time between consecutive feature extractions. Used by the GPS-derived
 * `acceleration_longitudinal` feature to convert a per-window speed
 * delta into a (m/s²) acceleration. Equal to `WINDOW_STEP / SAMPLE_RATE`
 * — every window slides by `WINDOW_STEP` samples.
 */
const WINDOW_STEP_SECONDS = WINDOW_STEP / SAMPLE_RATE_HZ;

export interface WindowFeatures {
  // ── Time-domain (accelerometer magnitude) ──
  rms: number;
  std: number;
  peak_to_peak: number;
  crest_factor: number;
  zero_crossing_rate: number;
  percentile_95: number;
  kurtosis: number;
  skewness: number;
  // ── Device family one-hot (issue #494) ──
  // Five-bucket encoding produced from the rider's `device_model` via
  // `encodeDeviceFamily` in `@tarmoto/shared`. The on-device classifier
  // contract still uses the v1.1 21-feature vector by default — the
  // device-family fields are exposed in WindowFeatures so a future
  // training cycle that opts into the v1.2 contract can pack them
  // into the input tensor without re-plumbing the producer.
  device_family_iphone_pro: number;
  device_family_iphone_standard: number;
  device_family_pixel: number;
  device_family_samsung_galaxy_s: number;
  device_family_other: number;
  // ── Frequency-domain (FFT of accelerometer magnitude) ──
  // Issue #492: distinguishes surface types (cobblestone vs gravel vs
  // rough asphalt) and impulse-vs-continuous vibration. Per
  // `docs/ML_MODEL_SPEC.md` §3.3.
  spectral_centroid: number;
  spectral_energy_low: number;
  spectral_energy_mid: number;
  spectral_energy_high: number;
  dominant_frequency: number;
  spectral_entropy: number;
  band_ratio_high_low: number;
  // ── Gyroscope ──
  gyro_rms: number;
  /** Variance of pitch rate (gy, rad/s) across the window. */
  gyro_pitch_var: number;
  /** Variance of roll rate (gx, rad/s) across the window. */
  gyro_roll_var: number;
  // ── GPS context ──
  speed_kmh: number;
  speed_normalized_rms: number;
  /**
   * Forward/backward acceleration (m/s²) derived from the GPS speed
   * delta between consecutive windows. Frame-independent, so it works
   * regardless of phone mounting orientation. `0` for the very first
   * window of a ride (no previous speed yet).
   */
  acceleration_longitudinal: number;
  /**
   * Maximum absolute lean angle (degrees) observed across this 2 s
   * window. `0` while the orientation filter is still calibrating —
   * see `LeanAngleFilter` for the calibration semantics.
   */
  max_abs_lean_deg: number;
  timestamp: number;
}

export interface ClassificationResult {
  quality_class: QualityClass;
  quality_score: number;
  surface_type: SurfaceType;
  rms: number;
  confidence: number;
  /**
   * Identifier of the on-device classifier that produced this result.
   * `null` when the v0 RMS heuristic fired (model not loaded, load
   * failed, or inference errored). Backend persists this so future
   * aggregations can re-weight or ignore deprecated classifier output.
   */
  model_version: string | null;
}

type SensorCallback = (
  features: WindowFeatures,
  classification: ClassificationResult,
) => void;

/**
 * Per-sample listener invoked on every accelerometer reading (50 Hz).
 * Used by the crash detector to evaluate spike + immobility thresholds
 * at the raw sample rate, not the 1-second window cadence.
 */
export type ReadingListener = (reading: SensorReading) => void;

class SensorService {
  private accelSub: Subscription | null = null;
  private gyroSub: Subscription | null = null;
  private buffer: SensorReading[] = [];
  private rawReadings: SensorReading[] = [];
  private tagEvents: RideTagEvent[] = [];
  private isRecording = false;
  private callback: SensorCallback | null = null;
  private currentSpeed = 0;
  private currentLat = 0;
  private currentLng = 0;
  /**
   * Idle-baseline calibrator (issue #494). Captures the first ~30 s of
   * stationary samples; once `done`, the snapshot's per-axis mean is
   * subtracted from raw samples in {@link extractFeatures} before
   * magnitude computation. `null` outside an active recording, and
   * also `null` for the rest of the ride if the rider started moving
   * before the minimum sample-count floor was reached (uploader
   * treats that case as "no calibration block in this batch").
   */
  private calibrator: IdleBaselineCalibrator | null = null;
  /**
   * The active rider's device family (issue #494). Resolved once on
   * `start()` from the supplied device model string and packed into
   * every WindowFeatures emitted by this ride. Defaults to `"other"`
   * until the first {@link start} call; the unknown-bucket assignment
   * means a forgotten model identifier doesn't crash the feature
   * packer.
   */
  private deviceFamily: DeviceFamily = "other";
  private deviceFamilyOneHot: number[] = oneHotDeviceFamily("other");
  // Tracks whether `updateLocation` has fired at least once this ride.
  // Distinguishing the `currentLat/Lng = 0` *initial* state from a real
  // 0° fix matters for tag events (a rider on the equator / prime
  // meridian shouldn't have their tag's position silently dropped).
  // The accelerometer reading still uses `currentLat/Lng` directly
  // because `SensorReading.lat` is a required number — pre-fix
  // accelerometer samples just carry 0/0 and the backend filters them
  // out via `MIN_SPEED_MS`.
  private hasGpsFix = false;
  private readingListeners = new Set<ReadingListener>();
  // Per-ride orientation filter (US-19). One instance per ride so the
  // calibration offset captured at start doesn't leak from one ride to
  // the next. The filter needs the synchronous gyroscope tick in front
  // of the accelerometer one to integrate cleanly, so we track the
  // most recent gyro sample and feed it on the next accel tick.
  private leanFilter = new LeanAngleFilter();
  private latestGyroX: number | null = null;
  private latestGyroY: number | null = null;
  private latestGyroZ: number | null = null;
  /**
   * Speed (m/s) sampled at the previous window's emission. The
   * `acceleration_longitudinal` feature is the delta between this and
   * the current GPS speed, divided by the window step. `null` until
   * the first window emits — first window yields 0 m/s².
   */
  private previousSpeedMs: number | null = null;
  // Per-axis low-pass filters (issue #493). 4th-order Butterworth at
  // 22 Hz cutoff strips phone-vibration artefacts (case rattle, mount
  // resonance, GPS antenna noise) from the raw 50 Hz stream before
  // gravity-subtract, magnitude, and feature extraction. State taps
  // are owned by the filter instance, so the 1 s window slide doesn't
  // re-introduce a fresh edge transient on every window.
  private accelFilterX = new LowPassFilter();
  private accelFilterY = new LowPassFilter();
  private accelFilterZ = new LowPassFilter();
  private gyroFilterX = new LowPassFilter();
  private gyroFilterY = new LowPassFilter();
  private gyroFilterZ = new LowPassFilter();

  /**
   * Start recording sensor data.
   *
   * `deviceModel` is the rider's device model string (typically
   * `DeviceInfo.getModel()`). It's optional so the `sensorService.start(()=>{})`
   * call sites in tests don't need to plumb it through; production
   * callers should always pass one. The model string is resolved to a
   * five-bucket {@link DeviceFamily} once at start and packed into
   * every emitted WindowFeatures so a future v1.2 model contract can
   * consume the device family as a per-window feature without further
   * plumbing.
   */
  start(onWindow: SensorCallback, deviceModel?: string): void {
    if (this.isRecording) return;
    // Defense-in-depth for the `sys_accel_collection` operator kill switch.
    // The ride-start call site (RideActiveScreen) already gates on this, but
    // `sensorService` is a singleton with other potential callers; refusing to
    // subscribe here guarantees the raw 50Hz accelerometer/gyro streams never
    // spin up while the operator has the switch force-disabled. Reads ON by
    // default so the common path is unchanged.
    if (!isSystemSwitchEnabled("sys_accel_collection")) return;
    this.isRecording = true;
    this.callback = onWindow;
    this.buffer = [];
    this.rawReadings = [];
    this.tagEvents = [];
    this.hasGpsFix = false;
    // Resolve and cache the rider's device family for the duration of
    // this ride. `encodeDeviceFamily` falls back to `"other"` on null /
    // empty / unknown inputs so a missing model identifier doesn't
    // disable the feature.
    this.deviceFamily = encodeDeviceFamily(deviceModel);
    this.deviceFamilyOneHot = oneHotDeviceFamily(this.deviceFamily);
    // Issue #494 — fresh calibrator per ride so a previous ride's bias
    // doesn't leak. The calibrator captures stationary samples and
    // produces a snapshot once the window closes; until then the
    // feature pipeline runs without bias subtraction (the historical
    // behaviour, equivalent to mean = 0).
    this.calibrator = new IdleBaselineCalibrator();
    // Reset the orientation filter so a previous ride's offset / drift
    // doesn't bleed into this one. `start` also kicks off the auto-
    // calibration window (~1.5 s of upright readings).
    this.leanFilter.start();
    this.latestGyroX = null;
    this.latestGyroY = null;
    this.latestGyroZ = null;
    this.previousSpeedMs = null;
    // Reset the per-axis low-pass state so a previous ride's settling
    // tail can't bleed into the first samples of this ride. The
    // coefficients are static (computed once at module load) and
    // shared across instances; only the state taps are reset here.
    this.accelFilterX.reset();
    this.accelFilterY.reset();
    this.accelFilterZ.reset();
    this.gyroFilterX.reset();
    this.gyroFilterY.reset();
    this.gyroFilterZ.reset();

    // Kick off the model load in the background. The first windows
    // arrive ~2s later, so the classifier is typically ready by then;
    // any window that lands before warmup completes uses the heuristic
    // (mlClassifier.classify returns null until the model is loaded).
    // Skip it entirely when the operator has killed on-device ML
    // classification (`sys_surface_ml_classification`) — no point loading a
    // model the per-window gate below won't use. Fail-SAFE: default ON.
    if (isSystemSwitchEnabled("sys_surface_ml_classification")) {
      void mlClassifier.warmup();
    }

    setUpdateIntervalForType(SensorTypes.accelerometer, SAMPLE_RATE_MS);
    setUpdateIntervalForType(SensorTypes.gyroscope, SAMPLE_RATE_MS);

    // Accelerometer stream
    this.accelSub = accelerometer.subscribe(({ x, y, z, timestamp }) => {
      if (!this.isRecording) return;

      const t = timestamp || Date.now();
      // Forward the **unfiltered** reading to listeners *before* the
      // low-pass runs (US-12 crash detector). The detector's 4 g /
      // 100 ms thresholds are tuned for the raw 50 Hz stream — the
      // IIR edge response of the 22 Hz Butterworth attenuates the
      // first samples of a sharp impact enough that a near-threshold
      // crash can fail the sustained-spike check. `subscribeReadings`
      // is documented as the raw stream and we keep that promise here.
      // Errors in a listener must not break the sensor pipeline —
      // swallow per-listener so a bug in the detector can't stop a
      // ride from collecting road-quality data.
      if (this.readingListeners.size > 0) {
        const rawReading: SensorReading = {
          t,
          ax: x,
          ay: y,
          az: z,
          lat: this.currentLat,
          lng: this.currentLng,
          speed: this.currentSpeed / 3.6,
        };
        for (const listener of this.readingListeners) {
          try {
            listener(rawReading);
          } catch {
            // ignore — listener is responsible for its own error handling
          }
        }
      }

      // Apply the 22 Hz low-pass on every axis before any downstream
      // use (issue #493). Filtering at ingest means the lean filter,
      // the per-window features, AND the upload payload all see the
      // same anti-vibration signal. ML_MODEL_SPEC §6.1 explicitly
      // orders this step before gravity subtraction and magnitude.
      // The crash detector is the one consumer that needs the raw
      // axes — it gets them via the listener path above.
      const ax = this.accelFilterX.process(x);
      const ay = this.accelFilterY.process(y);
      const az = this.accelFilterZ.process(z);

      // Update the orientation filter on every accelerometer tick. The
      // gyro stream is faster than the accel stream on some devices,
      // so we use the most recent gyro reading (or 0 if no gyro tick
      // has arrived yet) as the rate input. `gy` / `gz` aren't used by
      // the roll integration itself but feed the calibration rest-check
      // so a yaw or pitch transient doesn't lock in a biased offset.
      // The filter still calibrates off accelerometer roll alone if the
      // gyro is silent — that's a degenerate case (no gyro = no roll
      // detection at speed) but at least the no-gyro device still
      // surfaces gravity-only roll.
      const gx = this.latestGyroX ?? 0;
      const gy = this.latestGyroY ?? 0;
      const gz = this.latestGyroZ ?? 0;
      const leanDeg = this.leanFilter.update({
        ax,
        ay,
        az,
        gx,
        gy,
        gz,
        t,
      });

      const reading: SensorReading = {
        t,
        ax,
        ay,
        az,
        lat: this.currentLat,
        lng: this.currentLng,
        speed: this.currentSpeed / 3.6, // store as m/s
        // Skip lean while still calibrating so the backend's per-ride
        // distribution doesn't soak up a stream of zeros captured
        // before the rider sat upright. The filter returns 0 verbatim
        // during calibration; we differentiate from a real 0° lean
        // (rider is genuinely upright) by checking the calibration
        // flag, not the value.
        ...(this.leanFilter.isCalibrating() ? {} : { lean_deg: leanDeg }),
      };

      this.buffer.push(reading);
      this.rawReadings.push(reading);

      // Issue #494 — feed every sample to the idle-baseline
      // calibrator. The calibrator self-terminates after ~30 s, after
      // an early-truncation when the rider starts moving, or after
      // declaring the calibration unusable when the rider never
      // settled. `speedMs` is gated on `hasGpsFix` because
      // `currentSpeed` is reset only via `updateLocation`, so an
      // accelerometer sample arriving before the first GPS fix would
      // otherwise carry the previous ride's last speed and abandon
      // the calibration on a phantom-moving signal.
      //
      // We feed the LOW-PASS-FILTERED axes (`ax/ay/az`), not the raw
      // ones, so the bias is captured in the same domain it'll be
      // subtracted from in `extractFeatures`. Using the raw values
      // here would inflate the per-axis std (raw noise > filtered
      // noise) and unnecessarily flip valid stationary captures to
      // `'poor'` via the `CALIBRATION_STATIONARY_STD_LIMIT` gate.
      // The DC component the bias subtraction relies on is preserved
      // by the 22 Hz Butterworth filter, so the means converge
      // regardless — but the std deserves the cleaned signal.
      if (this.calibrator) {
        this.calibrator.push({
          ax,
          ay,
          az,
          t,
          speedMs: this.hasGpsFix ? this.currentSpeed / 3.6 : undefined,
        });
      }
      // Process window when we have enough samples
      if (this.buffer.length >= WINDOW_SIZE) {
        const window = this.buffer.slice(0, WINDOW_SIZE);
        this.buffer = this.buffer.slice(WINDOW_STEP); // slide by step

        const features = this.extractFeatures(window);
        const classification = this.classify(features);
        this.callback?.(features, classification);
      }
    });

    // Gyroscope stream (merge into readings)
    this.gyroSub = gyroscope.subscribe(({ x, y, z }) => {
      // Same 22 Hz low-pass as the accelerometer (issue #493). Mount
      // resonance and case rattle land on both sensor frames, so the
      // gyroscope handlebar-vibration metric needs the cleanup just as
      // much as the accel features (and #492's spectral features).
      const gx = this.gyroFilterX.process(x);
      const gy = this.gyroFilterY.process(y);
      const gz = this.gyroFilterZ.process(z);

      // Attach to most recent reading
      const last = this.rawReadings[this.rawReadings.length - 1];
      if (last !== undefined) {
        last.gx = gx;
        last.gy = gy;
        last.gz = gz;
      }
      // Cache the full gyro vector (rad/s) for the next accelerometer
      // tick to feed into the orientation filter. We don't update the
      // filter directly from the gyro stream — combining ticks per
      // accel sample keeps the filter's `dt` stable around 20 ms.
      // `gy` / `gz` aren't used by the roll integration; they gate the
      // calibration rest-check (US-19) so yaw/pitch transients don't
      // lock in a biased offset.
      this.latestGyroX = gx;
      this.latestGyroY = gy;
      this.latestGyroZ = gz;
    });
  }

  /**
   * Manually re-zero the orientation filter (US-19). The rider taps
   * "Calibrate" on the live HUD when the auto-captured offset looks
   * off — typically because the phone shifted in its mount mid-ride.
   * Returns the new offset stats so the caller can surface a
   * confirmation toast.
   */
  recalibrateLean(): CalibrationStats {
    this.leanFilter.beginCalibration();
    return { samples: 0, offsetDeg: this.leanFilter.getOffsetDeg() };
  }

  /**
   * Whether the orientation filter is in its initial calibration
   * window. Surfaced to the HUD so it can show "Calibrating…" instead
   * of a 0° lean reading on the first second of a ride.
   */
  isLeanCalibrating(): boolean {
    return this.leanFilter.isCalibrating();
  }

  /**
   * Stop recording. Returns the buffered raw readings, the rider tag
   * events captured during the ride (research issue #7), AND the
   * idle-baseline calibration payload (issue #494) so the caller can
   * ship them in a single upload payload — keeps the offline-queue +
   * retry semantics shared between readings, tags, and calibration.
   *
   * `calibration` is `null` when the rider stopped before the
   * minimum calibration window's worth of stationary samples was
   * captured (a sub-{@link CALIBRATION_MIN_SECONDS} ride or one with
   * the bike rolled the whole time). The uploader treats that as
   * "ship the readings without a calibration block" and the backend
   * persists `calibration_quality: null` on the resulting rows.
   */
  stop(): {
    readings: SensorReading[];
    tagEvents: RideTagEvent[];
    calibration: CalibrationPayload | null;
  } {
    this.isRecording = false;
    this.accelSub?.unsubscribe();
    this.gyroSub?.unsubscribe();
    this.accelSub = null;
    this.gyroSub = null;
    this.callback = null;

    const readings = [...this.rawReadings];
    const tagEvents = [...this.tagEvents];
    // Force-finalise the calibrator so a ride that was stopped before
    // the natural close of the window still surfaces whatever was
    // captured (subject to the minimum-samples floor inside the
    // calibrator). `finalize()` is a no-op when the calibrator
    // already closed naturally during the ride.
    const snapshot = this.calibrator?.finalize() ?? null;
    const calibration = snapshot?.payload ?? null;
    this.calibrator = null;
    this.rawReadings = [];
    this.buffer = [];
    this.tagEvents = [];
    return { readings, tagEvents, calibration };
  }

  /**
   * Record a rider-asserted surface label (research issue #7).
   * Called from the in-ride tagging FAB. The event is buffered in
   * memory and emitted alongside the raw readings on `stop()` — the
   * sensor pipeline keeps running with no other side effects, so a
   * tap mid-ride costs ~one allocation. Returns the persisted event
   * so the caller can confirm capture (HUD toast, latest-label
   * indicator).
   *
   * Tags fired before `start()` are dropped — the buffer only exists
   * during an active recording. Callers should hide the FAB when the
   * ride isn't active.
   */
  tagSurface(label: SurfaceLabel): RideTagEvent | null {
    if (!this.isRecording) return null;
    // Gate on `hasGpsFix` rather than the falsy-check `lat || undefined`
    // pattern: 0° latitude / longitude are valid coordinates (equator /
    // prime meridian) and a rider tagging there shouldn't have their
    // position silently dropped to `undefined`. Pre-fix tags still
    // omit the field entirely so the backend can't mistake the
    // initial 0/0 sentinel for a real position.
    const event: RideTagEvent = {
      t: Date.now(),
      ...(this.hasGpsFix ? { lat: this.currentLat, lng: this.currentLng } : {}),
      label,
    };
    this.tagEvents.push(event);
    // Cap the buffer to match the backend DTO's @ArrayMaxSize. Without
    // this, a long labelling ride that exceeds MAX_TAG_EVENTS_PER_UPLOAD
    // would produce a payload the backend rejects with HTTP 400 — and
    // the offline queue treats 4xx as non-retriable, so BOTH the tags
    // AND the readings for that ride get dropped instead of queued.
    // Trimming the head keeps the most recent taps (the ones the rider
    // most likely cares about) and silently drops the oldest. This is
    // a defensive cap — at one tap every ~3 s a 500-cap absorbs a 25-
    // minute ride, so it should rarely fire in practice.
    if (this.tagEvents.length > MAX_TAG_EVENTS_PER_UPLOAD) {
      this.tagEvents.splice(
        0,
        this.tagEvents.length - MAX_TAG_EVENTS_PER_UPLOAD,
      );
    }
    return event;
  }

  /**
   * Read-only snapshot of the rider tags captured so far in this
   * ride. The HUD uses this to render the most-recent label as an
   * indicator that the FAB worked.
   */
  getTagEvents(): readonly RideTagEvent[] {
    return this.tagEvents;
  }

  /**
   * Update GPS data (called from location service)
   */
  updateLocation(lat: number, lng: number, speedKmh: number): void {
    this.currentLat = lat;
    this.currentLng = lng;
    this.currentSpeed = speedKmh;
    this.hasGpsFix = true;
  }

  /**
   * Subscribe to the raw 50 Hz reading stream. Returns an unsubscribe
   * function. The crash detector uses this to evaluate the peak-g spike
   * and immobility windows on the per-sample cadence — too fine-grained
   * for the 1-second classifier window callback.
   *
   * Listeners receive **unfiltered** `ax/ay/az` values verbatim from
   * the native sensor bridge. The 22 Hz Butterworth low-pass (issue
   * #493) only applies to the buffered/upload path; the crash
   * detector is calibrated against the raw 50 Hz stream and the IIR
   * edge response would otherwise mask near-threshold impacts. Gyro
   * fields are not populated on the listener payload — the crash
   * detector only consumes `ax/ay/az`.
   */
  subscribeReadings(listener: ReadingListener): () => void {
    this.readingListeners.add(listener);
    return () => {
      this.readingListeners.delete(listener);
    };
  }

  /**
   * Extract features from a 2-second window of accelerometer data.
   *
   * The idle-baseline calibration (issue #494) is uploaded to the
   * backend on every batch — that's how the training pipeline gets
   * per-rider bias data for the next model contract — but the v1.1
   * classifier currently bundled in the app was trained on the
   * historical scalar deviation `abs(|a| − 9.81)`. Switching the
   * on-device feature pipeline to the per-axis residual magnitude
   * `||a − bias||` would push the model out of distribution: for
   * vibrations perpendicular to gravity, `||a − bias||` is large
   * (full vibration amplitude lands on a perpendicular axis) while
   * `abs(|a| − g)` stays small (gravity magnitude is invariant under
   * a perpendicular rotation), so a smooth ride would suddenly score
   * rougher once calibration completes.
   *
   * The compromise this revision lands on:
   *
   *   - keep the v1.1 inference contract intact: time-domain features
   *     and FFT both consume the SCALAR deviation `|a| − rest`
   *     (signed for FFT, absolute for time-domain), exactly the shape
   *     the bundled model expects;
   *   - use the calibrated rest magnitude `||bias||` instead of the
   *     literal 9.81 when a good calibration is available — that
   *     absorbs per-rider MEMS scale-factor error without changing
   *     the contract;
   *   - keep uploading the per-axis calibration so the v1.2 retrained
   *     model can consume the orientation-invariant residual once
   *     it's bundled.
   *
   * The previous revision applied per-axis bias subtraction to the
   * time-domain features directly. This was reverted because the
   * v1.1 model artifact hasn't been retrained yet — see Codex P1 in
   * the PR review for the out-of-distribution discussion.
   */
  private extractFeatures(window: SensorReading[]): WindowFeatures {
    const calibrationSnap = this.calibrator?.snapshot();
    // Only use the calibrated rest magnitude when the captured
    // window cleared the same quality bar the backend uses to tag a
    // reading 'good'. A `'poor'` snapshot means the capture was
    // contaminated by motion / cornering, and `||bias||` could land
    // far from gravity — we'd silently shift the v1.1 model's
    // baseline. We still keep the snapshot so the upload ships its
    // payload (the backend persists the `'poor'` tag for analytics);
    // the on-device pipeline just stays on the literal 9.81 baseline.
    const useCalibration =
      calibrationSnap !== null &&
      calibrationSnap !== undefined &&
      calibrationSnap.quality === "good";
    const restMag =
      useCalibration && calibrationSnap
        ? Math.sqrt(
            calibrationSnap.meanX * calibrationSnap.meanX +
              calibrationSnap.meanY * calibrationSnap.meanY +
              calibrationSnap.meanZ * calibrationSnap.meanZ,
          )
        : 9.81;
    // Signed FFT input — `|a| − rest` oscillates around 0 for
    // vibration and stays near 0 for a stationary phone. The two
    // views the downstream code keeps:
    //   - `signedDeviations` (signed): preserves oscillation polarity
    //     for the FFT pass. Rectifying would double every input
    //     frequency and alias high-band content (PR #502).
    //   - `deviations` (|signedDeviations|): the v1.1 contract for
    //     RMS, kurtosis, skewness, percentile, zero-crossing rate.
    //     RMS is invariant under |·|; the higher-moment / ordering-
    //     based features were trained on the absolute signal, so we
    //     keep them on `deviations` rather than the signed view.
    const signedDeviations = window.map((r) => {
      const mag = Math.sqrt(r.ax * r.ax + r.ay * r.ay + r.az * r.az);
      return mag - restMag;
    });
    const deviations = signedDeviations.map((v) => Math.abs(v));

    const n = deviations.length;
    const mean = deviations.reduce((s, v) => s + v, 0) / n;
    const rms = Math.sqrt(deviations.reduce((s, v) => s + v * v, 0) / n);
    const std = Math.sqrt(
      deviations.reduce((s, v) => s + (v - mean) ** 2, 0) / n,
    );
    const sorted = [...deviations].sort((a, b) => a - b);
    const min = sorted[0] ?? 0;
    const max = sorted[n - 1] ?? 0;
    const peak_to_peak = max - min;
    const crest_factor = rms > 0 ? max / rms : 0;
    const percentile_95 = sorted[Math.floor(n * 0.95)] ?? 0;

    // Zero crossing rate
    let zeroCrossings = 0;
    for (let i = 1; i < n; i++) {
      const current = deviations[i];
      const previous = deviations[i - 1];
      if (current === undefined || previous === undefined) continue;
      if ((current - mean) * (previous - mean) < 0) zeroCrossings++;
    }
    const zero_crossing_rate = zeroCrossings / n;

    // Kurtosis
    const m4 = deviations.reduce((s, v) => s + (v - mean) ** 4, 0) / n;
    const kurtosis = std > 0 ? m4 / std ** 4 - 3 : 0;

    // Skewness
    const m3 = deviations.reduce((s, v) => s + (v - mean) ** 3, 0) / n;
    const skewness = std > 0 ? m3 / std ** 3 : 0;

    // Frequency-domain features (issue #492). The signed deviation is
    // approximately zero-mean for vibration around gravity; the FFT
    // helper still subtracts its own mean and applies a Hann window
    // before transforming. Sample rate is fixed at 50 Hz upstream;
    // shorter windows (e.g. an early-stop) just yield reduced
    // frequency resolution.
    const spectral = computeSpectralFeatures(signedDeviations, SAMPLE_RATE_HZ);

    // Gyroscope features. Variance of pitch / roll rate complement
    // the magnitude RMS — the model uses them to tell apart side-to-
    // side wobble from forward/back pogoing. Phone convention in this
    // codebase: gx = roll rate, gy = pitch rate (see leanAngle.ts).
    let gyroSampleCount = 0;
    let gyroMagSquaredSum = 0;
    let pitchSum = 0;
    let pitchSqSum = 0;
    let rollSum = 0;
    let rollSqSum = 0;
    for (const r of window) {
      if (r.gx === undefined) continue;
      const gx = r.gx;
      const gy = r.gy ?? 0;
      const gz = r.gz ?? 0;
      gyroSampleCount++;
      gyroMagSquaredSum += gx * gx + gy * gy + gz * gz;
      rollSum += gx;
      rollSqSum += gx * gx;
      pitchSum += gy;
      pitchSqSum += gy * gy;
    }
    const gyro_rms =
      gyroSampleCount > 0 ? Math.sqrt(gyroMagSquaredSum / gyroSampleCount) : 0;
    const gyro_roll_var =
      gyroSampleCount > 0
        ? rollSqSum / gyroSampleCount - (rollSum / gyroSampleCount) ** 2
        : 0;
    const gyro_pitch_var =
      gyroSampleCount > 0
        ? pitchSqSum / gyroSampleCount - (pitchSum / gyroSampleCount) ** 2
        : 0;

    // Speed + GPS-derived longitudinal acceleration. Using the GPS
    // speed delta keeps the feature frame-independent — a phone in a
    // tank-bag, handlebar mount or pocket all produce the same
    // braking/accelerating signal. `previousSpeedMs` is `null` on the
    // first window of a ride, in which case we report 0 m/s² rather
    // than fabricating a delta from an undefined baseline.
    const speed_kmh = this.currentSpeed;
    const speed_normalized_rms = speed_kmh > 10 ? rms / (speed_kmh / 50) : rms;
    const currentSpeedMs = this.currentSpeed / 3.6;
    const acceleration_longitudinal =
      this.previousSpeedMs === null
        ? 0
        : (currentSpeedMs - this.previousSpeedMs) / WINDOW_STEP_SECONDS;
    this.previousSpeedMs = currentSpeedMs;

    // Maximum absolute lean angle observed across this window (US-19).
    // Pre-calibration samples carry no `lean_deg` (undefined) so the
    // window-level max is just whatever the post-calibration samples
    // saw. A window that's still entirely inside the calibration
    // period returns 0.
    let max_abs_lean_deg = 0;
    for (const r of window) {
      if (r.lean_deg === undefined) continue;
      const abs = Math.abs(r.lean_deg);
      if (abs > max_abs_lean_deg) max_abs_lean_deg = abs;
    }

    // Device family one-hot — packed verbatim from the resolved
    // family captured at `start()` time so every window in the ride
    // carries the same encoding. Unpack-by-index keeps the struct
    // initialisation explicit and immune to future re-orderings of
    // `DEVICE_FAMILIES`.
    const [
      device_family_iphone_pro = 0,
      device_family_iphone_standard = 0,
      device_family_pixel = 0,
      device_family_samsung_galaxy_s = 0,
      device_family_other = 0,
    ] = this.deviceFamilyOneHot;

    return {
      rms,
      std,
      peak_to_peak,
      crest_factor,
      zero_crossing_rate,
      percentile_95,
      kurtosis,
      skewness,
      device_family_iphone_pro,
      device_family_iphone_standard,
      device_family_pixel,
      device_family_samsung_galaxy_s,
      device_family_other,
      spectral_centroid: spectral.spectral_centroid,
      spectral_energy_low: spectral.spectral_energy_low,
      spectral_energy_mid: spectral.spectral_energy_mid,
      spectral_energy_high: spectral.spectral_energy_high,
      dominant_frequency: spectral.dominant_frequency,
      spectral_entropy: spectral.spectral_entropy,
      band_ratio_high_low: spectral.band_ratio_high_low,
      gyro_rms,
      gyro_pitch_var,
      gyro_roll_var,
      speed_kmh,
      speed_normalized_rms,
      acceleration_longitudinal,
      max_abs_lean_deg,
      timestamp: Date.now(),
    };
  }

  /**
   * Classify road quality from features.
   *
   * Tries the on-device TF Lite model first (US-3); when the model
   * isn't ready or inference fails, falls back to the v0 RMS heuristic
   * so a missing/broken model never prevents a ride from contributing
   * data.
   */
  private classify(features: WindowFeatures): ClassificationResult {
    // Operator system switch (`sys_surface_ml_classification`): when force_off,
    // skip the on-device TF Lite model and fall through to the RMS heuristic —
    // lets an operator kill a misbehaving model release without an app update,
    // while ride recording continues. Read live (per-window) so a mid-session
    // flip takes effect. Fail-SAFE: default ON, so the common path is
    // unchanged.
    const mlEnabled = isSystemSwitchEnabled("sys_surface_ml_classification");
    if (mlEnabled && !mlClassifier.isReady()) {
      // The switch may have flipped ON mid-ride after start() skipped the
      // warmup (operator re-enable, or force_off at ride start). classify()
      // never initiates a load, so without this the advertised live flip
      // would stay on the heuristic until the rider restarts sensor
      // collection. warmup() is idempotent and latches a failed load, so this
      // is a cheap no-op once the model is ready or has permanently failed;
      // the model becomes available to subsequent windows.
      void mlClassifier.warmup();
    }
    const ml = mlEnabled ? mlClassifier.classify(features) : null;
    if (ml) {
      return {
        quality_class: ml.quality_class,
        quality_score: ml.quality_score,
        surface_type: ml.surface_type,
        rms: features.rms,
        confidence: ml.confidence,
        model_version: ml.model_version,
      };
    }
    return this.classifyHeuristic(features);
  }

  /**
   * v0 fallback classifier used when the TF Lite model isn't available
   * (initial load not finished, load failed, or runtime error). RMS-only
   * thresholds line up with `apps/backend/.../sensor.service.ts` so the
   * client and server agree on labels even without ML output.
   */
  private classifyHeuristic(features: WindowFeatures): ClassificationResult {
    const rms = features.speed_normalized_rms;

    let quality_class: QualityClass;
    let quality_score: number;

    if (rms < 1.5) {
      quality_class = "excellent";
      quality_score = 5.0 - (rms / 1.5) * 0.5;
    } else if (rms < 3.0) {
      quality_class = "good";
      quality_score = 4.0 - ((rms - 1.5) / 1.5) * 1.0;
    } else if (rms < 5.5) {
      quality_class = "fair";
      quality_score = 3.0 - ((rms - 3.0) / 2.5) * 1.0;
    } else if (rms < 9.0) {
      quality_class = "poor";
      quality_score = 2.0 - ((rms - 5.5) / 3.5) * 1.0;
    } else {
      quality_class = "very_poor";
      quality_score = Math.max(0.5, 1.0 - ((rms - 9.0) / 5.0) * 0.5);
    }

    // Surface heuristic only separates gravel and cobblestone with any
    // confidence — the remaining PRD tiers (asphalt, concrete, dirt)
    // need spectral features the RMS-only fallback can't extract.
    // Default to `unknown` rather than guessing 'asphalt' so the
    // backend can choose to discard low-confidence surface labels
    // from heuristic uploads instead of mistaking them for ground
    // truth.
    let surface_type: SurfaceType = "unknown";
    if (features.zero_crossing_rate > 0.4 && rms > 3.0) {
      surface_type = "gravel";
    } else if (features.crest_factor > 5.0) {
      surface_type = "cobblestone";
    }

    return {
      quality_class,
      quality_score: Math.round(quality_score * 10) / 10,
      surface_type,
      rms: features.rms,
      confidence: features.speed_kmh > 20 ? 70 : 30, // Higher confidence at speed
      model_version: null, // heuristic — backend treats null as v0
    };
  }

  get recording(): boolean {
    return this.isRecording;
  }
}

export const sensorService = new SensorService();
