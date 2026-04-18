/**
 * Hook backing the US-15 "Proactive commute hazard warnings" surface.
 *
 * Loads the rider's primary commute route and current commute status, and
 * augments the hazards with a `isNew` flag derived from the last-seen
 * snapshot in `useCommuteStore`. The snapshot is only advanced when the
 * caller calls `acknowledge()` — that way a rider who opens the screen
 * briefly, scrolls away, and comes back still sees the same NEW markers
 * until they choose to dismiss them.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import type { CommuteRoute, CommuteStatus, Hazard } from "@/types";
import { api } from "@/services/api";
import { diffNewHazards, useCommuteStore } from "@/stores";

export type CommutePhase =
  | "loading"
  | "learning" // not enough rides yet to have a primary commute
  | "ready"
  | "error";

export interface CommuteHazardView extends Hazard {
  isNew: boolean;
}

export interface UseCommuteResult {
  phase: CommutePhase;
  route: CommuteRoute | null;
  status: CommuteStatus | null;
  hazards: CommuteHazardView[];
  newHazardCount: number;
  errorMessage: string | null;
  /** Pull-to-refresh from the ready state — keeps existing data visible. */
  refresh: () => Promise<void>;
  /** Error-state retry — goes back through the full loading spinner. */
  retry: () => Promise<void>;
  /** Mark every currently-visible hazard as seen (dismiss NEW markers). */
  acknowledge: () => void;
  isRefreshing: boolean;
}

export function useCommute(): UseCommuteResult {
  const [route, setRoute] = useState<CommuteRoute | null>(null);
  const [status, setStatus] = useState<CommuteStatus | null>(null);
  const [phase, setPhase] = useState<CommutePhase>("loading");
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const markHazardsSeen = useCommuteStore((s) => s.markHazardsSeen);
  // Subscribe to the store slice so `acknowledge()` triggers a re-render
  // and the hazard `isNew` flags flip off without a refetch.
  const seenByRoute = useCommuteStore((s) => s.seenHazardsByRoute);

  const load = useCallback(async (isInitial: boolean) => {
    if (isInitial) setPhase("loading");
    else setIsRefreshing(true);
    setErrorMessage(null);

    try {
      const routes = await api.getCommuteRoutes();
      const primary = routes.find((r) => r.is_primary) ?? routes[0] ?? null;

      if (!primary) {
        setRoute(null);
        setStatus(null);
        setPhase("learning");
        return;
      }

      setRoute(primary);
      // getCommuteStatus returns the status for whichever route the backend
      // treats as primary — same route we just picked above.
      const next = await api.getCommuteStatus();
      setStatus(next);
      setPhase("ready");
    } catch (err) {
      setPhase("error");
      setErrorMessage(
        err instanceof Error ? err.message : "Unable to load commute",
      );
    } finally {
      if (!isInitial) setIsRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load(true);
  }, [load]);

  const refresh = useCallback(() => load(false), [load]);
  const retry = useCallback(() => load(true), [load]);

  const hazards = useMemo<CommuteHazardView[]>(() => {
    if (!route || !status) return [];
    // Prefer the in-memory cache (kept in sync by `markHazardsSeen`), and
    // fall back to a synchronous MMKV read so returning users don't see
    // every hazard flash with a NEW badge on the first paint.
    const seen =
      seenByRoute[route.id] ??
      useCommuteStore.getState().getSeenHazards(route.id);
    const currentIds = status.hazards.map((h) => h.id);
    const newIds = new Set(diffNewHazards(currentIds, seen));
    // Surface NEW hazards first so they're unmissable when the rider opens
    // the screen. Preserve server order within each group.
    const decorated = status.hazards.map((h) => ({
      ...h,
      isNew: newIds.has(h.id),
    }));
    return [...decorated].sort((a, b) => Number(b.isNew) - Number(a.isNew));
  }, [route, status, seenByRoute]);

  const newHazardCount = useMemo(
    () => hazards.reduce((n, h) => n + (h.isNew ? 1 : 0), 0),
    [hazards],
  );

  const acknowledge = useCallback(() => {
    if (!route || !status) return;
    markHazardsSeen(
      route.id,
      status.hazards.map((h) => h.id),
    );
  }, [route, status, markHazardsSeen]);

  return {
    phase,
    route,
    status,
    hazards,
    newHazardCount,
    errorMessage,
    refresh,
    retry,
    acknowledge,
    isRefreshing,
  };
}
