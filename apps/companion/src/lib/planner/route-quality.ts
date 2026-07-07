import type * as GeoJSON from "geojson";
import { SURFACE_TYPES, type SurfaceType } from "@tarmoto/shared";
import type { RouteQualitySegment } from "@/lib/api";
import {
  clampUnit,
  cumulativeKm,
  slicePolylineByDistanceKm,
  type LngLat,
} from "./polyline";
import { scoreToBand } from "./quality-bands";
import type { RouteSegment } from "./types";

/**
 * Maps backend route-quality spans onto a routed polyline to produce display
 * {@link RouteSegment}s.
 *
 * `POST /roads/route-quality` returns quality spans ordered along the route
 * and keyed by fraction (`start_fraction`/`end_fraction`), but WITHOUT
 * geometry — so this slices each span's line out of the routed polyline at
 * those fractions. Stretches no imported segment covers (before the first
 * span, between spans, after the last) become explicit `no_data` fillers, so
 * the colored line stays continuous from start to finish. A route with zero
 * covering spans collapses to one `no_data` stretch.
 */

const SURFACE_TYPE_SET: ReadonlySet<string> = new Set(SURFACE_TYPES);
function toSurfaceType(key: string): SurfaceType {
  return SURFACE_TYPE_SET.has(key) ? (key as SurfaceType) : "unknown";
}

// A gap narrower than this fraction of the whole route (~metres on a typical
// day) isn't worth its own filler segment — suppressing it avoids degenerate,
// unclickable slivers between spans that already abut at cell edges.
const MIN_FILLER_FRACTION = 1e-4;

// No-data stretches are sub-divided at roughly this many km (mirroring the
// display-slice target in `segmentize`). The day splitter assigns each segment
// to the day holding its midpoint, so a single whole-route no_data segment
// would give only the middle day any segments; slicing keeps every day of an
// uncovered multi-day route covered.
const NO_DATA_SLICE_KM = 12;

export function mapRouteQualitySpans(
  points: ReadonlyArray<{ lat: number; lng: number }>,
  spans: readonly RouteQualitySegment[],
  dayNumber: number,
): RouteSegment[] {
  if (points.length < 2) return [];
  const coordinates: LngLat[] = points.map((p) => [p.lng, p.lat]);
  const cumKm = cumulativeKm(coordinates);
  const totalKm = cumKm[cumKm.length - 1] ?? 0;
  if (totalKm <= 0) return [];

  // Normalize defensively: clamp to [0,1], drop empty/inverted spans, order by
  // start (the backend already orders them, but this makes the walk robust).
  const ordered = spans
    .map((span) => ({
      span,
      start: clampUnit(span.start_fraction),
      end: clampUnit(span.end_fraction),
    }))
    .filter((entry) => entry.end > entry.start)
    .sort((a, b) => a.start - b.start);

  const out: RouteSegment[] = [];
  const push = (
    startFraction: number,
    endFraction: number,
    quality: RouteQualitySegment | null,
  ) => {
    if (endFraction - startFraction <= 0) return;
    const line = slicePolylineByDistanceKm(
      coordinates,
      cumKm,
      startFraction * totalKm,
      endFraction * totalKm,
    );
    if (line.length < 2) return;
    const geometry: GeoJSON.LineString = {
      type: "LineString",
      coordinates: line,
    };
    const score = quality?.quality_score ?? null;
    out.push({
      id: `d${dayNumber}-s${out.length}`,
      geometry,
      band: scoreToBand(score),
      surface: quality ? toSurfaceType(quality.surface_type) : "unknown",
      score,
      passes: quality?.reading_count ?? 0,
      lengthKm: (endFraction - startFraction) * totalKm,
      dayNumber,
    });
  };

  // A no-data stretch is sliced into ~NO_DATA_SLICE_KM chunks (no upper cap):
  // the day splitter assigns each segment to the day holding its midpoint, so a
  // chunk larger than the day size would leave some days of a long uncovered
  // route without any segments.
  const pushNoData = (startFraction: number, endFraction: number) => {
    const rangeKm = (endFraction - startFraction) * totalKm;
    const slices = Math.max(1, Math.round(rangeKm / NO_DATA_SLICE_KM));
    const step = (endFraction - startFraction) / slices;
    for (let i = 0; i < slices; i += 1) {
      push(startFraction + step * i, startFraction + step * (i + 1), null);
    }
  };

  // Build intervals that tile [0, 1] exactly: a real span where covered,
  // no_data elsewhere. A sub-threshold gap (before/between/after spans) is
  // folded into the adjacent span rather than dropped, so the line never breaks
  // and lengths (and the splitter distances built on them) stay exact.
  const intervals: {
    start: number;
    end: number;
    quality: RouteQualitySegment | null;
  }[] = [];
  let cursor = 0;
  for (const { span, start, end } of ordered) {
    const spanStart = Math.max(start, cursor);
    if (end <= spanStart) continue; // fully covered by an earlier span
    if (spanStart - cursor > MIN_FILLER_FRACTION) {
      intervals.push({ start: cursor, end: spanStart, quality: null });
      intervals.push({ start: spanStart, end, quality: span });
    } else {
      intervals.push({ start: cursor, end, quality: span }); // fold tiny lead gap
    }
    cursor = end;
  }
  if (cursor < 1) {
    if (intervals.length === 0 || 1 - cursor > MIN_FILLER_FRACTION) {
      intervals.push({ start: cursor, end: 1, quality: null });
    } else {
      // Fold a sub-threshold trailing gap into the last segment so the line
      // reaches the route end (there is no following span to extend from).
      intervals[intervals.length - 1]!.end = 1;
    }
  }

  for (const interval of intervals) {
    if (interval.quality) {
      push(interval.start, interval.end, interval.quality);
    } else {
      pushNoData(interval.start, interval.end);
    }
  }

  // A valid route always yields at least one segment.
  if (out.length === 0) pushNoData(0, 1);
  return out;
}
