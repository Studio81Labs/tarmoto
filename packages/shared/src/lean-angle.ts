/**
 * Lean angle bucketing (US-19).
 *
 * Per-window absolute lean angles are bucketed into the four ranges
 * below for the per-ride histogram rendered on the mobile ride-detail
 * screen and persisted on `ride_stats.lean_distribution_json`. Both
 * mobile and backend share this contract so a histogram aggregated
 * server-side and a histogram derived client-side from the same
 * samples produce the same buckets.
 */

export type LeanBucketId = "0_10" | "10_20" | "20_30" | "30_plus";

export interface LeanBucket {
  /** Stable identifier persisted on `ride_stats.lean_distribution_json`. */
  id: LeanBucketId;
  /** Inclusive lower bound in degrees. */
  minDeg: number;
  /**
   * Exclusive upper bound in degrees. `Infinity` for the open-ended
   * top bucket so 60° / 70° leans don't get dropped.
   */
  maxDeg: number;
  /** Display label for the histogram row. */
  label: string;
}

export const LEAN_BUCKETS: readonly LeanBucket[] = [
  { id: "0_10", minDeg: 0, maxDeg: 10, label: "0–10°" },
  { id: "10_20", minDeg: 10, maxDeg: 20, label: "10–20°" },
  { id: "20_30", minDeg: 20, maxDeg: 30, label: "20–30°" },
  { id: "30_plus", minDeg: 30, maxDeg: Infinity, label: "30°+" },
] as const;

export type LeanDistribution = Record<LeanBucketId, number>;

/** Empty distribution — every bucket at zero. */
export function emptyLeanDistribution(): LeanDistribution {
  return { "0_10": 0, "10_20": 0, "20_30": 0, "30_plus": 0 };
}

/**
 * Bucket a single absolute lean angle in degrees. Negative or non-finite
 * values return `null` so callers can decide whether to drop the sample
 * or treat it as zero.
 */
export function leanBucketFor(absDeg: number): LeanBucketId | null {
  if (!Number.isFinite(absDeg) || absDeg < 0) return null;
  for (const bucket of LEAN_BUCKETS) {
    if (absDeg >= bucket.minDeg && absDeg < bucket.maxDeg) {
      return bucket.id;
    }
  }
  // `LEAN_BUCKETS` covers `[0, ∞)` so a finite non-negative reading
  // always lands in some bucket — but TypeScript can't prove that, and
  // an invariant violation upstream shouldn't crash the aggregator.
  return null;
}

/**
 * Tally a stream of lean samples (absolute degrees) into a bucket
 * histogram. Each sample is one window; the resulting counts are
 * "windows in bucket", not "seconds" — callers convert by multiplying
 * by the window step (1 second at 50 Hz / step=50).
 */
export function tallyLeanSamples(samples: Iterable<number>): LeanDistribution {
  const out = emptyLeanDistribution();
  for (const sample of samples) {
    const bucket = leanBucketFor(Math.abs(sample));
    if (bucket) out[bucket] += 1;
  }
  return out;
}

/**
 * Combine two distributions — used by the backend when a ride uploads
 * multiple sensor batches and each batch contributes its own histogram
 * to the cumulative `ride_stats.lean_distribution_json`. Pure: returns
 * a fresh object.
 */
export function mergeLeanDistributions(
  a: LeanDistribution,
  b: LeanDistribution,
): LeanDistribution {
  return {
    "0_10": (a["0_10"] ?? 0) + (b["0_10"] ?? 0),
    "10_20": (a["10_20"] ?? 0) + (b["10_20"] ?? 0),
    "20_30": (a["20_30"] ?? 0) + (b["20_30"] ?? 0),
    "30_plus": (a["30_plus"] ?? 0) + (b["30_plus"] ?? 0),
  };
}

/**
 * Round-trip through JSON-safe shape with defaults for any missing
 * keys. Backend reads the column as `unknown` and feeds it through
 * here before merging so a hand-edited or migrated row that drops a
 * bucket key still produces a complete distribution.
 */
export function normalizeLeanDistribution(value: unknown): LeanDistribution {
  if (typeof value !== "object" || value === null) {
    return emptyLeanDistribution();
  }
  const v = value as Partial<Record<LeanBucketId, unknown>>;
  return {
    "0_10": toCount(v["0_10"]),
    "10_20": toCount(v["10_20"]),
    "20_30": toCount(v["20_30"]),
    "30_plus": toCount(v["30_plus"]),
  };
}

function toCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return 0;
  }
  // Histogram counts are always non-negative integers; floor a stray
  // float so JSON.stringify doesn't round-trip `1.0000000001`.
  return Math.floor(value);
}
