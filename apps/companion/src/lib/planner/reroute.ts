import { haversineKm } from "@tarmoto/shared";
import { filterRoutingWaypoints } from "@/lib/trip-routing";
import type { Trip, TripDay, Waypoint } from "@/lib/types";
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

/** Minimal line-shaped input the planner needs — RouteSegment fits. */
export interface RerouteTarget {
  geometry: { coordinates: ReadonlyArray<ReadonlyArray<number>> };
  lengthKm: number;
}

export function planRerouteAroundSegment(
  day: Pick<TripDay, "routeGeometry" | "waypoints">,
  segment: RerouteTarget,
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

/**
 * Full reroute action shared by the Road Preview Card and the Inspect
 * tab's flagged-section REROUTE button: plan the avoidance via for the
 * segment's day and insert it through the store action. Returns false when
 * the segment can't be rerouted (no routed geometry / unknown day).
 */
export function rerouteAroundSegmentInTrip(
  trip: Trip | null,
  segment: RouteSegment,
  insertWaypointBefore: (
    dayIndex: number,
    beforeWaypointId: string | null,
    waypoint: Waypoint,
  ) => void,
): boolean {
  const dayIndex =
    trip?.days.findIndex((day) => day.dayNumber === segment.dayNumber) ?? -1;
  const day = dayIndex >= 0 ? trip?.days[dayIndex] : undefined;
  const plan = day ? planRerouteAroundSegment(day, segment) : null;
  if (!plan || dayIndex < 0) return false;
  insertWaypointBefore(
    dayIndex,
    plan.insertBeforeWaypointId,
    rerouteViaWaypoint(plan, segment.id),
  );
  return true;
}

/**
 * A map condition (closure / roadworks / pass) as a reroute target
 * (revision 7): the marker anchor picks the day, the condition's own
 * line (or a short route-aligned stub for point conditions like
 * passes) drives the perpendicular offset.
 */
export interface PlannerConditionTarget {
  id: string;
  location: { lng: number; lat: number };
  /** Line geometry when the condition has one (closures). */
  line?: ReadonlyArray<{ lng: number; lat: number }>;
}

/**
 * Index of the day whose route geometry passes nearest to `location`, or
 * -1 when no day carries a routed line. Point-anchored actions on
 * multi-day trips (condition reroutes, POI adds from the route-wide
 * STOPS list) must target the point's OWNING day — the selected day can
 * be a different leg entirely.
 */
export function nearestDayIndexToPoint(
  trip: Trip | null,
  location: { lat: number; lng: number },
): number {
  return nearestDayToPoint(trip, location).index;
}

/**
 * Index of the day whose route passes nearest to any SEGMENT of `line`
 * (distance from each day vertex to each line segment), or -1 when no
 * day carries a routed line.
 */
function nearestDayIndexToLine(
  trip: Trip,
  line: ReadonlyArray<{ lat: number; lng: number }>,
): number {
  let bestDayIndex = -1;
  let bestKm = Number.POSITIVE_INFINITY;
  trip.days.forEach((day, index) => {
    const polyline = day.routeGeometry?.coordinates;
    if (!polyline || polyline.length < 2) return;
    for (const [lng, lat] of polyline) {
      if (typeof lng !== "number" || typeof lat !== "number") continue;
      for (let i = 0; i < line.length - 1; i += 1) {
        const km = pointToSegmentKm({ lat, lng }, line[i]!, line[i + 1]!);
        if (km < bestKm) {
          bestKm = km;
          bestDayIndex = index;
        }
      }
    }
  });
  return bestDayIndex;
}

/**
 * Distance from a point to a segment, km — equirectangular projection
 * around the point (exact enough at closure scales).
 */
function pointToSegmentKm(
  point: { lat: number; lng: number },
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const kmPerDegLng =
    KM_PER_DEGREE_LAT * Math.cos((point.lat * Math.PI) / 180) || 1e-6;
  const ax = (a.lng - point.lng) * kmPerDegLng;
  const ay = (a.lat - point.lat) * KM_PER_DEGREE_LAT;
  const bx = (b.lng - point.lng) * kmPerDegLng;
  const by = (b.lat - point.lat) * KM_PER_DEGREE_LAT;
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSq = dx * dx + dy * dy;
  const t =
    lengthSq > 0
      ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / lengthSq))
      : 0;
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return Math.hypot(cx, cy);
}

function nearestDayToPoint(
  trip: Trip | null,
  location: { lat: number; lng: number },
): { index: number; km: number } {
  let bestDayIndex = -1;
  let bestKm = Number.POSITIVE_INFINITY;
  trip?.days.forEach((day, index) => {
    const polyline = day.routeGeometry?.coordinates;
    if (!polyline || polyline.length < 2) return;
    for (const [lng, lat] of polyline) {
      if (typeof lng !== "number" || typeof lat !== "number") continue;
      const km = haversineKm(lat, lng, location.lat, location.lng);
      if (km < bestKm) {
        bestKm = km;
        bestDayIndex = index;
      }
    }
  });
  return { index: bestDayIndex, km: bestKm };
}

export function rerouteAroundConditionInTrip(
  trip: Trip | null,
  condition: PlannerConditionTarget,
  insertWaypointBefore: (
    dayIndex: number,
    beforeWaypointId: string | null,
    waypoint: Waypoint,
  ) => void,
): boolean {
  if (!trip) return false;
  // Owning day from the WHOLE closure line — measured against its
  // SEGMENTS, not just its vertices: a sparse two-point roadwork line
  // can cross the ridden route near its middle while both endpoints sit
  // closer to a different leg. Point conditions use the location alone.
  const bestDayIndex =
    condition.line && condition.line.length >= 2
      ? nearestDayIndexToLine(trip, condition.line)
      : nearestDayIndexToPoint(trip, condition.location);
  if (bestDayIndex < 0) return false;
  const day = trip.days[bestDayIndex]!;

  let coordinates: number[][];
  if (condition.line && condition.line.length >= 2) {
    coordinates = condition.line.map((point) => [point.lng, point.lat]);
  } else {
    // Point condition: borrow the route's local direction around the
    // nearest vertex so the perpendicular offset is meaningful.
    const polyline = day.routeGeometry!.coordinates;
    const vertex = nearestVertexIndex(polyline, condition.location);
    const from = polyline[Math.max(0, vertex - 1)];
    const to = polyline[Math.min(polyline.length - 1, vertex + 1)];
    if (!from || !to) return false;
    coordinates = [
      [from[0]!, from[1]!],
      [to[0]!, to[1]!],
    ];
  }
  let lengthKm = 0;
  for (let i = 1; i < coordinates.length; i += 1) {
    lengthKm += haversineKm(
      coordinates[i - 1]![1]!,
      coordinates[i - 1]![0]!,
      coordinates[i]![1]!,
      coordinates[i]![0]!,
    );
  }

  const plan = planRerouteAroundSegment(day, {
    geometry: { coordinates },
    lengthKm,
  });
  if (!plan) return false;
  insertWaypointBefore(
    bestDayIndex,
    plan.insertBeforeWaypointId,
    rerouteViaWaypoint(plan, `condition-${condition.id}`),
  );
  return true;
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
  segment: RerouteTarget,
): { lng: number; lat: number } | null {
  const coordinates = segment.geometry.coordinates;
  const middle = coordinates[Math.floor(coordinates.length / 2)];
  const [lng, lat] = middle ?? [];
  if (typeof lng !== "number" || typeof lat !== "number") return null;
  return { lng, lat };
}

function offsetPerpendicular(
  segment: RerouteTarget,
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

/**
 * The waypoint to insert a point-anchored stop BEFORE so it lands at its
 * along-route position: the first non-start waypoint whose nearest route
 * vertex is at/after the point's. Null (= insert before the finish) when
 * the day has no usable geometry — appending is the only honest option
 * pre-route.
 */
export function insertionAnchorForPoint(
  day: Pick<TripDay, "routeGeometry" | "waypoints">,
  location: { lat: number; lng: number },
): string | null {
  const polyline = day.routeGeometry?.coordinates;
  if (!polyline || polyline.length < 2) return null;
  const pointVertex = nearestVertexIndex(polyline, location);
  for (const waypoint of day.waypoints) {
    if (waypoint.type === "start") continue;
    if (nearestVertexIndex(polyline, waypoint.location) >= pointVertex) {
      return waypoint.id;
    }
  }
  return null;
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
