/**
 * Shared screen-space hit-testing for the `tarmoto-roads` vector-tile line
 * layers (quality / surface), used by both /explore and the trip planner so a
 * segment tap behaves identically on either map.
 */

import type {
  Map as MapLibreMap,
  MapGeoJSONFeature,
  Point,
  PointLike,
} from "maplibre-gl";

/**
 * Screen-space padding (px) added around a tap when hit-testing the thin
 * quality/surface road lines, so a rider doesn't have to land exactly on the
 * stroke. Generous on purpose (touch targets); the nearest-line tie-break keeps
 * a wide box from grabbing the wrong parallel road.
 */
export const SEGMENT_HIT_PADDING_PX = 16;

/**
 * The promoted `road_segments` UUID for a vector-tile road feature, or null.
 * `MapCanvas` promotes the `id` property to the feature id, but read the raw
 * property first (and fall back to a numeric id) so this stays robust to how
 * the feature was queried.
 */
export function readSegmentId(
  feature: MapGeoJSONFeature | undefined,
): string | null {
  if (!feature) return null;
  const propertyId = feature.properties?.id;
  if (typeof propertyId === "string" && propertyId.length > 0) {
    return propertyId;
  }
  if (typeof feature.id === "string" && feature.id.length > 0) {
    return feature.id;
  }
  if (typeof feature.id === "number") {
    return String(feature.id);
  }
  return null;
}

/**
 * Hit-test `layers` within a small screen-space box around `point` (thin
 * strokes are hard to tap exactly) and return the feature whose geometry runs
 * closest to the tap, so a padded click never grabs a parallel road that
 * merely clips the box corner.
 */
export function pickNearestLineFeature(
  map: MapLibreMap,
  point: Point,
  layers: string[],
  paddingPx: number,
): MapGeoJSONFeature | undefined {
  const box: [PointLike, PointLike] = [
    [point.x - paddingPx, point.y - paddingPx],
    [point.x + paddingPx, point.y + paddingPx],
  ];
  const features = map.queryRenderedFeatures(box, { layers });
  if (features.length <= 1) return features[0];
  let best: MapGeoJSONFeature | undefined;
  let bestDist = Infinity;
  for (const feature of features) {
    const dist = screenDistanceToLineFeature(map, point, feature);
    if (dist < bestDist) {
      bestDist = dist;
      best = feature;
    }
  }
  return best;
}

/**
 * Smallest screen-space distance (px) from `point` to a line feature — measured
 * to each edge (segment), not just the vertices. A long straight vector-tile
 * segment can pass directly under the tap while both of its endpoints sit far
 * outside the hit box; ranking by vertices alone would then lose it to a nearby
 * cross-street that merely has a closer vertex.
 */
function screenDistanceToLineFeature(
  map: MapLibreMap,
  point: Point,
  feature: MapGeoJSONFeature,
): number {
  const geom = feature.geometry;
  const lines: number[][][] =
    geom.type === "LineString"
      ? [geom.coordinates]
      : geom.type === "MultiLineString"
        ? geom.coordinates
        : [];
  let min = Infinity;
  for (const line of lines) {
    let prev: { x: number; y: number } | null = null;
    for (const coord of line) {
      const curr = map.project([coord[0]!, coord[1]!]);
      const d = prev
        ? pointToSegmentDistance(point, prev, curr)
        : Math.hypot(curr.x - point.x, curr.y - point.y);
      if (d < min) min = d;
      prev = curr;
    }
  }
  return min;
}

/** Distance from point `p` to the line segment `a`–`b`, all in screen px. */
function pointToSegmentDistance(
  p: { x: number; y: number },
  a: { x: number; y: number },
  b: { x: number; y: number },
): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  // Project p onto the segment, clamped to [0,1] so it stays on the edge.
  const tRaw = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
  const t = Math.max(0, Math.min(1, tRaw));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}
