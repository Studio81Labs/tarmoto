import { haversineKm } from "@tarmoto/shared";
import { filterRoutingWaypoints } from "@/lib/trip-routing";
import type { TripDay, Waypoint } from "@/lib/types";
import type { RouteSegment } from "./types";

/**
 * "Reroute around this" v1: nudge the route away from a flagged segment by
 * inserting a via point offset perpendicular from the segment's midpoint.
 * Valhalla snaps the via to the nearest road, so the recomputed route takes
 * a parallel alternative where one exists.
 *
 * The via must land between the routing waypoints that bracket the segment
 * along the route — appending it blindly before the finish would make the
 * route backtrack when later vias exist. We bracket by nearest polyline
 * vertex: each routing waypoint maps to its closest vertex, the segment to
 * its midpoint vertex, and the via inserts before the first waypoint whose
 * vertex lies beyond the segment.
 */

export interface ReroutePlan {
  location: { lng: number; lat: number };
  /**
   * Waypoint id the via should be inserted before, or null to insert at the
   * day's finish boundary (the `viaInsertIndex` position).
   */
  insertBeforeWaypointId: string | null;
}

const MIN_OFFSET_KM = 0.8;
const MAX_OFFSET_KM = 3;
const KM_PER_DEGREE_LAT = 110.574;

export function planRerouteAroundSegment(
  day: Pick<TripDay, "routeGeometry" | "waypoints">,
  segment: RouteSegment,
): ReroutePlan | null {
  const polyline = day.routeGeometry?.coordinates;
  if (!polyline || polyline.length < 2) return null;

  const midpoint = segmentMidpoint(segment);
  if (!midpoint) return null;

  const location = offsetPerpendicular(segment, midpoint);
  if (!location) return null;

  const segmentVertex = nearestVertexIndex(polyline, midpoint);
  const routingWaypoints = filterRoutingWaypoints(day.waypoints);
  let insertBeforeWaypointId: string | null = null;
  for (const waypoint of routingWaypoints) {
    if (waypoint.type === "start") continue;
    const waypointVertex = nearestVertexIndex(polyline, waypoint.location);
    if (waypointVertex >= segmentVertex) {
      insertBeforeWaypointId = waypoint.id;
      break;
    }
  }

  return { location, insertBeforeWaypointId };
}

/** Build the via waypoint a reroute plan inserts. */
export function rerouteViaWaypoint(
  plan: ReroutePlan,
  segmentId: string,
): Waypoint {
  return {
    id: `reroute-${segmentId}-${Math.random().toString(36).slice(2, 8)}`,
    name: "Reroute via",
    location: plan.location,
    type: "via",
  };
}

function segmentMidpoint(
  segment: RouteSegment,
): { lng: number; lat: number } | null {
  const coordinates = segment.geometry.coordinates;
  const middle = coordinates[Math.floor(coordinates.length / 2)];
  const [lng, lat] = middle ?? [];
  if (typeof lng !== "number" || typeof lat !== "number") return null;
  return { lng, lat };
}

function offsetPerpendicular(
  segment: RouteSegment,
  midpoint: { lng: number; lat: number },
): { lng: number; lat: number } | null {
  const coordinates = segment.geometry.coordinates;
  const first = coordinates[0];
  const last = coordinates[coordinates.length - 1];
  const [x1, y1] = first ?? [];
  const [x2, y2] = last ?? [];
  if (
    typeof x1 !== "number" ||
    typeof y1 !== "number" ||
    typeof x2 !== "number" ||
    typeof y2 !== "number"
  ) {
    return null;
  }

  const offsetKm = Math.min(
    MAX_OFFSET_KM,
    Math.max(MIN_OFFSET_KM, segment.lengthKm * 0.4),
  );
  const latRad = (midpoint.lat * Math.PI) / 180;
  const kmPerDegreeLng = KM_PER_DEGREE_LAT * Math.cos(latRad) || 1e-6;

  // Direction of travel in km-space, then rotate 90° for the offset.
  const dxKm = (x2 - x1) * kmPerDegreeLng;
  const dyKm = (y2 - y1) * KM_PER_DEGREE_LAT;
  const length = Math.hypot(dxKm, dyKm);
  if (length === 0) return null;
  const perpX = -dyKm / length;
  const perpY = dxKm / length;

  return {
    lng: roundCoord(midpoint.lng + (perpX * offsetKm) / kmPerDegreeLng),
    lat: roundCoord(midpoint.lat + (perpY * offsetKm) / KM_PER_DEGREE_LAT),
  };
}

function nearestVertexIndex(
  polyline: ReadonlyArray<ReadonlyArray<number>>,
  point: { lng: number; lat: number },
): number {
  let best = 0;
  let bestKm = Number.POSITIVE_INFINITY;
  for (let i = 0; i < polyline.length; i += 1) {
    const [lng, lat] = polyline[i] ?? [];
    if (typeof lng !== "number" || typeof lat !== "number") continue;
    const km = haversineKm(lat, lng, point.lat, point.lng);
    if (km < bestKm) {
      bestKm = km;
      best = i;
    }
  }
  return best;
}

function roundCoord(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}
