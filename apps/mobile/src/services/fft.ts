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
      const reI = re[i] ?? 0;
      const reJ = re[j] ?? 0;
      re[i] = reJ;
      re[j] = reI;
      const imI = im[i] ?? 0;
      const imJ = im[j] ?? 0;
      im[i] = imJ;
      im[j] = imI;
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
        const reHalf = re[start + k + half] ?? 0;
        const imHalf = im[start + k + half] ?? 0;
        const tRe = reHalf * wRe - imHalf * wIm;
        const tIm = reHalf * wIm + imHalf * wRe;
        const uRe = re[start + k] ?? 0;
        const uIm = im[start + k] ?? 0;
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
  for (let i = 0; i < n; i++) mean += signal[i] ?? 0;
  mean /= n;

  // Hann window over the original n samples; zero-pad to fftN.
  for (let i = 0; i < n; i++) {
    const w = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
    re[i] = ((signal[i] ?? 0) - mean) * w;
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
    const reK = re[k] ?? 0;
    const imK = im[k] ?? 0;
    const power = reK * reK + imK * imK;
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
  // normalised by `ln(analysisBins)` — the count of *all* analysis
  // bins (1..topBin), not just the bins that ended up with non-zero
  // power. Normalising by the used-bin count would conflate a
  // 3-bin-concentrated spectrum with broadband white noise (both
  // would sit at 1.0); using the full denominator keeps the value
  // tied to "how spread out is this signal across the analysis band"
  // — silence and pure tones → 0, white noise → ≈1, anything in
  // between scales linearly with bin coverage. The training pipeline
  // must mirror this exact denominator (issue #492 model contract).
  let entropySum = 0;
  for (let k = 1; k <= topBin; k++) {
    const reK = re[k] ?? 0;
    const imK = im[k] ?? 0;
    const power = reK * reK + imK * imK;
    if (power === 0) continue;
    const p = power / totalPower;
    entropySum -= p * Math.log(p);
  }
  const analysisBins = topBin; // bins k = 1..topBin inclusive
  const entropy = analysisBins > 1 ? entropySum / Math.log(analysisBins) : 0;

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
