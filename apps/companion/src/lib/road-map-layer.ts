/**
 * Pure helpers for the personal road-map MapLibre overlay (US-50).
 *
 * Two responsibilities:
 *   - Period-filter the ridden-segments list driven by the page's filter
 *     pills, so the highlight layer reflects "all" / "this year" / etc.
 *     without a backend round-trip.
 *   - Build & validate the JSONB snapshot shipped to `/map-shares` so the
 *     read-only public viewer can render the same layer offline.
 *
 * Kept side-effect-free so the page's state derivations (and the share
 * snapshot) stay deterministic and easy to test under vitest.
 */

import type { components } from "@tarmoto/openapi-client";
import type { ExplorationStats } from "@/lib/api";
import { periodStartDate, type TimePeriod } from "@/lib/exploration";

/** One row from `GET /exploration/ridden-segments`. */
export type RiddenSegment = components["schemas"]["RiddenSegmentDto"];

/** A ridden segment with the quality reading removed — see
 *  {@link stripSegmentQuality}. */
export type SanitizedRiddenSegment = Pick<
  RiddenSegment,
  "id" | "last_ridden_at" | "ride_count"
>;

/**
 * Rebuild each segment with only the fields the shared map renders, for when
 * the operator has killed `road_quality_overlay`.
 *
 * An ALLOWLIST rather than `Omit<RiddenSegment, "last_quality_score">`, for
 * the reason #1200 found on best-roads: a blocklist ships whatever the DTO
 * gains next, and says nothing about fields derived from the one removed. Only
 * `RoadSegmentPopover` reads the score; `PersonalRoadMap` draws from the other
 * three, so nothing else is lost.
 *
 * Deletes the key rather than nulling it — these segments cross into
 * `SharedMap`, a `"use client"` component, and Next serializes
 * client-component props into the RSC Flight payload embedded in the HTML, so
 * `last_quality_score: null` would leave the field readable in `view-source:`.
 * Run this AFTER `parseMapShareSnapshot`, whose `isRiddenSegment` guard
 * requires the key to be present.
 */
/**
 * A ridden segment that MAY carry its quality reading — the shape every
 * consumer should accept, because a killed `road_quality_overlay` strips the
 * score server-side. `RiddenSegment` (which always has it) is assignable here,
 * so nothing that already holds a full segment has to change.
 */
export type MaybeQualityRiddenSegment = SanitizedRiddenSegment & {
  last_quality_score?: number | null;
};

export function stripSegmentQuality(
  segments: readonly RiddenSegment[],
): SanitizedRiddenSegment[] {
  return segments.map((s) => ({
    id: s.id,
    last_ridden_at: s.last_ridden_at,
    ride_count: s.ride_count,
  }));
}

/**
 * Keep only segments whose most-recent ride falls inside the active period.
 * "all" returns the input unchanged. Segments with an unparseable
 * `last_ridden_at` are dropped (mirrors `computePeriodStats` behaviour).
 */
export function filterRiddenByPeriod(
  segments: readonly RiddenSegment[],
  period: TimePeriod,
  now: Date = new Date(),
): RiddenSegment[] {
  const lower = periodStartDate(period, now);
  if (lower === null) return [...segments];
  return segments.filter((seg) => {
    const ts = Date.parse(seg.last_ridden_at);
    if (Number.isNaN(ts)) return false;
    return ts >= lower.getTime();
  });
}

/** Lookup helper used by the hover popup. O(1) with a `Map`. */
export function indexRiddenSegments(
  segments: readonly RiddenSegment[],
): Map<string, RiddenSegment> {
  return new Map(segments.map((s) => [s.id, s]));
}

// ── Share snapshot ──

/**
 * The JSONB blob we POST to `/map-shares`. The public viewer reads this
 * shape verbatim — bumping it requires a coordinated viewer change. The
 * backend stores the snapshot but does not validate its shape.
 */
export interface MapShareSnapshot {
  /** Tagged so future viewer revisions can detect older payloads. */
  version: 1;
  /** ISO-8601 timestamp when the share was generated. */
  generated_at: string;
  /** Period chip active at share time — purely informational. */
  period: TimePeriod;
  /** Owner's exploration totals (snapshot, not live). */
  stats: ExplorationStats;
  /** Filtered ridden segments — drives the highlight layer in the viewer. */
  segments: RiddenSegment[];
  /** Where to centre the map when the public viewer opens. */
  initial_center?: { lat: number; lng: number; zoom: number };
}

export function buildMapShareSnapshot(input: {
  stats: ExplorationStats;
  period: TimePeriod;
  segments: readonly RiddenSegment[];
  initialCenter?: { lat: number; lng: number; zoom: number };
  now?: Date;
}): MapShareSnapshot {
  return {
    version: 1,
    generated_at: (input.now ?? new Date()).toISOString(),
    period: input.period,
    stats: input.stats,
    segments: [...input.segments],
    ...(input.initialCenter ? { initial_center: input.initialCenter } : {}),
  };
}

const VALID_PERIODS: ReadonlySet<TimePeriod> = new Set([
  "all",
  "year",
  "90d",
  "30d",
]);

/**
 * Narrow an opaque snapshot blob from `/map-shares/:token` into our
 * `MapShareSnapshot` shape. Returns null on malformed payloads so the
 * public viewer can degrade to "snapshot unreadable" rather than throw
 * during SSR.
 *
 * Defensive on-purpose: an older companion build may have shipped a
 * v0-shaped snapshot, and viewer SSR mustn't crash on it.
 */
export function parseMapShareSnapshot(value: unknown): MapShareSnapshot | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (v.version !== 1) return null;
  if (typeof v.generated_at !== "string") return null;
  if (
    typeof v.period !== "string" ||
    !VALID_PERIODS.has(v.period as TimePeriod)
  ) {
    return null;
  }
  if (!isExplorationStats(v.stats)) return null;
  if (!Array.isArray(v.segments) || !v.segments.every(isRiddenSegment)) {
    return null;
  }
  const initialCenter = v.initial_center;
  if (initialCenter !== undefined && !isInitialCenter(initialCenter)) {
    return null;
  }
  return {
    version: 1,
    generated_at: v.generated_at,
    period: v.period as TimePeriod,
    stats: v.stats as ExplorationStats,
    segments: v.segments as RiddenSegment[],
    ...(initialCenter
      ? {
          initial_center: initialCenter as {
            lat: number;
            lng: number;
            zoom: number;
          },
        }
      : {}),
  };
}

function isExplorationStats(v: unknown): v is ExplorationStats {
  if (typeof v !== "object" || v === null) return false;
  const s = v as Record<string, unknown>;
  return (
    typeof s.ridden_segments === "number" &&
    typeof s.total_segments === "number" &&
    typeof s.percent_explored === "number" &&
    typeof s.total_distance_km === "number"
  );
}

function isRiddenSegment(v: unknown): v is RiddenSegment {
  if (typeof v !== "object" || v === null) return false;
  const s = v as Record<string, unknown>;
  return (
    typeof s.id === "string" &&
    typeof s.last_ridden_at === "string" &&
    (s.last_quality_score === null ||
      typeof s.last_quality_score === "number") &&
    typeof s.ride_count === "number"
  );
}

function isInitialCenter(
  v: unknown,
): v is { lat: number; lng: number; zoom: number } {
  if (typeof v !== "object" || v === null) return false;
  const c = v as Record<string, unknown>;
  return (
    typeof c.lat === "number" &&
    typeof c.lng === "number" &&
    typeof c.zoom === "number"
  );
}

// ── MapLibre layer specs ──
//
// Both layers paint the shared `tarmoto-roads` source's `quality`
// source-layer. We promote the segment `id` property to the feature id
// (see `MapCanvas`), so the ridden layer can use `feature-state.ridden`
// for O(1) membership at paint time — scales to 10k+ segments without
// rebuilding a `["match", id, [literal-array], …]` filter.

export const ROAD_MAP_DIM_LAYER_ID = "road-map-dim";
export const ROAD_MAP_RIDDEN_LAYER_ID = "road-map-ridden";

/**
 * Canonical brand accent — must stay in sync with `text-accent` /
 * `bg-accent` (--color-accent in globals.css). Keeping the constant
 * local means the legend swatch and the MapLibre line paint render
 * identically.
 */
export const RIDDEN_LINE_COLOR = "#FF6A1A";

/** Muted slate for unridden roads — desaturated against the basemap. */
export const DIM_LINE_COLOR = "#475569";

// Plain (mutable) tuples so consumers can pass them straight to MapLibre's
// `setPaintProperty` / `addLayer`, both of which expect a mutable
// `ExpressionSpecification`. Marking these `as const` would surface the
// readonly-vs-mutable mismatch at the assignment site.
export const ROAD_MAP_LAYER_LINE_WIDTH: unknown[] = [
  "interpolate",
  ["linear"],
  ["zoom"],
  8,
  1.5,
  12,
  2.5,
  16,
  4.5,
];

export const ROAD_MAP_RIDDEN_LINE_WIDTH: unknown[] = [
  "interpolate",
  ["linear"],
  ["zoom"],
  8,
  2,
  12,
  3.5,
  16,
  6,
];
