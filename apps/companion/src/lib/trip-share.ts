import type { TripSharePublic } from "@/lib/api";
import { apiServer } from "@/lib/api/server";
import type { RoutePoint } from "@/lib/ride-detail";
import type { Trip, TripDay, Waypoint } from "@/lib/types";

// Re-exported so server-side callers keep importing `TripSharePublic`
// from this module (alongside `fetchSharedTrip`) without reaching into
// the client-side `api.ts` module for a type definition.
export type { TripSharePublic };

export async function fetchSharedTrip(
  token: string,
): Promise<TripSharePublic | null> {
  const { data, response } = await apiServer.GET(
    "/api/v1/trip-shares/{token}",
    {
      params: { path: { token } },
      cache: "no-store",
    },
  );

  if (response.status === 404) return null;
  // Branch on HTTP status, not `error`: openapi-fetch leaves `error` unset for
  // an empty-body 5xx, which would otherwise collapse an outage into a 404.
  if (!response.ok) {
    throw new Error(`GET /trip-shares/${token} failed (${response.status})`);
  }

  return data ?? null;
}

/**
 * Narrow the opaque snapshot blob into the companion's `Trip` type.
 *
 * The backend stores the snapshot as untyped JSONB so the server doesn't
 * need to track client schema changes. This check only validates the
 * minimum shape the read-only viewer relies on — `days[].waypoints[]` and
 * (optionally) `routeGeometry` — so an older or malformed snapshot
 * degrades to "no route" rather than crashing the page.
 */
export function parseTripSnapshot(
  snapshot: Record<string, unknown>,
): Trip | null {
  if (typeof snapshot !== "object" || snapshot === null) return null;
  const days = (snapshot as { days?: unknown }).days;
  if (!Array.isArray(days)) return null;
  if (!days.every(isTripDay)) return null;
  return snapshot as unknown as Trip;
}

function isTripDay(candidate: unknown): candidate is TripDay {
  if (typeof candidate !== "object" || candidate === null) return false;
  const waypoints = (candidate as { waypoints?: unknown }).waypoints;
  if (!Array.isArray(waypoints) || !waypoints.every(isWaypoint)) return false;
  // `routeGeometry` is optional (imported trips often lack it), but when
  // present `tripRouteLines` destructures each entry as `[lng, lat]`.
  // Reject malformed coordinate arrays here so a payload like
  // `{ coordinates: [1, 2, 3] }` routes to the "unexpected format" viewer
  // branch instead of crashing SSR with a TypeError at render time.
  const routeGeometry = (candidate as { routeGeometry?: unknown })
    .routeGeometry;
  if (routeGeometry !== undefined && !isLineStringGeometry(routeGeometry)) {
    return false;
  }
  return true;
}

function isLineStringGeometry(candidate: unknown): boolean {
  if (typeof candidate !== "object" || candidate === null) return false;
  const coordinates = (candidate as { coordinates?: unknown }).coordinates;
  // Geometry is only consumed when coordinates exist; absent/empty coords
  // are allowed — `tripRouteLines` already falls back to waypoints.
  if (coordinates === undefined) return true;
  if (!Array.isArray(coordinates)) return false;
  return coordinates.every(
    (entry) =>
      Array.isArray(entry) &&
      entry.length >= 2 &&
      typeof entry[0] === "number" &&
      typeof entry[1] === "number",
  );
}

const WAYPOINT_TYPES: ReadonlySet<Waypoint["type"]> = new Set([
  "start",
  "via",
  "end",
  "fuel",
  "rest",
  "photo",
  "accommodation",
]);

function isWaypoint(candidate: unknown): candidate is Waypoint {
  if (typeof candidate !== "object" || candidate === null) return false;
  const location = (candidate as { location?: unknown }).location;
  if (typeof location !== "object" || location === null) return false;
  const { lat, lng } = location as { lat?: unknown; lng?: unknown };
  if (typeof lat !== "number" || typeof lng !== "number") return false;
  // `type` is required by the Waypoint contract and is read at render time
  // (`waypointLabel` dereferences `type[0]`). Reject payloads that omit it
  // or supply an unknown value so legacy/malformed snapshots route into the
  // "unexpected format" viewer branch instead of crashing SSR.
  const type = (candidate as { type?: unknown }).type;
  return (
    typeof type === "string" && WAYPOINT_TYPES.has(type as Waypoint["type"])
  );
}

/**
 * Split a trip's route geometry into one polyline per day for the preview SVG.
 * Falls back to a day's waypoint coordinates when it carries no stored
 * `routeGeometry` (e.g. imported trips). Keeping days separate lets the preview
 * avoid bridging non-adjacent days with an artificial straight segment.
 */
export function tripRouteLines(trip: Trip): RoutePoint[][] {
  const lines: RoutePoint[][] = [];
  for (const day of trip.days) {
    const line: RoutePoint[] = [];
    if (day.routeGeometry?.coordinates?.length) {
      for (const entry of day.routeGeometry.coordinates) {
        // `parseTripSnapshot` already validates the coord shape, but this
        // function is callable from other paths (e.g. demo trips) where
        // the snapshot may not have been validated — skip non-pair entries
        // rather than throwing at destructure time.
        if (!Array.isArray(entry) || entry.length < 2) continue;
        const [lng, lat] = entry;
        if (
          typeof lat === "number" &&
          typeof lng === "number" &&
          Number.isFinite(lat) &&
          Number.isFinite(lng)
        ) {
          line.push({ lat, lng });
        }
      }
    } else {
      for (const wp of day.waypoints) {
        line.push({ lat: wp.location.lat, lng: wp.location.lng });
      }
    }
    if (line.length > 0) lines.push(line);
  }
  return lines;
}

/**
 * Intermediate stop waypoints (everything except the route's `start`/`end`
 * bookends) across all days, as plain points. Used both for the "Stops" count
 * and to dot them onto the route preview.
 */
export function tripStops(trip: Trip): RoutePoint[] {
  const stops: RoutePoint[] = [];
  for (const day of trip.days) {
    for (const wp of day.waypoints) {
      if (wp.type === "start" || wp.type === "end") continue;
      stops.push({ lat: wp.location.lat, lng: wp.location.lng });
    }
  }
  return stops;
}

export function tripSummary(trip: Trip): {
  totalDistanceKm: number;
  totalDurationMin: number;
  dayCount: number;
  waypointCount: number;
} {
  let totalDistanceKm = 0;
  let totalDurationMin = 0;
  let waypointCount = 0;
  for (const day of trip.days) {
    totalDistanceKm += day.distanceKm ?? 0;
    totalDurationMin += day.durationMinutes ?? 0;
    waypointCount += day.waypoints.length;
  }
  return {
    totalDistanceKm,
    totalDurationMin,
    dayCount: trip.days.length,
    waypointCount,
  };
}
