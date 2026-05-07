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
import { map, bufferCount } from "rxjs/operators";
import type { SensorReading, QualityClass, SurfaceType } from "@/types";
import type { RideTagEvent, SurfaceLabel } from "@tarmoto/shared";
import * as mlClassifier from "./mlClassifier";
import { LeanAngleFilter, type CalibrationStats } from "./leanAngle";

const SAMPLE_RATE_MS = 20; // 50Hz
const WINDOW_SIZE = 100; // 2 seconds at 50Hz
const WINDOW_STEP = 50; // 50% overlap = 1 second step

export interface WindowFeatures {
  rms: number;
  std: number;
  peak_to_peak: number;
  crest_factor: number;
  zero_crossing_rate: number;
  percentile_95: number;
  kurtosis: number;
  skewness: number;
  gyro_rms: number;
  speed_kmh: number;
  speed_normalized_rms: number;
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
   * Start recording sensor data
   */
  start(onWindow: SensorCallback): void {
    if (this.isRecording) return;
    this.isRecording = true;
    this.callback = onWindow;
    this.buffer = [];
    this.rawReadings = [];
    this.tagEvents = [];
    // Reset the orientation filter so a previous ride's offset / drift
    // doesn't bleed into this one. `start` also kicks off the auto-
    // calibration window (~1.5 s of upright readings).
    this.leanFilter.start();
    this.latestGyroX = null;
    this.latestGyroY = null;
    this.latestGyroZ = null;

    // Kick off the model load in the background. The first windows
    // arrive ~2s later, so the classifier is typically ready by then;
    // any window that lands before warmup completes uses the heuristic
    // (mlClassifier.classify returns null until the model is loaded).
    void mlClassifier.warmup();

    setUpdateIntervalForType(SensorTypes.accelerometer, SAMPLE_RATE_MS);
    setUpdateIntervalForType(SensorTypes.gyroscope, SAMPLE_RATE_MS);

    // Accelerometer stream
    this.accelSub = accelerometer.subscribe(({ x, y, z, timestamp }) => {
      if (!this.isRecording) return;

      const t = timestamp || Date.now();
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
        ax: x,
        ay: y,
        az: z,
        gx,
        gy,
        gz,
        t,
      });

      const reading: SensorReading = {
        t,
        ax: x,
        ay: y,
        az: z,
        lat: this.currentLat,
        lng: this.currentLng,
        speed: this.currentSpeed / 3.6, // store as m/s
        // Skip lean while still calibrating so the backend's per-ride
        // distribution doesn't soak up a stream of zeros captured
        // before the rider sat upright. The filter returns 0 verbatim
        // during calibration; we differentiate from a real 0° lean
        // (rider is genuinely upright) by checking the calibration
        // flag, not the value.
        lean_deg: this.leanFilter.isCalibrating() ? undefined : leanDeg,
      };

      this.buffer.push(reading);
      this.rawReadings.push(reading);

      // Forward the raw reading to subscribed listeners (US-12 crash
      // detector). Errors in a listener must not break the sensor
      // pipeline — swallow per-listener so a bug in the detector can't
      // stop a ride from collecting road-quality data.
      if (this.readingListeners.size > 0) {
        for (const listener of this.readingListeners) {
          try {
            listener(reading);
          } catch {
            // ignore — listener is responsible for its own error handling
          }
        }
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
      // Attach to most recent reading
      if (this.rawReadings.length > 0) {
        const last = this.rawReadings[this.rawReadings.length - 1];
        last.gx = x;
        last.gy = y;
        last.gz = z;
      }
      // Cache the full gyro vector (rad/s) for the next accelerometer
      // tick to feed into the orientation filter. We don't update the
      // filter directly from the gyro stream — combining ticks per
      // accel sample keeps the filter's `dt` stable around 20 ms.
      // `gy` / `gz` aren't used by the roll integration; they gate the
      // calibration rest-check (US-19) so yaw/pitch transients don't
      // lock in a biased offset.
      this.latestGyroX = x;
      this.latestGyroY = y;
      this.latestGyroZ = z;
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
   * Stop recording. Returns the buffered raw readings AND the rider
   * tag events captured during the ride (research issue #7) so the
   * caller can ship both in a single upload payload — keeps the
   * offline-queue + retry semantics shared between readings and
   * tags.
   */
  stop(): { readings: SensorReading[]; tagEvents: RideTagEvent[] } {
    this.isRecording = false;
    this.accelSub?.unsubscribe();
    this.gyroSub?.unsubscribe();
    this.accelSub = null;
    this.gyroSub = null;
    this.callback = null;

    const readings = [...this.rawReadings];
    const tagEvents = [...this.tagEvents];
    this.rawReadings = [];
    this.buffer = [];
    this.tagEvents = [];
    return { readings, tagEvents };
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
    const event: RideTagEvent = {
      t: Date.now(),
      lat: this.currentLat || undefined,
      lng: this.currentLng || undefined,
      label,
    };
    this.tagEvents.push(event);
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
  }

  /**
   * Subscribe to the raw 50 Hz reading stream. Returns an unsubscribe
   * function. The crash detector uses this to evaluate the peak-g spike
   * and immobility windows on the per-sample cadence — too fine-grained
   * for the 1-second classifier window callback.
   */
  subscribeReadings(listener: ReadingListener): () => void {
    this.readingListeners.add(listener);
    return () => {
      this.readingListeners.delete(listener);
    };
  }

  /**
   * Extract features from a 2-second window of accelerometer data
   */
  private extractFeatures(window: SensorReading[]): WindowFeatures {
    // Calculate acceleration magnitude minus gravity
    const deviations = window.map((r) => {
      const mag = Math.sqrt(r.ax ** 2 + r.ay ** 2 + r.az ** 2);
      return Math.abs(mag - 9.81);
    });

    const n = deviations.length;
    const mean = deviations.reduce((s, v) => s + v, 0) / n;
    const rms = Math.sqrt(deviations.reduce((s, v) => s + v * v, 0) / n);
    const std = Math.sqrt(
      deviations.reduce((s, v) => s + (v - mean) ** 2, 0) / n,
    );
    const sorted = [...deviations].sort((a, b) => a - b);
    const min = sorted[0];
    const max = sorted[n - 1];
    const peak_to_peak = max - min;
    const crest_factor = rms > 0 ? max / rms : 0;
    const percentile_95 = sorted[Math.floor(n * 0.95)];

    // Zero crossing rate
    let zeroCrossings = 0;
    for (let i = 1; i < n; i++) {
      if ((deviations[i] - mean) * (deviations[i - 1] - mean) < 0)
        zeroCrossings++;
    }
    const zero_crossing_rate = zeroCrossings / n;

    // Kurtosis
    const m4 = deviations.reduce((s, v) => s + (v - mean) ** 4, 0) / n;
    const kurtosis = std > 0 ? m4 / std ** 4 - 3 : 0;

    // Skewness
    const m3 = deviations.reduce((s, v) => s + (v - mean) ** 3, 0) / n;
    const skewness = std > 0 ? m3 / std ** 3 : 0;

    // Gyroscope RMS
    const gyroMags = window
      .filter((r) => r.gx !== undefined)
      .map((r) =>
        Math.sqrt((r.gx || 0) ** 2 + (r.gy || 0) ** 2 + (r.gz || 0) ** 2),
      );
    const gyro_rms =
      gyroMags.length > 0
        ? Math.sqrt(gyroMags.reduce((s, v) => s + v * v, 0) / gyroMags.length)
        : 0;

    // Speed
    const speed_kmh = this.currentSpeed;
    const speed_normalized_rms = speed_kmh > 10 ? rms / (speed_kmh / 50) : rms;

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

    return {
      rms,
      std,
      peak_to_peak,
      crest_factor,
      zero_crossing_rate,
      percentile_95,
      kurtosis,
      skewness,
      gyro_rms,
      speed_kmh,
      speed_normalized_rms,
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
    const ml = mlClassifier.classify(features);
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
