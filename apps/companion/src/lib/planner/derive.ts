import type * as GeoJSON from "geojson";
import { mockJoinQuality } from "./mocks";
import { segmentizeRoute } from "./segmentize";
import type { RouteSegment } from "./types";

/**
 * The quality-join seam: turns routed geometry into quality-annotated
 * display segments. Deterministic — same geometry in, same segments out —
 * so consumers can derive on demand (map layers, panel strips) without
 * caching or store state, and every geometry source (live routing, GPX
 * import, demo trips, saved trips) gets the same treatment.
 *
 * The join itself is the MOCK from `./mocks`; swapping in the real
 * per-segment quality source changes this function only.
 */
export function deriveQualitySegments(
  points: ReadonlyArray<{ lat: number; lng: number }>,
  dayNumber: number,
): RouteSegment[] {
  return mockJoinQuality(segmentizeRoute(points, dayNumber));
}

/** Same join for GeoJSON LineString geometry ([lng, lat] coordinate order). */
export function deriveQualitySegmentsFromLineString(
  geometry: GeoJSON.LineString,
  dayNumber: number,
): RouteSegment[] {
  const points: { lat: number; lng: number }[] = [];
  for (const coordinate of geometry.coordinates) {
    const [lng, lat] = coordinate;
    if (typeof lng === "number" && typeof lat === "number") {
      points.push({ lat, lng });
    }
  }
  return deriveQualitySegments(points, dayNumber);
}
