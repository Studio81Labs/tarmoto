/**
 * FFT + spectral-feature helpers (issue #492).
 *
 * The on-device classifier relies on these features to distinguish
 * surface types (cobblestone vs gravel vs rough asphalt) from the
 * 2-second / 100-sample acceleration window. This test suite pins
 * three behaviours the classifier depends on:
 *
 *   - silent input → no spectral energy in any band
 *   - pure sine    → dominant frequency near the input frequency
 *   - white noise  → high spectral entropy (energy spread across bins)
 *
 * It also covers the FFT primitive itself against a known sine input,
 * and the in-band reduction that powers `spectral_energy_*` /
 * `band_ratio_high_low`.
 */

import {
  computeSpectralFeatures,
  fft,
  nextPowerOfTwo,
  SPECTRAL_BAND_HIGH_HZ,
  SPECTRAL_BAND_MID_HZ,
  SPECTRAL_BAND_TOP_HZ,
} from "../fft";

const SAMPLE_RATE_HZ = 50;
const WINDOW_SAMPLES = 100;

function makeSine(
  freqHz: number,
  amplitude: number,
  samples: number,
  sampleRateHz: number,
): Float64Array {
  const out = new Float64Array(samples);
  const w = 2 * Math.PI * freqHz;
  for (let i = 0; i < samples; i++) {
    out[i] = amplitude * Math.sin(w * (i / sampleRateHz));
  }
  return out;
}

/**
 * Mulberry32 — small deterministic PRNG. Using a seeded generator keeps
 * the white-noise test reproducible across CI runs; `Math.random()` is
 * fine in production but flaky in unit tests.
 */
function seededRandom(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("nextPowerOfTwo", () => {
  it("rounds up to the next power of two", () => {
    expect(nextPowerOfTwo(1)).toBe(1);
    expect(nextPowerOfTwo(2)).toBe(2);
    expect(nextPowerOfTwo(3)).toBe(4);
    expect(nextPowerOfTwo(100)).toBe(128);
    expect(nextPowerOfTwo(128)).toBe(128);
    expect(nextPowerOfTwo(129)).toBe(256);
  });
});

describe("fft (radix-2 in-place)", () => {
  it("rejects non-power-of-two lengths", () => {
    expect(() => fft(new Float64Array(3), new Float64Array(3))).toThrow();
  });

  it("rejects mismatched re/im lengths", () => {
    expect(() => fft(new Float64Array(4), new Float64Array(8))).toThrow();
  });

  it("produces a single-bin spike for an integer-period sine", () => {
    // 8 Hz sine at 50 Hz over 128 samples falls just off-bin (50/128 ≈
    // 0.39 Hz/bin → 8 Hz lands at bin 20.48); to keep this exact-ish we
    // synthesize at fs=64 and N=64 so the 8 Hz bin lands precisely.
    const N = 64;
    const fs = 64;
    const targetBin = 8;
    const re = new Float64Array(N);
    const im = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      re[i] = Math.sin(2 * Math.PI * targetBin * (i / fs));
    }
    fft(re, im);

    const power = Array.from(
      { length: N / 2 + 1 },
      (_, k) => re[k] * re[k] + im[k] * im[k],
    );
    let maxBin = 0;
    for (let k = 1; k < power.length; k++) {
      if (power[k] > power[maxBin]) maxBin = k;
    }
    expect(maxBin).toBe(targetBin);
  });
});

describe("computeSpectralFeatures — degenerate inputs", () => {
  it("returns all-zero features for a silent (all-zero) window", () => {
    // Silence is the spec's first acceptance check: classifier must see
    // no spectral energy in any band so the model can't be tricked
    // into "rough" by a stopped or ungrounded sensor.
    const silent = new Float64Array(WINDOW_SAMPLES);
    const f = computeSpectralFeatures(silent, SAMPLE_RATE_HZ);

    expect(f.spectral_energy_low).toBe(0);
    expect(f.spectral_energy_mid).toBe(0);
    expect(f.spectral_energy_high).toBe(0);
    expect(f.spectral_centroid).toBe(0);
    expect(f.dominant_frequency).toBe(0);
    expect(f.spectral_entropy).toBe(0);
    expect(f.band_ratio_high_low).toBe(0);
  });

  it("returns near-zero spectral energy for a constant (DC-only) window", () => {
    // A constant signal is all DC and the helper drops DC before the
    // FFT. Mean removal on a 100-element float64 buffer leaves a few
    // ulps of residual energy (e.g. 100 × 3.7 / 100 differs from 3.7
    // by ~6e-16) — assert "negligibly small" rather than exact zero so
    // the test stays stable across architectures.
    const dc = new Float64Array(WINDOW_SAMPLES).fill(3.7);
    const f = computeSpectralFeatures(dc, SAMPLE_RATE_HZ);

    expect(f.spectral_energy_low).toBeLessThan(1e-20);
    expect(f.spectral_energy_mid).toBeLessThan(1e-20);
    expect(f.spectral_energy_high).toBeLessThan(1e-20);
  });

  it("returns zeros for a sub-4-sample input rather than throwing", () => {
    // A short window can happen during an early-stop on the very first
    // ride-second; we'd rather pass through harmless zeros than crash
    // the per-window pipeline.
    const tiny = new Float64Array([1, 2, 3]);
    const f = computeSpectralFeatures(tiny, SAMPLE_RATE_HZ);
    expect(f.spectral_centroid).toBe(0);
  });

  it("returns zeros for a non-positive sample rate", () => {
    const f = computeSpectralFeatures(
      new Float64Array(WINDOW_SAMPLES).fill(1),
      0,
    );
    expect(f.spectral_centroid).toBe(0);
  });
});

describe("computeSpectralFeatures — pure tone", () => {
  it("places dominant frequency near a 10 Hz sine input", () => {
    // 10 Hz lives in the mid band (5–15 Hz). At fs=50 / N_pad=128 the
    // bin width is ~0.39 Hz; the dominant bin should land within one
    // bin of 10 Hz.
    const sine = makeSine(10, 1, WINDOW_SAMPLES, SAMPLE_RATE_HZ);
    const f = computeSpectralFeatures(sine, SAMPLE_RATE_HZ);

    expect(f.dominant_frequency).toBeGreaterThan(9);
    expect(f.dominant_frequency).toBeLessThan(11);
  });

  it("concentrates a 10 Hz tone in the mid band", () => {
    const sine = makeSine(10, 1, WINDOW_SAMPLES, SAMPLE_RATE_HZ);
    const f = computeSpectralFeatures(sine, SAMPLE_RATE_HZ);

    // The mid band must dominate — but Hann-window leakage scatters
    // some energy into the low band at the 5 Hz boundary, so we test
    // the qualitative ordering, not strict equality.
    expect(f.spectral_energy_mid).toBeGreaterThan(f.spectral_energy_low);
    expect(f.spectral_energy_mid).toBeGreaterThan(f.spectral_energy_high);
  });

  it("places a 2 Hz tone in the low band (large bumps / body roll)", () => {
    const sine = makeSine(2, 1, WINDOW_SAMPLES, SAMPLE_RATE_HZ);
    const f = computeSpectralFeatures(sine, SAMPLE_RATE_HZ);

    expect(f.spectral_energy_low).toBeGreaterThan(f.spectral_energy_mid);
    expect(f.spectral_energy_low).toBeGreaterThan(f.spectral_energy_high);
    expect(f.dominant_frequency).toBeLessThan(SPECTRAL_BAND_MID_HZ);
  });

  it("places a 20 Hz tone in the high band (gravel / fine texture)", () => {
    const sine = makeSine(20, 1, WINDOW_SAMPLES, SAMPLE_RATE_HZ);
    const f = computeSpectralFeatures(sine, SAMPLE_RATE_HZ);

    expect(f.spectral_energy_high).toBeGreaterThan(f.spectral_energy_low);
    expect(f.spectral_energy_high).toBeGreaterThan(f.spectral_energy_mid);
    expect(f.dominant_frequency).toBeGreaterThanOrEqual(SPECTRAL_BAND_HIGH_HZ);
    expect(f.dominant_frequency).toBeLessThan(SPECTRAL_BAND_TOP_HZ);
  });

  it("yields a low spectral entropy for a pure tone", () => {
    // A single frequency concentrates probability mass on one bin →
    // near-zero normalised entropy. White noise (other test) sits at
    // the opposite end of this scale.
    const sine = makeSine(10, 1, WINDOW_SAMPLES, SAMPLE_RATE_HZ);
    const f = computeSpectralFeatures(sine, SAMPLE_RATE_HZ);
    expect(f.spectral_entropy).toBeGreaterThanOrEqual(0);
    expect(f.spectral_entropy).toBeLessThan(0.5);
  });

  it("computes the band ratio as high/low energy", () => {
    // A 20 Hz tone has all its mass in the high band → ratio ≫ 1. A
    // 2 Hz tone has it in the low band → ratio ≪ 1. The model uses
    // this to separate gravel (high-frequency-dominated) from a
    // pothole (low-frequency thump).
    const high = computeSpectralFeatures(
      makeSine(20, 1, WINDOW_SAMPLES, SAMPLE_RATE_HZ),
      SAMPLE_RATE_HZ,
    );
    expect(high.band_ratio_high_low).toBeGreaterThan(1);

    const low = computeSpectralFeatures(
      makeSine(2, 1, WINDOW_SAMPLES, SAMPLE_RATE_HZ),
      SAMPLE_RATE_HZ,
    );
    expect(low.band_ratio_high_low).toBeLessThan(1);
  });
});

describe("computeSpectralFeatures — white noise", () => {
  it("produces a high spectral entropy", () => {
    // White-ish noise spreads energy across all bins → normalised
    // entropy near 1. We sample a longer window (4 × 100 samples) so
    // randomness has room to average out and the assertion is stable.
    const rand = seededRandom(0x4242);
    const noise = new Float64Array(WINDOW_SAMPLES * 4);
    for (let i = 0; i < noise.length; i++) noise[i] = rand() * 2 - 1;

    const f = computeSpectralFeatures(noise, SAMPLE_RATE_HZ);

    expect(f.spectral_entropy).toBeGreaterThan(0.85);
    expect(f.spectral_entropy).toBeLessThanOrEqual(1.0001);
  });

  it("scatters energy across all three bands", () => {
    const rand = seededRandom(0x1234);
    const noise = new Float64Array(WINDOW_SAMPLES * 4);
    for (let i = 0; i < noise.length; i++) noise[i] = rand() * 2 - 1;

    const f = computeSpectralFeatures(noise, SAMPLE_RATE_HZ);

    expect(f.spectral_energy_low).toBeGreaterThan(0);
    expect(f.spectral_energy_mid).toBeGreaterThan(0);
    expect(f.spectral_energy_high).toBeGreaterThan(0);
  });
});
