import type { Trip } from "@/lib/types";
import { t as translate, type Translate } from "@/i18n";

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
  folder_id?: string | null;
}

export interface DuplicateTripContext {
  /**
   * Whether the rider invoking the duplicate owns the source trip.
   * Folders are private per-user (US-37): the backend's `POST /trips`
   * folder-ownership check resolves `folder_id` against the *calling*
   * user's folders, so blindly forwarding the source's `folder_id`
   * 404s every duplicate a co-collaborator runs against a filed trip.
   * The companion mirrors the same guard the server-side
   * `POST /trips/:tripId/duplicate` path applies.
   */
  isOwner: boolean;
}

export function duplicateTripPayload(
  trip: Trip,
  context: DuplicateTripContext = { isOwner: true },
  t: Translate = translate,
): TripDuplicatePayload {
  const payload: TripDuplicatePayload = {
    name: nextCopyName(trip.name, t),
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
  // Only carry the source folder forward when the duplicating rider
  // actually owns the source trip. A collaborator's duplicate lands
  // unfiled rather than 404-ing the whole request — the rider can
  // re-file the copy from their own folder list afterwards.
  if (context.isOwner && trip.folder_id !== undefined) {
    payload.folder_id = trip.folder_id;
  }
  return payload;
}

/**
 * Generates the next " (copy)" / " (copy 2)" / … suffix.
 * Exposed for unit tests and so the UI can show the same name optimistically
 * before the backend round-trip.
 */
export function nextCopyName(name: string, t: Translate = translate): string {
  const base = name.replace(/\s+\(copy(?:\s+\d+)?\)$/i, "").trim() || t("Trip");
  return t("{name} (copy)", { name: base });
}
