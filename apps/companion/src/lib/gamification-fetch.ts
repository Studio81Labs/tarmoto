/**
 * Fetcher for the gamification dashboard (US-57).
 *
 * Composes three real backend endpoints into a single `GamificationSnapshot`:
 *   - GET /users/{userId}/badges       → badge list with per-tier progress
 *   - GET /challenges                  → active challenges
 *   - GET /challenges/{id}             → leaderboard + my_progress per
 *                                        active challenge (parallel)
 *
 * Per-challenge progress is recomputed on every call; the page treats this
 * as cheap enough to refetch on each visit and stale-while-revalidate on
 * window focus.
 */

import type { components } from "@tarmoto/openapi";
import { api } from "@/lib/api";
import {
  buildLiveSnapshot,
  type GamificationSnapshot,
} from "@/lib/gamification";

type BadgeDto = components["schemas"]["BadgeDto"];
type ChallengeDto = components["schemas"]["ChallengeDto"];
type ChallengeDetailDto = components["schemas"]["ChallengeDetailDto"];

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
  signal?: AbortSignal;
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
    { params: { path: { userId } }, signal: options.signal },
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
    signal: options.signal,
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

export async function fetchChallengeDetail(
  challengeId: string,
  options: FetchOptions = {},
): Promise<ChallengeDetailDto> {
  const { data, error, response } = await api.GET(
    "/api/v1/challenges/{challengeId}",
    {
      params: { path: { challengeId } },
      signal: options.signal,
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
 * Loads the full gamification snapshot for the signed-in rider. Badges and
 * challenges run in parallel; per-challenge details fan out in a second
 * parallel batch. A failure in any step throws so the caller can render a
 * single error fallback rather than a half-populated page.
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
  const [badges, challenges] = await Promise.all([
    fetchBadges(userId, { signal }),
    fetchActiveChallenges({ signal }),
  ]);
  const challengeDetails = await Promise.all(
    challenges.map((c) => fetchChallengeDetail(c.id, { signal })),
  );
  return buildLiveSnapshot({
    badges,
    challengeDetails,
    currentUserId: userId,
  });
}
