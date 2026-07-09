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
 * The bounding box enclosing a `radiusKm` circle around a point (#925) — the
 * coverage probe approximates the circular request area by this box before
 * widening it to ask whether an imported point lies nearby.
 */
export function pointRadiusBbox(
  lat: number,
  lng: number,
  radiusKm: number,
): Bbox {
  const dLat = radiusKm / LAT_KM_PER_DEGREE;
  // Pad longitude at the circle's poleward edge (`|lat| + dLat`), where km/°
  // longitude is smallest — using the centre latitude under-pads that edge, so a
  // thin slice of the radius would fall outside the box the coverage probe sees.
  const dLng = radiusKm / lngKmPerDegree(Math.abs(lat) + dLat);
  return {
    minLng: lng - dLng,
    minLat: lat - dLat,
    maxLng: lng + dLng,
    maxLat: lat + dLat,
  };
}

/**
 * The bounding box enclosing a route polyline expanded by `bufferKm` (#925) —
 * the coverage probe approximates the buffered-corridor request area by this box
 * before widening it to ask whether an imported point lies nearby.
 */
export function routeBufferBbox(
  route: ReadonlyArray<{ lat: number; lng: number }>,
  bufferKm: number,
): Bbox {
  let minLat = Infinity;
  let minLng = Infinity;
  let maxLat = -Infinity;
  let maxLng = -Infinity;
  for (const p of route) {
    minLat = Math.min(minLat, p.lat);
    maxLat = Math.max(maxLat, p.lat);
    minLng = Math.min(minLng, p.lng);
    maxLng = Math.max(maxLng, p.lng);
  }
  const dLat = bufferKm / LAT_KM_PER_DEGREE;
  // Longitude km/degree shrinks toward the poles, so pad using the route's
  // poleward-MOST latitude (its widest longitude span for `bufferKm`). The
  // midpoint would under-pad a long north/south route's high-latitude end,
  // shrinking the box the coverage probe widens and searches (#925 review).
  const worstLat = Math.abs(minLat) >= Math.abs(maxLat) ? minLat : maxLat;
  const dLng = bufferKm / lngKmPerDegree(worstLat);
  return {
    minLng: minLng - dLng,
    minLat: minLat - dLat,
    maxLng: maxLng + dLng,
    maxLat: maxLat + dLat,
  };
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
