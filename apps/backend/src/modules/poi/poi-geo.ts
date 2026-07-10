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
