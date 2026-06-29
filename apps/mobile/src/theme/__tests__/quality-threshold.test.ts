/**
 * Quality threshold helper — the shared primitive that decides whether a
 * road segment passes the rider's minimum-quality filter (US-5).
 *
 * We lock in the boundary semantics (inclusive at the threshold) because the
 * map overlay, the road preview and the trip planner all depend on them. The
 * "gray when excluded" colour now comes from the brand ramp (the map overlay
 * paints below-threshold segments in `UNSCORED_COLOR`); the colour contract is
 * exercised in the MapScreen/RideScreens helper tests.
 */

import { meetsQualityThreshold } from "../index";

describe("meetsQualityThreshold", () => {
  it("passes when score sits inside the threshold label's bucket", () => {
    // 2.8 is labeled "Fair" (>= 2.5), so a "Fair or better" filter
    // (minQuality = 3) must accept it — otherwise the UI copy lies.
    expect(meetsQualityThreshold(2.8, 3)).toBe(true);
  });

  it("passes when score is above the threshold label", () => {
    expect(meetsQualityThreshold(4.2, 3)).toBe(true);
  });

  it("passes at the exact bucket boundary", () => {
    // minQuality = 3 ("Fair") → lower edge is 2.5.
    expect(meetsQualityThreshold(2.5, 3)).toBe(true);
  });

  it("fails when score falls into the bucket below the threshold", () => {
    // 2.4 is labeled "Poor", so it should fail a "Fair or better" filter.
    expect(meetsQualityThreshold(2.4, 3)).toBe(false);
  });

  it("accepts any real score when the threshold is the minimum", () => {
    expect(meetsQualityThreshold(1, 1)).toBe(true);
    expect(meetsQualityThreshold(0.5, 1)).toBe(true);
  });

  it("requires near-perfect scores at the top bucket", () => {
    // minQuality = 5 ("Excellent") → lower edge is 4.5. A 4.7 "Excellent"
    // road should pass an "Excellent" filter, a 4.4 "Good" should not.
    expect(meetsQualityThreshold(4.7, 5)).toBe(true);
    expect(meetsQualityThreshold(4.4, 5)).toBe(false);
  });

  it("rejects non-finite scores so unknown segments are excluded", () => {
    expect(meetsQualityThreshold(Number.NaN, 1)).toBe(false);
    expect(meetsQualityThreshold(Number.POSITIVE_INFINITY, 1)).toBe(false);
  });
});
