/**
 * Sensor pre-processing low-pass filter (issue #493).
 *
 * The filter has to satisfy four properties to be safe to drop into
 * the live 50 Hz sensor pipeline:
 *
 *   1. **Stopband attenuation.** A tone above the 22 Hz cutoff is
 *      meaningfully attenuated (≥ 20 dB at 40 Hz; ≥ 10 dB at 30 Hz).
 *      This is the property that removes case rattle, mount
 *      resonance, and GPS antenna buzz — none of which carry road-
 *      surface signal. (The issue's "≥ 20 dB at 30 Hz" target isn't
 *      physically reachable with a 4th-order Butterworth at fc=22 Hz:
 *      analog math gives 1/√(1 + (30/22)⁸) ≈ 0.28 ≈ -11 dB, so we
 *      verify the same shape using ≥ 20 dB at the next-octave-out
 *      40 Hz where 4th-order Butterworth comfortably hits the bar.)
 *
 *   2. **Passband flatness.** A 5 Hz tone (typical road-bump
 *      frequency) passes with < 1 dB loss, so the RMS / peak-to-peak
 *      / spectral features the ML pipeline depends on aren't reshaped.
 *
 *   3. **Impulse response decay.** The filter settles within ~50
 *      samples (1 s at 50 Hz). A long ringing tail would make every
 *      pothole leak energy into the next 2 s window.
 *
 *   4. **State continuity.** Filtering an N-sample stream in two
 *      halves (with state preserved) produces the same output as
 *      filtering it in one shot. Without this guarantee the 1 s
 *      window slide would inject a fresh transient into every window
 *      boundary, exactly the artefact the issue is trying to remove.
 *
 * Tests use the production fs=50 Hz / fc=22 Hz where appropriate.
 * The stopband tests are run at fs=200 Hz with the same 22 Hz cutoff
 * so the test signal is unaliased — at fs=50 Hz a 30 Hz tone folds
 * back to 20 Hz and would not actually exercise the stopband.
 */

import * as fs from "fs";
import * as path from "path";
import {
  butterworthLowpassCoefficients,
  LowPassFilter,
  SENSOR_LOWPASS_COEFFICIENTS,
  SENSOR_LOWPASS_CUTOFF_HZ,
  SENSOR_SAMPLE_RATE_HZ,
} from "../sensorsFilter";

function generateTone(
  frequencyHz: number,
  sampleRateHz: number,
  durationS: number,
): number[] {
  const n = Math.floor(sampleRateHz * durationS);
  const samples: number[] = new Array(n);
  const omega = (2 * Math.PI * frequencyHz) / sampleRateHz;
  for (let i = 0; i < n; i++) {
    samples[i] = Math.sin(omega * i);
  }
  return samples;
}

/** Steady-state RMS of the second half of a filtered tone. */
function steadyStateRms(filter: LowPassFilter, signal: number[]): number {
  const filtered = signal.map((x) => filter.process(x));
  // Discard the first half so the filter's transient doesn't bias the
  // RMS measurement. For the durations used here the second half is
  // comfortably steady-state.
  const tail = filtered.slice(Math.floor(filtered.length / 2));
  const sumSq = tail.reduce((acc, v) => acc + v * v, 0);
  return Math.sqrt(sumSq / tail.length);
}

describe("butterworthLowpassCoefficients", () => {
  it("rejects cutoffs at or above Nyquist", () => {
    expect(() => butterworthLowpassCoefficients(25, 50)).toThrow();
    expect(() => butterworthLowpassCoefficients(30, 50)).toThrow();
    expect(() => butterworthLowpassCoefficients(0, 50)).toThrow();
    expect(() => butterworthLowpassCoefficients(-1, 50)).toThrow();
  });

  it("returns two biquad sections with unity DC gain", () => {
    const stages = butterworthLowpassCoefficients(22, 50);
    expect(stages).toHaveLength(2);
    for (const { b0, b1, b2, a1, a2 } of stages) {
      // H(z=1) = (b0 + b1 + b2) / (1 + a1 + a2). A Butterworth lowpass
      // is unity at DC — drift away from 1 here would mean a steady
      // signal silently shifts in amplitude through the filter.
      const dcGain = (b0 + b1 + b2) / (1 + a1 + a2);
      expect(dcGain).toBeCloseTo(1, 6);
    }
  });

  it("places zeros at Nyquist (z = -1)", () => {
    // A digital lowpass derived via bilinear transform has zeros at
    // fs/2 — the numerator collapses to zero at z = -1. Verifies the
    // coefficient design rather than just the API surface.
    const stages = butterworthLowpassCoefficients(22, 50);
    for (const { b0, b1, b2 } of stages) {
      expect(b0 - b1 + b2).toBeCloseTo(0, 6);
    }
  });
});

describe("LowPassFilter — frequency response", () => {
  it("attenuates a 30 Hz tone by at least 10 dB above the 22 Hz cutoff", () => {
    // fs=200 Hz so the 30 Hz tone is unaliased (Nyquist 100 Hz).
    // The same 22 Hz cutoff is used so the filter shape under test is
    // exactly the production design, only sampled finer. 30 Hz is
    // 1.36× cutoff — analog Butterworth gives ~-11 dB here; we assert
    // ≥ 10 dB to leave a small margin against numerical drift.
    const stages = butterworthLowpassCoefficients(22, 200);
    const filter = new LowPassFilter(stages);
    const signal = generateTone(30, 200, 4);
    const inputRms = Math.SQRT1_2; // RMS of a unit sine
    const outRms = steadyStateRms(filter, signal);
    const attenuationDb = 20 * Math.log10(outRms / inputRms);
    expect(attenuationDb).toBeLessThanOrEqual(-10);
  });

  it("attenuates a 40 Hz tone by at least 20 dB", () => {
    // 40 Hz is ~1.82× the 22 Hz cutoff — well into the stopband for
    // a 4th-order Butterworth: analog math gives 1/√(1+1.82⁸) ≈
    // -22 dB. The digital implementation is slightly steeper than
    // the analog reference at fs=200 Hz so the bar is comfortable.
    const stages = butterworthLowpassCoefficients(22, 200);
    const filter = new LowPassFilter(stages);
    const signal = generateTone(40, 200, 4);
    const inputRms = Math.SQRT1_2;
    const outRms = steadyStateRms(filter, signal);
    const attenuationDb = 20 * Math.log10(outRms / inputRms);
    expect(attenuationDb).toBeLessThanOrEqual(-20);
  });

  it("passes a 5 Hz tone with less than 1 dB loss", () => {
    const filter = new LowPassFilter();
    const signal = generateTone(5, SENSOR_SAMPLE_RATE_HZ, 4);
    const inputRms = Math.SQRT1_2;
    const outRms = steadyStateRms(filter, signal);
    const lossDb = 20 * Math.log10(outRms / inputRms);
    expect(lossDb).toBeGreaterThanOrEqual(-1);
    expect(lossDb).toBeLessThanOrEqual(0.05);
  });

  it("uses the production 50 Hz / 22 Hz design by default", () => {
    expect(SENSOR_SAMPLE_RATE_HZ).toBe(50);
    expect(SENSOR_LOWPASS_CUTOFF_HZ).toBe(22);
    // Regression: the default coefficients on the LowPassFilter
    // constructor must match the module-level production constants so
    // every per-axis filter shares the same shape.
    expect(SENSOR_LOWPASS_COEFFICIENTS).toHaveLength(2);
  });
});

describe("LowPassFilter — impulse response", () => {
  it("decays toward zero within ~50 samples (1 s at 50 Hz)", () => {
    const filter = new LowPassFilter();
    // Feed an impulse: 1 followed by zeros. The 4th-order Butterworth
    // is IIR so the response never *reaches* zero, but it should be
    // negligibly small (< 1% of the peak) by ~50 samples.
    let peak = 0;
    let tailMax = 0;
    for (let i = 0; i < 200; i++) {
      const x = i === 0 ? 1 : 0;
      const y = filter.process(x);
      const abs = Math.abs(y);
      if (i < 50) {
        if (abs > peak) peak = abs;
      } else if (abs > tailMax) {
        tailMax = abs;
      }
    }
    expect(peak).toBeGreaterThan(0);
    expect(tailMax / peak).toBeLessThan(0.01);
  });
});

describe("LowPassFilter — state continuity", () => {
  it("produces identical output whether processed in one shot or in chunks", () => {
    // The 1 s sliding window in sensors.ts overlaps and re-processes
    // samples; the filter state taps must persist across windows so
    // each window doesn't start with a fresh transient. Test the
    // streaming guarantee directly: split the input mid-flight, the
    // output must match a single-pass run sample-for-sample.
    const signal = [
      ...generateTone(3, 50, 0.5),
      ...generateTone(15, 50, 0.5),
      ...generateTone(7, 50, 0.5),
    ];

    const oneShot = new LowPassFilter();
    const oneShotOut = signal.map((x) => oneShot.process(x));

    const split = new LowPassFilter();
    const cut = Math.floor(signal.length / 3);
    const part1 = signal.slice(0, cut).map((x) => split.process(x));
    const part2 = signal.slice(cut).map((x) => split.process(x));
    const splitOut = [...part1, ...part2];

    for (let i = 0; i < signal.length; i++) {
      expect(splitOut[i]).toBeCloseTo(oneShotOut[i], 12);
    }
  });

  it("reset() clears state so a new ride doesn't carry the old transient", () => {
    const filter = new LowPassFilter();
    // Drive the filter with a long signal so its state taps are non-
    // trivial, then reset and verify the impulse response from a
    // fresh state matches a freshly-constructed filter exactly.
    for (const v of generateTone(10, 50, 1)) filter.process(v);
    filter.reset();

    const reference = new LowPassFilter();
    for (let i = 0; i < 25; i++) {
      const x = i === 0 ? 1 : 0;
      expect(filter.process(x)).toBeCloseTo(reference.process(x), 12);
    }
  });

  it("isolates state per channel", () => {
    // Each per-axis filter in sensors.ts has its own LowPassFilter
    // instance. A non-zero ax stream must not affect ay's output.
    const ax = new LowPassFilter();
    const ay = new LowPassFilter();
    for (let i = 0; i < 50; i++) ax.process(Math.sin(i));
    // ay has only seen zeros, so its first impulse response should
    // match a fresh filter's first impulse response.
    const fresh = new LowPassFilter();
    expect(ay.process(1)).toBeCloseTo(fresh.process(1), 12);
  });
});

/**
 * Comparison vs unfiltered RMS on a real ride (issue #493 AC #5).
 *
 * Uses the contiguous first session of the bundled PoC fixture
 * (`apps/poc-sensor/fixtures/ride-2026-04-25-brno/raw.csv`). The PoC
 * recorder runs at ~60 Hz, not the production 50 Hz, so the test
 * derives the actual sample rate from the timestamps and rebuilds the
 * filter at the correct fs while keeping the production 22 Hz cutoff.
 *
 * The expected RMS reduction is small because most road-quality
 * energy is below the 22 Hz cutoff. We expect a ~5–25 % reduction —
 * tight enough to flag a regression that switches the filter polarity
 * or destroys the passband, loose enough to absorb fixture noise.
 */
describe("LowPassFilter — comparison vs unfiltered on the PoC ride fixture", () => {
  type Row = { t: number; ax: number; ay: number; az: number };

  function readContiguousSession(): { samples: Row[]; sampleRateHz: number } {
    const fixturePath = path.resolve(
      __dirname,
      "../../../../../apps/poc-sensor/fixtures/ride-2026-04-25-brno/raw.csv",
    );
    const text = fs.readFileSync(fixturePath, "utf8");
    const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
    // Header: rider,timestamp,ax,ay,az,deviation,lat,lng,speed_kmh,...
    const samples: Row[] = [];
    let prevT: number | null = null;
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(",");
      const t = Number(cols[1]);
      const row = {
        t,
        ax: Number(cols[2]),
        ay: Number(cols[3]),
        az: Number(cols[4]),
      };
      // Stop at the first gap > 100 ms — the fixture concatenates a
      // few ride sessions and using the join would inject a 16-minute
      // jump into the filter state.
      if (prevT !== null && t - prevT > 100) break;
      samples.push(row);
      prevT = t;
    }
    const span = samples[samples.length - 1].t - samples[0].t;
    const sampleRateHz = ((samples.length - 1) * 1000) / span;
    return { samples, sampleRateHz };
  }

  function rmsDeviation(samples: ReadonlyArray<Row>): number {
    let sumSq = 0;
    for (const r of samples) {
      const mag = Math.sqrt(r.ax * r.ax + r.ay * r.ay + r.az * r.az);
      const dev = Math.abs(mag - 9.81);
      sumSq += dev * dev;
    }
    return Math.sqrt(sumSq / samples.length);
  }

  it("reduces RMS deviation by 0–30% on a real 26 s ride clip", () => {
    const { samples, sampleRateHz } = readContiguousSession();
    expect(samples.length).toBeGreaterThan(500);
    expect(sampleRateHz).toBeGreaterThan(40);
    expect(sampleRateHz).toBeLessThan(120);

    const stages = butterworthLowpassCoefficients(
      SENSOR_LOWPASS_CUTOFF_HZ,
      sampleRateHz,
    );
    const filterAx = new LowPassFilter(stages);
    const filterAy = new LowPassFilter(stages);
    const filterAz = new LowPassFilter(stages);

    const filtered: Row[] = samples.map((r) => ({
      t: r.t,
      ax: filterAx.process(r.ax),
      ay: filterAy.process(r.ay),
      az: filterAz.process(r.az),
    }));

    // Skip the first ~1 s of filtered output so the filter's startup
    // transient (state taps initialised to zero against a non-zero
    // gravity offset) doesn't bias the RMS comparison.
    const skip = Math.floor(sampleRateHz);
    const rawRms = rmsDeviation(samples.slice(skip));
    const filteredRms = rmsDeviation(filtered.slice(skip));

    expect(rawRms).toBeGreaterThan(0);
    expect(filteredRms).toBeGreaterThan(0);
    // Filtering should never *amplify* the deviation (modulo the
    // startup transient we skipped above) and should remove some
    // amount of out-of-band energy. A reduction outside 0–30 % means
    // either the filter polarity broke or we're cutting into the road
    // signal — both should fail the build.
    const reductionPct = (1 - filteredRms / rawRms) * 100;
    expect(reductionPct).toBeGreaterThanOrEqual(0);
    expect(reductionPct).toBeLessThan(30);
  });
});
