/**
 * Rider profile fetch + follow helpers (US-345 convergence).
 *
 * Companion and mobile both consume the same public profile shape from the
 * same endpoint:
 *
 *   GET /users/:userId/profile  ->  PublicProfile  (defined in @tarmoto/shared)
 *   POST/DELETE /users/:userId/follow
 *   GET /users/:userId/badges    ->  UserBadge[]
 *
 * The previous companion implementation targeted a still-unbuilt
 * `/community/riders/:id` endpoint with a richer demo-fed payload (bikes,
 * recent rides, collections). Issue #345 collapses the two contracts onto
 * the basic shape — fields that don't have a real source on the backend are
 * dropped here rather than faked client-side, preventing both clients from
 * silently displaying different data for the same rider.
 *
 * Formatters live in `@tarmoto/shared` so mobile and companion render the
 * same labels; we re-export them so existing companion call sites that
 * import from `@/lib/rider-profile` keep working.
 */

import {
  formatCount as formatCountLocale,
  formatJoinedLabel,
  initialsFromName,
  type PublicProfile,
} from "@tarmoto/shared";
import type { components } from "@tarmoto/openapi-client";
import { api, ApiError } from "@/lib/api";
import type { Translate } from "@/i18n";

export { formatJoinedLabel, initialsFromName };
export type { PublicProfile };

/**
 * Re-exports the shared `formatCount` with `locale` required rather than
 * optional. Every companion call site renders inside a `Formatters` context
 * (`useFormat()`), so there's no legitimate reason to fall back to the
 * shared helper's environment-default locale here — requiring the argument
 * makes a forgotten `format.locale` a typecheck failure instead of a silent
 * wrong-locale render.
 */
export function formatCount(value: number, locale: string): string {
  return formatCountLocale(value, locale);
}

/** UI badge entry — the generated `BadgeDto`. */
export type UserBadge = components["schemas"]["BadgeDto"];

export class RiderProfileNotFoundError extends Error {
  constructor(public readonly riderId: string) {
    super(`Rider ${riderId} not found`);
    this.name = "RiderProfileNotFoundError";
  }
}

export class RiderProfileFetchError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "RiderProfileFetchError";
  }
}

/**
 * Loads the rider's public profile via the typed openapi client. 404s
 * surface as `RiderProfileNotFoundError` so the page can render its
 * not-found state — the backend already conflates "missing" and
 * "soft-deleted" / "hidden by privacy" behind a 404, so the client has
 * nothing more to disambiguate. Other non-OK statuses raise
 * `RiderProfileFetchError` carrying the status code, mirroring the
 * pre-convergence error contract used by the page.
 */
export async function fetchPublicProfile(
  riderId: string,
  options: { signal?: AbortSignal; translate: Translate },
): Promise<PublicProfile> {
  const result = await api.GET("/api/v1/users/{userId}/profile", {
    params: { path: { userId: riderId } },
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  });
  if (result.error) {
    const status =
      typeof result.response?.status === "number" ? result.response.status : 0;
    // 400 = a malformed rider id in the URL (e.g. /community/fee) — as
    // dead a link as a missing rider, so both render the 404 screen.
    if (status === 404 || status === 400) {
      throw new RiderProfileNotFoundError(riderId);
    }
    throw new RiderProfileFetchError(
      options.translate("Could not load rider profile"),
      status,
    );
  }
  if (!result.data) {
    throw new RiderProfileFetchError(
      options.translate("Could not load rider profile"),
      result.response?.status ?? 0,
    );
  }
  return result.data;
}

export type PublicBadgesResult =
  | { status: "ok"; badges: UserBadge[] }
  | { status: "failed" };

/**
 * Loads the rider's badges.
 *
 * REPORTS failure rather than resolving to an empty list. The badge shelf
 * renders "No badges earned yet" from an empty result — a claim about the
 * RIDER, which a transient gamification-service hiccup must not be able to
 * make on their behalf. Swallowing to `[]` also made every caller's error
 * handling unreachable, since nothing but an abort ever rejected.
 *
 * The caller decides what a failure costs: the profile page keeps its other
 * sections up and says the shelf failed, so a bad badge request still cannot
 * take the page down.
 *
 * `AbortError` propagates so a cancelled effect can ignore it rather than
 * paint a failure for a request it abandoned.
 */
export async function fetchPublicBadges(
  riderId: string,
  options: { signal?: AbortSignal } = {},
): Promise<PublicBadgesResult> {
  try {
    const result = await api.GET("/api/v1/users/{userId}/badges", {
      params: { path: { userId: riderId } },
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    });
    if (result.error || !result.data) return { status: "failed" };
    return { status: "ok", badges: result.data as UserBadge[] };
  } catch (err) {
    if ((err as { name?: string })?.name === "AbortError") throw err;
    return { status: "failed" };
  }
}

/**
 * 409 (already following) on POST and 404 (not following) on DELETE are
 * idempotent from the user's perspective — swallow them so the optimistic
 * UI doesn't flicker when a stale state races against a click.
 */
export async function followRider(
  riderId: string,
  t: Translate,
): Promise<void> {
  const result = await api.POST("/api/v1/users/{userId}/follow", {
    params: { path: { userId: riderId } },
  });
  if (!result.error) return;
  const status = result.response?.status ?? 0;
  if (status === 409) return;
  throw new ApiError(t("Could not update follow"), status, result.error, true);
}

export async function unfollowRider(
  riderId: string,
  t: Translate,
): Promise<void> {
  const result = await api.DELETE("/api/v1/users/{userId}/follow", {
    params: { path: { userId: riderId } },
  });
  if (!result.error) return;
  const status = result.response?.status ?? 0;
  if (status === 404) return;
  throw new ApiError(t("Could not update follow"), status, result.error, true);
}
