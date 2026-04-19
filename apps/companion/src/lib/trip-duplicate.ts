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
      ...day,
      waypoints: day.waypoints.map((wp) => ({ ...wp })),
    })),
    parameters: {
      ...trip.parameters,
      surfacePreference: [...trip.parameters.surfacePreference],
    },
  };
  if (trip.description) payload.description = trip.description;
  if (trip.folderId) payload.folderId = trip.folderId;
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
