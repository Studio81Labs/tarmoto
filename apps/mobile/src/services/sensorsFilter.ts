/**
 * Sensor pre-processing low-pass filter (issue #493).
 *
 * `docs/ML_MODEL_SPEC.md` §6.1 step 4 prescribes a 25 Hz low-pass on
 * the raw accelerometer (and ideally gyroscope) stream before any
 * feature extraction, so phone-vibration artefacts (case rattle, GPS
 * antenna noise, mount resonance) don't leak into RMS, peak-to-peak,
 * kurtosis, or the spectral features (#492).
 *
 * Order in the pipeline (per spec):
 *   filter → gravity-subtract → magnitude → window → features
 *
 * We never filter the magnitude — that would scramble directional
 * information for the gyro and change the spectral content of the
 * road signal.
 *
 * # Design
 *
 * The filter is a 4th-order Butterworth lowpass implemented as two
 * cascaded biquad sections (Direct Form II Transposed). Coefficients
 * are computed once at module load from `(cutoffHz, sampleRateHz)`;
 * each per-axis filter instance owns its own state taps. State is
 * preserved across the 2 s sliding window boundaries so we don't
 * inject a fresh transient into every window.
 *
 * # Cutoff choice
 *
 * Sample rate is 50 Hz, so Nyquist sits at 25 Hz. The spec calls for a
 * cutoff "slightly lower" than Nyquist to avoid response distortion
 * close to fs/2; we use 22 Hz which gives a -3 dB point at 22 Hz, ~20
 * dB attenuation by 30 Hz on a higher-rate test, and < 1 dB loss at
 * 5 Hz (a typical road-bump frequency).
 *
 * # Limitations: this is *not* a pre-sample anti-alias filter
 *
 * At fs = 50 Hz, anything above the 25 Hz Nyquist has already aliased
 * by the time the sample reaches this filter — a 30 Hz vibration on
 * the bike folds to 20 Hz and lands *inside* the 22 Hz passband. True
 * anti-aliasing has to happen before sampling, in hardware (the
 * accelerometer's internal low-pass) or in the OS sensor framework.
 * iOS Core Motion and Android SensorManager typically apply a
 * hardware low-pass at the requested output rate, but that's not part
 * of the React Native bridge contract and varies by device.
 *
 * What this filter *does* deliver:
 *
 *   - Cleans up in-band noise between 22 Hz and the 25 Hz Nyquist.
 *     The bilinear-transform-warped digital response is much steeper
 *     near fs/2 than the analog reference, so resonance components
 *     that land in that strip are sharply attenuated.
 *   - Spectral cleanup ML_MODEL_SPEC §6.1 calls for before feature
 *     extraction (#492 spectral features especially benefit from a
 *     clean upper band).
 *   - Stops the per-window-edge transient that would otherwise show
 *     up if features were extracted directly from raw samples.
 *
 * If a future device proves to deliver heavily-aliased signal (e.g.
 * because the OS framework's hardware low-pass is bypassed at 50 Hz),
 * the mitigation is to request a higher sample rate from the bridge
 * (e.g. 200 Hz) and decimate to 50 Hz *after* this filter — but
 * that's a sensor-stack change well beyond the scope of #493.
 */

export interface BiquadCoefficients {
  /** Feed-forward taps (numerator, normalised so a0 = 1). */
  readonly b0: number;
  readonly b1: number;
  readonly b2: number;
  /** Feedback taps (denominator). a0 is implicit 1. */
  readonly a1: number;
  readonly a2: number;
}

/** Production sensor sample rate (Hz). Mirrors `SAMPLE_RATE_MS` in sensors.ts. */
export const SENSOR_SAMPLE_RATE_HZ = 50;

/**
 * Production low-pass cutoff (Hz). 22 Hz keeps the passband well below
 * the 25 Hz Nyquist so the bilinear-transform response distortion near
 * fs/2 doesn't reshape the road signal (≤ 20 Hz on chassis).
 */
export const SENSOR_LOWPASS_CUTOFF_HZ = 22;

/**
 * Compute biquad coefficients for a 4th-order Butterworth lowpass
 * decomposed into two cascaded second-order sections. Both stages
 * share the cutoff but use different Q values to place the four poles
 * of a Butterworth response on the s-plane unit circle:
 *
 *   Q₁ = 1 / (2·sin(3π/8)) ≈ 0.5412
 *   Q₂ = 1 / (2·sin(π/8))  ≈ 1.3066
 *
 * The standard RBJ Audio EQ Cookbook biquad design is used per stage;
 * the bilinear-transform pre-warping is implicit in the cookbook
 * formulas. The result is a Butterworth-shape magnitude response with
 * the requested -3 dB cutoff.
 */
export function butterworthLowpassCoefficients(
  cutoffHz: number,
  sampleRateHz: number,
): readonly [BiquadCoefficients, BiquadCoefficients] {
  if (cutoffHz <= 0 || cutoffHz >= sampleRateHz / 2) {
    throw new Error(
      `Lowpass cutoff ${cutoffHz} Hz must be in (0, ${sampleRateHz / 2}) at fs=${sampleRateHz} Hz`,
    );
  }
  const omega = (2 * Math.PI * cutoffHz) / sampleRateHz;
  const Q1 = 1 / (2 * Math.sin((3 * Math.PI) / 8));
  const Q2 = 1 / (2 * Math.sin(Math.PI / 8));
  return [
    biquadCoefficients(omega, Q1),
    biquadCoefficients(omega, Q2),
  ] as const;
}

function biquadCoefficients(omega: number, q: number): BiquadCoefficients {
  const cosW = Math.cos(omega);
  const sinW = Math.sin(omega);
  const alpha = sinW / (2 * q);
  const a0 = 1 + alpha;
  const b0 = (1 - cosW) / 2;
  const b1 = 1 - cosW;
  const b2 = (1 - cosW) / 2;
  const a1 = -2 * cosW;
  const a2 = 1 - alpha;
  return {
    b0: b0 / a0,
    b1: b1 / a0,
    b2: b2 / a0,
    a1: a1 / a0,
    a2: a2 / a0,
  };
}

/**
 * Pre-computed Butterworth lowpass coefficients for the production
 * sensor stream (50 Hz, 22 Hz cutoff). Computed once at module load —
 * `LowPassFilter` instances reuse this constant rather than recomputing
 * the coefficients per channel or per sample.
 */
export const SENSOR_LOWPASS_COEFFICIENTS = butterworthLowpassCoefficients(
  SENSOR_LOWPASS_CUTOFF_HZ,
  SENSOR_SAMPLE_RATE_HZ,
);

/**
 * Single second-order IIR section in Direct Form II Transposed.
 * DF II Transposed is the standard choice for fixed-point and
 * floating-point biquads because it minimises round-off error
 * accumulation in the state taps relative to DF I.
 */
class BiquadFilter {
  private z1 = 0;
  private z2 = 0;

  constructor(private readonly coef: BiquadCoefficients) {}

  process(x: number): number {
    const y = this.coef.b0 * x + this.z1;
    this.z1 = this.coef.b1 * x - this.coef.a1 * y + this.z2;
    this.z2 = this.coef.b2 * x - this.coef.a2 * y;
    return y;
  }

  reset(): void {
    this.z1 = 0;
    this.z2 = 0;
  }
}

/**
 * Streaming 4th-order Butterworth lowpass. One instance per channel
 * (ax, ay, az, gx, gy, gz). Each instance owns its own state — call
 * `process` once per incoming sample and `reset` between rides so a
 * previous ride's transient doesn't bleed in.
 */
export class LowPassFilter {
  private readonly stages: readonly BiquadFilter[];

  constructor(
    coefficients: readonly BiquadCoefficients[] = SENSOR_LOWPASS_COEFFICIENTS,
  ) {
    this.stages = coefficients.map((c) => new BiquadFilter(c));
  }

  process(x: number): number {
    let y = x;
    for (const stage of this.stages) {
      y = stage.process(y);
    }
    return y;
  }

  reset(): void {
    for (const stage of this.stages) {
      stage.reset();
    }
  }
}
