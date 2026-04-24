import type { Waypoint } from "./types";

export const ROUTING_WAYPOINT_TYPES = [
  "start",
  "via",
  "end",
] as const satisfies readonly Waypoint["type"][];

const ROUTING_WAYPOINT_TYPE_SET: ReadonlySet<Waypoint["type"]> = new Set(
  ROUTING_WAYPOINT_TYPES,
);

export function isRoutingWaypoint(waypoint: Pick<Waypoint, "type">): boolean {
  return ROUTING_WAYPOINT_TYPE_SET.has(waypoint.type);
}

export function filterRoutingWaypoints<T extends Pick<Waypoint, "type">>(
  waypoints: readonly T[],
): T[] {
  return waypoints.filter(isRoutingWaypoint);
}
