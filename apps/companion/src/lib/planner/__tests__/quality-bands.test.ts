import { describe, expect, it } from "vitest";
import {
  coalesceQualityRuns,
  FAIR_BAND_MIN_SCORE,
  GOOD_BAND_MIN_SCORE,
  isLowConfidence,
  LOW_CONFIDENCE_MAX_PASSES,
  scoreToBand,
} from "../quality-bands";
import type { QualityBand, RouteSegment } from "../types";

describe("scoreToBand", () => {
  it("maps null to no_data", () => {
    expect(scoreToBand(null)).toBe("no_data");
  });

  it("maps scores at or above the good floor to good", () => {
    expect(scoreToBand(GOOD_BAND_MIN_SCORE)).toBe("good");
    expect(scoreToBand(5)).toBe("good");
  });

  it("maps scores between the fair and good floors to fair", () => {
    expect(scoreToBand(FAIR_BAND_MIN_SCORE)).toBe("fair");
    expect(scoreToBand(GOOD_BAND_MIN_SCORE - 0.1)).toBe("fair");
  });

  it("maps scores below the fair floor to rough", () => {
    expect(scoreToBand(FAIR_BAND_MIN_SCORE - 0.1)).toBe("rough");
    expect(scoreToBand(1)).toBe("rough");
  });
});

describe("isLowConfidence", () => {
  it("treats the threshold itself as low confidence", () => {
    expect(isLowConfidence(LOW_CONFIDENCE_MAX_PASSES)).toBe(true);
  });

  it("treats one pass above the threshold as trustworthy", () => {
    expect(isLowConfidence(LOW_CONFIDENCE_MAX_PASSES + 1)).toBe(false);
  });

  it("treats zero passes as low confidence", () => {
    expect(isLowConfidence(0)).toBe(true);
  });
});

describe("coalesceQualityRuns", () => {
  function seg(
    id: string,
    band: QualityBand,
    lengthKm: number,
    surface: RouteSegment["surface"] = "asphalt",
  ): RouteSegment {
    return {
      id,
      geometry: {
        type: "LineString",
        coordinates: [
          [0, 0],
          [1, 0],
        ],
      },
      band,
      surface,
      score: band === "no_data" ? null : 4,
      passes: 1,
      lengthKm,
      dayNumber: 1,
    };
  }

  it("merges adjacent same-band segments and sums their length", () => {
    const runs = coalesceQualityRuns([
      seg("d1-s0", "good", 10),
      seg("d1-s1", "good", 5),
      seg("d1-s2", "rough", 3, "gravel"),
      seg("d1-s3", "rough", 2, "dirt"),
      seg("d1-s4", "good", 4),
    ]);
    expect(runs.map((r) => r.band)).toEqual(["good", "rough", "good"]);
    expect(runs.map((r) => r.lengthKm)).toEqual([15, 5, 4]);
    // Run id is `run:<firstSegmentId>`; surface comes from its first segment.
    expect(runs[0]!.id).toBe("run:d1-s0");
    expect(runs[1]!).toMatchObject({ id: "run:d1-s2", surface: "gravel" });
  });

  it("collapses a fully-uncovered route to a single no_data run", () => {
    const runs = coalesceQualityRuns([
      seg("d1-s0", "no_data", 12, "unknown"),
      seg("d1-s1", "no_data", 12, "unknown"),
      seg("d1-s2", "no_data", 12, "unknown"),
    ]);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      id: "run:d1-s0",
      band: "no_data",
      lengthKm: 36,
    });
  });

  it("returns nothing for an empty input", () => {
    expect(coalesceQualityRuns([])).toEqual([]);
  });
});
