/**
 * Pure formatter helpers used by RoadPreviewScreen.
 *
 * Covers the display contract the screen relies on: length units flip at
 * 1km, relative-time buckets, curviness copy bands, and breakdown
 * normalization dropping empty buckets.
 */

import type { LatLng, RoadReview } from "@/types";
import { setActiveFormatContext } from "@/format";
import {
  applyVoteDelta,
  buildElevationChartPaths,
  computeCurveCount,
  computeElevationStats,
  curvinessLabel,
  formatLengthKm,
  formatRelativeTime,
  isFlatElevationProfile,
  normalizeBreakdown,
} from "../RoadPreviewScreen.helpers";

describe("formatLengthKm", () => {
  it("shows km with one decimal at or above 1km", () => {
    expect(formatLengthKm(1000)).toBe("1 km");
    expect(formatLengthKm(2450)).toBe("2.5 km");
  });

  it("shows meters below 1km", () => {
    expect(formatLengthKm(250)).toBe("250 m");
  });

  // Round the meters before the unit pick so 999.7m doesn't render
  // as "1000 m" when the rounded value would flip to km.
  it("promotes to km when meters round up to 1000", () => {
    expect(formatLengthKm(999.7)).toBe("1 km");
    expect(formatLengthKm(999.4)).toBe("999 m");
  });

  it("returns empty for non-positive or invalid input", () => {
    expect(formatLengthKm(0)).toBe("");
    expect(formatLengthKm(-5)).toBe("");
    expect(formatLengthKm(Number.NaN)).toBe("");
  });
});

describe("formatRelativeTime", () => {
  const NOW = new Date("2026-04-17T12:00:00Z").getTime();

  beforeEach(() => {
    jest.spyOn(Date, "now").mockReturnValue(NOW);
    setActiveFormatContext({
      locale: "en-US",
      timeZone: "UTC",
      units: "metric",
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    setActiveFormatContext({
      locale: "en-US",
      timeZone: "UTC",
      units: "metric",
    });
  });

  it('returns the cataloged "just now" label for recent timestamps', () => {
    expect(formatRelativeTime(new Date(NOW - 10_000).toISOString())).toBe(
      "just now",
    );
  });

  it("returns minute, hour, and day buckets", () => {
    expect(formatRelativeTime(new Date(NOW - 5 * 60_000).toISOString())).toBe(
      "5m ago",
    );
    expect(
      formatRelativeTime(new Date(NOW - 3 * 3_600_000).toISOString()),
    ).toBe("3h ago");
    expect(
      formatRelativeTime(new Date(NOW - 2 * 86_400_000).toISOString()),
    ).toBe("2d ago");
  });

  // Floor (not round) so labels don't jump a bucket early at half-unit
  // boundaries — 90m must stay "1h ago", not "2h ago".
  it("floors partial units instead of rounding them up", () => {
    expect(formatRelativeTime(new Date(NOW - 90 * 60_000).toISOString())).toBe(
      "1h ago",
    );
    expect(formatRelativeTime(new Date(NOW - 150 * 60_000).toISOString())).toBe(
      "2h ago",
    );
    expect(
      formatRelativeTime(new Date(NOW - 36 * 3_600_000).toISOString()),
    ).toBe("1d ago");
  });

  it("keeps words in the UI locale while formatting digits regionally", () => {
    const fiveMinutesAgo = new Date(NOW - 5 * 60_000).toISOString();

    setActiveFormatContext({
      locale: "cs-CZ",
      timeZone: "Europe/Prague",
      units: "metric",
    });
    expect(formatRelativeTime(fiveMinutesAgo)).toBe("5m ago");

    setActiveFormatContext({
      locale: "ar-EG",
      timeZone: "Africa/Cairo",
      units: "metric",
    });
    expect(formatRelativeTime(fiveMinutesAgo)).toBe("٥m ago");
  });

  it("returns empty string for unparseable input", () => {
    expect(formatRelativeTime("not-a-date")).toBe("");
  });
});

describe("curvinessLabel", () => {
  it("maps score bands to descriptive copy", () => {
    expect(curvinessLabel(4.8)).toMatch(/twisty/i);
    expect(curvinessLabel(3.7)).toMatch(/curves/i);
    expect(curvinessLabel(3.0)).toMatch(/mixed/i);
    expect(curvinessLabel(2.0)).toMatch(/straight/i);
    expect(curvinessLabel(0.5)).toMatch(/transit/i);
  });
});

describe("computeCurveCount", () => {
  // Build a polyline starting due-east from an origin with `turnCount`
  // pivots, each separated by a few straight legs. The straight stretches
  // reset the detector's "in turn" state so each pivot is treated as a
  // distinct curve instead of coalescing into one continuous arc — which
  // is what we want when the test's intent is "N separate bends".
  function polylineWithTurns(turnCount: number, turnDeg: number): LatLng[] {
    const origin: LatLng = { lat: 50, lng: 15 };
    const points: LatLng[] = [origin];
    let heading = 90;
    const stepLatDeg = 0.001;
    const STRAIGHT_LEGS_BETWEEN_TURNS = 3;
    const step = () => {
      const last = points[points.length - 1];
      if (!last) throw new Error("expected a previous point");
      const rad = (heading * Math.PI) / 180;
      const dLat = Math.cos(rad) * stepLatDeg;
      const dLng =
        (Math.sin(rad) * stepLatDeg) / Math.cos((last.lat * Math.PI) / 180);
      points.push({ lat: last.lat + dLat, lng: last.lng + dLng });
    };
    for (let i = 0; i < turnCount; i++) {
      for (let j = 0; j < STRAIGHT_LEGS_BETWEEN_TURNS; j++) step();
      heading += turnDeg;
    }
    for (let j = 0; j < STRAIGHT_LEGS_BETWEEN_TURNS; j++) step();
    return points;
  }

  it("returns 0 for empty or near-empty geometries", () => {
    expect(computeCurveCount([])).toBe(0);
    expect(computeCurveCount([{ lat: 50, lng: 15 }])).toBe(0);
    expect(
      computeCurveCount([
        { lat: 50, lng: 15 },
        { lat: 50.001, lng: 15.001 },
      ]),
    ).toBe(0);
  });

  it("returns 0 for a straight line", () => {
    const line: LatLng[] = Array.from({ length: 10 }, (_, i) => ({
      lat: 50,
      lng: 15 + i * 0.001,
    }));
    expect(computeCurveCount(line)).toBe(0);
  });

  it("counts each distinct sharp turn as one curve", () => {
    expect(computeCurveCount(polylineWithTurns(5, 45))).toBe(5);
  });

  it("ignores gentle heading jitter below the threshold", () => {
    expect(computeCurveCount(polylineWithTurns(10, 10))).toBe(0);
  });

  it("coalesces consecutive turning vertices into a single curve", () => {
    // A hairpin sampled as four consecutive 30° bends: the detector should
    // call it one curve, not four, because there's no straight leg between
    // the pivots.
    const origin: LatLng = { lat: 50, lng: 15 };
    const pts: LatLng[] = [origin];
    let heading = 90;
    const stepLatDeg = 0.0005;
    for (let i = 0; i < 5; i++) {
      const last = pts[pts.length - 1];
      if (!last) throw new Error("expected a previous point");
      const rad = (heading * Math.PI) / 180;
      const dLat = Math.cos(rad) * stepLatDeg;
      const dLng =
        (Math.sin(rad) * stepLatDeg) / Math.cos((last.lat * Math.PI) / 180);
      pts.push({ lat: last.lat + dLat, lng: last.lng + dLng });
      heading += 30;
    }
    expect(computeCurveCount(pts)).toBe(1);
  });

  it("skips duplicate GPS samples without splitting a turn", () => {
    const pivot: LatLng = { lat: 50, lng: 15 };
    const geometry: LatLng[] = [
      { lat: 50, lng: 14.999 },
      pivot,
      pivot,
      { lat: 50.001, lng: 15 },
    ];
    expect(computeCurveCount(geometry)).toBe(1);
  });

  it("honours a custom turn threshold", () => {
    // Five 20° pivots separated by straight legs: none qualify at the
    // stricter 25° threshold, all five qualify at a more permissive 15°.
    const geometry = polylineWithTurns(5, 20);
    expect(computeCurveCount(geometry, 25)).toBe(0);
    expect(computeCurveCount(geometry, 15)).toBe(5);
  });
});

describe("computeElevationStats", () => {
  it("returns zero ascent/descent for empty or single-sample profiles", () => {
    expect(computeElevationStats([])).toEqual({ ascent: 0, descent: 0 });
    expect(computeElevationStats([100])).toEqual({ ascent: 0, descent: 0 });
  });

  it("sums positive deltas as ascent and negative deltas as descent", () => {
    expect(computeElevationStats([100, 120, 110, 130, 125])).toEqual({
      ascent: 40,
      descent: 15,
    });
  });

  it("returns zero descent for a monotonic climb", () => {
    expect(computeElevationStats([100, 110, 120, 130])).toEqual({
      ascent: 30,
      descent: 0,
    });
  });

  it("skips non-finite samples without splitting the run", () => {
    // The NaN should be ignored; the 110→130 gap still counts as +20.
    expect(computeElevationStats([100, 110, Number.NaN, 130])).toEqual({
      ascent: 30,
      descent: 0,
    });
  });
});

describe("isFlatElevationProfile", () => {
  it("returns false for empty or single-sample profiles", () => {
    expect(isFlatElevationProfile([])).toBe(false);
    expect(isFlatElevationProfile([100])).toBe(false);
  });

  it("returns true when all samples are equal", () => {
    expect(isFlatElevationProfile([100, 100, 100])).toBe(true);
    expect(isFlatElevationProfile([100, 100])).toBe(true);
  });

  it("returns false when any two finite samples differ", () => {
    expect(isFlatElevationProfile([100, 100, 101])).toBe(false);
    expect(isFlatElevationProfile([100, 200])).toBe(false);
  });

  it("returns false when < 2 samples are finite even if equal", () => {
    // A single finite reading is insufficient data, not a flat road —
    // callers should skip the block rather than render "Flat profile.".
    expect(isFlatElevationProfile([Number.NaN, 100, Number.NaN])).toBe(false);
  });

  it("ignores non-finite samples when evaluating equality", () => {
    expect(isFlatElevationProfile([100, Number.NaN, 100])).toBe(true);
  });
});

describe("buildElevationChartPaths", () => {
  it("returns null for too-short profiles", () => {
    expect(buildElevationChartPaths([], 200, 80)).toBeNull();
    expect(buildElevationChartPaths([100], 200, 80)).toBeNull();
  });

  it("returns null for invalid chart dimensions", () => {
    expect(buildElevationChartPaths([100, 200], 0, 80)).toBeNull();
    expect(buildElevationChartPaths([100, 200], 200, 0)).toBeNull();
    expect(buildElevationChartPaths([100, 200], Number.NaN, 80)).toBeNull();
  });

  it("returns null for a perfectly flat profile", () => {
    expect(buildElevationChartPaths([100, 100, 100], 200, 80)).toBeNull();
  });

  it("maps min to bottom of chart and max to top of chart", () => {
    const result = buildElevationChartPaths([100, 200, 300], 200, 80);
    expect(result).not.toBeNull();
    expect(result!.min).toBe(100);
    expect(result!.max).toBe(300);
    // First point: x=0, max delta - min => max value (300) sits at top (y=0)
    // Last point: highest value at the right edge
    expect(result!.line.startsWith("M0.00 80.00")).toBe(true);
    expect(result!.line.endsWith("L200.00 0.00")).toBe(true);
  });

  it("closes the area path back to the baseline", () => {
    const result = buildElevationChartPaths([100, 200], 200, 80);
    expect(result).not.toBeNull();
    // Area path must start and end at baseline (y=height) so the fill
    // region is bounded — otherwise SVG would fill an open polygon weirdly.
    expect(result!.area.startsWith("M0.00 80.00")).toBe(true);
    expect(result!.area.endsWith("L200.00 80.00 Z")).toBe(true);
  });
});

describe("normalizeBreakdown", () => {
  const keys = ["excellent", "good", "fair", "poor", "very_poor"] as const;

  it("drops empty buckets and normalises to sum to 1", () => {
    const result = normalizeBreakdown(keys, {
      excellent: 30,
      good: 20,
      fair: 0,
      poor: 0,
      very_poor: 0,
    });
    expect(result).toHaveLength(2);
    const sum = result.reduce((acc, s) => acc + s.pct, 0);
    expect(sum).toBeCloseTo(1);
    expect(result.find((s) => s.key === "excellent")?.pct).toBeCloseTo(0.6);
  });

  it("returns empty array when total is zero", () => {
    const result = normalizeBreakdown(keys, {
      excellent: 0,
      good: 0,
      fair: 0,
      poor: 0,
      very_poor: 0,
    });
    expect(result).toEqual([]);
  });

  it("ignores negative inputs", () => {
    const result = normalizeBreakdown(keys, {
      excellent: -5,
      good: 10,
      fair: 0,
      poor: 0,
      very_poor: 0,
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ key: "good", pct: 1 });
  });
});

describe("applyVoteDelta", () => {
  // Baseline review with existing votes and no caller vote — the common
  // case for a road-detail response where /roads/:id doesn't know who's
  // reading.
  const baseline: RoadReview = {
    id: "r",
    user_id: "user-jane",
    user_display_name: "Jane",
    rating: 4,
    comment: null,
    bike_model: null,
    photos: [],
    created_at: "2026-04-01T00:00:00Z",
    helpful_count: 3,
    not_helpful_count: 1,
    my_vote: null,
    is_mine: false,
  };

  it("first helpful vote bumps helpful_count and records the vote", () => {
    expect(applyVoteDelta(baseline, true)).toEqual({
      helpful_count: 4,
      not_helpful_count: 1,
      my_vote: true,
    });
  });

  it("first not-helpful vote bumps not_helpful_count", () => {
    expect(applyVoteDelta(baseline, false)).toEqual({
      helpful_count: 3,
      not_helpful_count: 2,
      my_vote: false,
    });
  });

  it("switches helpful→not-helpful: one tally moves across", () => {
    const withHelpful: RoadReview = {
      ...baseline,
      my_vote: true,
      helpful_count: 4,
    };
    expect(applyVoteDelta(withHelpful, false)).toEqual({
      helpful_count: 3,
      not_helpful_count: 2,
      my_vote: false,
    });
  });

  it("clears helpful vote (null next): decrements helpful_count, caller vote gone", () => {
    const withHelpful: RoadReview = {
      ...baseline,
      my_vote: true,
      helpful_count: 4,
    };
    expect(applyVoteDelta(withHelpful, null)).toEqual({
      helpful_count: 3,
      not_helpful_count: 1,
      my_vote: null,
    });
  });

  it("floors counts at zero when the stored count is already zero", () => {
    // Defensive: a stale client cache might carry `my_vote: true` while
    // `helpful_count: 0` if the row was edited server-side. Clearing that
    // vote must not produce a negative count.
    const stale: RoadReview = {
      ...baseline,
      my_vote: true,
      helpful_count: 0,
    };
    expect(applyVoteDelta(stale, null)).toEqual({
      helpful_count: 0,
      not_helpful_count: 1,
      my_vote: null,
    });
  });
});
