/**
 * Quality threshold helpers — the shared primitives that decide whether a
 * road segment passes the rider's minimum-quality filter (US-5).
 *
 * We lock in the boundary semantics (inclusive at the threshold) and the
 * "gray when excluded" color contract because the map overlay, the road
 * preview and the trip planner all depend on them.
 */

import {
  colors,
  meetsQualityThreshold,
  qualityColor,
  qualityColorWithThreshold,
} from "../index";

describe("meetsQualityThreshold", () => {
  it("passes when score equals the threshold (inclusive boundary)", () => {
    expect(meetsQualityThreshold(3, 3)).toBe(true);
  });

  it("passes when score is above the threshold", () => {
    expect(meetsQualityThreshold(4.2, 3)).toBe(true);
  });

  it("fails when score is below the threshold", () => {
    expect(meetsQualityThreshold(2.9, 3)).toBe(false);
  });

  it("rejects non-finite scores so unknown segments are excluded", () => {
    expect(meetsQualityThreshold(Number.NaN, 1)).toBe(false);
    expect(meetsQualityThreshold(Number.POSITIVE_INFINITY, 1)).toBe(false);
  });
});

describe("qualityColorWithThreshold", () => {
  it("returns the bucket color when the segment meets the threshold", () => {
    // 4.6 is in the "excellent" bucket, so it should match qualityColor.
    expect(qualityColorWithThreshold(4.6, 3)).toBe(qualityColor(4.6));
  });

  it("returns the dim (tertiary text) color when below the threshold", () => {
    expect(qualityColorWithThreshold(1.8, 3)).toBe(colors.textTertiary);
  });

  it("uses dim color for NaN so excluded segments never look vibrant", () => {
    expect(qualityColorWithThreshold(Number.NaN, 2)).toBe(colors.textTertiary);
  });
});
