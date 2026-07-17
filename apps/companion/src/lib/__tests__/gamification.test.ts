import { describe, expect, it } from "vitest";
import type { components } from "@tarmoto/openapi-client";
import { createFormatters } from "@tarmoto/shared";
import { t } from "@/i18n";
import type { RiderStats } from "../types";
import {
  activeChallenges,
  buildDemoSnapshot,
  buildLiveSnapshot,
  categoryForChallengeMetric,
  challengeProgress,
  formatDaysRemaining,
  formatMilestoneLabel,
  humanizeRewardBadgeKey,
  iconForBadgeKey,
  labelForDimension,
  mapBadgeDto,
  mapChallengeDto,
  mapDimensionLeaderboard,
  mapRegionalLeaderboardEntry,
  mapRegionalLeaderboards,
  milestoneProgress,
  pickNextMilestone,
  riderStatsFromBadges,
  riderStatsFromMeProfile,
  seasonalProgress,
  unitForChallengeMetric,
  LEADERBOARD_DIMENSION_KEYS,
  type Challenge,
  type Milestone,
  type SeasonalChallenge,
} from "../gamification";

const NOW = new Date("2026-04-18T00:00:00Z");

// Deterministic en/UTC/metric context — mirrors the component-test default
// (no FormatProvider) so lib-level assertions stay locale-neutral.
const format = createFormatters({ locale: "en", units: "metric" });

function stats(overrides: Partial<RiderStats> = {}): RiderStats {
  return {
    totalKm: 12_000,
    totalRides: 100,
    totalHours: 300,
    roadsDiscovered: 120,
    hazardsReported: 20,
    joinedAt: "2024-04-18T00:00:00Z",
    ...overrides,
  };
}

function challenge(overrides: Partial<Challenge> & { id: string }): Challenge {
  return {
    name: "Test challenge",
    description: "Do a thing",
    category: "distance",
    current: 0,
    target: 100,
    unit: "km",
    endsAt: new Date(NOW.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    ...overrides,
  };
}

describe("challengeProgress", () => {
  it("returns 0 when current is negative or zero", () => {
    expect(
      challengeProgress(challenge({ id: "a", current: 0, target: 100 })),
    ).toBe(0);
    expect(
      challengeProgress(challenge({ id: "a", current: -5, target: 100 })),
    ).toBe(0);
  });

  it("caps completion at 1 when exceeded", () => {
    expect(
      challengeProgress(challenge({ id: "a", current: 250, target: 100 })),
    ).toBe(1);
  });

  it("returns a fraction between 0 and 1 mid-progress", () => {
    expect(
      challengeProgress(challenge({ id: "a", current: 25, target: 100 })),
    ).toBe(0.25);
  });

  it("guards against zero target", () => {
    expect(
      challengeProgress(challenge({ id: "a", current: 10, target: 0 })),
    ).toBe(0);
  });
});

describe("seasonalProgress", () => {
  it("computes a fraction toward the seasonal target", () => {
    const seasonal: SeasonalChallenge = {
      id: "s",
      name: "Spring",
      tagline: "",
      description: "",
      season: "spring",
      startsAt: "2026-03-01T00:00:00Z",
      endsAt: "2026-06-01T00:00:00Z",
      current: 750,
      target: 1500,
      unit: "km",
    };
    expect(seasonalProgress(seasonal)).toBe(0.5);
  });
});

describe("activeChallenges", () => {
  it("drops challenges whose endsAt is in the past", () => {
    const past = challenge({
      id: "past",
      endsAt: new Date(NOW.getTime() - 1000).toISOString(),
    });
    const future = challenge({ id: "future" });
    expect(activeChallenges([past, future], NOW).map((c) => c.id)).toEqual([
      "future",
    ]);
  });

  it("treats malformed endsAt as expired", () => {
    const bad = challenge({ id: "bad", endsAt: "not-a-date" });
    expect(activeChallenges([bad], NOW)).toEqual([]);
  });
});

describe("milestoneProgress", () => {
  const milestone: Milestone = {
    id: "distance",
    name: "Distance",
    description: "",
    metric: "totalKm",
    thresholds: [1_000, 5_000, 10_000, 25_000],
  };

  it("identifies the current tier and the next one", () => {
    const progress = milestoneProgress(milestone, stats({ totalKm: 12_000 }));
    expect(progress.previousThreshold).toBe(10_000);
    expect(progress.nextThreshold).toBe(25_000);
    expect(progress.remaining).toBe(13_000);
    expect(progress.fraction).toBeCloseTo(
      (12_000 - 10_000) / (25_000 - 10_000),
    );
  });

  it("marks maxed milestones with fraction 1", () => {
    const progress = milestoneProgress(milestone, stats({ totalKm: 50_000 }));
    expect(progress.nextThreshold).toBeNull();
    expect(progress.previousThreshold).toBe(25_000);
    expect(progress.fraction).toBe(1);
    expect(progress.remaining).toBe(0);
  });

  it("handles riders below the first tier", () => {
    const progress = milestoneProgress(milestone, stats({ totalKm: 250 }));
    expect(progress.previousThreshold).toBeNull();
    expect(progress.nextThreshold).toBe(1_000);
    expect(progress.fraction).toBeCloseTo(0.25);
  });

  it("sorts thresholds defensively", () => {
    const unsorted: Milestone = {
      ...milestone,
      thresholds: [25_000, 1_000, 5_000, 10_000],
    };
    const progress = milestoneProgress(unsorted, stats({ totalKm: 6_000 }));
    expect(progress.previousThreshold).toBe(5_000);
    expect(progress.nextThreshold).toBe(10_000);
  });
});

describe("pickNextMilestone", () => {
  const milestones: Milestone[] = [
    {
      id: "km",
      name: "Km",
      description: "",
      metric: "totalKm",
      thresholds: [10_000, 25_000],
    },
    {
      id: "roads",
      name: "Roads",
      description: "",
      metric: "roadsDiscovered",
      thresholds: [100, 250, 500],
    },
  ];

  it("returns the most-progressed actionable milestone", () => {
    // km progress:    (20000-10000)/(25000-10000) ≈ 0.667
    // roads progress: (120-100)/(250-100)         ≈ 0.133
    const pick = pickNextMilestone(
      milestones,
      stats({ totalKm: 20_000, roadsDiscovered: 120 }),
    );
    expect(pick?.milestone.id).toBe("km");
  });

  it("skips milestones that are already maxed", () => {
    const pick = pickNextMilestone(
      milestones,
      stats({ totalKm: 100_000, roadsDiscovered: 120 }),
    );
    expect(pick?.milestone.id).toBe("roads");
  });

  it("returns null when the list is empty", () => {
    expect(pickNextMilestone([], stats())).toBeNull();
  });
});

describe("formatMilestoneLabel", () => {
  const milestone: Milestone = {
    id: "km",
    name: "Km",
    description: "",
    metric: "totalKm",
    thresholds: [10_000, 25_000],
  };

  it("shows current / next with the metric unit", () => {
    const progress = milestoneProgress(milestone, stats({ totalKm: 12_345 }));
    expect(formatMilestoneLabel(progress, format)).toBe("12,345 / 25,000 km");
  });

  it("labels maxed milestones", () => {
    const progress = milestoneProgress(milestone, stats({ totalKm: 30_000 }));
    expect(formatMilestoneLabel(progress, format)).toBe("Maxed at 30,000 km");
  });
});

describe("formatDaysRemaining", () => {
  it("reports ended when past the end", () => {
    expect(
      formatDaysRemaining(new Date(NOW.getTime() - 1000).toISOString(), NOW, t),
    ).toBe("Ended");
  });

  it("reports today when less than 24 hours remain", () => {
    const endsAt = new Date(NOW.getTime() + 6 * 60 * 60 * 1000).toISOString();
    expect(formatDaysRemaining(endsAt, NOW, t)).toBe("Ends today");
  });

  it("uses the tomorrow shortcut for one day left", () => {
    const endsAt = new Date(NOW.getTime() + 24 * 60 * 60 * 1000).toISOString();
    expect(formatDaysRemaining(endsAt, NOW, t)).toBe("Ends tomorrow");
  });

  it("reports days under a week", () => {
    const endsAt = new Date(
      NOW.getTime() + 3 * 24 * 60 * 60 * 1000,
    ).toISOString();
    expect(formatDaysRemaining(endsAt, NOW, t)).toBe("3 days left");
  });

  it("switches to weeks between 1 and 4 weeks", () => {
    const endsAt = new Date(
      NOW.getTime() + 10 * 24 * 60 * 60 * 1000,
    ).toISOString();
    expect(formatDaysRemaining(endsAt, NOW, t)).toBe("1w 3d left");
  });

  it("switches to months past four weeks", () => {
    const endsAt = new Date(
      NOW.getTime() + 45 * 24 * 60 * 60 * 1000,
    ).toISOString();
    expect(formatDaysRemaining(endsAt, NOW, t)).toBe("1 month left");
  });

  it("rounds the 28-29 day band up to '1 month left' instead of zero", () => {
    const endsAt = new Date(
      NOW.getTime() + 28 * 24 * 60 * 60 * 1000,
    ).toISOString();
    expect(formatDaysRemaining(endsAt, NOW, t)).toBe("1 month left");
  });

  it("falls back to 'Ongoing' for malformed dates", () => {
    expect(formatDaysRemaining("not-a-date", NOW, t)).toBe("Ongoing");
  });
});

// ── Backend → UI mappers ──

type BadgeDto = components["schemas"]["BadgeDto"];
type ChallengeDto = components["schemas"]["ChallengeDto"];
type ChallengeDetailDto = components["schemas"]["ChallengeDetailDto"];

function badgeDto(overrides: Partial<BadgeDto> = {}): BadgeDto {
  return {
    key: "total_distance",
    name: "Road Warrior",
    description: "Total distance ridden",
    category: "distance",
    tier: null,
    earned_at: null,
    progress: { current: 0, bronze: 100, silver: 1000, gold: 10000 },
    ...overrides,
  };
}

function challengeDto(overrides: Partial<ChallengeDto> = {}): ChallengeDto {
  return {
    id: "ch-1",
    title: "Spring Explorer",
    description: "Ride 10 new roads this month",
    metric: "roads_discovered",
    target: 10,
    starts_at: "2026-04-01T00:00:00Z",
    ends_at: "2026-05-01T00:00:00Z",
    reward_badge_key: null,
    participant_count: 0,
    ...overrides,
  };
}

function challengeDetailDto(
  overrides: Partial<ChallengeDetailDto> = {},
): ChallengeDetailDto {
  return {
    ...challengeDto(),
    my_progress: null,
    my_completed: null,
    leaderboard: [],
    ...overrides,
  };
}

describe("iconForBadgeKey", () => {
  it("maps known keys to icon names", () => {
    expect(iconForBadgeKey("total_distance")).toBe("trophy");
    expect(iconForBadgeKey("roads_discovered")).toBe("compass");
    expect(iconForBadgeKey("hazards_reported")).toBe("alert-triangle");
  });

  it("falls back to medal for unknown keys", () => {
    expect(iconForBadgeKey("brand_new_badge")).toBe("medal");
  });
});

describe("mapBadgeDto", () => {
  it("uses earned_at when set and leaves it undefined when null", () => {
    const earned = mapBadgeDto(
      badgeDto({ tier: "bronze", earned_at: "2026-04-01T00:00:00Z" }),
    );
    expect(earned.earnedAt).toBe("2026-04-01T00:00:00Z");

    const locked = mapBadgeDto(badgeDto());
    expect(locked.earnedAt).toBeUndefined();
  });

  it("derives id from the backend key and picks an icon", () => {
    const mapped = mapBadgeDto(badgeDto({ key: "roads_discovered" }));
    expect(mapped.id).toBe("roads_discovered");
    expect(mapped.icon).toBe("compass");
  });
});

describe("categoryForChallengeMetric", () => {
  it("maps backend metric → UI category", () => {
    expect(categoryForChallengeMetric("total_distance")).toBe("distance");
    expect(categoryForChallengeMetric("roads_discovered")).toBe("discovery");
    expect(categoryForChallengeMetric("hazards_reported")).toBe("safety");
    expect(categoryForChallengeMetric("rides_shared")).toBe("social");
  });

  it("falls back to distance for unknown metrics", () => {
    expect(categoryForChallengeMetric("anything_else")).toBe("distance");
  });
});

describe("unitForChallengeMetric", () => {
  it("returns the unit label by metric", () => {
    expect(unitForChallengeMetric("total_distance")).toBe("km");
    expect(unitForChallengeMetric("ride_count")).toBe("rides");
    expect(unitForChallengeMetric("roads_discovered")).toBe("roads");
    expect(unitForChallengeMetric("hazards_reported")).toBe("reports");
  });
});

describe("mapChallengeDto", () => {
  it("treats null my_progress as not-yet-joined (current = 0)", () => {
    const c = mapChallengeDto(challengeDto({ target: 10 }), null);
    expect(c.current).toBe(0);
    expect(c.target).toBe(10);
  });

  it("uses my_progress when the rider has joined", () => {
    const c = mapChallengeDto(challengeDto({ target: 10 }), 4);
    expect(c.current).toBe(4);
  });

  it("renames title → name and forwards endsAt", () => {
    const c = mapChallengeDto(
      challengeDto({ title: "Spring", ends_at: "2026-05-01T00:00:00Z" }),
    );
    expect(c.name).toBe("Spring");
    expect(c.endsAt).toBe("2026-05-01T00:00:00Z");
  });

  it("humanises a reward badge key into user-facing copy", () => {
    const c = mapChallengeDto(
      challengeDto({ reward_badge_key: "spring_explorer" }),
    );
    expect(c.reward).toBe("Spring explorer");
  });

  it("leaves reward undefined when no badge key is set", () => {
    const c = mapChallengeDto(challengeDto({ reward_badge_key: null }));
    expect(c.reward).toBeUndefined();
  });
});

describe("humanizeRewardBadgeKey", () => {
  it("converts snake_case to Sentence case", () => {
    expect(humanizeRewardBadgeKey("spring_explorer")).toBe("Spring explorer");
    expect(humanizeRewardBadgeKey("road_warrior_2026")).toBe(
      "Road warrior 2026",
    );
  });

  it("treats hyphens like underscores", () => {
    expect(humanizeRewardBadgeKey("safety-scout")).toBe("Safety scout");
  });

  it("returns an empty string for blank input", () => {
    expect(humanizeRewardBadgeKey("")).toBe("");
    expect(humanizeRewardBadgeKey("   ")).toBe("");
  });
});

describe("riderStatsFromBadges", () => {
  it("derives stats from badge progress.current values", () => {
    const stats = riderStatsFromBadges([
      badgeDto({
        key: "total_distance",
        progress: { current: 5_000, bronze: 100, silver: 1_000, gold: 10_000 },
      }),
      badgeDto({
        key: "roads_discovered",
        progress: { current: 120, bronze: 25, silver: 100, gold: 500 },
      }),
      badgeDto({
        key: "hazards_reported",
        progress: { current: 30, bronze: 5, silver: 25, gold: 100 },
      }),
    ]);
    expect(stats.totalKm).toBe(5_000);
    expect(stats.roadsDiscovered).toBe(120);
    expect(stats.hazardsReported).toBe(30);
  });

  it("zeros missing dimensions so milestone display still works", () => {
    const stats = riderStatsFromBadges([]);
    expect(stats.totalKm).toBe(0);
    expect(stats.roadsDiscovered).toBe(0);
    expect(stats.hazardsReported).toBe(0);
  });
});

describe("riderStatsFromMeProfile", () => {
  it("maps all RiderStats fields directly from the me-profile DTO", () => {
    const stats = riderStatsFromMeProfile({
      joined_at: "2025-01-15T10:00:00.000Z",
      total_hours: 87.4,
      total_rides: 42,
      total_distance_km: 3_217.6,
      roads_discovered: 198,
      hazards_reported: 11,
      follower_count: 5,
      following_count: 9,
      badges_earned: 4,
    });

    expect(stats).toEqual({
      totalKm: 3_217.6,
      totalRides: 42,
      totalHours: 87.4,
      roadsDiscovered: 198,
      hazardsReported: 11,
      joinedAt: "2025-01-15T10:00:00.000Z",
    });
  });
});

describe("regional leaderboard mappers", () => {
  function entryDto(
    overrides: Partial<{
      rank: number;
      user_id: string;
      display_name: string;
      home_region: string | null;
      value: number;
    }> = {},
  ) {
    return {
      rank: 1,
      user_id: "user-1",
      display_name: "Rider",
      home_region: "Beskydy",
      value: 100,
      ...overrides,
    };
  }

  it("flags isMe when the user id matches the current user", () => {
    const mapped = mapRegionalLeaderboardEntry(
      entryDto({ user_id: "me" }),
      "me",
    );
    expect(mapped.isMe).toBe(true);
    expect(mapped.userId).toBe("me");
  });

  it("does not flag isMe for other users or anonymous viewers", () => {
    expect(
      mapRegionalLeaderboardEntry(entryDto({ user_id: "u1" }), "u2").isMe,
    ).toBe(false);
    expect(mapRegionalLeaderboardEntry(entryDto(), null).isMe).toBe(false);
  });

  it("maps a dimension leaderboard, propagating me", () => {
    const dim = mapDimensionLeaderboard(
      {
        dimension: "total_distance_km",
        unit: "km",
        entries: [entryDto({ user_id: "u1", rank: 1, value: 500 })],
        me: entryDto({ user_id: "me", rank: 47, value: 12 }),
      },
      "me",
    );
    expect(dim.dimension).toBe("total_distance_km");
    expect(dim.unit).toBe("km");
    expect(dim.entries).toHaveLength(1);
    expect(dim.entries[0]?.isMe).toBe(false);
    expect(dim.me?.userId).toBe("me");
    expect(dim.me?.isMe).toBe(true);
  });

  it("maps the full regional response with three dimensions", () => {
    const full = mapRegionalLeaderboards(
      {
        region: "Beskydy",
        generated_at: "2026-05-01T00:00:00Z",
        total_distance_km: {
          dimension: "total_distance_km",
          unit: "km",
          entries: [entryDto({ user_id: "u1", value: 500 })],
          me: null,
        },
        roads_discovered: {
          dimension: "roads_discovered",
          unit: "roads",
          entries: [entryDto({ user_id: "me", value: 12 })],
          me: entryDto({ user_id: "me", value: 12 }),
        },
        hazards_reported: {
          dimension: "hazards_reported",
          unit: "reports",
          entries: [],
          me: null,
        },
      },
      "me",
    );
    expect(full.region).toBe("Beskydy");
    expect(full.total_distance_km.entries[0]?.isMe).toBe(false);
    expect(full.roads_discovered.me?.isMe).toBe(true);
    expect(full.hazards_reported.entries).toEqual([]);
  });
});

describe("labelForDimension", () => {
  it("returns a human-readable label per dimension", () => {
    for (const dim of LEADERBOARD_DIMENSION_KEYS) {
      expect(labelForDimension(dim)).toBeTruthy();
    }
  });
});

describe("buildLiveSnapshot", () => {
  it("produces an empty snapshot when no data is available", () => {
    const snap = buildLiveSnapshot({ badges: [], challengeDetails: [] });
    expect(snap.badges).toEqual([]);
    expect(snap.challenges).toEqual([]);
    expect(snap.seasonal).toBeNull();
    expect(snap.milestones.length).toBeGreaterThan(0);
  });

  it("populates challengeMeta with joined flag and participant count", () => {
    const detail = challengeDetailDto({
      id: "ch-1",
      participant_count: 7,
      my_progress: 3,
    });
    const snap = buildLiveSnapshot({ badges: [], challengeDetails: [detail] });
    expect(snap.challengeMeta["ch-1"]).toEqual({
      joined: true,
      participantCount: 7,
    });
    expect(snap.challenges[0]?.current).toBe(3);
  });

  it("treats null my_progress as not-joined", () => {
    const detail = challengeDetailDto({
      id: "ch-1",
      participant_count: 0,
      my_progress: null,
    });
    const snap = buildLiveSnapshot({ badges: [], challengeDetails: [detail] });
    expect(snap.challengeMeta["ch-1"]?.joined).toBe(false);
    expect(snap.challenges[0]?.current).toBe(0);
  });

  it("derives stats from the badges payload", () => {
    const snap = buildLiveSnapshot({
      badges: [
        badgeDto({
          key: "total_distance",
          progress: {
            current: 8_000,
            bronze: 100,
            silver: 1_000,
            gold: 10_000,
          },
        }),
      ],
      challengeDetails: [],
    });
    expect(snap.stats.totalKm).toBe(8_000);
  });

  it("prefers the me-profile summary for stats when supplied (totalHours / joinedAt only available there)", () => {
    const snap = buildLiveSnapshot({
      badges: [
        badgeDto({
          key: "total_distance",
          // Stale badge value — me-profile should win.
          progress: {
            current: 100,
            bronze: 100,
            silver: 1_000,
            gold: 10_000,
          },
        }),
      ],
      challengeDetails: [],
      meProfile: {
        joined_at: "2024-01-15T10:00:00.000Z",
        total_hours: 120.5,
        total_rides: 18,
        total_distance_km: 1_234.5,
        roads_discovered: 73,
        hazards_reported: 6,
        follower_count: 11,
        following_count: 7,
        badges_earned: 3,
      },
    });

    expect(snap.stats.totalKm).toBe(1_234.5);
    expect(snap.stats.totalHours).toBe(120.5);
    expect(snap.stats.joinedAt).toBe("2024-01-15T10:00:00.000Z");
  });
});

describe("buildDemoSnapshot", () => {
  it("returns deterministic output for the same rider id", () => {
    const a = buildDemoSnapshot("rider-1", NOW);
    const b = buildDemoSnapshot("rider-1", NOW);
    expect(a).toEqual(b);
  });

  it("emits future-dated challenges so they render on the dashboard", () => {
    const snap = buildDemoSnapshot("rider-1", NOW);
    expect(activeChallenges(snap.challenges, NOW).length).toBe(
      snap.challenges.length,
    );
  });

  it("builds a seasonal challenge with a positive target", () => {
    const snap = buildDemoSnapshot("rider-1", NOW);
    expect(snap.seasonal).not.toBeNull();
    if (!snap.seasonal) throw new Error("seasonal expected");
    expect(snap.seasonal.target).toBeGreaterThan(0);
    expect(seasonalProgress(snap.seasonal)).toBeGreaterThan(0);
  });

  it("exposes a mix of earned and locked badges", () => {
    const snap = buildDemoSnapshot("rider-1", NOW);
    const earned = snap.badges.filter((b) => b.earnedAt).length;
    const locked = snap.badges.length - earned;
    expect(earned).toBeGreaterThan(0);
    expect(locked).toBeGreaterThan(0);
  });
});
