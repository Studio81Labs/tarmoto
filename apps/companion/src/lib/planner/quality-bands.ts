import { dedupeAdjacentPoints, type LngLat } from "./polyline";
import type { QualityBand, QualitySpan, RouteSegment } from "./types";
import type { EnglishMessageKey } from "@/i18n";

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

export const QUALITY_BAND_LABELS: Record<QualityBand, EnglishMessageKey> = {
  good: "Good or better",
  fair: "Fair",
  rough: "Rough",
  no_data: "No data",
};

/** Short variants used where space is tight (map legend, preview header). */
export const QUALITY_BAND_LABELS_SHORT: Record<QualityBand, EnglishMessageKey> =
  {
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

/** A run of contiguous same-band segments, for list/strip presentation. */
export interface QualityRun {
  /** `run:<firstSegmentId>:<lastSegmentId>` — the exact segment range it spans. */
  id: string;
  band: QualityBand;
  surface: RouteSegment["surface"];
  lengthKm: number;
}

/**
 * Coalesce adjacent same-band segments into runs. The map draws the fine
 * per-segment line, but the Inspect strip and flagged list render one node per
 * run — so a long covered route shows a handful of nodes, not thousands.
 *
 * The id encodes the run's EXPLICIT segment range (`run:<first>:<last>`) so it
 * resolves the same whether coalesced over the whole day or a plan-scoped
 * subset (`findRunSegment`): inspect/reroute target exactly the run — not the
 * first span, and not beyond the selected plan. Runs never cross a day
 * boundary (even in the concatenated whole-route view), so a run's single
 * `dayNumber` is a safe reroute target.
 */
export function coalesceQualityRuns(
  segments: readonly RouteSegment[],
): QualityRun[] {
  const runs: {
    firstId: string;
    lastId: string;
    band: QualityBand;
    surface: RouteSegment["surface"];
    lengthKm: number;
    dayNumber: number;
  }[] = [];
  for (const segment of segments) {
    const last = runs[runs.length - 1];
    // Never coalesce across a day boundary: the whole-route inspect view feeds
    // every day's segments through here at once, and a run's target day for
    // reroute is taken from its first segment — a cross-day run would reroute
    // the wrong day. Keeping runs within a day also keeps their ids resolvable
    // per day. Same-day callers (plan/day-scoped) are unaffected.
    if (
      last &&
      last.band === segment.band &&
      last.dayNumber === segment.dayNumber
    ) {
      last.lastId = segment.id;
      last.lengthKm += segment.lengthKm;
    } else {
      runs.push({
        firstId: segment.id,
        lastId: segment.id,
        band: segment.band,
        surface: segment.surface,
        lengthKm: segment.lengthKm,
        dayNumber: segment.dayNumber,
      });
    }
  }
  return runs.map((run) => ({
    id: `run:${run.firstId}:${run.lastId}`,
    band: run.band,
    surface: run.surface,
    lengthKm: run.lengthKm,
  }));
}

// Cap the preview "quality across section" strip so a long run (which can hold
// one span per matched road-quality segment — hundreds on a long route) doesn't
// render thousands of DOM bars or overflow the ~380px popover.
const MAX_STRIP_SPANS = 48;

/**
 * Downsample quality spans into at most `maxSpans` equal-distance buckets
 * (length-weighted score) so the strip stays bounded while still mapping the
 * 0→run-length axis. Returned unchanged when already within the cap (#863).
 */
export function resampleQualitySpans(
  spans: QualitySpan[],
  maxSpans: number,
): QualitySpan[] {
  if (spans.length <= maxSpans) return spans;
  const total = spans.reduce((sum, s) => sum + s.lengthKm, 0);
  if (total <= 0) return spans.slice(0, maxSpans);
  const bucketKm = total / maxSpans;
  const out: QualitySpan[] = [];
  let idx = 0;
  let remaining = spans[0]!.lengthKm;
  let score = spans[0]!.score;
  for (let bucket = 0; bucket < maxSpans && idx < spans.length; bucket += 1) {
    let need = bucketKm;
    let scoreLen = 0;
    let len = 0;
    while (need > 1e-9 && idx < spans.length) {
      const take = Math.min(need, remaining);
      scoreLen += score * take;
      len += take;
      remaining -= take;
      need -= take;
      if (remaining <= 1e-9) {
        idx += 1;
        if (idx < spans.length) {
          remaining = spans[idx]!.lengthKm;
          score = spans[idx]!.score;
        }
      }
    }
    if (len > 0) out.push({ score: scoreLen / len, lengthKm: len });
  }
  return out;
}

/**
 * Reconstruct a coalesced run's {@link RouteSegment} (combined geometry, summed
 * length) from `segments` given its `run:<first>:<last>` id. Slices exactly the
 * `[first..last]` range, so an inspect/reroute action covers precisely the run
 * — even when the id was minted from a plan-scoped subset. Null when the id
 * isn't a run id or its range isn't present/ordered in `segments`.
 */
export function findRunSegment(
  segments: readonly RouteSegment[],
  runId: string,
): RouteSegment | null {
  if (!runId.startsWith("run:")) return null;
  const [firstId, lastId] = runId.slice(4).split(":");
  if (!firstId) return null;
  const firstIdx = segments.findIndex((s) => s.id === firstId);
  const lastIdx = segments.findIndex((s) => s.id === (lastId ?? firstId));
  if (firstIdx < 0 || lastIdx < firstIdx) return null;

  const runSegments = segments.slice(firstIdx, lastIdx + 1);
  const first = runSegments[0]!;

  // Aggregate the preview metadata across the run (length-weighted) rather than
  // taking the first span's — otherwise a run whose first ~100 m has 1 pass but
  // the rest has many would open a whole-run preview labelled low-confidence.
  const coordinates: LngLat[] = [];
  const subScores: QualitySpan[] = [];
  let scoreWeighted = 0;
  let scoredLength = 0;
  let passesWeighted = 0;
  let totalLength = 0;
  const surfaceLength = new Map<RouteSegment["surface"], number>();
  for (const segment of runSegments) {
    for (const coordinate of segment.geometry.coordinates) {
      coordinates.push(coordinate as LngLat);
    }
    const length = segment.lengthKm;
    totalLength += length;
    passesWeighted += segment.passes * length;
    if (segment.score != null) {
      scoreWeighted += segment.score * length;
      scoredLength += length;
      subScores.push({ score: segment.score, lengthKm: length });
    }
    surfaceLength.set(
      segment.surface,
      (surfaceLength.get(segment.surface) ?? 0) + length,
    );
  }
  let surface = first.surface;
  let maxSurfaceLength = -1;
  for (const [candidate, length] of surfaceLength) {
    if (length > maxSurfaceLength) {
      maxSurfaceLength = length;
      surface = candidate;
    }
  }

  return {
    ...first,
    id: runId,
    geometry: {
      type: "LineString",
      coordinates: dedupeAdjacentPoints(coordinates),
    },
    surface,
    score:
      scoredLength > 0
        ? Math.round((scoreWeighted / scoredLength) * 10) / 10
        : null,
    passes:
      totalLength > 0 ? Math.round(passesWeighted / totalLength) : first.passes,
    lengthKm: totalLength,
    // Sub-band variation for the preview strip — only meaningful with ≥2
    // measured constituents; a single one carries no "across section" story.
    // Downsampled so a long run can't render thousands of bars.
    ...(subScores.length >= 2
      ? { microStrip: resampleQualitySpans(subScores, MAX_STRIP_SPANS) }
      : {}),
  };
}
