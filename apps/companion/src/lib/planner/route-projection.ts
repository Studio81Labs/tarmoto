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

const clamp = (value: number, lo: number, hi: number): number =>
  Math.max(lo, Math.min(hi, value));

/**
 * Shortest distance (km) between two segments on the local equirectangular
 * plane, plus the fraction `s` (0..1) along the FIRST segment (the route leg
 * `routeA`→`routeB`) at which that nearest approach falls. Clamped
 * closest-point-between-segments (Ericson, Real-Time Collision Detection): two
 * crossing segments resolve to distance 0 at the true intersection, with no
 * sampling error, and a degenerate (point) segment collapses to point-to-
 * segment. Reference latitude is the route leg's midpoint.
 */
function segmentToSegmentKm(
  routeA: LatLng,
  routeB: LatLng,
  edgeA: LatLng,
  edgeB: LatLng,
): { distanceKm: number; s: number } {
  const cosLat = Math.cos(((routeA.lat + routeB.lat) / 2) * DEG_TO_RAD);
  const toXY = (p: LatLng) => ({
    x: p.lng * DEG_TO_RAD * cosLat * EARTH_RADIUS_KM,
    y: p.lat * DEG_TO_RAD * EARTH_RADIUS_KM,
  });
  const p1 = toXY(routeA);
  const q1 = toXY(routeB);
  const p2 = toXY(edgeA);
  const q2 = toXY(edgeB);
  const d1 = { x: q1.x - p1.x, y: q1.y - p1.y }; // route-leg direction
  const d2 = { x: q2.x - p2.x, y: q2.y - p2.y }; // boundary-edge direction
  const r = { x: p1.x - p2.x, y: p1.y - p2.y };
  const a = d1.x * d1.x + d1.y * d1.y; // squared route-leg length
  const e = d2.x * d2.x + d2.y * d2.y; // squared edge length
  const f = d2.x * r.x + d2.y * r.y;
  const EPS = 1e-12;
  let s: number;
  let t: number;
  if (a <= EPS && e <= EPS) {
    s = 0; // both degenerate
    t = 0;
  } else if (a <= EPS) {
    s = 0; // route leg is a point
    t = clamp(f / e, 0, 1);
  } else {
    const c = d1.x * r.x + d1.y * r.y;
    if (e <= EPS) {
      t = 0; // boundary edge is a point
      s = clamp(-c / a, 0, 1);
    } else {
      const b = d1.x * d2.x + d1.y * d2.y;
      const denom = a * e - b * b; // 0 => parallel
      s = denom > EPS ? clamp((b * f - c * e) / denom, 0, 1) : 0;
      t = (b * s + f) / e;
      if (t < 0) {
        t = 0;
        s = clamp(-c / a, 0, 1);
      } else if (t > 1) {
        t = 1;
        s = clamp((b - c) / a, 0, 1);
      }
    }
  }
  const closest1 = { x: p1.x + s * d1.x, y: p1.y + s * d1.y }; // on the route leg
  const closest2 = { x: p2.x + t * d2.x, y: p2.y + t * d2.y }; // on the edge
  return {
    distanceKm: Math.hypot(closest1.x - closest2.x, closest1.y - closest2.y),
    s,
  };
}

/** A point on the route where it meets a zone: how far off, how far along, and
 * the on-route lat/lng itself (so a fun-zone stop drops its via on the road, not
 * at the polygon centroid). */
export interface RouteContact {
  distanceFromRouteKm: number;
  kmAlongRoute: number;
  lat: number;
  lng: number;
}

/**
 * Project a polygon boundary ring onto the route and return the NEAREST
 * contact — the min off-route distance, its along-route km, and the on-route
 * lat/lng at that contact. Every closed boundary edge is measured analytically
 * against every route leg ({@link segmentToSegmentKm}), so a route that crosses
 * a boundary edge — even a short one, or one crossed *between* the ring's own
 * vertices — reads the true ~0 km contact instead of the nearest sampled point.
 * Returns null on a degenerate route or empty ring.
 */
export function projectRingOntoRoute(
  ring: readonly LatLng[],
  route: readonly LatLng[],
): RouteContact | null {
  if (route.length < 2 || ring.length === 0) return null;
  const prefixKm = cumulativeRouteKm(route);
  const EPS_KM = 1e-9;
  let bestKm = Number.POSITIVE_INFINITY;
  let bestAlongKm = 0;
  let bestLat = route[0]!.lat;
  let bestLng = route[0]!.lng;
  for (let i = 1; i < route.length; i++) {
    const a = route[i - 1]!;
    const b = route[i]!;
    const legKm = prefixKm[i]! - prefixKm[i - 1]!;
    for (let j = 0; j < ring.length; j++) {
      const { distanceKm, s } = segmentToSegmentKm(
        a,
        b,
        ring[j]!,
        ring[(j + 1) % ring.length]!, // close the ring
      );
      const alongKm = prefixKm[i - 1]! + s * legKm;
      // Strictly nearer wins; on a tie (e.g. the several 0 km crossings where a
      // route enters and exits a zone) keep the earliest along the route, so a
      // zone is anchored at its entry rather than an arbitrary later crossing.
      if (
        distanceKm < bestKm - EPS_KM ||
        (distanceKm <= bestKm + EPS_KM && alongKm < bestAlongKm)
      ) {
        bestKm = distanceKm;
        bestAlongKm = alongKm;
        bestLat = a.lat + s * (b.lat - a.lat); // the on-route contact point
        bestLng = a.lng + s * (b.lng - a.lng);
      }
    }
  }
  return {
    distanceFromRouteKm: Math.round(bestKm * 10) / 10,
    kmAlongRoute: Math.round(bestAlongKm),
    lat: bestLat,
    lng: bestLng,
  };
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
 * Contact between a route polyline and a polygon (zone): the off-route distance
 * + the along-route km of the EARLIEST point at which the route meets the zone.
 *
 * - If the route starts inside the zone, it is on it from km 0 (no boundary is
 *   crossed before the start), so the stop anchors at the route start. This also
 *   covers a fully-surrounded route whose boundary edges are km away — the case
 *   the server's polygon `ST_DWithin` still selects.
 * - Otherwise the earliest contact is the first boundary crossing: an analytic
 *   0 km contact at the true entry point, via {@link projectRingOntoRoute}
 *   (which returns the earliest minimum-distance contact). We deliberately do
 *   NOT anchor on the first *contained vertex* — the crossing happened earlier
 *   on that segment, so a contained-vertex km sorts a large zone (or one under
 *   sparse route geometry) several km late.
 * - If the route never meets the zone, `projectRingOntoRoute` yields the nearest
 *   boundary distance (the off-route case).
 *
 * The returned `lat`/`lng` is the on-route contact point (not the polygon
 * centroid), so a stop placed here drops its via on the rider's road. Null on a
 * degenerate route or empty ring.
 */
export function nearestPolygonContact(
  ring: readonly LatLng[],
  route: readonly LatLng[],
): RouteContact | null {
  if (route.length < 2 || ring.length === 0) return null;
  if (pointInPolygon(route[0]!, ring)) {
    return {
      distanceFromRouteKm: 0,
      kmAlongRoute: 0,
      lat: route[0]!.lat,
      lng: route[0]!.lng,
    };
  }
  return projectRingOntoRoute(ring, route);
}
