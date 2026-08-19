/**
 * Types, mappers and helpers for the gamification dashboard (US-57).
 *
 * The dashboard surfaces four data surfaces on top of the rider's profile
 * badges: active challenges with progress, a multi-dimensional regional
 * leaderboard (km / roads / hazards), the next milestone the rider is
 * working toward, and an optional long-running seasonal challenge banner.
 *
 * The regional leaderboard is fetched on its own (region selection is
 * interactive) and is therefore not part of `GamificationSnapshot` —
 * see `fetchRegionalLeaderboards` in `gamification-fetch.ts`.
 *
 * `buildDemoSnapshot` is retained as a typed test fixture only — production
 * rendering goes through `gamification-fetch.ts` and the real backend.
 */

import type { components } from "@tarmoto/openapi-client";
import {
  challengeContentKeyForMetric,
  isBadgeKey,
  isChallengeContentKey,
  isChallengeRewardKey,
  formatSplitValueUnitRange,
  type BadgeKey,
  type ChallengeContentKey,
  type ChallengeRewardKey,
  type Formatters,
} from "@tarmoto/shared";
import type { EnglishMessageKey, Translate } from "@/i18n";
import {
  BADGE_TIER_LABELS,
  PROGRESSION_TIER_LABELS,
  translateKnownLabel,
} from "@/i18n/domainLabels";
import type { Badge, RiderStats } from "@/lib/types";

type MeProfileDto = components["schemas"]["MeProfileDto"];

// ── Types ──

export type ChallengeCategory =
  "distance" | "discovery" | "safety" | "social" | "seasonal";

export interface Challenge {
  id: string;
  name: string;
  description: string;
  category: ChallengeCategory;
  /** Progress units (e.g. km ridden, roads discovered). */
  current: number;
  target: number;
  /** Unit label surfaced next to the progress bar ("km", "roads", etc.). */
  unit: EnglishMessageKey;
  /** ISO string. Challenges past their end date are filtered out. */
  endsAt: string;
  /** Optional reward copy shown on completion. */
  reward?: string | undefined;
}

export type LeaderboardMetric =
  "totalKm" | "roadsDiscovered" | "hazardsReported";

/**
 * Backend dimension keys for the multi-dimensional regional leaderboard
 * (`/leaderboards/regional`). Mirrors the API enum exactly so OpenAPI types
 * line up without translation.
 */
export type LeaderboardDimensionKey =
  "total_distance_km" | "roads_discovered" | "hazards_reported";

export const LEADERBOARD_DIMENSION_KEYS: readonly LeaderboardDimensionKey[] = [
  "total_distance_km",
  "roads_discovered",
  "hazards_reported",
];

export interface RegionalLeaderboardEntry {
  rank: number;
  userId: string;
  displayName: string;
  homeRegion: string | null;
  /** Score in the dimension's unit (km, count). */
  value: number;
  /** True when the entry belongs to the signed-in rider. */
  isMe: boolean;
}

export interface RegionalDimensionLeaderboard {
  dimension: LeaderboardDimensionKey;
  /** Catalog key derived from the semantic dimension, never raw API copy. */
  unit: EnglishMessageKey;
  entries: RegionalLeaderboardEntry[];
  /**
   * Signed-in rider's row even when outside the top N. Null when the rider
   * has no score in this dimension or is anonymous.
   */
  me: RegionalLeaderboardEntry | null;
}

export interface RegionalLeaderboards {
  /** The region filter the backend applied (`null` for global rankings). */
  region: string | null;
  generatedAt: string;
  total_distance_km: RegionalDimensionLeaderboard;
  roads_discovered: RegionalDimensionLeaderboard;
  hazards_reported: RegionalDimensionLeaderboard;
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
  name: EnglishMessageKey;
  tagline: EnglishMessageKey;
  description: EnglishMessageKey;
  descriptionCount?: number;
  season: "spring" | "summer" | "autumn" | "winter";
  startsAt: string;
  endsAt: string;
  current: number;
  target: number;
  unit: "km" | "roads" | "reports" | "rides" | "reviews" | "units";
}

/**
 * Per-challenge metadata kept alongside the UI `Challenge` shape. Lets the
 * dashboard render "Join challenge" / "Joined" CTAs and show participant
 * counts without changing the existing `Challenge` shape used by the demo
 * fixture and pure helpers.
 */
export interface ChallengeMeta {
  joined: boolean;
  participantCount: number;
}

export interface GamificationSnapshot {
  badges: Badge[];
  challenges: Challenge[];
  /** Backend metadata per challenge id (joined flag, participant count). */
  challengeMeta: Record<string, ChallengeMeta>;
  milestones: Milestone[];
  /** Optional seasonal banner — hidden when no long-running challenge fits. */
  seasonal: SeasonalChallenge | null;
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

export function formatMilestoneLabel(
  progress: MilestoneProgress,
  format: Formatters,
  t: Translate,
): string {
  const metric = progress.milestone.metric;
  if (metric === "totalKm") {
    // Distance milestones follow the rider's unit preference — current and
    // threshold derive from the same formatter so they share one unit
    // (byte-identical to the old output for metric riders).
    if (progress.nextThreshold === null) {
      return t("Maxed at {value}", {
        value: format.distanceKm(progress.current),
      });
    }
    const current = format.splitDistanceKm(progress.current);
    const target = format.splitDistanceKm(progress.nextThreshold);
    return formatSplitValueUnitRange(current, target, " / ");
  }
  const unit = t(MILESTONE_UNITS[metric]);
  if (progress.nextThreshold === null) {
    return t("Maxed at {value} {unit}", {
      value: format.integer(progress.current),
      unit,
    });
  }
  return t("{current} / {target} {unit}", {
    current: format.integer(progress.current),
    target: format.integer(progress.nextThreshold),
    unit,
  });
}

export function formatDaysRemaining(
  endsAt: string,
  now: Date,
  t: Translate,
): string {
  const end = new Date(endsAt).getTime();
  if (!Number.isFinite(end)) return t("Ongoing");
  const diffMs = end - now.getTime();
  if (diffMs <= 0) return t("Ended");
  const days = Math.floor(diffMs / (24 * 60 * 60 * 1000));
  if (days === 0) return t("Ends today");
  if (days === 1) return t("Ends tomorrow");
  if (days < 7) {
    return t("{count, plural, one {# day} other {# days}} left", {
      count: days,
    });
  }
  const weeks = Math.floor(days / 7);
  const extra = days % 7;
  if (weeks < 4) {
    return extra === 0
      ? t("{count, plural, one {# week} other {# weeks}} left", {
          count: weeks,
        })
      : t("{weeks}w {days}d left", { weeks, days: extra });
  }
  // Clamp to at least 1 so the 28-29 day band (weeks === 4, days / 30 === 0)
  // doesn't render "0 months left".
  const months = Math.max(1, Math.floor(days / 30));
  return t("{count, plural, one {# month} other {# months}} left", {
    count: months,
  });
}

const MILESTONE_UNITS: Record<LeaderboardMetric, EnglishMessageKey> = {
  totalKm: "km",
  roadsDiscovered: "roads",
  hazardsReported: "reports",
};

function clamp01(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return value > 1 ? 1 : value;
}

// ── Demo data ──

const DEFAULT_MILESTONES: Array<
  Omit<Milestone, "name" | "description"> & {
    name: EnglishMessageKey;
    description: EnglishMessageKey;
  }
> = [
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
      unit: "rides",
      endsAt: isoDaysFromNow(21, now),
    },
  ];

  const seasonal: SeasonalChallenge = {
    id: "alpine-spring-2026",
    name: "Alpine Spring",
    tagline: "Chase the thaw across Europe's reopening passes.",
    description:
      "Ride {distance} featuring at least {count, plural, one {# alpine pass} other {# alpine passes}} before the season closes in June.",
    descriptionCount: 10,
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
    challengeMeta: {},
    milestones: DEFAULT_MILESTONES,
    seasonal,
    stats,
  };
}

// ── Backend → UI mappers ──

type BadgeDto = components["schemas"]["BadgeDto"];
type ChallengeDto = components["schemas"]["ChallengeDto"];
type ChallengeDetailDto = components["schemas"]["ChallengeDetailDto"];

/**
 * Lucide icon name for a badge key. Backend keys are stable identifiers, so a
 * static map is the right shape — unknown keys fall back to "medal" so a new
 * server-side badge still renders without a UI deploy.
 */
const BADGE_ICON_BY_KEY: Record<string, string> = {
  total_distance: "trophy",
  single_ride: "mountain",
  ride_count: "flame",
  roads_discovered: "compass",
  reviews_written: "star",
  hazards_reported: "alert-triangle",
  rides_shared: "medal",
};

export function iconForBadgeKey(key: string): string {
  return BADGE_ICON_BY_KEY[key] ?? "medal";
}

const BADGE_COPY: Record<
  BadgeKey,
  { name: EnglishMessageKey; description: EnglishMessageKey }
> = {
  total_distance: {
    name: "Road Warrior",
    description: "Total distance ridden",
  },
  single_ride: {
    name: "Iron Butt",
    description: "Longest single ride distance",
  },
  ride_count: {
    name: "Regular Rider",
    description: "Total number of completed rides",
  },
  roads_discovered: {
    name: "Explorer",
    description: "Unique road segments ridden",
  },
  reviews_written: {
    name: "Road Critic",
    description: "Road reviews written",
  },
  hazards_reported: {
    name: "Safety Scout",
    description: "Hazards reported to the community",
  },
  rides_shared: {
    name: "Social Rider",
    description: "Rides shared with the community",
  },
};

export function badgeCopyForKey(
  key: string,
  t: Translate,
): { name: string; description: string } {
  if (!isBadgeKey(key)) {
    return {
      name: t("Unknown badge"),
      description: t("Badge details unavailable."),
    };
  }
  const copy = BADGE_COPY[key];
  return { name: t(copy.name), description: t(copy.description) };
}

export function badgeTierLabel(tier: string, t: Translate): string {
  // Badge tiers are canonical API enum tokens.
  // eslint-disable-next-line tarmoto-localization/no-locale-insensitive-search
  return translateKnownLabel(tier.toLowerCase(), BADGE_TIER_LABELS, t);
}

export function progressionTierLabel(tier: string, t: Translate): string {
  return translateKnownLabel(tier, PROGRESSION_TIER_LABELS, t);
}

export function challengeCopyForKey(
  challenge: { contentKey: string; metric: string; target: number },
  format: Formatters,
  t: Translate,
): { title: string; description: string } {
  const contentKey: ChallengeContentKey = isChallengeContentKey(
    challenge.contentKey,
  )
    ? challenge.contentKey
    : (challengeContentKeyForMetric(challenge.metric) ?? "generic");
  const distance = format.distanceKm(challenge.target);
  let title: string;
  switch (contentKey) {
    case "total_distance":
      title = t("Ride {distance}", { distance });
      break;
    case "single_ride":
      title = t("Complete a {distance} ride", { distance });
      break;
    case "ride_count":
      title = t(
        "{count, plural, one {Complete # ride} other {Complete # rides}}",
        { count: challenge.target },
      );
      break;
    case "roads_discovered":
      title = t(
        "{count, plural, one {Discover # road} other {Discover # roads}}",
        { count: challenge.target },
      );
      break;
    case "reviews_written":
      title = t(
        "{count, plural, one {Write # road review} other {Write # road reviews}}",
        { count: challenge.target },
      );
      break;
    case "hazards_reported":
      title = t(
        "{count, plural, one {Report # hazard} other {Report # hazards}}",
        { count: challenge.target },
      );
      break;
    case "rides_shared":
      title = t("{count, plural, one {Share # ride} other {Share # rides}}", {
        count: challenge.target,
      });
      break;
    default:
      title = t("Active challenge");
  }
  return {
    title,
    description: t("Reach this goal before the challenge ends."),
  };
}

const SEASONAL_REWARD_COPY: Record<
  Exclude<ChallengeRewardKey, BadgeKey>,
  EnglishMessageKey
> = {
  spring_explorer: "Spring Explorer",
};

export function challengeRewardCopyForKey(
  key: string | null,
  t: Translate,
): string | undefined {
  if (!key || !isChallengeRewardKey(key)) return undefined;
  return isBadgeKey(key)
    ? badgeCopyForKey(key, t).name
    : t(SEASONAL_REWARD_COPY[key]);
}

/**
 * Maps the backend `BadgeDto` to the companion's `Badge` UI shape. The badge
 * is treated as earned only when `earned_at` is set — `tier === null` is the
 * locked state regardless of whether progress has begun.
 */
export function mapBadgeDto(dto: BadgeDto, t: Translate): Badge {
  const copy = badgeCopyForKey(dto.key, t);
  return {
    id: dto.key,
    name: copy.name,
    description: copy.description,
    icon: iconForBadgeKey(dto.key),
    earnedAt: dto.earned_at ?? undefined,
  };
}

/** Mapping from backend metric key → UI challenge category. */
const CHALLENGE_CATEGORY_BY_METRIC: Record<string, ChallengeCategory> = {
  total_distance: "distance",
  single_ride: "distance",
  ride_count: "distance",
  roads_discovered: "discovery",
  reviews_written: "discovery",
  hazards_reported: "safety",
  rides_shared: "social",
};

export function categoryForChallengeMetric(metric: string): ChallengeCategory {
  const canonicalMetric = challengeContentKeyForMetric(metric) ?? metric;
  return CHALLENGE_CATEGORY_BY_METRIC[canonicalMetric] ?? "distance";
}

/** Mapping from backend metric key → unit label rendered next to progress. */
const UNIT_BY_METRIC: Record<string, EnglishMessageKey> = {
  total_distance: "km",
  single_ride: "km",
  ride_count: "rides",
  roads_discovered: "roads",
  reviews_written: "reviews",
  hazards_reported: "reports",
  rides_shared: "rides",
};

/**
 * Returns the SEMANTIC unit label ("km"/"rides"/"roads"/…) for a challenge
 * metric — NOT translated. `Challenge.unit` is consumed as a `=== "km"`
 * discriminant at the render site (achievements page) to decide whether to
 * apply distance conversion for imperial riders; translating it here would
 * break that check once a locale ships a non-English "km". Translation
 * happens at the display boundary via `t(challenge.unit)`.
 */
export function unitForChallengeMetric(metric: string): EnglishMessageKey {
  const canonicalMetric = challengeContentKeyForMetric(metric) ?? metric;
  return UNIT_BY_METRIC[canonicalMetric] ?? "units";
}

/**
 * Maps `ChallengeDto` (+ optional my-progress from `ChallengeDetailDto`) to
 * the companion's `Challenge` shape. `my_progress === null` means the rider
 * has not joined yet; we render that as 0 progress so the bar is visible
 * while the CTA stays "Join challenge".
 */
export function mapChallengeDto(
  dto: ChallengeDto,
  myProgress: number | null | undefined,
  format: Formatters,
  t: Translate,
): Challenge {
  const copy = challengeCopyForKey(
    {
      contentKey: dto.content_key,
      metric: dto.metric,
      target: dto.target,
    },
    format,
    t,
  );
  return {
    id: dto.id,
    name: copy.title,
    description: copy.description,
    category: categoryForChallengeMetric(dto.metric),
    current: typeof myProgress === "number" ? myProgress : 0,
    target: dto.target,
    unit: unitForChallengeMetric(dto.metric),
    endsAt: dto.ends_at,
    reward: challengeRewardCopyForKey(dto.reward_badge_key, t),
  };
}

/**
 * Derives a partial `RiderStats` from badge progress values. The badges
 * endpoint is the only API that exposes per-metric current values; rides /
 * hours / joined-at are not available there and fall back to zeros so the
 * milestone tracker still renders. Callers that have access to the
 * `/users/me/profile` summary should prefer `riderStatsFromMeProfile`,
 * which fills in the gaps.
 */
export function riderStatsFromBadges(
  badges: readonly BadgeDto[],
  joinedAt = new Date(0).toISOString(),
): RiderStats {
  const byKey = new Map(badges.map((b) => [b.key, b.progress.current]));
  return {
    totalKm: byKey.get("total_distance") ?? 0,
    totalRides: byKey.get("ride_count") ?? 0,
    totalHours: 0,
    roadsDiscovered: byKey.get("roads_discovered") ?? 0,
    hazardsReported: byKey.get("hazards_reported") ?? 0,
    joinedAt,
  };
}

/**
 * Builds `RiderStats` from the authenticated rider's `/users/me/profile`
 * summary (issue #334). This endpoint is the only source for `totalHours`
 * and `joinedAt`, which the badges endpoint does not expose; the other
 * fields agree with `BadgesService.computeStats` server-side so either
 * source is fine for them, but using one source keeps the values
 * consistent between renders.
 */
export function riderStatsFromMeProfile(me: MeProfileDto): RiderStats {
  return {
    totalKm: me.total_distance_km,
    totalRides: me.total_rides,
    totalHours: me.total_hours,
    roadsDiscovered: me.roads_discovered,
    hazardsReported: me.hazards_reported,
    joinedAt: me.joined_at,
  };
}

/**
 * Builds a full `GamificationSnapshot` from the data the backend exposes.
 * Real fetches go through `gamification-fetch.ts`; this is the pure
 * transform so it can be tested without touching network.
 *
 * `meProfile` is optional so the demo / fixture path still works without a
 * signed-in user. When present (the live dashboard always passes it),
 * `total_hours` and `joined_at` come from the dedicated summary endpoint —
 * the badges endpoint does not surface those fields.
 *
 * The regional leaderboard is fetched separately (region selection is
 * interactive) and is therefore not part of the snapshot — see
 * `fetchRegionalLeaderboards` and `mapRegionalLeaderboards`.
 */
export function buildLiveSnapshot(
  input: {
    badges: readonly BadgeDto[];
    challengeDetails: readonly ChallengeDetailDto[];
    meProfile?: MeProfileDto | null;
  },
  format: Formatters,
  t: Translate,
): GamificationSnapshot {
  const badges = input.badges.map((badge) => mapBadgeDto(badge, t));
  const challenges = input.challengeDetails.map((d) =>
    mapChallengeDto(d, d.my_progress, format, t),
  );
  const challengeMeta: Record<string, ChallengeMeta> = {};
  for (const d of input.challengeDetails) {
    challengeMeta[d.id] = {
      joined: d.my_progress !== null && d.my_progress !== undefined,
      participantCount: d.participant_count,
    };
  }
  return {
    badges,
    challenges,
    challengeMeta,
    // DEFAULT_MILESTONES stays canonical English data (also shared by the
    // buildDemoSnapshot test fixture); this is the one live render path, so
    // it's the read site that translates name/description for display.
    milestones: DEFAULT_MILESTONES.map((m) => ({
      ...m,
      name: t(m.name),
      description: t(m.description),
    })),
    seasonal: null,
    stats: input.meProfile
      ? riderStatsFromMeProfile(input.meProfile)
      : riderStatsFromBadges(input.badges),
  };
}

// ── Regional leaderboards ──

type RegionalLeaderboardsResponseDto =
  components["schemas"]["RegionalLeaderboardsResponseDto"];
type RegionalDimensionLeaderboardDto =
  components["schemas"]["DimensionLeaderboardDto"];
type RegionalLeaderboardEntryDto =
  components["schemas"]["RegionalLeaderboardEntryDto"];

const DIMENSION_LABELS: Record<LeaderboardDimensionKey, EnglishMessageKey> = {
  total_distance_km: "Distance",
  roads_discovered: "Roads discovered",
  hazards_reported: "Hazards reported",
};

const DIMENSION_UNITS: Record<LeaderboardDimensionKey, EnglishMessageKey> = {
  total_distance_km: "km",
  roads_discovered: "roads",
  hazards_reported: "reports",
};

export function labelForDimension(
  dim: LeaderboardDimensionKey,
  t: Translate,
): string {
  return t(DIMENSION_LABELS[dim]);
}

export function unitForLeaderboardDimension(
  dimension: string,
): EnglishMessageKey {
  return DIMENSION_UNITS[dimension as LeaderboardDimensionKey] ?? "units";
}

export function mapRegionalLeaderboardEntry(
  dto: RegionalLeaderboardEntryDto,
  currentUserId: string | null,
): RegionalLeaderboardEntry {
  return {
    rank: dto.rank,
    userId: dto.user_id,
    displayName: dto.display_name,
    homeRegion: dto.home_region,
    value: dto.value,
    isMe: currentUserId !== null && dto.user_id === currentUserId,
  };
}

export function mapDimensionLeaderboard(
  dto: RegionalDimensionLeaderboardDto,
  currentUserId: string | null,
): RegionalDimensionLeaderboard {
  const dimension = dto.dimension as LeaderboardDimensionKey;
  return {
    dimension,
    unit: unitForLeaderboardDimension(dimension),
    entries: dto.entries.map((e) =>
      mapRegionalLeaderboardEntry(e, currentUserId),
    ),
    me: dto.me ? mapRegionalLeaderboardEntry(dto.me, currentUserId) : null,
  };
}

export function mapRegionalLeaderboards(
  dto: RegionalLeaderboardsResponseDto,
  currentUserId: string | null,
): RegionalLeaderboards {
  return {
    region: dto.region,
    generatedAt: dto.generated_at,
    total_distance_km: mapDimensionLeaderboard(
      dto.total_distance_km,
      currentUserId,
    ),
    roads_discovered: mapDimensionLeaderboard(
      dto.roads_discovered,
      currentUserId,
    ),
    hazards_reported: mapDimensionLeaderboard(
      dto.hazards_reported,
      currentUserId,
    ),
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
