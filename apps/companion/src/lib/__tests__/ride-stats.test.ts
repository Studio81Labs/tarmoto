import { describe, expect, it } from "vitest";
import { createFormatters } from "@tarmoto/shared";
import {
  availableYears,
  computeAllTimeTotals,
  computeCalendarHeatmap,
  computeDistanceSeries,
  computeMonthlyDistance,
  computeQualityTrend,
  computeRollingHeatmap,
  computeYearOverYear,
  computeYearlyTotals,
  DEFAULT_RIDE_FILTERS,
  filterRides,
  isRideType,
  windowStart,
  type RideFilters,
  type RideForStats,
} from "../ride-stats";

// Deterministic en/UTC/metric context — mirrors the component-test default
// (no FormatProvider) so lib-level assertions stay locale-neutral.
const format = createFormatters({ locale: "en", units: "metric" });

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

  it("rejects future-dated rides (clock skew / bad import) in every window", () => {
    const withFuture = [
      ...dataset,
      ride({ id: "future", started_at: "2026-12-31T10:00:00Z" }),
    ];
    // Future ride is dropped from both the windowed and the all-time view.
    expect(
      filterRides(withFuture, makeFilters({ window: "year" }), now).map(
        (r) => r.id,
      ),
    ).toEqual(["a", "b"]);
    expect(
      filterRides(withFuture, makeFilters(), now).map((r) => r.id),
    ).toEqual(["a", "b", "c"]);
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

  it("anchors 30d / 90d to the start of the day spanning N calendar days", () => {
    const start30 = windowStart("30d", now)!;
    const start90 = windowStart("90d", now)!;
    // Local midnight, exactly `days - 1` whole days before today → `days`
    // calendar days including today.
    expect(start30.getHours()).toBe(0);
    expect(start30.getMinutes()).toBe(0);
    expect(start30.getTime()).toBe(
      new Date(now.getFullYear(), now.getMonth(), now.getDate() - 29).getTime(),
    );
    expect(start90.getTime()).toBe(
      new Date(now.getFullYear(), now.getMonth(), now.getDate() - 89).getTime(),
    );
  });
});

describe("computeDistanceSeries", () => {
  const now = new Date("2026-06-15T10:00:00Z");

  it("all-time → last 12 rolling months with unambiguous labels", () => {
    const points = computeDistanceSeries([], "all", format, now);
    expect(points).toHaveLength(12);
    expect(points[0]?.key).toBe("2025-07");
    expect(points[11]?.key).toBe("2026-06");
    // Formatters has no "month name only" primitive, so both the axis tick
    // and the tooltip render the full `monthYear` shape (accepted — see
    // ride-stats.ts's `monthPoint`).
    expect(points[11]?.axisLabel).toBe("Jun 2026");
    expect(points[11]?.tooltipLabel).toBe("Jun 2026");
    expect(points.every((p) => p.distanceKm === 0 && p.rides === 0)).toBe(true);
  });

  it("all-time → buckets rides by calendar month, ignores >12mo-old rides", () => {
    const points = computeDistanceSeries(
      [
        ride({ id: "1", started_at: "2026-06-02T10:00:00Z", distance_km: 40 }),
        ride({ id: "2", started_at: "2026-06-09T10:00:00Z", distance_km: 60 }),
        ride({ id: "3", started_at: "2026-04-01T10:00:00Z", distance_km: 25 }),
        ride({ id: "4", started_at: "2024-01-01T10:00:00Z", distance_km: 999 }),
      ],
      "all",
      format,
      now,
    );
    expect(points.find((p) => p.key === "2026-06")).toMatchObject({
      distanceKm: 100,
      rides: 2,
    });
    expect(points.find((p) => p.key === "2026-04")).toMatchObject({
      distanceKm: 25,
      rides: 1,
    });
    expect(points.some((p) => p.distanceKm === 999)).toBe(false);
  });

  it("this-year → Jan→Dec of the current year, future months empty", () => {
    const points = computeDistanceSeries(
      [ride({ id: "1", started_at: "2026-03-10T10:00:00Z", distance_km: 30 })],
      "year",
      format,
      now,
    );
    expect(points).toHaveLength(12);
    expect(points[0]?.key).toBe("2026-01");
    expect(points[11]?.key).toBe("2026-12");
    expect(points[2]).toMatchObject({ axisLabel: "Mar 2026", distanceKm: 30 });
    // December is in the future relative to `now` → stays empty.
    expect(points[11]?.distanceKm).toBe(0);
  });

  it("last-30-days → one bar per day for the trailing 30 days", () => {
    const points = computeDistanceSeries(
      [ride({ id: "1", started_at: "2026-06-10T08:00:00Z", distance_km: 12 })],
      "30d",
      format,
      now,
    );
    expect(points).toHaveLength(30);
    expect(points[29]?.key).toBe("2026-06-15"); // today
    expect(points.find((p) => p.key === "2026-06-10")).toMatchObject({
      // Day axisLabel is a bare day-of-month number — locale-neutral, so it's
      // untouched by the migration. The tooltip now goes through
      // `format.calendarDate`, which renders month-first for "en" (was the
      // hand-rolled "10 Jun 2026").
      axisLabel: "10",
      tooltipLabel: "Jun 10, 2026",
      distanceKm: 12,
    });
  });

  it("last-90-days → 90 daily bars", () => {
    const points = computeDistanceSeries([], "90d", format, now);
    expect(points).toHaveLength(90);
    expect(points[89]?.key).toBe("2026-06-15");
  });
});

describe("computeQualityTrend", () => {
  const now = new Date("2026-06-15T10:00:00Z");

  it("returns 12 rolling months, null for months without scored rides", () => {
    const points = computeQualityTrend([], format, now);
    expect(points).toHaveLength(12);
    expect(points[0]?.key).toBe("2025-07");
    expect(points[11]?.key).toBe("2026-06");
    // Formatters has no "month name only" primitive, so the axis tick renders
    // the full `monthYear` shape (accepted — see ride-stats.ts's `monthPoint`).
    expect(points[11]?.axisLabel).toBe("Jun 2026");
    expect(points.every((p) => p.avgQuality === null && p.rides === 0)).toBe(
      true,
    );
  });

  it("distance-weights quality within a month and counts rides", () => {
    const points = computeQualityTrend(
      [
        ride({
          id: "1",
          started_at: "2026-06-02T10:00:00Z",
          distance_km: 10,
          avg_road_quality: 4,
        }),
        ride({
          id: "2",
          started_at: "2026-06-09T10:00:00Z",
          distance_km: 30,
          avg_road_quality: 2,
        }),
      ],
      format,
      now,
    );
    const june = points.find((p) => p.key === "2026-06");
    // (4·10 + 2·30) / 40 = 2.5
    expect(june?.avgQuality).toBeCloseTo(2.5);
    expect(june?.rides).toBe(2);
  });

  it("ignores unscored rides for the average but still counts them", () => {
    const points = computeQualityTrend(
      [
        ride({
          id: "1",
          started_at: "2026-05-02T10:00:00Z",
          distance_km: 10,
          avg_road_quality: null,
        }),
        ride({
          id: "2",
          started_at: "2026-05-09T10:00:00Z",
          distance_km: 10,
          avg_road_quality: 4,
        }),
      ],
      format,
      now,
    );
    const may = points.find((p) => p.key === "2026-05");
    expect(may?.avgQuality).toBeCloseTo(4);
    expect(may?.rides).toBe(2);
  });

  it("ignores rides older than 12 months", () => {
    const points = computeQualityTrend(
      [
        ride({
          id: "1",
          started_at: "2024-06-02T10:00:00Z",
          distance_km: 10,
          avg_road_quality: 5,
        }),
      ],
      format,
      now,
    );
    expect(points.every((p) => p.avgQuality === null)).toBe(true);
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
    const buckets = computeMonthlyDistance([], 2026, format);
    expect(buckets).toHaveLength(12);
    // Formatters has no "month name only" primitive, so the label renders
    // the full `monthYear` shape (accepted — see ride-stats.ts's `monthPoint`).
    expect(buckets[0]?.monthLabel).toBe("Jan 2026");
    expect(buckets[11]?.monthLabel).toBe("Dec 2026");
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
      format,
    );
    expect(buckets[3]).toEqual({
      monthIndex: 3,
      monthLabel: "Apr 2026",
      distanceKm: 100,
      rides: 2,
    });
    expect(buckets[6]).toEqual({
      monthIndex: 6,
      monthLabel: "Jul 2026",
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

describe("computeRollingHeatmap", () => {
  it("spans the last N days, including the previous year across Jan 1", () => {
    const now = new Date("2026-01-15T10:00:00Z");
    const days = computeRollingHeatmap(
      [
        ride({ id: "1", started_at: "2025-11-20T10:00:00Z", distance_km: 40 }),
        ride({ id: "2", started_at: "2026-01-10T10:00:00Z", distance_km: 25 }),
        // Older than 90 days → not represented.
        ride({ id: "3", started_at: "2025-09-01T10:00:00Z", distance_km: 99 }),
      ],
      90,
      now,
    );
    expect(days).toHaveLength(90);
    expect(days[89]?.date).toBe("2026-01-15");
    expect(days.find((d) => d.date === "2025-11-20")).toMatchObject({
      distanceKm: 40,
      rides: 1,
    });
    expect(days.find((d) => d.date === "2026-01-10")).toMatchObject({
      distanceKm: 25,
      rides: 1,
    });
    expect(days.some((d) => d.distanceKm === 99)).toBe(false);
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
      format,
    );
    expect(points).toHaveLength(12);
    // The month label has no per-row year (Formatters has no "month name
    // only" primitive) — it's anchored on the latest requested year (2026)
    // for every row, even though the row's own columns span 2025 AND 2026.
    // Accepted: see ride-stats.ts's `computeYearOverYear` comment.
    expect(points[0]).toEqual({
      monthIndex: 0,
      monthLabel: "Jan 2026",
      "2025": 100,
      "2026": 200,
    });
    expect(points[5]).toEqual({
      monthIndex: 5,
      monthLabel: "Jun 2026",
      "2025": 0,
      "2026": 50,
    });
  });

  it("returns zero columns when no years are requested", () => {
    const points = computeYearOverYear(
      [ride({ id: "1", started_at: "2026-01-01T00:00:00Z" })],
      [],
      format,
    );
    expect(points).toHaveLength(12);
    expect(Object.keys(points[0] ?? {}).sort()).toEqual([
      "monthIndex",
      "monthLabel",
    ]);
  });
});
