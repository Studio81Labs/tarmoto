import { describe, expect, it } from "vitest";
import {
  coalesceQualityRuns,
  FAIR_BAND_MIN_SCORE,
  findRunSegment,
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
    dayNumber = 1,
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
      dayNumber,
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
    // Run id is `run:<first>:<last>`; surface comes from its first segment.
    expect(runs[0]!.id).toBe("run:d1-s0:d1-s1");
    expect(runs[1]!).toMatchObject({
      id: "run:d1-s2:d1-s3",
      surface: "gravel",
    });
  });

  it("collapses a fully-uncovered route to a single no_data run", () => {
    const runs = coalesceQualityRuns([
      seg("d1-s0", "no_data", 12, "unknown"),
      seg("d1-s1", "no_data", 12, "unknown"),
      seg("d1-s2", "no_data", 12, "unknown"),
    ]);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      id: "run:d1-s0:d1-s2",
      band: "no_data",
      lengthKm: 36,
    });
  });

  it("never coalesces across a day boundary", () => {
    const runs = coalesceQualityRuns([
      seg("d1-s0", "no_data", 10, "unknown", 1),
      seg("d1-s1", "no_data", 10, "unknown", 1),
      seg("d2-s0", "no_data", 10, "unknown", 2),
      seg("d2-s1", "no_data", 10, "unknown", 2),
    ]);
    // Same band throughout, but the day boundary splits it into two runs so a
    // reroute (which targets a run's single day) can't mutate the wrong day.
    expect(runs).toHaveLength(2);
    expect(runs[0]!.id).toBe("run:d1-s0:d1-s1");
    expect(runs[1]!.id).toBe("run:d2-s0:d2-s1");
  });

  it("returns nothing for an empty input", () => {
    expect(coalesceQualityRuns([])).toEqual([]);
  });
});

describe("findRunSegment", () => {
  function seg(id: string, band: QualityBand): RouteSegment {
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
      surface: "gravel",
      score: band === "no_data" ? null : 2,
      passes: 1,
      lengthKm: 5,
      dayNumber: 1,
    };
  }
  // A full uncovered day; two plans each scope half of it.
  const fullDay = [
    seg("d1-s0", "no_data"),
    seg("d1-s1", "no_data"),
    seg("d1-s2", "no_data"),
    seg("d1-s3", "no_data"),
  ];

  it("resolves a plan-scoped run range against the full day, not the whole run", () => {
    // Same band crosses the day boundary; each plan's run id must resolve to
    // exactly its own segments — not the full-day run.
    const first = findRunSegment(fullDay, "run:d1-s0:d1-s1")!;
    expect(first.lengthKm).toBe(10);
    const second = findRunSegment(fullDay, "run:d1-s2:d1-s3")!;
    expect(second.lengthKm).toBe(10);
  });

  it("returns null for an unknown range, an out-of-order range, or a fine id", () => {
    expect(findRunSegment(fullDay, "run:d1-s9:d1-s9")).toBeNull();
    expect(findRunSegment(fullDay, "run:d1-s3:d1-s0")).toBeNull();
    expect(findRunSegment(fullDay, "d1-s0")).toBeNull();
  });

  it("aggregates score, passes, and surface across the run (length-weighted)", () => {
    const scored = (
      id: string,
      lengthKm: number,
      score: number,
      passes: number,
      surface: RouteSegment["surface"],
    ): RouteSegment => ({
      id,
      geometry: {
        type: "LineString",
        coordinates: [
          [0, 0],
          [1, 0],
        ],
      },
      band: "rough",
      surface,
      score,
      passes,
      lengthKm,
      dayNumber: 1,
    });
    // A 100 m / 1-pass span followed by a 40 km / 50-pass span.
    const day = [
      scored("d1-s0", 0.1, 2.0, 1, "gravel"),
      scored("d1-s1", 40, 2.4, 50, "dirt"),
    ];

    const run = findRunSegment(day, "run:d1-s0:d1-s1")!;
    // Length-weighted, so the long span dominates — not the first 100 m.
    expect(run.passes).toBe(50);
    expect(run.score).toBeCloseTo(2.4, 1);
    expect(run.surface).toBe("dirt");
    expect(run.lengthKm).toBeCloseTo(40.1, 5);
    // The strip carries each constituent's score AND length, so the 100 m
    // sliver renders far narrower than the 40 km span (#863 review).
    expect(run.microStrip).toEqual([
      { score: 2.0, lengthKm: 0.1 },
      { score: 2.4, lengthKm: 40 },
    ]);
  });
});
