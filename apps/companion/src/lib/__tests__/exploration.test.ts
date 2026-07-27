import { describe, expect, it } from "vitest";
import {
  computePeriodStats,
  groupUnriddenByRegion,
  periodStartDate,
} from "../exploration";
import type { RideForStats } from "../ride-stats";
import type { UnriddenSegment } from "../api";

function ride(overrides: Partial<RideForStats> & { id: string }): RideForStats {
  return {
    started_at: "2026-04-01T10:00:00Z",
    ended_at: "2026-04-01T11:00:00Z",
    distance_km: 50,
    duration_min: 60,
    ride_type: "free",
    ...overrides,
  };
}

function segment(
  overrides: Partial<UnriddenSegment> & { id: string },
): UnriddenSegment {
  return {
    road_name: "E65 section",
    length_m: 500,
    quality_score: 3,
    surface_type: "asphalt",
    distance_m: 1200,
    ...overrides,
  };
}

describe("periodStartDate", () => {
  const now = new Date("2026-04-19T12:00:00Z");

  it("returns null for 'all'", () => {
    expect(periodStartDate("all", now)).toBeNull();
  });

  it("returns Jan 1st of current year for 'year'", () => {
    const start = periodStartDate("year", now);
    expect(start).not.toBeNull();
    expect(start?.getFullYear()).toBe(2026);
    expect(start?.getMonth()).toBe(0);
    expect(start?.getDate()).toBe(1);
  });

  it("returns ~30/90 day rolling windows", () => {
    const ninety = periodStartDate("90d", now);
    const thirty = periodStartDate("30d", now);
    expect(ninety).not.toBeNull();
    expect(thirty).not.toBeNull();
    const msInDay = 24 * 60 * 60 * 1000;
    expect(
      Math.round((now.getTime() - (ninety as Date).getTime()) / msInDay),
    ).toBe(90);
    expect(
      Math.round((now.getTime() - (thirty as Date).getTime()) / msInDay),
    ).toBe(30);
  });
});

describe("computePeriodStats — window selection", () => {
  const now = new Date("2026-04-19T12:00:00Z");
  const rides: RideForStats[] = [
    ride({
      id: "r-today",
      started_at: "2026-04-19T09:00:00Z",
      distance_km: 10,
    }),
    ride({ id: "r-60d", started_at: "2026-02-18T09:00:00Z", distance_km: 20 }),
    ride({
      id: "r-lastyear",
      started_at: "2025-12-01T09:00:00Z",
      distance_km: 30,
    }),
    ride({
      id: "r-2years",
      started_at: "2024-06-01T09:00:00Z",
      distance_km: 40,
    }),
  ];

  it("'all' counts every ride regardless of age", () => {
    const stats = computePeriodStats(rides, "all", now);
    expect(stats.rideCount).toBe(4);
    expect(stats.distanceKm).toBeCloseTo(100);
  });

  it("'year' keeps only rides in the current calendar year", () => {
    const stats = computePeriodStats(rides, "year", now);
    expect(stats.rideCount).toBe(2);
    expect(stats.distanceKm).toBeCloseTo(30);
  });

  it("'90d' keeps rides inside the rolling window", () => {
    const stats = computePeriodStats(rides, "90d", now);
    expect(stats.rideCount).toBe(2);
    expect(stats.distanceKm).toBeCloseTo(30);
  });

  it("'30d' keeps only the most recent ride", () => {
    const stats = computePeriodStats(rides, "30d", now);
    expect(stats.rideCount).toBe(1);
    expect(stats.distanceKm).toBeCloseTo(10);
  });

  it("drops rides with an unparseable timestamp across every period", () => {
    const broken = [
      ...rides,
      ride({
        id: "r-bad",
        started_at: "not-a-date",
        distance_km: 999,
      }),
    ];
    for (const period of ["all", "year", "90d", "30d"] as const) {
      const stats = computePeriodStats(broken, period, now);
      expect(stats.distanceKm).not.toBeCloseTo(
        computePeriodStats(rides, period, now).distanceKm + 999,
      );
    }
  });

  it("excludes rides started in the future from every period", () => {
    const withFuture = [
      ...rides,
      ride({
        id: "r-future",
        started_at: "2027-01-01T09:00:00Z",
        distance_km: 500,
      }),
    ];
    for (const period of ["all", "year", "90d", "30d"] as const) {
      const statsWith = computePeriodStats(withFuture, period, now);
      const statsWithout = computePeriodStats(rides, period, now);
      expect(statsWith.rideCount).toBe(statsWithout.rideCount);
      expect(statsWith.distanceKm).toBeCloseTo(statsWithout.distanceKm);
    }
  });
});

describe("computePeriodStats", () => {
  const now = new Date("2026-04-19T12:00:00Z");

  it("zeroes everything when no rides match", () => {
    const stats = computePeriodStats([], "30d", now);
    expect(stats).toEqual({
      period: "30d",
      distanceKm: 0,
      rideCount: 0,
      activeDays: 0,
    });
  });

  it("sums distance and counts unique active days inside the window", () => {
    const rides: RideForStats[] = [
      ride({
        id: "a",
        started_at: "2026-04-19T09:00:00Z",
        distance_km: 40,
      }),
      ride({
        id: "b",
        started_at: "2026-04-19T11:30:00Z", // same calendar day as 'a', still before `now`
        distance_km: 25,
      }),
      ride({
        id: "c",
        started_at: "2026-04-18T10:00:00Z",
        distance_km: 30,
      }),
      ride({
        id: "old",
        started_at: "2024-01-01T09:00:00Z",
        distance_km: 1000,
      }),
    ];
    const stats = computePeriodStats(rides, "30d", now);
    expect(stats.rideCount).toBe(3);
    expect(stats.distanceKm).toBeCloseTo(95);
    expect(stats.activeDays).toBe(2);
  });

  it("treats null distances as zero", () => {
    const rides: RideForStats[] = [
      ride({ id: "a", started_at: "2026-04-10T10:00:00Z", distance_km: null }),
    ];
    const stats = computePeriodStats(rides, "all", now);
    expect(stats.distanceKm).toBe(0);
    expect(stats.rideCount).toBe(1);
  });
});

describe("groupUnriddenByRegion", () => {
  it("groups by the first word of road name, case-insensitively", () => {
    const segments = [
      segment({ id: "1", road_name: "Beskydy ridge road", length_m: 500 }),
      segment({ id: "2", road_name: "beskydy eastern", length_m: 1500 }),
      segment({ id: "3", road_name: "Jizerské horské", length_m: 2500 }),
      segment({ id: "4", road_name: null, length_m: 800 }),
    ];
    const groups = groupUnriddenByRegion(segments, "en");
    const byLabel = Object.fromEntries(groups.map((g) => [g.label, g]));
    expect(byLabel.Beskydy?.segments).toHaveLength(2);
    expect(byLabel.Beskydy?.totalLengthKm).toBeCloseTo(2);
    expect(byLabel["Jizerské"]?.segments).toHaveLength(1);
    expect(byLabel.Unnamed?.segments).toHaveLength(1);
  });

  it("sorts buckets by total length descending", () => {
    const segments = [
      segment({ id: "a", road_name: "Alpha", length_m: 500 }),
      segment({ id: "b1", road_name: "Beta road", length_m: 1500 }),
      segment({ id: "b2", road_name: "Beta drive", length_m: 2000 }),
      segment({ id: "c", road_name: "Chi", length_m: 1000 }),
    ];
    const groups = groupUnriddenByRegion(segments, "en");
    expect(groups.map((g) => g.label)).toEqual(["Beta", "Chi", "Alpha"]);
  });

  it("uses locale-aware casing when grouping region labels", () => {
    const segments = [
      segment({ id: "tr-1", road_name: "IŞIK yolu", length_m: 500 }),
      segment({ id: "tr-2", road_name: "ışık geçidi", length_m: 750 }),
    ];
    const groups = groupUnriddenByRegion(segments, "tr");
    expect(groups).toHaveLength(1);
    expect(groups[0]?.segments).toHaveLength(2);
  });

  it("returns an empty array for no segments", () => {
    expect(groupUnriddenByRegion([], "en")).toEqual([]);
  });
});
