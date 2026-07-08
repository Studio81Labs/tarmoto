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
/** Cumulative km from the route start to each vertex. */
function cumulativeRouteKm(route: readonly LatLng[]): number[] {
  const cum: number[] = [0];
  for (let i = 1; i < route.length; i++) {
    cum.push(cum[i - 1]! + segmentLengthKm(route[i - 1]!, route[i]!));
  }
  return cum;
}

export function projectOntoRoute(
  point: LatLng,
  route: readonly LatLng[],
): { distanceFromRouteKm: number; kmAlongRoute: number } | null {
  if (route.length < 2) return null;
  // Prefix km per vertex, so the nearest segment's along-route position is
  // prefix + t * segment length.
  const prefixKm = cumulativeRouteKm(route);
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

/**
 * Project a polygon boundary ring onto the route and return the NEAREST
 * contact — the min off-route distance + its along-route km. The ring is
 * densified to ~`stepKm` along each edge (and closed) before projecting, so a
 * route that runs alongside or through a long edge *between* the ring's own
 * vertices is measured at the real contact, not a far corner vertex. Returns
 * null on a degenerate route or empty ring.
 */
export function projectRingOntoRoute(
  ring: readonly LatLng[],
  route: readonly LatLng[],
  stepKm = 1,
): { distanceFromRouteKm: number; kmAlongRoute: number } | null {
  if (route.length < 2 || ring.length === 0) return null;
  let best: { distanceFromRouteKm: number; kmAlongRoute: number } | null = null;
  const consider = (point: LatLng): void => {
    const projected = projectOntoRoute(point, route);
    if (
      projected &&
      (!best || projected.distanceFromRouteKm < best.distanceFromRouteKm)
    ) {
      best = projected;
    }
  };
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % ring.length]!; // close the ring
    consider(a);
    // Interpolate along the edge so a contact point between vertices is caught.
    const steps = Math.floor(segmentLengthKm(a, b) / stepKm);
    for (let k = 1; k <= steps; k++) {
      const t = k / (steps + 1);
      consider({
        lat: a.lat + t * (b.lat - a.lat),
        lng: a.lng + t * (b.lng - a.lng),
      });
    }
  }
  return best;
}

/**
 * Ray-casting point-in-polygon test on the lat/lng plane (adequate at the
 * few-km scale these corridors operate on). `ring` is the polygon's exterior
 * ring, open or closed.
 */
export function pointInPolygon(
  point: LatLng,
  ring: readonly LatLng[],
): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!;
    const b = ring[j]!;
    const straddles = a.lat > point.lat !== b.lat > point.lat;
    if (
      straddles &&
      point.lng <
        ((b.lng - a.lng) * (point.lat - a.lat)) / (b.lat - a.lat) + a.lng
    ) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Nearest contact between a route polyline and a polygon (zone): the off-route
 * distance + its along-route km. A route vertex inside the polygon is on the
 * zone (0 km off) — the server's polygon `ST_DWithin` counts a fully-surrounded
 * route segment even when the boundary edges are km away. Otherwise the nearest
 * densified-boundary contact ({@link projectRingOntoRoute}). Null on a
 * degenerate route or empty ring.
 */
export function nearestPolygonContact(
  ring: readonly LatLng[],
  route: readonly LatLng[],
): { distanceFromRouteKm: number; kmAlongRoute: number } | null {
  if (route.length < 2 || ring.length === 0) return null;
  const cumKm = cumulativeRouteKm(route);
  for (let i = 0; i < route.length; i++) {
    if (pointInPolygon(route[i]!, ring)) {
      return { distanceFromRouteKm: 0, kmAlongRoute: Math.round(cumKm[i]!) };
    }
  }
  return projectRingOntoRoute(ring, route);
}
