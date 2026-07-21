/**
 * Mobile rider-profile formatters (US-27).
 *
 * The platform-agnostic helpers (`formatJoinedLabel`, `formatCount`,
 * `initialsFromName`) live in `@tarmoto/shared/rider-format` so mobile
 * and companion render the same labels from one source of truth. This
 * file re-exports them for mobile-side imports and adds
 * `formatFollowedSince`, which is mobile-only — companion doesn't have
 * a follower/following list screen yet.
 */

export { formatCount, formatJoinedLabel } from "@tarmoto/shared";
import { getFormatters } from "@/format";
import { translate } from "@/i18n";

/**
 * "Follower since 5 May 2026" / "Following since 5 May 2026" — used on the
 * followers/following list rows. The mode flips the leading verb so the
 * Followers list reads correctly ("Follower since X" — the row user is a
 * follower of the profile being viewed) instead of always-"Following since
 * X", which incorrectly implied the viewer was following each row. Uses
 * Date formatting follows the active rider/device locale and timezone.
 */
export function formatFollowedSince(
  followedAt: string,
  mode: "followers" | "following",
): string {
  const date = new Date(followedAt);
  const verb =
    mode === "followers" ? translate("Follower") : translate("Following");
  if (Number.isNaN(date.getTime())) return verb;
  return translate("{relation} since {date}", {
    relation: verb,
    date: getFormatters().date(date),
  });
}
