import { describe, expect, it } from "vitest";
import type { TripDay } from "@/lib/types";
import { aggregateInspectDay } from "../inspect-day";

function day(
  dayNumber: number,
  distanceKm: number,
  avgQuality: number,
): TripDay {
  return {
    dayNumber,
    distanceKm,
    avgQuality,
    durationMinutes: 0,
    elevationGain: 0,
    waypoints: [],
  };
}

describe("aggregateInspectDay", () => {
  it("returns null for an empty trip", () => {
    expect(aggregateInspectDay([])).toBeNull();
  });

  it("returns the single day unchanged", () => {
    const only = day(1, 100, 4);
    expect(aggregateInspectDay([only])).toBe(only);
  });

  it("sums distance across days", () => {
    const agg = aggregateInspectDay([day(1, 100, 4), day(2, 50, 3)])!;
    expect(agg.distanceKm).toBe(150);
  });

  it("distance-weights the quality of measured days", () => {
    // (4·100 + 2·300) / 400 = 2.5
    const agg = aggregateInspectDay([day(1, 100, 4), day(2, 300, 2)])!;
    expect(agg.avgQuality).toBe(2.5);
  });

  it("excludes no-data days from the weighted quality mean", () => {
    // Day 1 measured 4.0, day 2 unmeasured (0) — the mean is the measured
    // day's 4.0, not (4·100 + 0·100)/200 = 2.0.
    const agg = aggregateInspectDay([day(1, 100, 4), day(2, 100, 0)])!;
    expect(agg.avgQuality).toBe(4);
  });

  it("reports 0 quality when no day carries a measurement", () => {
    const agg = aggregateInspectDay([day(1, 100, 0), day(2, 100, 0)])!;
    expect(agg.avgQuality).toBe(0);
  });
});
