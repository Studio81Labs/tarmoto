/**
 * Pure formatting helpers for the rider profile screens (US-27).
 *
 * Mirrors the companion's `apps/companion/src/lib/rider-profile.ts` math so
 * the same "Joined 2 months ago" / "Joined this month" labels show on both
 * surfaces without divergence. Kept as separate helpers here (vs importing)
 * because mobile's `@tarmoto/shared` package exposes domain primitives, not
 * date-formatting utilities — and this is small enough to live next to the
 * screen.
 */

/**
 * "Joined this month" / "Joined 5 months ago" / "Joined 2 years ago".
 *
 * Calendar-month arithmetic is intentional — using days would round
 * unevenly across months. The day-of-month back-off keeps "joined Mar 20,
 * now Apr 18" from showing as a full month even though the Date diff
 * crossed a month boundary. UTC accessors avoid timezone drift around
 * midnight in the user's locale flipping the displayed bucket.
 */
export function formatJoinedLabel(
  joinedAt: string,
  now: Date = new Date(),
): string {
  const date = new Date(joinedAt);
  if (Number.isNaN(date.getTime())) return "Joined recently";
  let months =
    (now.getUTCFullYear() - date.getUTCFullYear()) * 12 +
    (now.getUTCMonth() - date.getUTCMonth());
  if (now.getUTCDate() < date.getUTCDate()) months -= 1;
  if (months < 0) months = 0;
  if (months < 1) return "Joined this month";
  if (months < 12)
    return `Joined ${months} month${months === 1 ? "" : "s"} ago`;
  const years = Math.floor(months / 12);
  return `Joined ${years} year${years === 1 ? "" : "s"} ago`;
}

/**
 * "Follower since 5 May 2026" / "Following since 5 May 2026" — used on the
 * followers/following list rows. The mode flips the leading verb so the
 * Followers list reads correctly ("Follower since X" — the row user is a
 * follower of the profile being viewed) instead of the previous always-
 * "Following since X" wording, which incorrectly implied the viewer was
 * following each row. Uses British formatting (DD Mon YYYY) for compactness;
 * matches the rest of the mobile app's date rendering.
 */
export function formatFollowedSince(
  followedAt: string,
  mode: "followers" | "following",
): string {
  const date = new Date(followedAt);
  const verb = mode === "followers" ? "Follower" : "Following";
  if (Number.isNaN(date.getTime())) return verb;
  return `${verb} since ${date.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  })}`;
}

/**
 * Compact follower / following count formatter — keeps the stats row from
 * wrapping when a rider crosses the 1000-follower mark.
 */
export function formatCount(value: number): string {
  if (value < 1_000) return Math.round(value).toLocaleString();
  const k = value / 1000;
  if (k >= 9.95) return `${Math.round(k).toLocaleString()}k`;
  return `${k.toFixed(1)}k`;
}
