/**
 * Rotation policy for the scoped tile credential both clients append to
 * backend vector-tile requests (#1279).
 *
 * The BACKEND owns the lifetime (`expires_in` on `POST /roads/tiles/token`);
 * this owns only when a client goes back for the next one. Shared because
 * companion and mobile answer the same question with the same numbers, and a
 * divergence would show up as one platform silently dropping to the free zoom
 * cap between rotations — the least visible bug this feature can have.
 */

/**
 * Fraction of a credential's lifetime to spend before rotating. Rotating a
 * little early rather than at expiry means the replacement is in hand before
 * the old one stops resolving, so there is never a window where tiles are
 * fetched anonymously.
 */
const TILE_TOKEN_ROTATION_FRACTION = 0.6;

/**
 * Floor on the rotation interval. A short server TTL must not turn a map into
 * a mint loop; at 30 s the mint cost stays negligible beside the tile traffic
 * it authorises.
 */
const TILE_TOKEN_MIN_ROTATION_MS = 30_000;

/** When to fetch the next tile credential, given the current one's TTL. */
export function tileTokenRotationMs(expiresInSeconds: number): number {
  return Math.max(
    TILE_TOKEN_MIN_ROTATION_MS,
    Math.floor(expiresInSeconds * 1000 * TILE_TOKEN_ROTATION_FRACTION),
  );
}
