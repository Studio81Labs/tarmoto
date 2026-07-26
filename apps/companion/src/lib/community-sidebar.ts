/**
 * Data layer for the Community → Feed right sidebar: the active challenge
 * card, the regional "km ridden" leaderboard, and "people you might follow".
 * Each fetch is independent so one failing widget never blanks the others.
 */
import type { components } from "@tarmoto/openapi-client";
import { api } from "./api";
import {
  fetchActiveChallenges,
  fetchChallengeDetail,
} from "./gamification-fetch";
import type { Translate } from "@/i18n";

export type SuggestedRider = components["schemas"]["SuggestedRiderDto"];

/** "People you might follow" — riders the caller doesn't already follow. */
export async function fetchSuggestedRiders(
  limit = 3,
  signal?: AbortSignal,
): Promise<SuggestedRider[]> {
  const { data, error } = await api.GET("/api/v1/users/suggestions", {
    params: { query: { limit: String(limit) } },
    ...(signal !== undefined ? { signal } : {}),
  });
  if (error || !data) return [];
  return data;
}

export interface ActiveChallengeCard {
  id: string;
  contentKey: string;
  metric: string;
  current: number;
  target: number;
  /** Days remaining until the challenge ends (clamped at 0). */
  daysLeft: number;
}

/**
 * The rider's most relevant active challenge with their progress. Returns the
 * soonest-ending active challenge plus `my_progress` from its detail; null when
 * there are no active challenges.
 */
export async function fetchActiveChallengeCard(
  now = new Date(),
  signal: AbortSignal | undefined,
  t: Translate,
): Promise<ActiveChallengeCard | null> {
  const challenges = await fetchActiveChallenges(
    signal !== undefined ? { signal, translate: t } : { translate: t },
  );
  if (challenges.length === 0) return null;
  // Soonest to end so the card reflects the most time-pressured goal.
  const next = [...challenges].sort((a, b) =>
    a.ends_at.localeCompare(b.ends_at),
  )[0]!;
  const detail = await fetchChallengeDetail(
    next.id,
    signal !== undefined ? { signal, translate: t } : { translate: t },
  );
  const endMs = new Date(next.ends_at).getTime();
  const daysLeft = Math.max(0, Math.ceil((endMs - now.getTime()) / 86_400_000));
  return {
    id: next.id,
    contentKey: next.content_key,
    metric: next.metric,
    current: Math.round(detail.my_progress ?? 0),
    target: next.target,
    daysLeft,
  };
}
