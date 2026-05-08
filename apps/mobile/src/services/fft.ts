/**
 * Frequency-domain helpers for the on-device road-surface classifier
 * (issue #492 / `docs/ML_MODEL_SPEC.md` §3.3).
 *
 * The 2-second / 100-sample accelerometer window passes through the FFT
 * to derive the seven spectral features the v1.1 model contract relies
 * on (see `mlClassifier.INPUT_FEATURES`). A small in-repo radix-2 FFT
 * keeps the inference path free of native dependencies — JS-only is
 * fine here because a 128-point FFT is ~900 complex multiplies, well
 * inside the per-window budget (the spec caps inference at 50 ms total
 * and the existing time-domain pass already runs in well under 1 ms).
 */

export interface SpectralFeatures {
  spectral_centroid: number;
  spectral_energy_low: number;
  spectral_energy_mid: number;
  spectral_energy_high: number;
  dominant_frequency: number;
  spectral_entropy: number;
  band_ratio_high_low: number;
}

/** Lower bound (inclusive) of the low/mid/high accelerometer bands (Hz). */
export const SPECTRAL_BAND_LOW_HZ = 0;
export const SPECTRAL_BAND_MID_HZ = 5;
export const SPECTRAL_BAND_HIGH_HZ = 15;
/** Upper bound (exclusive) of the high band — also the analysis ceiling. */
export const SPECTRAL_BAND_TOP_HZ = 25;

/** Smallest power of two ≥ `n`. */
export function nextPowerOfTwo(n: number): number {
  if (n <= 1) return 1;
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

/**
 * In-place radix-2 iterative Cooley-Tukey FFT. `re` / `im` carry the
 * real and imaginary parts of the signal; for a real input pass an
 * imaginary buffer of zeros. Length must be a power of two.
 *
 * Forward transform only — `1/N` scaling is left to the caller (the
 * power spectrum we compute downstream is invariant under it).
 */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  if (n !== im.length) {
    throw new Error("fft: re/im length mismatch");
  }
  if (n === 0 || (n & (n - 1)) !== 0) {
    throw new Error(`fft: length ${n} is not a power of two`);
  }

  // Bit-reversal permutation.
  let j = 0;
  for (let i = 1; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) {
      j ^= bit;
    }
    j ^= bit;
    if (i < j) {
      let tmp = re[i];
      re[i] = re[j];
      re[j] = tmp;
      tmp = im[i];
      im[i] = im[j];
      im[j] = tmp;
    }
  }

  // Butterflies.
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const angleStep = (-2 * Math.PI) / size;
    for (let start = 0; start < n; start += size) {
      for (let k = 0; k < half; k++) {
        const angle = angleStep * k;
        const wRe = Math.cos(angle);
        const wIm = Math.sin(angle);
        const tRe = re[start + k + half] * wRe - im[start + k + half] * wIm;
        const tIm = re[start + k + half] * wIm + im[start + k + half] * wRe;
        const uRe = re[start + k];
        const uIm = im[start + k];
        re[start + k] = uRe + tRe;
        im[start + k] = uIm + tIm;
        re[start + k + half] = uRe - tRe;
        im[start + k + half] = uIm - tIm;
      }
    }
  }
}

/**
 * Returns zeros across every spectral feature. Used both for degenerate
 * inputs (silent / too-short signal) and as the post-mean-removal
 * fallback when the windowed signal carries no AC energy.
 */
function zeroFeatures(): SpectralFeatures {
  return {
    spectral_centroid: 0,
    spectral_energy_low: 0,
    spectral_energy_mid: 0,
    spectral_energy_high: 0,
    dominant_frequency: 0,
    spectral_entropy: 0,
    band_ratio_high_low: 0,
  };
}

/**
 * Compute the seven spectral features (per `ML_MODEL_SPEC.md` §3.3) for
 * a real-valued signal sampled at `sampleRateHz`.
 *
 * Pipeline:
 *   1. Subtract the mean (drop DC) — the centroid and dominant-freq
 *      metrics are uninteresting at 0 Hz.
 *   2. Apply a Hann window to suppress spectral leakage from the
 *      finite window.
 *   3. Zero-pad to the next power of two (128 for the canonical 100-
 *      sample / 50 Hz window) and FFT.
 *   4. Reduce to a power spectrum on the positive-frequency bins,
 *      ignoring everything above `SPECTRAL_BAND_TOP_HZ` so noise above
 *      the spec's 25 Hz cutoff doesn't bias the centroid / entropy.
 *
 * Returns all-zero features when the signal is degenerate (silent,
 * sub-4 samples, or `sampleRateHz <= 0`) so the downstream feature
 * vector stays well-formed.
 */
export function computeSpectralFeatures(
  signal: ArrayLike<number>,
  sampleRateHz: number,
): SpectralFeatures {
  const n = signal.length;
  if (n < 4 || sampleRateHz <= 0) return zeroFeatures();

  const fftN = nextPowerOfTwo(n);
  const re = new Float64Array(fftN);
  const im = new Float64Array(fftN);

  let mean = 0;
  for (let i = 0; i < n; i++) mean += signal[i];
  mean /= n;

  // Hann window over the original n samples; zero-pad to fftN.
  for (let i = 0; i < n; i++) {
    const w = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
    re[i] = (signal[i] - mean) * w;
  }

  fft(re, im);

  const halfN = fftN >> 1;
  const binHz = sampleRateHz / fftN;
  const topBin = Math.min(halfN, Math.floor(SPECTRAL_BAND_TOP_HZ / binHz));

  let totalPower = 0;
  let centroidNum = 0;
  let dominantBin = 0;
  let dominantPower = -1;
  let energyLow = 0;
  let energyMid = 0;
  let energyHigh = 0;

  // Pass 1: bin-wise power, band sums, dominant bin (skip DC).
  for (let k = 1; k <= topBin; k++) {
    const power = re[k] * re[k] + im[k] * im[k];
    if (power === 0) continue;
    const f = k * binHz;
    totalPower += power;
    centroidNum += f * power;

    if (power > dominantPower) {
      dominantPower = power;
      dominantBin = k;
    }

    if (f < SPECTRAL_BAND_MID_HZ) energyLow += power;
    else if (f < SPECTRAL_BAND_HIGH_HZ) energyMid += power;
    else energyHigh += power;
  }

  if (totalPower === 0) return zeroFeatures();

  // Pass 2: Shannon entropy of the in-band probability distribution,
  // normalised to [0, 1] by `ln(usedBins)` so silence and a tone both
  // yield 0 and white noise yields ≈1 regardless of FFT size.
  let entropySum = 0;
  let usedBins = 0;
  for (let k = 1; k <= topBin; k++) {
    const power = re[k] * re[k] + im[k] * im[k];
    if (power === 0) continue;
    const p = power / totalPower;
    entropySum -= p * Math.log(p);
    usedBins++;
  }
  const entropy = usedBins > 1 ? entropySum / Math.log(usedBins) : 0;

  return {
    spectral_centroid: centroidNum / totalPower,
    spectral_energy_low: energyLow,
    spectral_energy_mid: energyMid,
    spectral_energy_high: energyHigh,
    dominant_frequency: dominantBin * binHz,
    spectral_entropy: entropy,
    band_ratio_high_low: energyLow > 0 ? energyHigh / energyLow : 0,
  };
}
