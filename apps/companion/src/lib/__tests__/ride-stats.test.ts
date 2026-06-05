import { describe, expect, it } from "vitest";
import {
  availableYears,
  computeAllTimeTotals,
  computeCalendarHeatmap,
  computeMonthlyDistance,
  computeRollingMonthly,
  computeYearOverYear,
  computeYearlyTotals,
  DEFAULT_RIDE_FILTERS,
  filterRides,
  isRideType,
  windowStart,
  type RideFilters,
  type RideForStats,
} from "../ride-stats";

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

function makeFilters(overrides: Partial<RideFilters> = {}): RideFilters {
  return { ...DEFAULT_RIDE_FILTERS, ...overrides };
}

describe("isRideType", () => {
  it("accepts the four canonical ride types", () => {
    expect(isRideType("free")).toBe(true);
    expect(isRideType("commute")).toBe(true);
    expect(isRideType("trip")).toBe(true);
    expect(isRideType("tracked")).toBe(true);
  });

  it("rejects unknown values and non-strings", () => {
    expect(isRideType("offroad")).toBe(false);
    expect(isRideType("")).toBe(false);
    expect(isRideType(null)).toBe(false);
    expect(isRideType(42)).toBe(false);
  });
});

describe("computeAllTimeTotals", () => {
  it("returns zeroed totals for empty input", () => {
    const totals = computeAllTimeTotals([]);
    expect(totals).toEqual({
      totalDistanceKm: 0,
      totalRides: 0,
      totalHours: 0,
      avgRideDistanceKm: 0,
      avgRideDurationMin: 0,
      ridingDays: 0,
    });
  });

  it("sums distance and duration and converts to hours", () => {
    const totals = computeAllTimeTotals([
      ride({ id: "1", distance_km: 100, duration_min: 90 }),
      ride({ id: "2", distance_km: 50, duration_min: 30 }),
    ]);
    expect(totals.totalDistanceKm).toBe(150);
    expect(totals.totalRides).toBe(2);
    expect(totals.totalHours).toBe(2);
    expect(totals.avgRideDistanceKm).toBe(75);
    expect(totals.avgRideDurationMin).toBe(60);
  });

  it("treats nullable distance and duration as zero", () => {
    const totals = computeAllTimeTotals([
      ride({ id: "1", distance_km: null, duration_min: null }),
      ride({ id: "2", distance_km: 20, duration_min: 30 }),
    ]);
    expect(totals.totalDistanceKm).toBe(20);
    expect(totals.totalHours).toBeCloseTo(0.5, 5);
    expect(totals.avgRideDistanceKm).toBe(10);
  });

  it("counts unique riding days even when multiple rides share a day", () => {
    const totals = computeAllTimeTotals([
      ride({ id: "1", started_at: "2026-04-01T08:00:00Z" }),
      ride({ id: "2", started_at: "2026-04-01T18:00:00Z" }),
      ride({ id: "3", started_at: "2026-04-02T09:00:00Z" }),
    ]);
    expect(totals.ridingDays).toBe(2);
  });

  it("ignores rides with unparseable started_at when counting days", () => {
    const totals = computeAllTimeTotals([
      ride({ id: "1", started_at: "not-a-date" }),
      ride({ id: "2", started_at: "2026-04-01T08:00:00Z" }),
    ]);
    expect(totals.totalRides).toBe(2);
    expect(totals.ridingDays).toBe(1);
  });
});

describe("filterRides", () => {
  const dataset: RideForStats[] = [
    ride({
      id: "a",
      started_at: "2026-01-15T10:00:00Z",
      ride_type: "free",
    }),
    ride({
      id: "b",
      started_at: "2026-06-15T10:00:00Z",
      ride_type: "commute",
    }),
    ride({
      id: "c",
      started_at: "2025-09-01T10:00:00Z",
      ride_type: "trip",
    }),
  ];

  // Fixed "now" so the rolling windows are deterministic across runs.
  const now = new Date("2026-06-20T00:00:00Z");

  it("returns everything with default filters (all time)", () => {
    expect(filterRides(dataset, makeFilters(), now)).toHaveLength(3);
  });

  it("filters by this-year window", () => {
    const result = filterRides(dataset, makeFilters({ window: "year" }), now);
    expect(result.map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("filters by last-30-days window", () => {
    const result = filterRides(dataset, makeFilters({ window: "30d" }), now);
    expect(result.map((r) => r.id)).toEqual(["b"]);
  });

  it("filters by ride type", () => {
    const result = filterRides(
      dataset,
      makeFilters({ rideType: "commute" }),
      now,
    );
    expect(result.map((r) => r.id)).toEqual(["b"]);
  });

  it("combines window and ride type with AND semantics", () => {
    const result = filterRides(
      dataset,
      makeFilters({ window: "year", rideType: "free" }),
      now,
    );
    expect(result.map((r) => r.id)).toEqual(["a"]);
  });

  it("excludes rides with unparseable started_at inside a window", () => {
    const result = filterRides(
      [...dataset, ride({ id: "d", started_at: "garbage", ride_type: "free" })],
      makeFilters({ window: "year" }),
      now,
    );
    expect(result.map((r) => r.id)).toEqual(["a", "b"]);
  });
});

describe("windowStart", () => {
  const now = new Date("2026-06-20T00:00:00Z");

  it("returns null for the all-time window", () => {
    expect(windowStart("all", now)).toBeNull();
  });

  it("anchors the year window to Jan 1 of the current year", () => {
    const start = windowStart("year", now);
    expect(start?.getFullYear()).toBe(2026);
    expect(start?.getMonth()).toBe(0);
    expect(start?.getDate()).toBe(1);
  });

  it("subtracts the rolling day count for 30d / 90d", () => {
    const start30 = windowStart("30d", now);
    const start90 = windowStart("90d", now);
    expect(Math.round((now.getTime() - start30!.getTime()) / 86_400_000)).toBe(
      30,
    );
    expect(Math.round((now.getTime() - start90!.getTime()) / 86_400_000)).toBe(
      90,
    );
  });
});

describe("computeRollingMonthly", () => {
  const now = new Date("2026-06-15T10:00:00Z");

  it("returns the last 12 calendar months oldest→newest with single-letter labels", () => {
    const buckets = computeRollingMonthly([], 12, now);
    expect(buckets).toHaveLength(12);
    expect(buckets[0]?.key).toBe("2025-07");
    expect(buckets[11]?.key).toBe("2026-06");
    expect(buckets[11]?.monthLabel).toBe("J"); // June
    expect(buckets.every((b) => b.distanceKm === 0 && b.rides === 0)).toBe(
      true,
    );
  });

  it("buckets rides into their calendar month and ignores out-of-range rides", () => {
    const buckets = computeRollingMonthly(
      [
        ride({ id: "1", started_at: "2026-06-02T10:00:00Z", distance_km: 40 }),
        ride({ id: "2", started_at: "2026-06-09T10:00:00Z", distance_km: 60 }),
        ride({ id: "3", started_at: "2026-04-01T10:00:00Z", distance_km: 25 }),
        ride({ id: "4", started_at: "2024-01-01T10:00:00Z", distance_km: 999 }),
      ],
      12,
      now,
    );
    const june = buckets.find((b) => b.key === "2026-06");
    const april = buckets.find((b) => b.key === "2026-04");
    expect(june).toMatchObject({ distanceKm: 100, rides: 2 });
    expect(april).toMatchObject({ distanceKm: 25, rides: 1 });
    // The 2024 ride is older than 12 months → not represented.
    expect(buckets.some((b) => b.distanceKm === 999)).toBe(false);
  });
});

describe("availableYears", () => {
  it("returns years sorted newest-first, deduped", () => {
    const years = availableYears([
      ride({ id: "1", started_at: "2024-01-01T00:00:00Z" }),
      ride({ id: "2", started_at: "2026-01-01T00:00:00Z" }),
      ride({ id: "3", started_at: "2026-06-01T00:00:00Z" }),
      ride({ id: "4", started_at: "broken" }),
    ]);
    expect(years).toEqual([2026, 2024]);
  });
});

describe("computeMonthlyDistance", () => {
  it("returns 12 buckets in calendar order even with no rides", () => {
    const buckets = computeMonthlyDistance([], 2026);
    expect(buckets).toHaveLength(12);
    expect(buckets[0]?.monthLabel).toBe("Jan");
    expect(buckets[11]?.monthLabel).toBe("Dec");
    expect(buckets.every((b) => b.distanceKm === 0 && b.rides === 0)).toBe(
      true,
    );
  });

  it("buckets rides into the correct local month for the requested year", () => {
    const buckets = computeMonthlyDistance(
      [
        ride({
          id: "1",
          started_at: "2026-04-10T10:00:00Z",
          distance_km: 30,
        }),
        ride({
          id: "2",
          started_at: "2026-04-22T10:00:00Z",
          distance_km: 70,
        }),
        ride({
          id: "3",
          started_at: "2026-07-05T10:00:00Z",
          distance_km: 200,
        }),
        ride({
          id: "4",
          started_at: "2025-04-10T10:00:00Z",
          distance_km: 999,
        }),
      ],
      2026,
    );
    expect(buckets[3]).toEqual({
      monthIndex: 3,
      monthLabel: "Apr",
      distanceKm: 100,
      rides: 2,
    });
    expect(buckets[6]).toEqual({
      monthIndex: 6,
      monthLabel: "Jul",
      distanceKm: 200,
      rides: 1,
    });
    expect(buckets[0]?.distanceKm).toBe(0);
  });
});

describe("computeYearlyTotals", () => {
  it("groups rides by calendar year and sorts ascending", () => {
    const totals = computeYearlyTotals([
      ride({ id: "1", started_at: "2024-03-01T10:00:00Z", distance_km: 100 }),
      ride({ id: "2", started_at: "2025-09-01T10:00:00Z", distance_km: 50 }),
      ride({ id: "3", started_at: "2025-10-01T10:00:00Z", distance_km: 75 }),
      ride({ id: "4", started_at: "2026-04-01T10:00:00Z", distance_km: 200 }),
    ]);
    expect(totals).toEqual([
      { year: 2024, distanceKm: 100, rides: 1 },
      { year: 2025, distanceKm: 125, rides: 2 },
      { year: 2026, distanceKm: 200, rides: 1 },
    ]);
  });

  it("skips rides with invalid timestamps", () => {
    const totals = computeYearlyTotals([
      ride({ id: "1", started_at: "garbage", distance_km: 100 }),
      ride({ id: "2", started_at: "2026-01-01T00:00:00Z", distance_km: 10 }),
    ]);
    expect(totals).toEqual([{ year: 2026, distanceKm: 10, rides: 1 }]);
  });
});

describe("computeCalendarHeatmap", () => {
  it("returns 365 entries for a non-leap year", () => {
    const heatmap = computeCalendarHeatmap([], 2025);
    expect(heatmap).toHaveLength(365);
    expect(heatmap[0]?.date).toBe("2025-01-01");
    expect(heatmap[heatmap.length - 1]?.date).toBe("2025-12-31");
  });

  it("returns 366 entries for a leap year (2024)", () => {
    const heatmap = computeCalendarHeatmap([], 2024);
    expect(heatmap).toHaveLength(366);
  });

  it("aggregates multiple rides on the same day", () => {
    const heatmap = computeCalendarHeatmap(
      [
        ride({ id: "1", started_at: "2026-04-15T08:00:00Z", distance_km: 30 }),
        ride({ id: "2", started_at: "2026-04-15T17:00:00Z", distance_km: 20 }),
      ],
      2026,
    );
    const day = heatmap.find((d) => d.date === "2026-04-15");
    expect(day).toEqual({ date: "2026-04-15", distanceKm: 50, rides: 2 });
  });

  it("ignores rides outside the requested year", () => {
    const heatmap = computeCalendarHeatmap(
      [ride({ id: "1", started_at: "2024-04-15T10:00:00Z", distance_km: 100 })],
      2026,
    );
    expect(heatmap.every((d) => d.distanceKm === 0)).toBe(true);
  });
});

describe("computeYearOverYear", () => {
  it("emits one row per month with a numeric column per requested year", () => {
    const points = computeYearOverYear(
      [
        ride({ id: "1", started_at: "2025-01-15T10:00:00Z", distance_km: 100 }),
        ride({ id: "2", started_at: "2026-01-15T10:00:00Z", distance_km: 200 }),
        ride({ id: "3", started_at: "2026-06-15T10:00:00Z", distance_km: 50 }),
        ride({
          id: "4",
          started_at: "2024-06-15T10:00:00Z",
          distance_km: 999,
        }),
      ],
      [2025, 2026],
    );
    expect(points).toHaveLength(12);
    expect(points[0]).toEqual({
      monthIndex: 0,
      monthLabel: "Jan",
      "2025": 100,
      "2026": 200,
    });
    expect(points[5]).toEqual({
      monthIndex: 5,
      monthLabel: "Jun",
      "2025": 0,
      "2026": 50,
    });
  });

  it("returns zero columns when no years are requested", () => {
    const points = computeYearOverYear(
      [ride({ id: "1", started_at: "2026-01-01T00:00:00Z" })],
      [],
    );
    expect(points).toHaveLength(12);
    expect(Object.keys(points[0] ?? {}).sort()).toEqual([
      "monthIndex",
      "monthLabel",
    ]);
  });
});
