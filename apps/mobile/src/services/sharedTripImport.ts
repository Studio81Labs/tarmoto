/**
 * Mobile-side glue for the "Push to mobile" deep-link flow (US-39 / #283).
 * Web companion mints a trip share, then opens
 * `tarmoto://trips/import?tripId=...&token=...`. The screen fetches the
 * share via `/trip-shares/:token` for the preview UI; on confirmation it
 * posts the token to `/trips/from-share` (#357), which reconstructs the
 * full multi-day structure server-side.
 *
 * This module previously also exported `sharedSnapshotToImportRequest`,
 * which collapsed multi-day snapshots into a single-day `/trips/import`
 * request because the legacy import endpoint only stored one geometry
 * per trip. The new `/trips/from-share` endpoint preserves the day
 * breakdown, so the lossy flattening helper has been removed.
 */

import type { TripSharePublic } from "@/types";

export interface SharedTripPreview {
  title: string;
  ownerName: string;
  dayCount: number;
  totalDistanceKm: number;
  /**
   * Count of intermediate stops only (start/end are excluded). The
   * import-screen UI labels this "Stops", which a rider expects to mean
   * fuel/rest/photo/accommodation/via points — not "every waypoint
   * including start and end".
   */
  stopCount: number;
}

interface SnapshotDay {
  waypoints?: Array<{ type?: unknown }>;
  distanceKm?: unknown;
}

// Waypoint `type` values that are intermediate stops a rider would
// actually plan around. `start` and `end` describe the trip envelope and
// don't belong in a "stops" count.
const STOP_WAYPOINT_TYPES = new Set([
  "via",
  "fuel",
  "rest",
  "photo",
  "accommodation",
]);

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
  let stopCount = 0;
  for (const day of snapshot.days) {
    if (typeof day.distanceKm === "number" && Number.isFinite(day.distanceKm)) {
      totalDistanceKm += day.distanceKm;
    }
    if (Array.isArray(day.waypoints)) {
      for (const wp of day.waypoints) {
        if (typeof wp.type === "string" && STOP_WAYPOINT_TYPES.has(wp.type)) {
          stopCount += 1;
        }
      }
    }
  }
  return {
    title:
      share.title ||
      (typeof snapshot.name === "string" ? snapshot.name : "Shared trip"),
    ownerName: share.owner_name,
    dayCount: snapshot.days.length,
    totalDistanceKm,
    stopCount,
  };
}
