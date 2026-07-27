/**
 * Pure helpers backing the personal road-map page (US-50).
 *
 * The server exposes three things we use here:
 *   - global exploration totals (/exploration/stats)
 *   - the full set of ridden road-segment ids (/exploration/ridden-ids)
 *   - unridden road segments near a coordinate (/exploration/nearby-unridden)
 *
 * None of those are time-bucketed, so any "this year" / "90 days" view is
 * derived from the flat rides list we already pull from /api/v1/rides — this
 * module keeps that derivation centralised so the page re-renders cheaply when
 * the user flips a period chip.
 */

import {
  localDateKey,
  parseStartedAt,
  toNumber,
  type RideForStats,
} from "./ride-stats";
import type { UnriddenSegment } from "./api";
import type { Translate } from "@/i18n";
import {
  DEFAULT_LOCALE,
  formatDisplayUpperCase,
  normalizeForLocaleSearch,
} from "@tarmoto/shared";
import { timeWindowLabel } from "./time-window-label";

export const TIME_PERIODS = ["all", "year", "90d", "30d"] as const;
export type TimePeriod = (typeof TIME_PERIODS)[number];

export function timePeriodLabel(period: TimePeriod, t: Translate): string {
  return timeWindowLabel(period, t);
}

export interface PeriodStats {
  period: TimePeriod;
  distanceKm: number;
  rideCount: number;
  activeDays: number;
}

export interface RegionBucket {
  /** Stable key derived from the road-name prefix. "Unnamed" groups unnamed roads. */
  key: string;
  /** Human-readable label matching `key` with title-case for display. */
  label: string;
  segments: UnriddenSegment[];
  totalLengthKm: number;
}

/**
 * Inclusive lower bound for a time period relative to `now`. Returns `null` for
 * `"all"` which means "no lower bound". `"year"` is the start of the current
 * calendar year (not a rolling 365-day window) so the label "This year" matches
 * what the stats dashboard already shows.
 */
export function periodStartDate(
  period: TimePeriod,
  now: Date = new Date(),
): Date | null {
  switch (period) {
    case "all":
      return null;
    case "year":
      return new Date(now.getFullYear(), 0, 1);
    case "90d": {
      const d = new Date(now);
      d.setDate(d.getDate() - 90);
      return d;
    }
    case "30d": {
      const d = new Date(now);
      d.setDate(d.getDate() - 30);
      return d;
    }
  }
}

export function computePeriodStats(
  rides: readonly RideForStats[],
  period: TimePeriod,
  now: Date = new Date(),
): PeriodStats {
  // Single pass: parse the timestamp once, apply the period window, and fold
  // into the running totals. Combining the filter + reduce avoids both a
  // second parse inside the active-days loop and a separate exported
  // `filterRidesByPeriod` that would risk drifting out of sync with this one.
  const lowerBound = periodStartDate(period, now);
  const activeDayKeys = new Set<string>();
  let distanceKm = 0;
  let rideCount = 0;
  for (const ride of rides) {
    const date = parseStartedAt(ride.started_at);
    if (date === null || date > now) continue;
    if (lowerBound !== null && date < lowerBound) continue;
    distanceKm += toNumber(ride.distance_km);
    activeDayKeys.add(localDateKey(date));
    rideCount += 1;
  }
  return {
    period,
    distanceKm,
    rideCount,
    activeDays: activeDayKeys.size,
  };
}

/**
 * Bucket unridden segments by a coarse "region" key derived from the road name.
 * The backend has no region table so we lean on the road-name prefix: the first
 * word typically matches an administrative hint ("E65", "M1") or a locality
 * ("Beskydy", "Jizerské"). Unnamed segments fall into an "Unnamed" bucket so
 * they stay visible. Buckets are returned sorted by total length descending
 * so the heaviest regions surface first in the UI.
 */
export function groupUnriddenByRegion(
  segments: readonly UnriddenSegment[],
  locale: string = DEFAULT_LOCALE,
): RegionBucket[] {
  const buckets = new Map<string, RegionBucket>();
  for (const seg of segments) {
    const label = regionLabelFor(seg.road_name, locale);
    const key = normalizeForLocaleSearch(label, locale);
    const bucket = buckets.get(key) ?? {
      key,
      label,
      segments: [],
      totalLengthKm: 0,
    };
    bucket.segments.push(seg);
    bucket.totalLengthKm += toNumber(seg.length_m) / 1000;
    buckets.set(key, bucket);
  }
  // Sort by total length descending, then by label alphabetically so equal
  // buckets stay in a stable, predictable order across renders and tests.
  return [...buckets.values()].sort((a, b) => {
    const byLength = b.totalLengthKm - a.totalLengthKm;
    return byLength !== 0 ? byLength : a.label.localeCompare(b.label);
  });
}

function regionLabelFor(
  roadName: string | null | undefined,
  locale: string,
): string {
  if (!roadName) return "Unnamed";
  const trimmed = roadName.trim();
  if (!trimmed) return "Unnamed";
  const first = trimmed.split(/\s+/)[0] ?? trimmed;
  // Upper-case the first character so buckets render with consistent casing
  // regardless of whichever variant the backend returned first ("Beskydy"
  // and "beskydy" both surface as "Beskydy").
  return formatDisplayUpperCase(first.charAt(0), locale) + first.slice(1);
}
