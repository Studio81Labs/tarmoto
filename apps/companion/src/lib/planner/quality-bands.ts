import type * as GeoJSON from "geojson";
import { dedupeAdjacentPoints, type LngLat } from "./polyline";
import type { QualityBand, RouteSegment } from "./types";

/**
 * Route-quality band vocabulary for the Plan & inspect planner, per the
 * Web App v2 (Full) design frames — harmonized with the cream palette.
 * Single source of truth: the map line, quality strip, flagged cards, and
 * preview card all read from here.
 */
export const QUALITY_BAND_COLORS: Record<QualityBand, string> = {
  good: "#5FB97E",
  fair: "#E8A93C",
  rough: "#E05A3C",
  no_data: "#A89D8B",
};

export const QUALITY_BAND_LABELS: Record<QualityBand, string> = {
  good: "Good or better",
  fair: "Fair",
  rough: "Rough",
  no_data: "No data",
};

/** Short variants used where space is tight (map legend, preview header). */
export const QUALITY_BAND_LABELS_SHORT: Record<QualityBand, string> = {
  good: "Good+",
  fair: "Fair",
  rough: "Rough",
  no_data: "No data",
};

export const GOOD_BAND_MIN_SCORE = 3.5;
export const FAIR_BAND_MIN_SCORE = 2.5;

/**
 * A score backed by this many rider passes or fewer is presented as
 * provisional: dimmed numeric plus a "LOW CONFIDENCE · N PASSES" note.
 */
export const LOW_CONFIDENCE_MAX_PASSES = 3;

export function scoreToBand(score: number | null): QualityBand {
  if (score == null) return "no_data";
  if (score >= GOOD_BAND_MIN_SCORE) return "good";
  if (score >= FAIR_BAND_MIN_SCORE) return "fair";
  return "rough";
}

export function isLowConfidence(passes: number): boolean {
  return passes <= LOW_CONFIDENCE_MAX_PASSES;
}

/**
 * Coalesce adjacent same-band segments into runs — one {@link RouteSegment} per
 * run, carrying the run's COMBINED geometry, summed length, and id
 * `run:<firstSegmentId>`. The map draws the fine per-segment line, but the
 * Inspect strip and flagged list (and their inspect/reroute actions, resolved
 * through `findPlannerQualitySegment`) operate on runs — so a long covered route
 * renders a handful of nodes instead of thousands, and a "Rough · 40 km" card
 * previews/reroutes the WHOLE run, not just its first ~100 m span. The `run:`
 * prefix keeps run ids distinct from the fine segment ids the map clicks use.
 */
export function coalesceQualityRuns(
  segments: readonly RouteSegment[],
): RouteSegment[] {
  const runs: RouteSegment[] = [];
  let current: RouteSegment[] = [];
  const flush = () => {
    const first = current[0];
    if (!first) return;
    const coordinates: LngLat[] = [];
    for (const segment of current) {
      for (const coordinate of segment.geometry.coordinates) {
        coordinates.push(coordinate as LngLat);
      }
    }
    const geometry: GeoJSON.LineString = {
      type: "LineString",
      coordinates: dedupeAdjacentPoints(coordinates),
    };
    runs.push({
      ...first,
      id: `run:${first.id}`,
      geometry,
      lengthKm: current.reduce((sum, segment) => sum + segment.lengthKm, 0),
    });
    current = [];
  };
  for (const segment of segments) {
    const last = current[current.length - 1];
    if (last && last.band !== segment.band) flush();
    current.push(segment);
  }
  flush();
  return runs;
}
