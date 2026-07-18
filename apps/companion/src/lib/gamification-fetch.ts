/**
 * Fetcher for the gamification dashboard (US-57).
 *
 * The dashboard composes three independent backend reads:
 *   - GET /users/{userId}/badges       → badge list with per-tier progress
 *   - GET /challenges                  → active challenges
 *   - GET /challenges/{id}             → my_progress + participant count per
 *                                        active challenge (parallel)
 *
 * The multi-dimensional regional leaderboard
 * (`GET /leaderboards/regional`) is fetched on its own from the dashboard
 * widget — region selection is interactive, so it isn't part of the
 * one-shot `fetchGamificationSnapshot`.
 */

import type { components } from "@tarmoto/openapi-client";
import { api } from "@/lib/api";
import { t } from "@/i18n";
import {
  buildLiveSnapshot,
  mapRegionalLeaderboards,
  type GamificationSnapshot,
  type RegionalLeaderboards,
} from "@/lib/gamification";

type BadgeDto = components["schemas"]["BadgeDto"];
type ChallengeDto = components["schemas"]["ChallengeDto"];
type ChallengeDetailDto = components["schemas"]["ChallengeDetailDto"];
type MeProfileDto = components["schemas"]["MeProfileDto"];
export type RiderProgression = components["schemas"]["ProgressionDto"];

export class GamificationFetchError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "GamificationFetchError";
    this.status = status;
  }
}

function errorMessage(error: unknown, fallback: string): string {
  if (error && typeof error === "object" && "message" in error) {
    const m = (error as { message?: unknown }).message;
    if (typeof m === "string" && m.length > 0) return m;
  }
  return fallback;
}

export interface FetchOptions {
  /** Aborts the in-flight fetch when triggered (page unmount, user switch). */
  signal?: AbortSignal | undefined;
}

// Capturing `response.status` before the `error` narrow avoids an
// openapi-fetch typing quirk: in the discriminated union `{ data, error?,
// response } | { data?, error, response }`, narrowing on `error` collapses
// `response` to `never`, even though both branches share `response: Response`.
// Reading `response.status` up front sidesteps the narrow entirely.

export async function fetchBadges(
  userId: string,
  options: FetchOptions = {},
): Promise<BadgeDto[]> {
  const { data, error, response } = await api.GET(
    "/api/v1/users/{userId}/badges",
    {
      params: { path: { userId } },
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    },
  );
  const status = response.status;
  if (error) {
    throw new GamificationFetchError(
      errorMessage(error, "Could not load badges"),
      status,
    );
  }
  return data ?? [];
}

export async function fetchActiveChallenges(
  options: FetchOptions = {},
): Promise<ChallengeDto[]> {
  const { data, error, response } = await api.GET("/api/v1/challenges", {
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  });
  const status = response.status;
  if (error) {
    throw new GamificationFetchError(
      errorMessage(error, "Could not load challenges"),
      status,
    );
  }
  return data ?? [];
}

export async function fetchMeProfile(
  options: FetchOptions = {},
): Promise<MeProfileDto> {
  const { data, error, response } = await api.GET("/api/v1/users/me/profile", {
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  });
  const status = response.status;
  if (error || !data) {
    throw new GamificationFetchError(
      errorMessage(error, "Could not load your profile summary"),
      status,
    );
  }
  return data;
}

export async function fetchProgression(
  options: FetchOptions = {},
): Promise<RiderProgression> {
  const { data, error, response } = await api.GET(
    "/api/v1/users/me/progression",
    { ...(options.signal !== undefined ? { signal: options.signal } : {}) },
  );
  const status = response.status;
  if (error || !data) {
    throw new GamificationFetchError(
      errorMessage(error, "Could not load your progression"),
      status,
    );
  }
  return data;
}

export async function fetchChallengeDetail(
  challengeId: string,
  options: FetchOptions = {},
): Promise<ChallengeDetailDto> {
  const { data, error, response } = await api.GET(
    "/api/v1/challenges/{challengeId}",
    {
      params: { path: { challengeId } },
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    },
  );
  const status = response.status;
  if (error || !data) {
    throw new GamificationFetchError(
      errorMessage(error, "Could not load challenge details"),
      status,
    );
  }
  return data;
}

/**
 * Joins a challenge by its id. Treats 409 (already joined) as success so
 * a click that races against an existing entry doesn't surface an error.
 * 404 / other errors propagate so the page can show a toast.
 */
export async function joinChallenge(challengeId: string): Promise<void> {
  const { error, response } = await api.POST(
    "/api/v1/challenges/{challengeId}/join",
    { params: { path: { challengeId } } },
  );
  const status = response.status;
  if (!error) return;
  if (status === 409) return;
  throw new GamificationFetchError(
    errorMessage(error, "Could not join challenge"),
    status,
  );
}

/**
 * Loads the snapshot of badges + challenges + rider summary for the
 * signed-in rider. The three top-level reads (badges, active challenges,
 * `/users/me/profile`) run in parallel; per-challenge details fan out in
 * a second parallel batch. A failure in any step throws so the caller can
 * render a single error fallback rather than a half-populated page.
 *
 * The me-profile read backfills `totalHours` and `joinedAt` on
 * `RiderStats`, both of which the badges endpoint does not expose
 * (issue #334).
 *
 * The optional `signal` cancels every in-flight request when the page
 * unmounts or the user switches accounts, so abandoned fetches stop
 * consuming network and backend capacity.
 */
export async function fetchGamificationSnapshot(
  userId: string,
  options: FetchOptions = {},
): Promise<GamificationSnapshot> {
  const { signal } = options;
  const [badges, challenges, meProfile] = await Promise.all([
    fetchBadges(userId, { signal }),
    fetchActiveChallenges({ signal }),
    fetchMeProfile({ signal }),
  ]);
  const challengeDetails = await Promise.all(
    challenges.map((c) => fetchChallengeDetail(c.id, { signal })),
  );
  return buildLiveSnapshot({ badges, challengeDetails, meProfile }, t);
}

export interface FetchRegionalLeaderboardsOptions extends FetchOptions {
  /**
   * Region filter — matched case-insensitively against the rider's
   * `home_region` server-side. Omit for a global ranking.
   */
  region?: string | null;
  /** Top-N rows returned per dimension (1..100, defaults server-side to 20). */
  limit?: number;
  /**
   * The signed-in rider's id, used by the mapper to flag the `isMe` row in
   * each dimension. The backend already returns the rider's row as `me`, but
   * letting the client tag entries lets the table highlight rows that show
   * up in both `entries` and `me`.
   */
  currentUserId?: string | null;
}

/**
 * Fetches the multi-dimensional regional leaderboards (km / roads / hazards)
 * for the gamification dashboard's leaderboard widget. Returns a typed
 * client-side `RegionalLeaderboards` shape rather than the raw DTO so the
 * `isMe` highlight is consistent with the rest of the dashboard.
 */
export async function fetchRegionalLeaderboards(
  options: FetchRegionalLeaderboardsOptions = {},
): Promise<RegionalLeaderboards> {
  const region = options.region?.trim() ?? "";
  const query: { region?: string; limit?: number } = {};
  if (region.length > 0) query.region = region;
  if (options.limit !== undefined) query.limit = options.limit;

  const { data, error, response } = await api.GET(
    "/api/v1/leaderboards/regional",
    {
      params: { query },
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    },
  );
  const status = response.status;
  if (error || !data) {
    throw new GamificationFetchError(
      errorMessage(error, "Could not load regional leaderboards"),
      status,
    );
  }
  return mapRegionalLeaderboards(data, options.currentUserId ?? null);
}
