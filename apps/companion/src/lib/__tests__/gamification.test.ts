import { describe, expect, it } from "vitest";
import type { RiderStats } from "../types";
import {
  activeChallenges,
  buildDemoSnapshot,
  challengeProgress,
  formatDaysRemaining,
  formatMilestoneLabel,
  milestoneProgress,
  myLeaderboardRank,
  pickNextMilestone,
  seasonalProgress,
  sortLeaderboard,
  type Challenge,
  type LeaderboardEntry,
  type Milestone,
  type SeasonalChallenge,
} from "../gamification";

const NOW = new Date("2026-04-18T00:00:00Z");

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

function entry(
  overrides: Partial<LeaderboardEntry> & { riderId: string },
): LeaderboardEntry {
  return {
    displayName: "Rider",
    totalKm: 0,
    roadsDiscovered: 0,
    hazardsReported: 0,
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

describe("sortLeaderboard", () => {
  it("sorts by the requested metric descending", () => {
    const sorted = sortLeaderboard(
      [
        entry({ riderId: "a", totalKm: 10 }),
        entry({ riderId: "b", totalKm: 100 }),
        entry({ riderId: "c", totalKm: 50 }),
      ],
      "totalKm",
    );
    expect(sorted.map((e) => e.riderId)).toEqual(["b", "c", "a"]);
  });

  it("does not mutate the input array", () => {
    const input = [
      entry({ riderId: "a", roadsDiscovered: 1 }),
      entry({ riderId: "b", roadsDiscovered: 5 }),
    ];
    const snapshot = [...input];
    sortLeaderboard(input, "roadsDiscovered");
    expect(input).toEqual(snapshot);
  });
});

describe("myLeaderboardRank", () => {
  it("returns the 1-based rank of the entry flagged as me", () => {
    const rank = myLeaderboardRank(
      [
        entry({ riderId: "a", totalKm: 10 }),
        entry({ riderId: "me", totalKm: 100, isMe: true }),
        entry({ riderId: "c", totalKm: 50 }),
      ],
      "totalKm",
    );
    expect(rank).toBe(1);
  });

  it("returns null when no entry is flagged", () => {
    expect(
      myLeaderboardRank([entry({ riderId: "a", totalKm: 1 })], "totalKm"),
    ).toBeNull();
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
    expect(formatMilestoneLabel(progress)).toBe("12,345 / 25,000 km");
  });

  it("labels maxed milestones", () => {
    const progress = milestoneProgress(milestone, stats({ totalKm: 30_000 }));
    expect(formatMilestoneLabel(progress)).toBe("Maxed at 30,000 km");
  });
});

describe("formatDaysRemaining", () => {
  it("reports ended when past the end", () => {
    expect(
      formatDaysRemaining(new Date(NOW.getTime() - 1000).toISOString(), NOW),
    ).toBe("Ended");
  });

  it("reports today when less than 24 hours remain", () => {
    const endsAt = new Date(NOW.getTime() + 6 * 60 * 60 * 1000).toISOString();
    expect(formatDaysRemaining(endsAt, NOW)).toBe("Ends today");
  });

  it("uses the tomorrow shortcut for one day left", () => {
    const endsAt = new Date(NOW.getTime() + 24 * 60 * 60 * 1000).toISOString();
    expect(formatDaysRemaining(endsAt, NOW)).toBe("Ends tomorrow");
  });

  it("reports days under a week", () => {
    const endsAt = new Date(
      NOW.getTime() + 3 * 24 * 60 * 60 * 1000,
    ).toISOString();
    expect(formatDaysRemaining(endsAt, NOW)).toBe("3 days left");
  });

  it("switches to weeks between 1 and 4 weeks", () => {
    const endsAt = new Date(
      NOW.getTime() + 10 * 24 * 60 * 60 * 1000,
    ).toISOString();
    expect(formatDaysRemaining(endsAt, NOW)).toBe("1w 3d left");
  });

  it("switches to months past four weeks", () => {
    const endsAt = new Date(
      NOW.getTime() + 45 * 24 * 60 * 60 * 1000,
    ).toISOString();
    expect(formatDaysRemaining(endsAt, NOW)).toBe("1 month left");
  });

  it("rounds the 28-29 day band up to '1 month left' instead of zero", () => {
    const endsAt = new Date(
      NOW.getTime() + 28 * 24 * 60 * 60 * 1000,
    ).toISOString();
    expect(formatDaysRemaining(endsAt, NOW)).toBe("1 month left");
  });

  it("falls back to 'Ongoing' for malformed dates", () => {
    expect(formatDaysRemaining("not-a-date", NOW)).toBe("Ongoing");
  });
});

describe("buildDemoSnapshot", () => {
  it("returns deterministic output for the same rider id", () => {
    const a = buildDemoSnapshot("rider-1", NOW);
    const b = buildDemoSnapshot("rider-1", NOW);
    expect(a).toEqual(b);
  });

  it("includes the signed-in rider in the leaderboard", () => {
    const snap = buildDemoSnapshot("rider-1", NOW);
    const me = snap.leaderboard.find((e) => e.isMe);
    expect(me?.riderId).toBe("rider-1");
  });

  it("emits future-dated challenges so they render on the dashboard", () => {
    const snap = buildDemoSnapshot("rider-1", NOW);
    expect(activeChallenges(snap.challenges, NOW).length).toBe(
      snap.challenges.length,
    );
  });

  it("builds a seasonal challenge with a positive target", () => {
    const snap = buildDemoSnapshot("rider-1", NOW);
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
