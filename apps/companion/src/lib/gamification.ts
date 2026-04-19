/**
 * Pure helpers + demo data for the gamification dashboard (US-57).
 *
 * The dashboard surfaces four data surfaces on top of the rider's profile
 * badges: active challenges with progress, a regional leaderboard, the next
 * milestone the rider is working toward, and a seasonal challenge banner.
 *
 * The backend endpoints are still spec-pending, so the page drives off a
 * deterministic demo generator keyed by rider id — same approach used by the
 * rider profile fetcher (`rider-profile.ts`) so the UI can be rendered and
 * tested without the API.
 */

import type { Badge, RiderStats } from "@/lib/types";

// ── Types ──

export type ChallengeCategory =
  | "distance"
  | "discovery"
  | "safety"
  | "social"
  | "seasonal";

export interface Challenge {
  id: string;
  name: string;
  description: string;
  category: ChallengeCategory;
  /** Progress units (e.g. km ridden, roads discovered). */
  current: number;
  target: number;
  /** Unit label surfaced next to the progress bar ("km", "roads", etc.). */
  unit: string;
  /** ISO string. Challenges past their end date are filtered out. */
  endsAt: string;
  /** Optional reward copy shown on completion. */
  reward?: string;
}

export type LeaderboardMetric =
  | "totalKm"
  | "roadsDiscovered"
  | "hazardsReported";

export interface LeaderboardEntry {
  riderId: string;
  displayName: string;
  homeRegion?: string;
  totalKm: number;
  roadsDiscovered: number;
  hazardsReported: number;
  /** Whether this entry is the signed-in rider (highlighted in the table). */
  isMe?: boolean;
}

export interface Milestone {
  id: string;
  name: string;
  description: string;
  metric: LeaderboardMetric;
  /** Ordered thresholds the rider progresses through. */
  thresholds: number[];
}

export interface MilestoneProgress {
  milestone: Milestone;
  current: number;
  /** Next threshold the rider is working toward, or `null` when maxed. */
  nextThreshold: number | null;
  /** Threshold just crossed, or `null` before the first tier. */
  previousThreshold: number | null;
  /** 0..1 toward `nextThreshold` from `previousThreshold`. 1 when maxed. */
  fraction: number;
  /** Units remaining until `nextThreshold`, or 0 when maxed. */
  remaining: number;
}

export interface SeasonalChallenge {
  id: string;
  name: string;
  tagline: string;
  description: string;
  season: "spring" | "summer" | "autumn" | "winter";
  startsAt: string;
  endsAt: string;
  current: number;
  target: number;
  unit: string;
}

export interface GamificationSnapshot {
  badges: Badge[];
  challenges: Challenge[];
  leaderboard: LeaderboardEntry[];
  milestones: Milestone[];
  seasonal: SeasonalChallenge;
  stats: RiderStats;
}

// ── Helpers ──

export function challengeProgress(challenge: Challenge): number {
  if (challenge.target <= 0) return 0;
  return clamp01(challenge.current / challenge.target);
}

export function seasonalProgress(seasonal: SeasonalChallenge): number {
  if (seasonal.target <= 0) return 0;
  return clamp01(seasonal.current / seasonal.target);
}

/**
 * Filters challenges that have already ended relative to `now`. Completed
 * challenges stay on the dashboard until they expire — they're the most
 * rewarding to look at and clear out on their own.
 */
export function activeChallenges(
  challenges: readonly Challenge[],
  now: Date = new Date(),
): Challenge[] {
  const cutoff = now.getTime();
  return challenges.filter((c) => {
    const t = new Date(c.endsAt).getTime();
    return Number.isFinite(t) && t >= cutoff;
  });
}

export function sortLeaderboard(
  entries: readonly LeaderboardEntry[],
  metric: LeaderboardMetric,
): LeaderboardEntry[] {
  return [...entries].sort((a, b) => b[metric] - a[metric]);
}

/**
 * Returns the 1-based rank of the signed-in rider for `metric`, or `null` if
 * none of the entries are flagged `isMe`. Ties preserve the natural order of
 * `sortLeaderboard`, which is good enough for a dashboard rank pill.
 */
export function myLeaderboardRank(
  entries: readonly LeaderboardEntry[],
  metric: LeaderboardMetric,
): number | null {
  const sorted = sortLeaderboard(entries, metric);
  const idx = sorted.findIndex((e) => e.isMe);
  return idx === -1 ? null : idx + 1;
}

export function milestoneProgress(
  milestone: Milestone,
  stats: RiderStats,
): MilestoneProgress {
  const current = stats[milestone.metric];
  // Defensive copy + ascending sort so consumers can declare thresholds in any
  // order; the progression logic relies on them being monotonic.
  const tiers = [...milestone.thresholds].sort((a, b) => a - b);
  let previousThreshold: number | null = null;
  let nextThreshold: number | null = null;
  for (const tier of tiers) {
    if (current >= tier) {
      previousThreshold = tier;
    } else {
      nextThreshold = tier;
      break;
    }
  }

  if (nextThreshold === null) {
    return {
      milestone,
      current,
      nextThreshold: null,
      previousThreshold,
      fraction: 1,
      remaining: 0,
    };
  }

  const base = previousThreshold ?? 0;
  const span = nextThreshold - base;
  const fraction = span > 0 ? clamp01((current - base) / span) : 0;
  return {
    milestone,
    current,
    nextThreshold,
    previousThreshold,
    fraction,
    remaining: Math.max(0, nextThreshold - current),
  };
}

/**
 * Picks the milestone the rider is closest to reaching. Milestones already at
 * their max tier deprioritise to the end so the UI surfaces actionable goals
 * first. Returns `null` only when the input list is empty.
 */
export function pickNextMilestone(
  milestones: readonly Milestone[],
  stats: RiderStats,
): MilestoneProgress | null {
  if (milestones.length === 0) return null;
  const progressed = milestones.map((m) => milestoneProgress(m, stats));
  const actionable = progressed.filter((p) => p.nextThreshold !== null);
  if (actionable.length === 0) return progressed[0] ?? null;
  return actionable.sort((a, b) => b.fraction - a.fraction)[0] ?? null;
}

export function formatMilestoneLabel(progress: MilestoneProgress): string {
  const unit = MILESTONE_UNITS[progress.milestone.metric];
  if (progress.nextThreshold === null) {
    return `Maxed at ${formatNumber(progress.current)} ${unit}`;
  }
  return `${formatNumber(progress.current)} / ${formatNumber(progress.nextThreshold)} ${unit}`;
}

export function formatDaysRemaining(
  endsAt: string,
  now: Date = new Date(),
): string {
  const end = new Date(endsAt).getTime();
  if (!Number.isFinite(end)) return "Ongoing";
  const diffMs = end - now.getTime();
  if (diffMs <= 0) return "Ended";
  const days = Math.floor(diffMs / (24 * 60 * 60 * 1000));
  if (days === 0) return "Ends today";
  if (days === 1) return "Ends tomorrow";
  if (days < 7) return `${days} days left`;
  const weeks = Math.floor(days / 7);
  const extra = days % 7;
  if (weeks < 4) {
    return extra === 0
      ? `${weeks} week${weeks === 1 ? "" : "s"} left`
      : `${weeks}w ${extra}d left`;
  }
  // Clamp to at least 1 so the 28-29 day band (weeks === 4, days / 30 === 0)
  // doesn't render "0 months left".
  const months = Math.max(1, Math.floor(days / 30));
  return `${months} month${months === 1 ? "" : "s"} left`;
}

const MILESTONE_UNITS: Record<LeaderboardMetric, string> = {
  totalKm: "km",
  roadsDiscovered: "roads",
  hazardsReported: "reports",
};

function clamp01(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return value > 1 ? 1 : value;
}

function formatNumber(value: number): string {
  return Math.round(value).toLocaleString();
}

// ── Demo data ──

const DEFAULT_MILESTONES: Milestone[] = [
  {
    id: "distance-traveller",
    name: "Distance Traveller",
    description: "Cumulative kilometres ridden across every bike.",
    metric: "totalKm",
    thresholds: [1_000, 5_000, 10_000, 25_000, 50_000, 100_000],
  },
  {
    id: "road-cartographer",
    name: "Road Cartographer",
    description: "Unique roads you were first to map.",
    metric: "roadsDiscovered",
    thresholds: [10, 50, 100, 250, 500, 1_000],
  },
  {
    id: "hazard-hunter",
    name: "Hazard Hunter",
    description: "Confirmed hazards reported to the community.",
    metric: "hazardsReported",
    thresholds: [5, 25, 50, 100, 250],
  },
];

/**
 * Builds a deterministic gamification snapshot keyed by `riderId`. Matches the
 * rider-profile demo generator so the two pages feel coherent when neither
 * endpoint is live.
 */
export function buildDemoSnapshot(
  riderId: string,
  now: Date = new Date(),
): GamificationSnapshot {
  const seed = hashSeed(riderId);
  const stats: RiderStats = {
    totalKm: 16_550,
    totalRides: 121,
    totalHours: 412.5,
    roadsDiscovered: 284,
    hazardsReported: 47,
    joinedAt: isoDaysAgo(720, seed, now),
  };

  const badges: Badge[] = [
    {
      id: "pioneer",
      name: "Pioneer",
      description: "First to map 100 roads.",
      icon: "compass",
      earnedAt: isoDaysAgo(180, seed, now),
    },
    {
      id: "mountain-hunter",
      name: "Mountain hunter",
      description: "Ride 10 mountain passes.",
      icon: "mountain",
      earnedAt: isoDaysAgo(90, seed + 2, now),
    },
    {
      id: "night-owl",
      name: "Night owl",
      description: "Finish 5 rides after sunset.",
      icon: "moon",
      earnedAt: isoDaysAgo(32, seed + 3, now),
    },
    {
      id: "hazard-hunter",
      name: "Hazard hunter",
      description: "Report 25 confirmed hazards.",
      icon: "alert-triangle",
      earnedAt: isoDaysAgo(14, seed + 4, now),
    },
    {
      id: "curves-1000",
      name: "1000 curves",
      description: "Link 1,000 curves in a single month.",
      icon: "wind",
    },
    {
      id: "legend",
      name: "Legend",
      description: "Reach 100,000 km on a single bike.",
      icon: "trophy",
    },
  ];

  const challenges: Challenge[] = [
    {
      id: "spring-km",
      name: "Spring warm-up",
      description: "Clock 500 km during April.",
      category: "distance",
      current: 312,
      target: 500,
      unit: "km",
      endsAt: isoDaysFromNow(12, now),
      reward: "Spring 2026 badge",
    },
    {
      id: "new-roads-week",
      name: "Ten new roads",
      description: "Map 10 roads never ridden before.",
      category: "discovery",
      current: 7,
      target: 10,
      unit: "roads",
      endsAt: isoDaysFromNow(4, now),
    },
    {
      id: "hazard-report-week",
      name: "Community watch",
      description: "Report 5 hazards this week.",
      category: "safety",
      current: 2,
      target: 5,
      unit: "reports",
      endsAt: isoDaysFromNow(6, now),
    },
    {
      id: "group-ride",
      name: "Group ride",
      description: "Join a group ride with another Tarmoto rider.",
      category: "social",
      current: 0,
      target: 1,
      unit: "ride",
      endsAt: isoDaysFromNow(21, now),
    },
  ];

  const leaderboard: LeaderboardEntry[] = [
    {
      riderId: "leader-1",
      displayName: "Marek Novák",
      homeRegion: "Beskydy",
      totalKm: 21_400,
      roadsDiscovered: 356,
      hazardsReported: 62,
    },
    {
      riderId: "leader-2",
      displayName: "Karolína Dvořáková",
      homeRegion: "Beskydy",
      totalKm: 18_900,
      roadsDiscovered: 298,
      hazardsReported: 71,
    },
    {
      riderId,
      displayName: "You",
      homeRegion: "Beskydy",
      totalKm: stats.totalKm,
      roadsDiscovered: stats.roadsDiscovered,
      hazardsReported: stats.hazardsReported,
      isMe: true,
    },
    {
      riderId: "leader-4",
      displayName: "Tomáš Svoboda",
      homeRegion: "Beskydy",
      totalKm: 14_220,
      roadsDiscovered: 241,
      hazardsReported: 39,
    },
    {
      riderId: "leader-5",
      displayName: "Lenka Procházková",
      homeRegion: "Beskydy",
      totalKm: 12_880,
      roadsDiscovered: 213,
      hazardsReported: 28,
    },
  ];

  const seasonal: SeasonalChallenge = {
    id: "alpine-spring-2026",
    name: "Alpine Spring",
    tagline: "Chase the thaw across Europe's reopening passes.",
    description:
      "Ride 1,500 km featuring at least 10 alpine passes before the season closes in June.",
    season: "spring",
    startsAt: isoDaysAgo(30, seed, now),
    endsAt: isoDaysFromNow(45, now),
    current: 812,
    target: 1_500,
    unit: "km",
  };

  return {
    badges,
    challenges,
    leaderboard,
    milestones: DEFAULT_MILESTONES,
    seasonal,
    stats,
  };
}

// ── Deterministic date helpers (mirrors rider-profile.ts) ──

function hashSeed(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash) % 997;
}

function isoDaysAgo(days: number, seed: number, now: Date): string {
  const jitter = seed % 7;
  const offset = (days + jitter) * 24 * 60 * 60 * 1000;
  return new Date(now.getTime() - offset).toISOString();
}

function isoDaysFromNow(days: number, now: Date): string {
  return new Date(now.getTime() + days * 24 * 60 * 60 * 1000).toISOString();
}
