/**
 * Canonical wire shape for the authenticated rider's own profile summary,
 * served by `GET /users/me/profile`.
 *
 * Closes the gap left by PR #302 — the gamification dashboard had to fall
 * back to `totalHours: 0` and `joinedAt: epoch` because no backend endpoint
 * exposed them. This summary surfaces the few fields the badges endpoint
 * does not (joined date, ride duration) plus the basic counts the profile
 * surfaces want without making the client compose three separate calls.
 *
 * Backend `MeProfileDto` implements this interface (compile-time agreement
 * via `class implements`); mobile and companion both consume it via
 * `import type { MeProfile } from "@tarmoto/shared"`. A field added here
 * propagates to all three; drift surfaces as a TypeScript error in CI.
 */
export interface MeProfile {
  /** ISO 8601 join timestamp (`users.created_at`). */
  joined_at: string;
  /** Total ride time in hours, summed across `status = 'completed'` rides. */
  total_hours: number;
  /** Count of completed rides. */
  total_rides: number;
  /** Sum of `distance_km` across completed rides. Stored in metric, the
   * client converts for display via `@tarmoto/shared` unit helpers. */
  total_distance_km: number;
  /** Distinct road segments ridden across completed rides. */
  roads_discovered: number;
  /** Count of hazard reports authored by the rider. */
  hazards_reported: number;
  /** Followers count (riders following the user). */
  follower_count: number;
  /** Following count (riders the user follows). */
  following_count: number;
  /** Count of badges the rider has earned at any tier. */
  badges_earned: number;
}
