import type * as GeoJSON from "geojson";
import { SURFACE_TYPES, type SurfaceType } from "@tarmoto/shared";
import type { RouteQualitySegment } from "@/lib/api";
import {
  clampUnit,
  cumulativeKm,
  dedupeAdjacentPoints,
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
 * covering spans collapses to `no_data`.
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

// The planner can force a route into up to this many days (MAX_TRIP_DAYS,
// stores/trip.ts). No-data slices must be no coarser than a day of the finest
// forced split, or the midpoint-based splitter leaves some days of a short
// uncovered route without a segment (empty Inspect / build-route state).
const MAX_SPLIT_DAYS = 14;

interface EmitRange {
  start: number; // route fraction [0,1]
  end: number;
  quality: RouteQualitySegment | null;
}

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

  // Build intervals tiling [0, 1] exactly: a real span where covered, no_data
  // elsewhere. A sub-threshold gap (before/between/after spans) is folded into
  // the adjacent span rather than dropped, so the line never breaks and lengths
  // (and the splitter distances built on them) stay exact.
  const intervals: EmitRange[] = [];
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

  // Expand into a flat, contiguous list of emit ranges: a real span stays one
  // range; a no_data interval is sub-divided so a multi-day split gives every
  // day it spans its own segment(s). Slice at ~NO_DATA_SLICE_KM, but never
  // coarser than a day of the finest forced split (so even a short route forced
  // to MAX_SPLIT_DAYS gets a midpoint per day); ceil keeps every piece within
  // that bound.
  const noDataSliceKm = Math.min(NO_DATA_SLICE_KM, totalKm / MAX_SPLIT_DAYS);
  const ranges: EmitRange[] = [];
  const addNoData = (start: number, end: number) => {
    const slices = Math.max(
      1,
      Math.ceil(((end - start) * totalKm) / noDataSliceKm),
    );
    const step = (end - start) / slices;
    for (let i = 0; i < slices; i += 1) {
      ranges.push({
        start: start + step * i,
        end: start + step * (i + 1),
        quality: null,
      });
    }
  };
  for (const interval of intervals) {
    if (interval.quality) ranges.push(interval);
    else addNoData(interval.start, interval.end);
  }
  if (ranges.length === 0) addNoData(0, 1);

  // Slice every range's geometry in a single forward pass over the route
  // vertices (O(vertices + ranges)) — a per-range re-scan would be
  // O(vertices × ranges), and a long route can carry thousands of ~100 m spans.
  const edgesKm = [0, ...ranges.map((r) => r.end * totalKm)];
  const geoms = sliceOrderedByDistanceKm(coordinates, cumKm, edgesKm);

  const out: RouteSegment[] = [];
  ranges.forEach((range, index) => {
    const line = geoms[index]!;
    if (line.length < 2) return;
    const geometry: GeoJSON.LineString = {
      type: "LineString",
      coordinates: line,
    };
    const score = range.quality?.quality_score ?? null;
    out.push({
      id: `d${dayNumber}-s${out.length}`,
      geometry,
      band: scoreToBand(score),
      surface: range.quality
        ? toSurfaceType(range.quality.surface_type)
        : "unknown",
      score,
      passes: range.quality?.reading_count ?? 0,
      lengthKm: (range.end - range.start) * totalKm,
      dayNumber,
      roadSegmentId: range.quality?.segment_id ?? null,
    });
  });
  return out;
}

/**
 * Slice a set of contiguous, ascending distance ranges out of one polyline in a
 * single forward pass. Ranges tile `[0, total]` and are described by their N+1
 * ascending edge distances (km). Output r is the sub-line for range r: the
 * interpolated start edge, the interior vertices, then the interpolated end
 * edge (deduped). Both the boundary interpolation and the interior collection
 * advance monotonic cursors, so the route is walked once, not re-scanned per
 * range.
 */
function sliceOrderedByDistanceKm(
  coordinates: readonly LngLat[],
  cumKm: readonly number[],
  edgesKm: readonly number[],
): LngLat[][] {
  const n = coordinates.length;
  const total = cumKm[n - 1] ?? 0;
  const pointAtEdge = (km: number, hi: number): LngLat => {
    const lo = hi - 1;
    const edgeKm = cumKm[hi]! - cumKm[lo]!;
    const t = edgeKm > 0 ? (km - cumKm[lo]!) / edgeKm : 0;
    const a = coordinates[lo]!;
    const b = coordinates[hi]!;
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  };

  // Interpolated point at every boundary, one forward pass.
  const boundary: LngLat[] = new Array(edgesKm.length) as LngLat[];
  let bc = 1;
  for (let e = 0; e < edgesKm.length; e += 1) {
    const km = Math.max(0, Math.min(total, edgesKm[e]!));
    while (bc < n - 1 && cumKm[bc]! < km) bc += 1;
    boundary[e] = pointAtEdge(km, bc);
  }

  // Interior vertices for each range, one forward pass.
  const geoms: LngLat[][] = [];
  let ic = 0;
  for (let r = 0; r < edgesKm.length - 1; r += 1) {
    const startKm = Math.max(0, Math.min(total, edgesKm[r]!));
    const endKm = Math.max(0, Math.min(total, edgesKm[r + 1]!));
    const line: LngLat[] = [boundary[r]!];
    while (ic < n && cumKm[ic]! <= startKm) ic += 1;
    while (ic < n && cumKm[ic]! < endKm) {
      line.push(coordinates[ic]!);
      ic += 1;
    }
    line.push(boundary[r + 1]!);
    geoms.push(dedupeAdjacentPoints(line));
  }
  return geoms;
}
