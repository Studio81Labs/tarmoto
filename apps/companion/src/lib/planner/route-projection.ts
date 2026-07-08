const EARTH_RADIUS_KM = 6371;
const DEG_TO_RAD = Math.PI / 180;

interface LatLng {
  lat: number;
  lng: number;
}

/**
 * Point-to-segment distance + along-segment fraction on a local
 * equirectangular plane (accurate to well under 1% at corridor scale).
 * Returns km from the point to the nearest point on [a, b] and the fraction
 * (0..1) of that nearest point along the segment.
 */
function pointToSegmentKm(
  point: LatLng,
  a: LatLng,
  b: LatLng,
): { distanceKm: number; t: number } {
  const cosLat = Math.cos(point.lat * DEG_TO_RAD);
  const toXY = (p: LatLng) => ({
    x: p.lng * DEG_TO_RAD * cosLat * EARTH_RADIUS_KM,
    y: p.lat * DEG_TO_RAD * EARTH_RADIUS_KM,
  });
  const pp = toXY(point);
  const pa = toXY(a);
  const pb = toXY(b);
  const dx = pb.x - pa.x;
  const dy = pb.y - pa.y;
  const lengthSq = dx * dx + dy * dy;
  const t =
    lengthSq === 0
      ? 0
      : Math.max(
          0,
          Math.min(1, ((pp.x - pa.x) * dx + (pp.y - pa.y) * dy) / lengthSq),
        );
  const nx = pa.x + t * dx;
  const ny = pa.y + t * dy;
  return { distanceKm: Math.hypot(pp.x - nx, pp.y - ny), t };
}

function segmentLengthKm(a: LatLng, b: LatLng): number {
  const cosLat = Math.cos(((a.lat + b.lat) / 2) * DEG_TO_RAD);
  const dx = (b.lng - a.lng) * DEG_TO_RAD * cosLat * EARTH_RADIUS_KM;
  const dy = (b.lat - a.lat) * DEG_TO_RAD * EARTH_RADIUS_KM;
  return Math.hypot(dx, dy);
}

/**
 * Project a point onto a route polyline: the shortest distance to the line (km)
 * and the along-route km of the nearest point (rounded like the mock/store
 * corridor outputs). Returns `null` for a degenerate (< 2 vertex) route.
 *
 * Extracted from the retired POI mock so the store-off `mountain_pass` /
 * `twisty_highlight` corridor reads (#865) can position their points the same
 * way `/poi/in-corridor` does server-side for the OSM categories.
 */
export function projectOntoRoute(
  point: LatLng,
  route: readonly LatLng[],
): { distanceFromRouteKm: number; kmAlongRoute: number } | null {
  if (route.length < 2) return null;
  // Prefix km per vertex, so the nearest segment's along-route position is
  // prefix + t * segment length.
  const prefixKm: number[] = [0];
  for (let i = 1; i < route.length; i++) {
    prefixKm.push(prefixKm[i - 1]! + segmentLengthKm(route[i - 1]!, route[i]!));
  }
  let bestKm = Number.POSITIVE_INFINITY;
  let bestAlongKm = 0;
  for (let i = 1; i < route.length; i++) {
    const { distanceKm, t } = pointToSegmentKm(point, route[i - 1]!, route[i]!);
    if (distanceKm < bestKm) {
      bestKm = distanceKm;
      bestAlongKm = prefixKm[i - 1]! + t * (prefixKm[i]! - prefixKm[i - 1]!);
    }
  }
  return {
    distanceFromRouteKm: Math.round(bestKm * 10) / 10,
    kmAlongRoute: Math.round(bestAlongKm),
  };
}
