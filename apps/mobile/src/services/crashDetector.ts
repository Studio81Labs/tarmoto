/**
 * Crash detector — US-12 AC #1.
 *
 * Two-stage trigger consumed from the 50 Hz raw accelerometer stream:
 *
 *   1. Spike: resultant acceleration deviation from gravity must reach
 *      `peakG` for at least `peakDurationMs` consecutive milliseconds.
 *      Real motorcycle impacts produce a sustained spike (helmet/airbag
 *      contact, body slam) — a single-sample bump can be a pothole or
 *      the rider dropping the phone, so we require duration to filter
 *      false positives.
 *
 *   2. Immobility: after the spike, the rider's phone must stay below
 *      `immobilityRmsMax` for `immobilityDurationMs`. A conscious rider
 *      who hits a curb at 4g will still be moving the phone (looking
 *      around, dismounting). Sustained stillness suggests the rider is
 *      down and possibly unconscious.
 *
 * Defaults follow the issue spec (4g / 100ms / 5s). They are configurable
 * so a future low-power profile or a research mode can override them.
 *
 * The detector is pure: it tracks state internally but takes no
 * dependencies on stores or RN modules, so unit tests can drive it with
 * synthetic readings against a fake clock.
 */

import type { SensorReading } from "@/types";

/** Earth gravity in m/s² used to extract pure motion from raw accel. */
const GRAVITY_MS2 = 9.81;

/** Default thresholds — see file header for the rationale. */
export const CRASH_DEFAULTS = {
  /** Peak resultant acceleration above gravity, in g. */
  peakG: 4.0,
  /** Spike must be sustained for this many milliseconds. */
  peakDurationMs: 100,
  /** Post-spike immobility duration, in milliseconds. */
  immobilityDurationMs: 5_000,
  /** Max RMS acceleration deviation (m/s²) considered "no significant motion". */
  immobilityRmsMax: 1.5,
  /** UI countdown after a positive trigger, in milliseconds. */
  countdownMs: 30_000,
  /** Minimum gap between consecutive triggers — guards against re-fire. */
  rearmDelayMs: 60_000,
} as const;

export interface CrashDetectorOptions {
  peakG?: number;
  peakDurationMs?: number;
  immobilityDurationMs?: number;
  immobilityRmsMax?: number;
  rearmDelayMs?: number;
  /** Override `Date.now()` for deterministic tests. */
  now?: () => number;
}

export interface CrashEvent {
  /** Wall-clock timestamp (ms) of the spike that triggered the alert. */
  triggeredAt: number;
  /** Peak deviation magnitude (m/s²) observed during the spike. */
  peakAcceleration: number;
  /**
   * Speed at the moment of impact (m/s), captured from the reading that
   * crossed the spike threshold. Reported here rather than read from
   * the ride store at fire time because by then the 5-second immobility
   * window has elapsed and the rider's speed has already dropped to ~0.
   * `null` when the reading didn't carry a speed (no GPS fix at impact).
   */
  speedAtImpactMps: number | null;
}

type State =
  | { kind: "idle" }
  | {
      kind: "spiking";
      startedAt: number;
      peak: number;
      speedAtImpact: number | null;
    }
  | {
      kind: "armed";
      armedAt: number;
      peak: number;
      speedAtImpact: number | null;
      rmsBuffer: RmsBuffer;
    };

/**
 * Rolling RMS buffer over the immobility window. Keeps a fixed-time
 * window of recent samples so we can ask "has the phone been still for
 * the last 5 seconds?" without scanning the entire ride history.
 */
class RmsBuffer {
  private readonly samples: { t: number; m: number }[] = [];

  push(t: number, magnitude: number, windowMs: number): void {
    this.samples.push({ t, m: magnitude });
    const cutoff = t - windowMs;
    while (this.samples.length > 0 && this.samples[0].t < cutoff) {
      this.samples.shift();
    }
  }

  rms(): number {
    if (this.samples.length === 0) return 0;
    const sumSq = this.samples.reduce((s, v) => s + v.m * v.m, 0);
    return Math.sqrt(sumSq / this.samples.length);
  }
}

export type CrashCallback = (event: CrashEvent) => void;

export class CrashDetector {
  private readonly peakG: number;
  private readonly peakThresholdMs2: number;
  private readonly peakDurationMs: number;
  private readonly immobilityDurationMs: number;
  private readonly immobilityRmsMax: number;
  private readonly rearmDelayMs: number;
  private readonly now: () => number;

  private state: State = { kind: "idle" };
  private listener: CrashCallback | null = null;
  /**
   * Wall-clock timestamp of the last positive trigger. The state
   * machine returns to idle immediately after firing so a future
   * crash can still be detected, but we refuse to enter the spiking
   * branch again until `rearmDelayMs` has elapsed. Without this guard
   * the detector could fire twice within seconds (e.g. helmet impact
   * then a second slap as the rider falls), spamming the rider with
   * back-to-back countdown overlays for the same incident.
   */
  private lastFireAt: number | null = null;

  constructor(options: CrashDetectorOptions = {}) {
    this.peakG = options.peakG ?? CRASH_DEFAULTS.peakG;
    this.peakThresholdMs2 = this.peakG * GRAVITY_MS2;
    this.peakDurationMs =
      options.peakDurationMs ?? CRASH_DEFAULTS.peakDurationMs;
    this.immobilityDurationMs =
      options.immobilityDurationMs ?? CRASH_DEFAULTS.immobilityDurationMs;
    this.immobilityRmsMax =
      options.immobilityRmsMax ?? CRASH_DEFAULTS.immobilityRmsMax;
    this.rearmDelayMs = options.rearmDelayMs ?? CRASH_DEFAULTS.rearmDelayMs;
    this.now = options.now ?? (() => Date.now());
  }

  onCrash(listener: CrashCallback | null): void {
    this.listener = listener;
  }

  /** Discard transient state (e.g. ride stopped). */
  reset(): void {
    this.state = { kind: "idle" };
    this.lastFireAt = null;
  }

  /**
   * Feed a raw 50 Hz accelerometer reading to the detector.
   *
   * Returns the event when the second-stage immobility threshold is
   * reached. Most calls return `null`. `onCrash` listener (if set) is
   * also invoked — callers can pick whichever side fits.
   */
  feed(reading: SensorReading): CrashEvent | null {
    // `reading.t` can legitimately be 0 (synthetic readings, fake clock
    // tests). Use nullish coalescing instead of `||` so a zero timestamp
    // doesn't fall through to wall-clock time.
    const t =
      reading.t !== undefined && reading.t !== null ? reading.t : this.now();
    const magnitude = magnitudeAboveGravity(reading);

    switch (this.state.kind) {
      case "idle": {
        // Refuse to re-arm within `rearmDelayMs` of a previous trigger
        // so a single incident can't fire two countdowns in a row
        // (helmet impact + body slam land within seconds and would
        // otherwise both clear the spike + immobility checks).
        if (
          this.lastFireAt !== null &&
          t - this.lastFireAt < this.rearmDelayMs
        ) {
          return null;
        }
        if (magnitude >= this.peakThresholdMs2) {
          this.state = {
            kind: "spiking",
            startedAt: t,
            peak: magnitude,
            // Capture the rider's speed at the moment the spike begins.
            // The ride store's `currentSpeed` would still be live here
            // too, but binding to the reading keeps the detector pure
            // (no store dependency) and survives the 5-second
            // immobility window with the pre-impact value intact.
            speedAtImpact: reading.speed ?? null,
          };
        }
        return null;
      }
      case "spiking": {
        if (magnitude >= this.peakThresholdMs2) {
          const peak = Math.max(this.state.peak, magnitude);
          if (t - this.state.startedAt >= this.peakDurationMs) {
            // Spike sustained long enough to count — switch to immobility
            // tracking.
            const buffer = new RmsBuffer();
            buffer.push(t, magnitude, this.immobilityDurationMs);
            this.state = {
              kind: "armed",
              armedAt: t,
              peak,
              speedAtImpact: this.state.speedAtImpact,
              rmsBuffer: buffer,
            };
          } else {
            this.state = { ...this.state, peak };
          }
          return null;
        }
        // Spike fizzled before clearing duration — drop back to idle so
        // a tap or a single-sample bump doesn't put us into the armed
        // state.
        this.state = { kind: "idle" };
        return null;
      }
      case "armed": {
        const { armedAt, peak, speedAtImpact, rmsBuffer } = this.state;
        rmsBuffer.push(t, magnitude, this.immobilityDurationMs);
        if (magnitude >= this.peakThresholdMs2) {
          // Aftershock spike — keep the peak record up to date AND push
          // `armedAt` forward to the aftershock timestamp so both the
          // fire check and the re-arm deadline restart relative to the
          // most recent spike. Without this push, an aftershock landing
          // late inside the immobility window would still be in the
          // rolling RMS buffer when the absolute re-arm check
          // (`elapsed >= immobilityDurationMs * 2`) fires, flipping the
          // detector back to idle before the buffer settles. (Bugbot
          // 7c1723a8.)
          this.state = {
            ...this.state,
            armedAt: t,
            peak: Math.max(peak, magnitude),
          };
          return null;
        }
        const elapsed = t - armedAt;
        if (
          elapsed >= this.immobilityDurationMs &&
          rmsBuffer.rms() <= this.immobilityRmsMax
        ) {
          const event: CrashEvent = {
            triggeredAt: t,
            peakAcceleration: peak,
            speedAtImpactMps: speedAtImpact,
          };
          this.state = { kind: "idle" };
          this.lastFireAt = t;
          this.listener?.(event);
          return event;
        }
        if (elapsed >= this.immobilityDurationMs * 2) {
          // Twice the immobility window has passed without the RMS
          // settling — the rider is moving (post-incident kit-check,
          // dismount, etc). Re-arm so a later, real crash can still
          // fire.
          this.state = { kind: "idle" };
        }
        return null;
      }
    }
  }
}

/** Resultant acceleration deviation from gravity, in m/s². */
export function magnitudeAboveGravity(reading: SensorReading): number {
  const mag = Math.sqrt(
    reading.ax * reading.ax + reading.ay * reading.ay + reading.az * reading.az,
  );
  return Math.abs(mag - GRAVITY_MS2);
}
