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

  let cursor = 0;
  for (const { span, start, end } of ordered) {
    const spanStart = Math.max(start, cursor);
    if (end <= spanStart) continue; // fully covered by an earlier span
    if (spanStart - cursor > MIN_FILLER_FRACTION) {
      // A real gap becomes its own no_data filler.
      push(cursor, spanStart, null);
      push(spanStart, end, span);
    } else {
      // Sub-threshold gap: fold the `[cursor, spanStart]` interval into this
      // span rather than dropping it, which would leave a hairline break in the
      // line and undercount its length (and the splitter distances built on it).
      push(cursor, end, span);
    }
    cursor = end;
  }
  if (1 - cursor > MIN_FILLER_FRACTION) push(cursor, 1, null);

  // No covering spans at all → the whole route is one no-data stretch.
  if (out.length === 0) push(0, 1, null);
  return out;
}
