import { EntityManager } from 'typeorm';
import { isWithinLimit } from '@tarmoto/shared';
import { featureLimitExceeded } from './feature-limit.error.js';

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

/**
 * Enforce the owner's `max_trip_collaborators` cap inside a caller's
 * transaction `manager` (which must already hold `tripCollaboratorLockKey`).
 * Throws `featureLimitExceeded` if a new collaborator would exceed it.
 *
 * `limit` is resolved by the CALLER, OUTSIDE the transaction: `FeatureResolver`
 * reads through the global connection pool, so doing it while the txn holds the
 * advisory lock would let concurrent waiters exhaust the pool and starve the
 * lock-holder of the connection it needs to commit — a deadlock. `null` means
 * unlimited, so the count is skipped entirely.
 *
 * The roster (non-owner members + pending invites) is counted in ONE SQL
 * statement — a single MVCC snapshot. Two separate counts could straddle a
 * concurrent invite ACCEPTANCE (member insert + invite delete, which does not
 * take this lock): reading members before it commits and invites after would
 * miss the collaborator in BOTH tables and undercount the roster by one,
 * admitting a visitor past the cap. One snapshot always counts them exactly
 * once, whichever table the row is in at that instant.
 */
export async function assertWithinCollaboratorLimit(
  manager: EntityManager,
  tripId: string,
  limit: number | null,
): Promise<void> {
  if (limit === null) return; // unlimited — skip the count entirely
  const rows: Array<{ current: number | string }> = await manager.query(
    `SELECT
       (SELECT COUNT(*) FROM trip_members WHERE trip_id = $1 AND role <> 'owner')
     + (SELECT COUNT(*) FROM trip_invites WHERE trip_id = $1) AS current`,
    [tripId],
  );
  const current = Number(rows[0]?.current ?? 0);
  if (!isWithinLimit(limit, current)) {
    throw featureLimitExceeded('max_trip_collaborators', limit, current);
  }
}
