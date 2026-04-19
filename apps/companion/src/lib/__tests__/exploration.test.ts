import { describe, expect, it } from "vitest";
import {
  buildShareSummary,
  computePeriodStats,
  filterRidesByPeriod,
  groupUnriddenByRegion,
  isTimePeriod,
  periodStartDate,
  TIME_PERIODS,
  type TimePeriod,
} from "../exploration";
import type { RideForStats } from "../ride-stats";
import type { ExplorationStats, UnriddenSegment } from "../api";

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

describe("isTimePeriod", () => {
  it("accepts all four period keys", () => {
    for (const p of TIME_PERIODS) {
      expect(isTimePeriod(p)).toBe(true);
    }
  });

  it("rejects unknown values and non-strings", () => {
    expect(isTimePeriod("month")).toBe(false);
    expect(isTimePeriod("")).toBe(false);
    expect(isTimePeriod(42)).toBe(false);
    expect(isTimePeriod(null)).toBe(false);
  });
});

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

describe("filterRidesByPeriod", () => {
  const now = new Date("2026-04-19T12:00:00Z");
  const rides: RideForStats[] = [
    ride({ id: "r-today", started_at: "2026-04-19T09:00:00Z" }),
    ride({ id: "r-60d", started_at: "2026-02-18T09:00:00Z" }),
    ride({ id: "r-lastyear", started_at: "2025-12-01T09:00:00Z" }),
    ride({ id: "r-2years", started_at: "2024-06-01T09:00:00Z" }),
  ];

  it("'all' returns every ride regardless of age", () => {
    expect(filterRidesByPeriod(rides, "all", now).map((r) => r.id)).toEqual([
      "r-today",
      "r-60d",
      "r-lastyear",
      "r-2years",
    ]);
  });

  it("'year' keeps only the current calendar year", () => {
    expect(filterRidesByPeriod(rides, "year", now).map((r) => r.id)).toEqual([
      "r-today",
      "r-60d",
    ]);
  });

  it("'90d' keeps rides inside the rolling window", () => {
    expect(filterRidesByPeriod(rides, "90d", now).map((r) => r.id)).toEqual([
      "r-today",
      "r-60d",
    ]);
  });

  it("'30d' only keeps the most recent ride", () => {
    expect(filterRidesByPeriod(rides, "30d", now).map((r) => r.id)).toEqual([
      "r-today",
    ]);
  });

  it("ignores rides with an unparseable timestamp across every period", () => {
    const broken = [...rides, ride({ id: "r-bad", started_at: "not-a-date" })];
    expect(
      filterRidesByPeriod(broken, "all", now).map((r) => r.id),
    ).not.toContain("r-bad");
    expect(
      filterRidesByPeriod(broken, "30d", now).map((r) => r.id),
    ).not.toContain("r-bad");
  });

  it("excludes rides started in the future from every period", () => {
    const withFuture = [
      ...rides,
      ride({ id: "r-future", started_at: "2027-01-01T09:00:00Z" }),
    ];
    for (const period of ["all", "year", "90d", "30d"] as const) {
      expect(
        filterRidesByPeriod(withFuture, period, now).map((r) => r.id),
      ).not.toContain("r-future");
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
    const groups = groupUnriddenByRegion(segments);
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
    const groups = groupUnriddenByRegion(segments);
    expect(groups.map((g) => g.label)).toEqual(["Beta", "Chi", "Alpha"]);
  });

  it("returns an empty array for no segments", () => {
    expect(groupUnriddenByRegion([])).toEqual([]);
  });
});

describe("buildShareSummary", () => {
  const stats: ExplorationStats = {
    ridden_segments: 1234,
    total_segments: 5678,
    percent_explored: 22,
    total_distance_km: 842,
  };

  it("includes the global percentage and totals in metric", () => {
    const text = buildShareSummary(
      stats,
      {
        period: "all",
        distanceKm: 0,
        rideCount: 0,
        activeDays: 0,
      },
      "metric",
    );
    expect(text).toContain("22%");
    expect(text).toContain("1,234");
    expect(text).toContain("5,678");
    expect(text).toContain("842 km");
    expect(text).toContain("Join me on Tarmoto");
  });

  it("renders distances as miles when units are imperial", () => {
    const text = buildShareSummary(
      stats,
      {
        period: "year" satisfies TimePeriod,
        distanceKm: 420,
        rideCount: 14,
        activeDays: 9,
      },
      "imperial",
    );
    expect(text).not.toContain("km");
    expect(text).toMatch(/\bmi\b/);
  });

  it("omits the period line when no rides match the selected period", () => {
    const text = buildShareSummary(
      stats,
      {
        period: "30d",
        distanceKm: 0,
        rideCount: 0,
        activeDays: 0,
      },
      "metric",
    );
    expect(text).not.toContain("Last 30 days");
  });

  it("includes a period line when there are rides in the window", () => {
    const text = buildShareSummary(
      stats,
      {
        period: "year" satisfies TimePeriod,
        distanceKm: 420,
        rideCount: 14,
        activeDays: 9,
      },
      "metric",
    );
    expect(text).toContain("This year");
    expect(text).toContain("14 rides");
    expect(text).toContain("420 km");
    expect(text).toContain("9 active days");
  });

  it("defaults to metric when no unit system is passed", () => {
    const text = buildShareSummary(stats, {
      period: "all",
      distanceKm: 0,
      rideCount: 0,
      activeDays: 0,
    });
    expect(text).toContain("842 km");
  });
});
