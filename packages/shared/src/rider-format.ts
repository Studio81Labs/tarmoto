/**
 * Pure formatting helpers shared by mobile (US-27) and companion (US-54)
 * rider profile surfaces. Pulled into `@tarmoto/shared` so both packages
 * render the same labels — a fix here flows to both at once instead of
 * needing two parallel edits and risking silent divergence.
 *
 * Zero platform-specific dependencies; only `Date` and string APIs.
 */

/**
 * "Joined this month" / "Joined 5 months ago" / "Joined 2 years ago".
 *
 * Calendar-month arithmetic is intentional — using days would round
 * unevenly across months. The day-of-month back-off keeps "joined Mar 20,
 * now Apr 18" from showing as a full month even though the Date diff
 * crossed a month boundary. Future timestamps clamp to "this month" so
 * ledger drift or clock skew never produces "Joined -2 months ago". UTC
 * accessors keep the comparison timezone-agnostic so a user's locale can't
 * flip the displayed bucket.
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
 * Compact count formatter — renders raw counts under 1k as locale-formatted
 * integers and 1k–9.9k with one decimal, then rounds to integer-k at and
 * above 10k so the row doesn't flip from "9.9k" to "10.0k" awkwardly.
 *
 * @param locale - BCP-47 tag applied to the grouping separators. Omitted
 * keeps today's runtime-default `toLocaleString()` behavior unchanged
 * (mobile's existing contract).
 */
export function formatCount(value: number, locale?: string): string {
  if (value < 1_000) return Math.round(value).toLocaleString(locale);
  const k = value / 1000;
  if (k >= 9.95) return `${Math.round(k).toLocaleString(locale)}k`;
  return `${k.toFixed(1)}k`;
}

/**
 * Up to 2 uppercase initials from `name`, falling back to "?" when the
 * input is empty/whitespace-only or yields no alphanumeric characters.
 *
 * Without the empty-word filter, `"  Alice".split(/\s+/)` would emit a
 * leading "" whose first char is `undefined` — joining that produces the
 * literal string "undefined" and the avatar fallback would render the
 * wrong initials.
 */
export function initialsFromName(name: string | null | undefined): string {
  if (!name) return "?";
  const letters = name
    .split(/\s+/)
    .map((word) => word[0])
    .filter((ch): ch is string => typeof ch === "string" && ch.length > 0)
    .join("")
    .slice(0, 2)
    .toUpperCase();
  return letters || "?";
}
