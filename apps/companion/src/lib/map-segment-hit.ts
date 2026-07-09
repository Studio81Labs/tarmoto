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
 * stroke.
 */
export const SEGMENT_HIT_PADDING_PX = 8;

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

/** Smallest screen-space distance (px) from `point` to a line feature's vertices. */
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
    for (const coord of line) {
      const p = map.project([coord[0]!, coord[1]!]);
      const d = Math.hypot(p.x - point.x, p.y - point.y);
      if (d < min) min = d;
    }
  }
  return min;
}
