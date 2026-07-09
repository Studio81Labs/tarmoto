import { haversineKm } from '@tarmoto/shared';

/**
 * Pure route geometry shared by the live `PoiService` (Overpass path) and the
 * store-backed `PoiStoreService` (#849). Kept dependency-free — no NestJS, no
 * DB — so both services can import it without the two service files forming an
 * import cycle.
 */

/**
 * Build the per-vertex cumulative-distance table for a polyline. Callers use
 * this to sample `around:` anchors at regular intervals and to look up a POI's
 * distance-along-route from its nearest projection.
 */
export function cumulativeLengthKm(
  route: ReadonlyArray<{ lat: number; lng: number }>,
): number[] {
  const cum = new Array<number>(route.length);
  cum[0] = 0;
  for (let i = 1; i < route.length; i++) {
    const prev = route[i - 1];
    const curr = route[i];
    const prevCum = cum[i - 1];
    if (prev === undefined || curr === undefined || prevCum === undefined) {
      throw new Error('Route index out of range while building length table');
    }
    cum[i] = prevCum + haversineKm(prev.lat, prev.lng, curr.lat, curr.lng);
  }
  return cum;
}

/**
 * Mean km per degree of latitude. Longitude km per degree scales by
 * `cos(lat)`; used to build a local flat-earth frame for projection.
 */
const LAT_KM_PER_DEGREE = 111.132;

/**
 * Project `point` onto the nearest segment of `route` and return both the
 * perpendicular distance (km) and the cumulative distance-along-route at the
 * projected point (km).
 *
 * Uses a local equirectangular frame scaled by `cos(point.lat)` — for the
 * few-km buffers this operates on this is accurate to well below the precision
 * of the upstream OSM coordinates. The returned distance is computed via
 * haversine against the interpolated lat/lng, not via the flat-earth distance,
 * so the reported off-route km matches the spherical distance riders expect.
 */
export function projectOntoRoute(
  point: { lat: number; lng: number },
  route: ReadonlyArray<{ lat: number; lng: number }>,
  cumKm: number[],
): { distance_from_route_km: number; distance_along_route_km: number } {
  const cosLat = Math.cos((point.lat * Math.PI) / 180);
  const lngScale = LAT_KM_PER_DEGREE * cosLat;
  const px = point.lng * lngScale;
  const py = point.lat * LAT_KM_PER_DEGREE;

  let bestDistanceKm = Infinity;
  let bestAlongKm = 0;

  for (let i = 1; i < route.length; i++) {
    const a = route[i - 1];
    const b = route[i];
    if (a === undefined || b === undefined) {
      throw new Error('Route index out of range while projecting point');
    }
    const ax = a.lng * lngScale;
    const ay = a.lat * LAT_KM_PER_DEGREE;
    const bx = b.lng * lngScale;
    const by = b.lat * LAT_KM_PER_DEGREE;
    const dx = bx - ax;
    const dy = by - ay;
    const segLenSq = dx * dx + dy * dy;
    let t = 0;
    if (segLenSq > 0) {
      t = ((px - ax) * dx + (py - ay) * dy) / segLenSq;
      if (t < 0) t = 0;
      else if (t > 1) t = 1;
    }
    const projLat = a.lat + t * (b.lat - a.lat);
    const projLng = a.lng + t * (b.lng - a.lng);
    const distKm = haversineKm(point.lat, point.lng, projLat, projLng);
    if (distKm < bestDistanceKm) {
      bestDistanceKm = distKm;
      const cumEnd = cumKm[i];
      const cumStart = cumKm[i - 1];
      if (cumEnd === undefined || cumStart === undefined) {
        throw new Error('Cumulative length table shorter than route');
      }
      const segLengthKm = cumEnd - cumStart;
      bestAlongKm = cumStart + t * segLengthKm;
    }
  }
  return {
    distance_from_route_km: bestDistanceKm,
    distance_along_route_km: bestAlongKm,
  };
}

/** A lng/lat bounding box (WGS84). */
export interface Bbox {
  minLng: number;
  minLat: number;
  maxLng: number;
  maxLat: number;
}

/** Degrees of longitude per km at `lat` — km/deg shrinks by `cos(lat)`. Clamped
 * so a near-polar latitude can't blow the value up (irrelevant for our coverage
 * regions, but keeps the helper total). */
function lngKmPerDegree(lat: number): number {
  return Math.max(LAT_KM_PER_DEGREE * Math.cos((lat * Math.PI) / 180), 1e-6);
}

/**
 * Expand a bbox by `km` on every side, poleward-safe (#925): longitude is
 * padded using the box's poleward-MOST edge, where km/° longitude is smallest,
 * so the pad never falls short on the high-latitude side. Used by the coverage
 * probe to widen the request area into "is there an imported point within `km`
 * of it?" — under-padding would shrink that ring and wrongly report an
 * un-imported gap as covered.
 */
export function padBbox(bbox: Bbox, km: number): Bbox {
  const dLat = km / LAT_KM_PER_DEGREE;
  const worstLat =
    Math.abs(bbox.minLat) >= Math.abs(bbox.maxLat) ? bbox.minLat : bbox.maxLat;
  const dLng = km / lngKmPerDegree(worstLat);
  return {
    minLng: bbox.minLng - dLng,
    minLat: bbox.minLat - dLat,
    maxLng: bbox.maxLng + dLng,
    maxLat: bbox.maxLat + dLat,
  };
}

/**
 * How near an imported OSM point must be for a location to count as inside
 * imported territory (#925). The coverage probe checks a point ± this margin;
 * the route/radius samplers space their probes at this stride so consecutive
 * probes overlap. Shared so the store's probe and the service's sampling agree.
 * See {@link PoiStoreService.hasImportedCoverage}.
 */
export const COVERAGE_BUFFER_KM = 20;

/**
 * Sample points that span a `radiusKm` disc for the coverage probe (#925) — its
 * centre plus the four cardinal points on the rim. Coverage is proven across the
 * disc (every sample near an import), NOT from one point anywhere inside it, so a
 * large-radius request that spills past the import frontier has an uncovered rim
 * sample and correctly falls through to an Overpass merge (#925 P1 review).
 */
export function radiusCoverageSamples(
  lat: number,
  lng: number,
  radiusKm: number,
): { lat: number; lng: number }[] {
  const dLat = radiusKm / LAT_KM_PER_DEGREE;
  const dLng = radiusKm / lngKmPerDegree(lat);
  return [
    { lat, lng },
    { lat: lat + dLat, lng },
    { lat: lat - dLat, lng },
    { lat, lng: lng + dLng },
    { lat, lng: lng - dLng },
  ];
}
