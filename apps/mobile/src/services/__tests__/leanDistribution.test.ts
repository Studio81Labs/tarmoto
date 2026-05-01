/**
 * Lean-angle bucket helpers (US-19) — exported from `@tarmoto/shared`
 * and consumed by both the mobile sensor pipeline and backend
 * aggregation. The shared package itself doesn't run jest, so the
 * canonical tests live alongside the consumer that exercises them
 * most heavily (mobile).
 */

import {
  emptyLeanDistribution,
  leanBucketFor,
  mergeLeanDistributions,
  normalizeLeanDistribution,
  tallyLeanSamples,
} from "@tarmoto/shared";

describe("leanBucketFor", () => {
  it.each([
    [0, "0_10"],
    [9.999, "0_10"],
    [10, "10_20"],
    [19.99, "10_20"],
    [20, "20_30"],
    [29.99, "20_30"],
    [30, "30_plus"],
    [55, "30_plus"],
    [89.99, "30_plus"],
  ])("buckets %p as %p", (deg, expected) => {
    expect(leanBucketFor(deg)).toBe(expected);
  });

  it("rejects negative and non-finite samples", () => {
    expect(leanBucketFor(-1)).toBeNull();
    expect(leanBucketFor(Number.NaN)).toBeNull();
    expect(leanBucketFor(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe("tallyLeanSamples", () => {
  it("counts samples into the expected buckets and ignores noise", () => {
    const dist = tallyLeanSamples([0, 5, 10, 15, 20, 25, 30, 50, Number.NaN]);
    expect(dist).toEqual({
      "0_10": 2,
      "10_20": 2,
      "20_30": 2,
      "30_plus": 2,
    });
  });

  it("treats negative samples by their absolute value (left = right lean)", () => {
    expect(tallyLeanSamples([-25, -5, 12])).toEqual({
      "0_10": 1,
      "10_20": 1,
      "20_30": 1,
      "30_plus": 0,
    });
  });
});

describe("mergeLeanDistributions", () => {
  it("sums two distributions independently per bucket", () => {
    const a = { "0_10": 5, "10_20": 0, "20_30": 1, "30_plus": 0 };
    const b = { "0_10": 1, "10_20": 3, "20_30": 0, "30_plus": 2 };
    expect(mergeLeanDistributions(a, b)).toEqual({
      "0_10": 6,
      "10_20": 3,
      "20_30": 1,
      "30_plus": 2,
    });
  });
});

describe("normalizeLeanDistribution", () => {
  it("treats null / non-object input as an empty distribution", () => {
    expect(normalizeLeanDistribution(null)).toEqual(emptyLeanDistribution());
    expect(normalizeLeanDistribution("garbage")).toEqual(
      emptyLeanDistribution(),
    );
  });

  it("fills in missing keys with zero so partial JSON survives", () => {
    expect(normalizeLeanDistribution({ "10_20": 4 } as unknown)).toEqual({
      "0_10": 0,
      "10_20": 4,
      "20_30": 0,
      "30_plus": 0,
    });
  });

  it("clamps non-integer / negative counts so a hand-edited row can't poison aggregation", () => {
    expect(
      normalizeLeanDistribution({
        "0_10": -3,
        "10_20": 1.7,
        "20_30": "not a number" as unknown,
        "30_plus": Number.POSITIVE_INFINITY,
      } as unknown),
    ).toEqual({
      "0_10": 0,
      "10_20": 1,
      "20_30": 0,
      "30_plus": 0,
    });
  });
});
