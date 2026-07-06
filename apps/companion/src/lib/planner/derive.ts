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
  // Present when the day was routed per leg (revision 3 §C): namespaces
  // segment ids per leg and tags every segment with its legId.
  leg?: { index: number; id: string },
): RouteSegment[] {
  const slices = segmentizeRoute(
    points,
    dayNumber,
    leg ? `d${dayNumber}-l${leg.index}` : undefined,
  );
  const segments = mockJoinQuality(slices);
  return leg
    ? segments.map((segment) => ({ ...segment, legId: leg.id }))
    : segments;
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
