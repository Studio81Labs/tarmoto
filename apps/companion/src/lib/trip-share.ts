import { API_BASE_SERVER } from "@/lib/config";
import type { RoutePoint } from "@/lib/ride-detail";
import type { Trip, TripDay, Waypoint } from "@/lib/types";

export interface TripSharePublic {
  share_token: string;
  title: string;
  owner_name: string;
  snapshot: Record<string, unknown>;
  view_count: number;
  created_at: string;
  updated_at: string;
}

export async function fetchSharedTrip(
  token: string,
): Promise<TripSharePublic | null> {
  const res = await fetch(
    `${API_BASE_SERVER}/trip-shares/${encodeURIComponent(token)}`,
    { cache: "no-store" },
  );

  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`GET /trip-shares/${token} failed (${res.status})`);
  }

  return (await res.json()) as TripSharePublic;
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
  return Array.isArray(waypoints) && waypoints.every(isWaypoint);
}

function isWaypoint(candidate: unknown): candidate is Waypoint {
  if (typeof candidate !== "object" || candidate === null) return false;
  const location = (candidate as { location?: unknown }).location;
  if (typeof location !== "object" || location === null) return false;
  const { lat, lng } = location as { lat?: unknown; lng?: unknown };
  return typeof lat === "number" && typeof lng === "number";
}

/**
 * Flatten a trip's day-level route geometry into a single polyline for the
 * preview SVG. Falls back to waypoint coordinates for days that don't carry
 * a stored `routeGeometry` (e.g. imported trips).
 */
export function flattenTripRoute(trip: Trip): RoutePoint[] {
  const out: RoutePoint[] = [];
  for (const day of trip.days) {
    if (day.routeGeometry?.coordinates?.length) {
      for (const [lng, lat] of day.routeGeometry.coordinates) {
        if (Number.isFinite(lat) && Number.isFinite(lng)) {
          out.push({ lat, lng });
        }
      }
      continue;
    }
    for (const wp of day.waypoints) {
      out.push({ lat: wp.location.lat, lng: wp.location.lng });
    }
  }
  return out;
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
