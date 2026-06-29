/**
 * Pure helpers for the Achievements / Badges / Challenges / Personal road
 * map screens. Kept separate from the screen components so they're
 * unit-testable without pulling in MapLibre or React Navigation.
 */

import type {
  UserBadge,
  BadgeTier,
  Challenge,
  ExplorationStats,
  RiddenSegment,
  UnriddenSegment,
} from "@/types";
import { UNSCORED_COLOR } from "@/theme/brand";

// ── Badge tier helpers ──

export const TIER_ORDER: readonly BadgeTier[] = [
  "bronze",
  "silver",
  "gold",
] as const;

/** Tier rank used to compare progression — higher is better, 0 = unearned. */
export function tierRank(tier: string | null): number {
  if (!tier) return 0;
  const idx = TIER_ORDER.indexOf(tier as BadgeTier);
  return idx === -1 ? 0 : idx + 1;
}

export const TIER_COLORS: Record<BadgeTier, string> = {
  bronze: "#CD7F32",
  silver: "#C0C0C0",
  gold: "#FFD700",
};

/**
 * Pick the colour for a badge's current tier. Locked badges (tier === null)
 * read as the neutral unscored grey so the locked state looks dim against
 * the row background.
 */
export function tierColor(tier: string | null): string {
  if (!tier) return UNSCORED_COLOR;
  const known = TIER_COLORS[tier as BadgeTier];
  return known ?? UNSCORED_COLOR;
}

/**
 * The next milestone the rider is working toward, given their current tier.
 * Returns `null` once gold has already been earned — there's nothing left
 * to chase, so the UI shows "Maxed" instead of a progress bar.
 */
export interface NextMilestone {
  tier: BadgeTier;
  target: number;
}

export function nextMilestone(badge: UserBadge): NextMilestone | null {
  const rank = tierRank(badge.tier);
  if (rank >= TIER_ORDER.length) return null;
  const nextTier = TIER_ORDER[rank];
  return { tier: nextTier, target: badge.progress[nextTier] };
}

/**
 * Progress (0..1) toward the next tier. The denominator is the threshold
 * for the next tier minus the threshold for the *previous* one — that way
 * a rider just past silver shows ~0% toward gold rather than ~50% (which
 * would happen if we naïvely divided by the gold threshold).
 */
export function progressToNext(badge: UserBadge): number {
  const next = nextMilestone(badge);
  if (!next) return 1;
  const rank = tierRank(badge.tier);
  // Threshold for the most-recently-earned tier (or 0 for unearned).
  const floor = rank === 0 ? 0 : badge.progress[TIER_ORDER[rank - 1]];
  const span = next.target - floor;
  if (span <= 0) return 1;
  const progressed = badge.progress.current - floor;
  if (progressed <= 0) return 0;
  return Math.min(1, progressed / span);
}

// ── Challenge helpers ──

/**
 * Days remaining until the challenge ends, anchored on `now`. A challenge
 * ending later on the same UTC calendar day reads as "0" so the UI can
 * label it "Ends today" rather than "1 day left". Past dates and invalid
 * timestamps clamp to 0.
 */
export function daysRemaining(endsAt: string, now: Date = new Date()): number {
  const end = new Date(endsAt);
  if (!Number.isFinite(end.getTime())) return 0;
  if (end.getTime() <= now.getTime()) return 0;
  if (
    end.getUTCFullYear() === now.getUTCFullYear() &&
    end.getUTCMonth() === now.getUTCMonth() &&
    end.getUTCDate() === now.getUTCDate()
  ) {
    return 0;
  }
  const diff = end.getTime() - now.getTime();
  return Math.max(0, Math.ceil(diff / (1000 * 60 * 60 * 24)));
}

/** Human label for the time remaining on a challenge card. */
export function formatTimeRemaining(
  endsAt: string,
  now: Date = new Date(),
): string {
  const days = daysRemaining(endsAt, now);
  if (days === 0) return "Ends today";
  if (days === 1) return "1 day left";
  return `${days} days left`;
}

/**
 * Percent (0..100, integer) progress for a challenge. The backend already
 * computes `percent` on the detail endpoint — this helper covers the list
 * endpoint where only `target` and the rider's progress are available.
 */
export function challengePercent(progress: number, target: number): number {
  if (target <= 0) return 0;
  if (progress <= 0) return 0;
  return Math.min(100, Math.round((progress / target) * 100));
}

/**
 * Human-friendly metric label, e.g. `total_km` → `km`. Used in challenge
 * cards next to the rider's progress number. Falls back to the raw metric
 * if we don't have a translation for it (forward-compatibility with
 * future challenge metrics added on the backend).
 */
const METRIC_UNITS: Record<string, string> = {
  total_km: "km",
  ride_count: "rides",
  unique_segments: "roads",
  reviews_written: "reviews",
  hazards_reported: "reports",
};

export function metricUnit(metric: string): string {
  return METRIC_UNITS[metric] ?? metric;
}

/**
 * Sort challenges so the ones the rider is most likely to act on appear
 * first: ending soonest at the top, then most-participants. Backend
 * already returns them ordered by `ends_at ASC` but we re-sort in the
 * UI to harden against future backend changes and to make the order
 * unit-testable.
 */
export function rankChallenges(challenges: Challenge[]): Challenge[] {
  return [...challenges].sort((a, b) => {
    const aEnd = new Date(a.ends_at).getTime();
    const bEnd = new Date(b.ends_at).getTime();
    if (aEnd !== bEnd) return aEnd - bEnd;
    return b.participant_count - a.participant_count;
  });
}

// ── Personal road map helpers ──

/**
 * Group a flat list of ridden segments by a coarse time bucket so the
 * UI can offer "this month / this year / all time" filters. The cutoff
 * is computed in milliseconds (30 days for month, 365 for year) rather
 * than via `Date.setMonth()` / `Date.setFullYear()` — those silently
 * overflow when the current day doesn't exist in the target month
 * (e.g. May 31 → setMonth(3) lands on May 1, dropping ~3 days; Feb 29
 * on a leap year via setFullYear lands on Mar 1). A fixed-window
 * subtraction is calendar-agnostic and stable across DST and leap
 * years.
 */
export type RidePeriod = "month" | "year" | "all";

const MS_PER_DAY = 1000 * 60 * 60 * 24;

export function filterByPeriod(
  segments: RiddenSegment[],
  period: RidePeriod,
  now: Date = new Date(),
): RiddenSegment[] {
  if (period === "all") return segments;
  const windowDays = period === "month" ? 30 : 365;
  const cutoffMs = now.getTime() - windowDays * MS_PER_DAY;
  return segments.filter((s) => {
    const t = new Date(s.last_ridden_at).getTime();
    return Number.isFinite(t) && t >= cutoffMs;
  });
}

export interface ExplorationSummary {
  riddenCount: number;
  totalCount: number;
  /** Percent ridden formatted like `12.4%` for display. */
  percentLabel: string;
  /** Total ridden distance in kilometres, rounded to 1 decimal. */
  distanceKmLabel: string;
}

export function summarizeExploration(
  stats: ExplorationStats,
): ExplorationSummary {
  return {
    riddenCount: stats.ridden_segments,
    totalCount: stats.total_segments,
    percentLabel: `${stats.percent_explored.toFixed(1)}%`,
    distanceKmLabel: `${stats.total_distance_km.toFixed(1)} km`,
  };
}

/**
 * Rank nearby unridden segments so the highest-quality ones appear first,
 * then by proximity. Segments without a quality score sink to the bottom —
 * the rider has no signal that they're worth seeking out yet.
 */
export function rankUnriddenSegments(
  segments: UnriddenSegment[],
): UnriddenSegment[] {
  return [...segments].sort((a, b) => {
    const aQ = a.quality_score ?? -1;
    const bQ = b.quality_score ?? -1;
    if (aQ !== bQ) return bQ - aQ;
    return a.distance_m - b.distance_m;
  });
}

/** Format the distance shown next to a nearby unridden segment. */
export function formatDistanceFromHere(distanceM: number): string {
  if (!Number.isFinite(distanceM) || distanceM < 0) return "—";
  if (distanceM < 1000) return `${Math.round(distanceM)} m`;
  return `${(distanceM / 1000).toFixed(1)} km`;
}

export function formatSegmentLength(lengthM: number): string {
  if (!Number.isFinite(lengthM) || lengthM <= 0) return "—";
  if (lengthM < 1000) return `${Math.round(lengthM)} m`;
  return `${(lengthM / 1000).toFixed(1)} km`;
}

/**
 * Format the rider's challenge progress as `current / target unit`.
 * Whole-number metrics (rides, reports, …) drop the decimal; floats keep
 * one decimal so a 12.4 km mark doesn't display as 12 km. The unit comes
 * from the challenge's `metric` field (e.g. `total_km`), not its ID, and
 * is resolved through `metricUnit()` so an unknown metric falls back to
 * the raw key — same behaviour as the meta-pill rendered next to it on
 * the same card.
 */
export function formatChallengeProgress(
  progress: number,
  target: number,
  metric: string,
): string {
  const isWhole = Number.isInteger(progress) && Number.isInteger(target);
  const unit = metricUnit(metric);
  const fmt = (n: number): string => (isWhole ? String(n) : n.toFixed(1));
  return `${fmt(progress)} / ${fmt(target)} ${unit}`;
}
