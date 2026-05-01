/**
 * Mobile-side glue for the "Push to mobile" deep-link flow (US-39 / #283).
 * Web companion mints a trip share, then opens
 * `tarmoto://trips/import?tripId=...&token=...`. This module fetches the
 * share by token and flattens the snapshot into the request body the
 * existing `POST /trips/import` endpoint already accepts — no new backend
 * surface needed.
 *
 * The mapping is intentionally lossy: multi-day structure collapses into
 * a single planned day because the import endpoint stores one geometry
 * per trip. The rider can split it after import in the web planner; the
 * mobile-side library entry preserves the title, geometry, and stops
 * which is what's needed in the tank bag.
 */

import type { TripSharePublic } from "@/types";

export interface SharedTripImportRequest {
  title: string;
  region?: string;
  source_format: "gpx" | "kml";
  geometry: Array<{ lat: number; lng: number }>;
  waypoints?: Array<{ lat: number; lng: number; name?: string }>;
}

export interface SharedTripPreview {
  title: string;
  ownerName: string;
  dayCount: number;
  totalDistanceKm: number;
  waypointCount: number;
}

interface SnapshotDay {
  routeGeometry?: { coordinates?: unknown };
  waypoints?: Array<{
    location?: { lat?: unknown; lng?: unknown };
    name?: unknown;
  }>;
  distanceKm?: unknown;
}

interface SnapshotShape {
  name?: unknown;
  description?: unknown;
  days?: SnapshotDay[];
}

/**
 * Build a small preview the rider sees before confirming the import.
 * Returns null when the snapshot is malformed so the screen can show an
 * error instead of crashing on `.days.map(...)`.
 */
export function buildSharedTripPreview(
  share: TripSharePublic,
): SharedTripPreview | null {
  const snapshot = share.snapshot as SnapshotShape;
  if (!snapshot || !Array.isArray(snapshot.days)) return null;
  let totalDistanceKm = 0;
  let waypointCount = 0;
  for (const day of snapshot.days) {
    if (typeof day.distanceKm === "number" && Number.isFinite(day.distanceKm)) {
      totalDistanceKm += day.distanceKm;
    }
    if (Array.isArray(day.waypoints)) waypointCount += day.waypoints.length;
  }
  return {
    title:
      share.title ||
      (typeof snapshot.name === "string" ? snapshot.name : "Shared trip"),
    ownerName: share.owner_name,
    dayCount: snapshot.days.length,
    totalDistanceKm,
    waypointCount,
  };
}

/**
 * Convert a shared trip snapshot into the request body the existing
 * `POST /trips/import` endpoint accepts. Returns null when the snapshot
 * has no usable geometry — callers should refuse to import in that case
 * rather than POSTing an empty geometry that the backend would reject.
 */
export function sharedSnapshotToImportRequest(
  share: TripSharePublic,
): SharedTripImportRequest | null {
  const snapshot = share.snapshot as SnapshotShape;
  if (!snapshot || !Array.isArray(snapshot.days)) return null;

  const geometry: Array<{ lat: number; lng: number }> = [];
  const waypoints: Array<{ lat: number; lng: number; name?: string }> = [];

  for (const day of snapshot.days) {
    const coords = day.routeGeometry?.coordinates;
    if (Array.isArray(coords)) {
      for (const entry of coords) {
        if (!Array.isArray(entry) || entry.length < 2) continue;
        const [lng, lat] = entry as [unknown, unknown];
        if (
          typeof lat === "number" &&
          typeof lng === "number" &&
          Number.isFinite(lat) &&
          Number.isFinite(lng)
        ) {
          geometry.push({ lat, lng });
        }
      }
    }
    if (Array.isArray(day.waypoints)) {
      for (const wp of day.waypoints) {
        const lat = wp.location?.lat;
        const lng = wp.location?.lng;
        if (
          typeof lat === "number" &&
          typeof lng === "number" &&
          Number.isFinite(lat) &&
          Number.isFinite(lng)
        ) {
          waypoints.push({
            lat,
            lng,
            name: typeof wp.name === "string" ? wp.name : undefined,
          });
        }
      }
    }
  }

  // No usable geometry means the snapshot was waypoints-only or malformed;
  // fall back to the waypoint coords so the rider at least gets the stop
  // list imported. The backend's import endpoint requires at least 2
  // points. We REPLACE rather than append: a single salvaged point from a
  // mostly-malformed geometry would otherwise prefix the waypoint
  // fallback with an arbitrary mid-route coordinate and draw the
  // imported route from there to the first stop, which is wrong.
  if (geometry.length < 2) {
    if (waypoints.length < 2) return null;
    geometry.length = 0;
    geometry.push(...waypoints.map((w) => ({ lat: w.lat, lng: w.lng })));
  }

  return {
    title:
      share.title ||
      (typeof snapshot.name === "string" ? snapshot.name : "Shared trip"),
    // Mark the imported snapshot as GPX-source: the backend doesn't
    // distinguish "from share" from "from GPX file" today, and GPX is the
    // safer default since it round-trips waypoint positions cleanly.
    source_format: "gpx",
    geometry,
    waypoints: waypoints.length > 0 ? waypoints : undefined,
  };
}
