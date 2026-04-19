import type { Trip } from "@/lib/types";

/**
 * Payload sent to `tripsApi.create` when duplicating a trip. The backend
 * allocates `id`, `createdAt`, `updatedAt`, `collaborators`, and `status`, so
 * we strip those here. A duplicate always lands back in the user's personal
 * workspace as a fresh draft — collaborators and overnight-stop bookings on
 * the original shouldn't leak into the copy.
 */
export interface TripDuplicatePayload {
  name: string;
  description?: string;
  days: Trip["days"];
  parameters: Trip["parameters"];
  folderId?: string;
}

export function duplicateTripPayload(trip: Trip): TripDuplicatePayload {
  const payload: TripDuplicatePayload = {
    name: nextCopyName(trip.name),
    days: trip.days.map((day) => ({
      // Construct each day explicitly rather than spreading, so overnight
      // bookings, cached route geometry, and segment previews don't leak
      // from the original trip into the copy. The backend will recompute
      // those fields when the duplicated trip is next opened.
      dayNumber: day.dayNumber,
      title: day.title,
      waypoints: day.waypoints.map((wp) => ({
        ...wp,
        location: { ...wp.location },
      })),
      distanceKm: day.distanceKm,
      durationMinutes: day.durationMinutes,
      elevationGain: day.elevationGain,
      avgQuality: day.avgQuality,
    })),
    parameters: {
      ...trip.parameters,
      surfacePreference: [...trip.parameters.surfacePreference],
    },
  };
  // Use `!== undefined` rather than truthiness so an intentionally empty
  // description ("") survives duplication instead of being silently dropped.
  if (trip.description !== undefined) payload.description = trip.description;
  if (trip.folderId !== undefined) payload.folderId = trip.folderId;
  return payload;
}

/**
 * Generates the next " (copy)" / " (copy 2)" / … suffix.
 * Exposed for unit tests and so the UI can show the same name optimistically
 * before the backend round-trip.
 */
export function nextCopyName(name: string): string {
  const base = name.replace(/\s+\(copy(?:\s+\d+)?\)$/i, "").trim() || "Trip";
  return `${base} (copy)`;
}
