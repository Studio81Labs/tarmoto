import {
  challengeCopy,
  challengePercent,
  daysRemaining,
  filterByPeriod,
  formatChallengeProgress,
  formatChallengeMetric,
  formatDistanceFromHere,
  formatSegmentLength,
  formatTimeRemaining,
  metricUnit,
  nextMilestone,
  progressToNext,
  rankChallenges,
  rankUnriddenSegments,
  summarizeExploration,
  tierColor,
  tierLabel,
  tierRank,
} from "../AchievementsScreen.helpers";
import type {
  UserBadge,
  Challenge,
  RiddenSegment,
  UnriddenSegment,
} from "@/types";
import { setActiveFormatContext } from "@/format";

beforeEach(() => {
  setActiveFormatContext({ locale: "en", timeZone: "UTC", units: "metric" });
});

const baseBadge: UserBadge = {
  key: "total_distance",
  category: "distance",
  tier: null,
  earned_at: null,
  progress: { current: 0, bronze: 100, silver: 1000, gold: 10000 },
};

describe("tierRank", () => {
  it("returns 0 for unearned badges", () => {
    expect(tierRank(null)).toBe(0);
  });
  it("orders bronze < silver < gold", () => {
    expect(tierRank("bronze")).toBe(1);
    expect(tierRank("silver")).toBe(2);
    expect(tierRank("gold")).toBe(3);
  });
  it("treats unknown tiers as unearned (forward-compatible)", () => {
    expect(tierRank("platinum")).toBe(0);
  });
});

describe("tierLabel", () => {
  it.each([
    ["bronze", "Bronze"],
    ["silver", "Silver"],
    ["gold", "Gold"],
  ])("uses cataloged copy for %s", (tier, expected) => {
    expect(tierLabel(tier)).toBe(expected);
  });

  it("preserves unknown future tiers until the catalog supports them", () => {
    expect(tierLabel("platinum")).toBe("platinum");
  });
});

describe("tierColor", () => {
  it("falls back to tertiary text color when no tier earned", () => {
    expect(typeof tierColor(null)).toBe("string");
    expect(tierColor(null)).not.toBe(tierColor("gold"));
  });
});

describe("nextMilestone", () => {
  it("returns bronze for an unearned badge", () => {
    expect(nextMilestone(baseBadge)).toEqual({ tier: "bronze", target: 100 });
  });

  it("returns silver after bronze is earned", () => {
    expect(nextMilestone({ ...baseBadge, tier: "bronze" })).toEqual({
      tier: "silver",
      target: 1000,
    });
  });

  it("returns null after gold (the rider has maxed)", () => {
    expect(nextMilestone({ ...baseBadge, tier: "gold" })).toBeNull();
  });
});

describe("progressToNext", () => {
  it("scales between the previous tier threshold and the next, not zero and the next", () => {
    // Just past bronze (105) toward silver (1000): the rider should
    // read as ~0.5% of the way to silver, not ~10.5%.
    const ratio = progressToNext({
      ...baseBadge,
      tier: "bronze",
      progress: { current: 105, bronze: 100, silver: 1000, gold: 10000 },
    });
    expect(ratio).toBeLessThan(0.05);
  });

  it("returns 1 once gold is achieved", () => {
    expect(
      progressToNext({
        ...baseBadge,
        tier: "gold",
        progress: { current: 12000, bronze: 100, silver: 1000, gold: 10000 },
      }),
    ).toBe(1);
  });

  it("clamps progress to [0, 1]", () => {
    // current is below the floor (shouldn't happen but be defensive)
    const ratio = progressToNext({
      ...baseBadge,
      tier: "bronze",
      progress: { current: 50, bronze: 100, silver: 1000, gold: 10000 },
    });
    expect(ratio).toBe(0);
  });
});

describe("daysRemaining", () => {
  const now = new Date("2026-05-01T00:00:00Z");

  it("rounds up partial days", () => {
    expect(daysRemaining("2026-05-04T12:00:00Z", now)).toBe(4);
  });

  it("clamps past dates to 0", () => {
    expect(daysRemaining("2026-04-01T00:00:00Z", now)).toBe(0);
  });

  it("returns 0 for invalid dates rather than NaN/negative", () => {
    expect(daysRemaining("not-a-date", now)).toBe(0);
  });
});

describe("formatTimeRemaining", () => {
  const now = new Date("2026-05-01T00:00:00Z");
  it("renders 'Ends today' for same-day deadlines", () => {
    expect(formatTimeRemaining("2026-05-01T01:00:00Z", now)).toBe("Ends today");
  });
  it("uses singular form for 1 day left", () => {
    expect(formatTimeRemaining("2026-05-02T00:00:00Z", now)).toBe("1 day left");
  });
  it("uses plural form for >1 day", () => {
    expect(formatTimeRemaining("2026-05-08T00:00:00Z", now)).toBe(
      "7 days left",
    );
  });
});

describe("challengePercent", () => {
  it("clamps to 100 when over target", () => {
    expect(challengePercent(150, 100)).toBe(100);
  });
  it("returns 0 for non-positive target", () => {
    expect(challengePercent(50, 0)).toBe(0);
  });
  it("returns 0 for non-positive progress", () => {
    expect(challengePercent(-1, 100)).toBe(0);
  });
});

describe("challengeCopy", () => {
  it("falls back from legacy metrics to cataloged goal-specific copy", () => {
    expect(
      challengeCopy({
        content_key: "stale-key",
        metric: "total_km",
        target: 100,
      }).title,
    ).toBe("Ride 100 km");
    expect(
      challengeCopy({
        content_key: "stale-key",
        metric: "unique_segments",
        target: 10,
      }).title,
    ).toBe("Discover 10 roads");
  });
});

describe("metricUnit", () => {
  it("translates known metrics", () => {
    expect(metricUnit("total_distance")).toBe("km");
    expect(metricUnit("ride_count")).toBe("rides");
    expect(metricUnit("total_km")).toBe("km");
    expect(metricUnit("unique_segments")).toBe("roads");
  });
  it("falls back to the raw metric for unknowns", () => {
    expect(metricUnit("freshly_added_metric")).toBe("units");
  });
});

describe("rankChallenges", () => {
  const make = (over: Partial<Challenge>): Challenge => ({
    id: over.id ?? "c",
    content_key: "total_distance",
    metric: "total_distance",
    target: 100,
    starts_at: "2026-05-01T00:00:00Z",
    ends_at: "2026-05-31T00:00:00Z",
    reward_badge_key: null,
    participant_count: 0,
    ...over,
  });

  it("sorts ending-soonest to the top", () => {
    const ranked = rankChallenges([
      make({ id: "a", ends_at: "2026-12-01T00:00:00Z" }),
      make({ id: "b", ends_at: "2026-06-01T00:00:00Z" }),
    ]);
    expect(ranked.map((c) => c.id)).toEqual(["b", "a"]);
  });

  it("breaks ties by participant count (most popular wins)", () => {
    const ranked = rankChallenges([
      make({
        id: "a",
        ends_at: "2026-06-01T00:00:00Z",
        participant_count: 5,
      }),
      make({
        id: "b",
        ends_at: "2026-06-01T00:00:00Z",
        participant_count: 50,
      }),
    ]);
    expect(ranked.map((c) => c.id)).toEqual(["b", "a"]);
  });
});

describe("filterByPeriod", () => {
  const now = new Date("2026-05-01T12:00:00Z");
  const make = (last_ridden_at: string): RiddenSegment => ({
    id: last_ridden_at,
    last_ridden_at,
    last_quality_score: null,
    ride_count: 1,
  });

  it("keeps the last 30 days for 'month'", () => {
    const segments = [
      make("2026-04-15T00:00:00Z"),
      make("2026-03-01T00:00:00Z"),
    ];
    const filtered = filterByPeriod(segments, "month", now);
    expect(filtered.map((s) => s.id)).toEqual(["2026-04-15T00:00:00Z"]);
  });

  it("keeps the last 12 months for 'year'", () => {
    const segments = [
      make("2025-08-01T00:00:00Z"),
      make("2024-01-01T00:00:00Z"),
    ];
    const filtered = filterByPeriod(segments, "year", now);
    expect(filtered.map((s) => s.id)).toEqual(["2025-08-01T00:00:00Z"]);
  });

  it("returns everything for 'all'", () => {
    const segments = [
      make("2020-01-01T00:00:00Z"),
      make("2026-04-30T00:00:00Z"),
    ];
    expect(filterByPeriod(segments, "all", now).length).toBe(2);
  });

  it("drops segments with unparseable timestamps rather than tossing them in", () => {
    const segments = [make("garbage"), make("2026-04-15T00:00:00Z")];
    const filtered = filterByPeriod(segments, "month", now);
    expect(filtered.map((s) => s.id)).toEqual(["2026-04-15T00:00:00Z"]);
  });

  // Regression for the `setMonth(getMonth() - 1)` overflow trap: on a 31st,
  // mutating the date by one calendar month silently lands on the *next*
  // month (e.g. May 31 → April 31 → May 1) and drops ~3 days off the
  // window. A fixed millisecond subtraction stays calendar-agnostic.
  it("uses a fixed 30-day window even when 'now' falls on the 31st", () => {
    const may31 = new Date("2026-05-31T12:00:00Z");
    // 30 days back from May 31 12:00 UTC is May 1 12:00 UTC. A segment
    // ridden on May 1 13:00 UTC should be kept; one ridden on April 30
    // should be dropped.
    const segments = [
      make("2026-05-01T13:00:00Z"),
      make("2026-04-30T00:00:00Z"),
    ];
    const filtered = filterByPeriod(segments, "month", may31);
    expect(filtered.map((s) => s.id)).toEqual(["2026-05-01T13:00:00Z"]);
  });

  it("survives leap-day arithmetic for the 'year' window", () => {
    // Same overflow class affects setFullYear when 'now' is Feb 29 — JS
    // would auto-correct to Mar 1 of the prior year. The fixed-window
    // subtraction sidesteps that entirely.
    const feb29 = new Date("2024-02-29T00:00:00Z");
    const oneYearBack = new Date(
      feb29.getTime() - 365 * 24 * 60 * 60 * 1000,
    ).toISOString();
    const segments = [make(oneYearBack), make("2022-01-01T00:00:00Z")];
    const filtered = filterByPeriod(segments, "year", feb29);
    expect(filtered.map((s) => s.id)).toEqual([oneYearBack]);
  });
});

describe("summarizeExploration", () => {
  it("formats percent with 1 decimal", () => {
    const summary = summarizeExploration({
      ridden_segments: 100,
      total_segments: 800,
      percent_explored: 12.534,
      total_distance_km: 1234.5,
    });
    expect(summary.percentLabel).toBe("12.5%");
    expect(summary.distanceKmLabel).toBe("1,234.5 km");
    expect(summary.riddenCount).toBe(100);
    expect(summary.totalCount).toBe(800);
  });
});

describe("rankUnriddenSegments", () => {
  const make = (over: Partial<UnriddenSegment>): UnriddenSegment => ({
    id: over.id ?? "u",
    road_name: null,
    length_m: 1000,
    quality_score: null,
    surface_type: "asphalt",
    distance_m: 1000,
    ...over,
  });

  it("higher quality wins, ties broken by proximity", () => {
    const ranked = rankUnriddenSegments([
      make({ id: "a", quality_score: 3.5, distance_m: 500 }),
      make({ id: "b", quality_score: 4.5, distance_m: 800 }),
      make({ id: "c", quality_score: 4.5, distance_m: 200 }),
    ]);
    expect(ranked.map((s) => s.id)).toEqual(["c", "b", "a"]);
  });

  it("treats null quality as worst", () => {
    const ranked = rankUnriddenSegments([
      make({ id: "a", quality_score: null, distance_m: 100 }),
      make({ id: "b", quality_score: 2.0, distance_m: 1000 }),
    ]);
    expect(ranked[0]?.id).toBe("b");
  });
});

describe("formatDistanceFromHere", () => {
  it("uses metres under 1 km", () => {
    expect(formatDistanceFromHere(450)).toBe("450 m");
  });
  it("uses km with 1 decimal at and above 1 km", () => {
    expect(formatDistanceFromHere(1234)).toBe("1.2 km");
    expect(formatDistanceFromHere(1000)).toBe("1 km");
  });
  it("falls back to em dash on bad input", () => {
    expect(formatDistanceFromHere(Number.NaN)).toBe("—");
    expect(formatDistanceFromHere(-1)).toBe("—");
  });
});

describe("formatSegmentLength", () => {
  it("matches formatDistanceFromHere shape but rejects 0-length segments", () => {
    expect(formatSegmentLength(0)).toBe("—");
    expect(formatSegmentLength(800)).toBe("800 m");
    expect(formatSegmentLength(2500)).toBe("2.5 km");
  });
});

describe("formatChallengeProgress", () => {
  it("drops decimals for whole numbers and uses the metric's unit", () => {
    expect(formatChallengeProgress(5, 10, "ride_count")).toBe("5 / 10 rides");
  });

  it("keeps 1 decimal for floats", () => {
    expect(formatChallengeProgress(12.4, 50, "total_distance")).toBe(
      "12.4 / 50 km",
    );
  });

  it("converts distance values and unit for imperial riders", () => {
    setActiveFormatContext({
      locale: "en-US",
      timeZone: "UTC",
      units: "imperial",
    });

    expect(formatChallengeProgress(100, 200, "total_distance")).toBe(
      "62.1 / 124.3 mi",
    );
    expect(formatChallengeProgress(100, 200, "total_km")).toBe(
      "62.1 / 124.3 mi",
    );
    expect(metricUnit("total_distance")).toBe("mi");
    expect(metricUnit("total_km")).toBe("mi");
    expect(formatChallengeMetric(200, "total_distance")).toBe("124.3 mi");
    expect(formatChallengeMetric(200, "total_km")).toBe("124.3 mi");
  });

  it("uses the cataloged generic unit for unknown metrics", () => {
    expect(formatChallengeProgress(5, 10, "fresh_metric")).toBe("5 / 10 units");
  });
});
