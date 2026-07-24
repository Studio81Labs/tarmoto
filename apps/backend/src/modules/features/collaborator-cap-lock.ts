/**
 * Advisory-lock key for the owner's `max_trip_collaborators` cap.
 *
 * EVERY path that grows a trip's collaborator roster — the email invite
 * (`TripsService.invite`) and the public group-link join
 * (`TripSharesService.joinByToken`) — takes `pg_advisory_xact_lock` on THIS
 * one per-trip key before its cap-check + write. Sharing a single key is what
 * makes those paths serialise against EACH OTHER, not merely within
 * themselves: without it an email invite and a link join with one slot left
 * could each observe the same roster count, pass the cap, and both insert —
 * overflowing the owner's paid limit.
 */
export function tripCollaboratorLockKey(tripId: string): string {
  return `trip:collaborators:${tripId}`;
}
