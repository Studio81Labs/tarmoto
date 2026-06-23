/**
 * Canonical wire shape for the public rider profile (US-27).
 *
 * Single source of truth — backend `PublicProfileDto` implements this
 * interface (compile-time agreement via `class implements`), mobile and
 * companion both consume it via `import type { PublicProfile } from
 * "@tarmoto/shared"`. A field added here propagates to all three; drift
 * surfaces as a TypeScript error in CI rather than as a runtime mismatch.
 *
 * `is_following` is `null` when `is_self === true` so clients can hide the
 * follow button rather than misleadingly defaulting it to "Follow". 404 from
 * the endpoint covers both a missing row and a soft-deleted user — public
 * profiles must not leak the difference.
 */
export interface PublicProfile {
  id: string;
  display_name: string;
  avatar_url: string | null;
  bio: string | null;
  home_region: string | null;
  /** ISO 8601 join timestamp. */
  created_at: string;
  follower_count: number;
  following_count: number;
  /**
   * Lifetime distance ridden in km, summed over the rider's completed rides.
   * A public vanity stat (the "Road Warrior" distance badge already exposes
   * the same signal); 0 when the rider has no completed rides.
   */
  total_distance_km: number;
  /**
   * Count of the rider's publicly shared rides — the headline number for the
   * "Rides shared" tile. Always the public-share count regardless of viewer,
   * so it stays a stable public metric.
   */
  shared_ride_count: number;
  /** Viewer's follow state on the target. Null when the viewer is the target. */
  is_following: boolean | null;
  /**
   * Whether the target follows the viewer back — drives the "Follows you"
   * badge. Null when the viewer is the target (the relationship is undefined).
   */
  follows_you: boolean | null;
  /** True when the viewer is the target. */
  is_self: boolean;
}
