/**
 * Hook backing the US-15 / US-21 / US-22 / US-23 commute surfaces.
 *
 * Loads the rider's primary commute route together with current status,
 * alternative routes, and rolling stats. Hazards are augmented with an
 * `isNew` flag derived from the last-seen snapshot in `useCommuteStore`
 * — that snapshot is only advanced when the caller invokes
 * `acknowledge()`, so a rider who opens the screen briefly, scrolls
 * away, and comes back still sees the same NEW markers.
 *
 * The four sources are fetched in parallel and surface independently:
 * a transient failure on one (alternatives, stats) should not blank the
 * primary status the rider came here for.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  CommuteAlternativesResponse,
  CommuteRoute,
  CommuteStats,
  CommuteStatus,
  Hazard,
} from "@/types";
import { api } from "@/services/api";
import { diffNewHazards, useAuthStore, useCommuteStore } from "@/stores";
import { getUserFacingErrorMessage, t as translate } from "@/i18n";
import { useFeature } from "@/hooks/useEntitlements";
import { useFeatureKillSwitchActive } from "@/hooks/useFeatureKillSwitch";
import { isFeatureEnabled } from "@tarmoto/shared";

/**
 * The commuter_mode grant read SYNCHRONOUSLY from the auth store, right now.
 * `load()` calls this at invocation so a callback that resumes after a
 * revocation — but BEFORE React's passive entitlement effect runs — still
 * fails closed against the current snapshot. Mirrors `useFeature`'s
 * resolution: a missing `features` slice reads as not-granted (fail closed).
 */
function commuterModeGrantedNow(): boolean {
  const features = useAuthStore.getState().user?.features ?? null;
  return features != null && isFeatureEnabled(features, "commuter_mode");
}

export type CommutePhase =
  | "loading"
  | "learning" // not enough rides yet to have a primary commute
  | "ready"
  | "error"
  | "locked"; // commuter_mode entitlement not granted — no fetch is issued

export interface CommuteHazardView extends Hazard {
  isNew: boolean;
}

export interface UseCommuteOptions {
  /**
   * When true (the default), the hook also fetches alternatives and
   * weekly stats in parallel with status. Light callers — HomeScreen,
   * notification handlers — pass `false` so they don't fan out two
   * extra requests on cold start that the surface never renders.
   */
  withSecondary?: boolean;
}

export interface UseCommuteResult {
  phase: CommutePhase;
  /** The user's primary commute route, or `null` if none is saved yet. */
  route: CommuteRoute | null;
  /**
   * All saved routes including the primary, server-ordered. Used by the
   * UI's "Saved routes" section to drive the "Use as primary" swap on
   * non-primary saved routes (alternatives from the routing engine are
   * ad-hoc and don't have an `id` to swap with).
   */
  savedRoutes: CommuteRoute[];
  status: CommuteStatus | null;
  hazards: CommuteHazardView[];
  newHazardCount: number;
  alternatives: CommuteAlternativesResponse | null;
  stats: CommuteStats | null;
  errorMessage: string | null;
  /** Pull-to-refresh from the ready state — keeps existing data visible. */
  refresh: () => Promise<void>;
  /** Error-state retry — goes back through the full loading spinner. */
  retry: () => Promise<void>;
  /** Mark every currently-visible hazard as seen (dismiss NEW markers). */
  acknowledge: () => void;
  /** Promote a saved route to primary, then refresh to reflect the swap. */
  setPrimary: (routeId: string) => Promise<void>;
  isRefreshing: boolean;
  /** True only when a swap is in flight — drives the per-row spinner. */
  isUpdatingPrimary: boolean;
}

export function useCommute(options: UseCommuteOptions = {}): UseCommuteResult {
  const { withSecondary = true } = options;
  const [route, setRoute] = useState<CommuteRoute | null>(null);
  const [savedRoutes, setSavedRoutes] = useState<CommuteRoute[]>([]);
  const [status, setStatus] = useState<CommuteStatus | null>(null);
  const [alternatives, setAlternatives] =
    useState<CommuteAlternativesResponse | null>(null);
  const [stats, setStats] = useState<CommuteStats | null>(null);
  const [phase, setPhase] = useState<CommutePhase>("loading");
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isUpdatingPrimary, setIsUpdatingPrimary] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const markHazardsSeen = useCommuteStore((s) => s.markHazardsSeen);
  // Subscribe to the store slice so `acknowledge()` triggers a re-render
  // and the hazard `isNew` flags flip off without a refetch.
  const seenByRoute = useCommuteStore((s) => s.seenHazardsByRoute);

  // Monotonic load generation. The entitlement effect bumps it whenever
  // commuter_mode changes (e.g. a revoke), so an in-flight `load()` started
  // while entitled discards its late results instead of overwriting the
  // `locked` phase — otherwise a stale `ready` could restore the paid
  // HomeScreen CTA/badge for a rider who just lost access.
  const loadGenRef = useRef(0);

  const load = useCallback(
    async (isInitial: boolean) => {
      // Fail closed against the live entitlement, read SYNCHRONOUSLY from the
      // store at invocation. The generation guard only catches a change AFTER a
      // load starts; a callback-triggered load (setPrimary/refresh/retry) can be
      // INVOKED after a revoke, capturing the post-revoke generation so
      // `isStale()` never trips. Reading the snapshot here — rather than a ref
      // updated in a passive effect that may not have run yet — never issues a
      // guarded `/commute/*` request as a now-locked rider.
      if (!commuterModeGrantedNow()) return;
      const gen = loadGenRef.current;
      // Abandon a post-await result if the load was superseded (generation
      // bumped) OR the rider no longer has access. The generation guard alone
      // relies on the passive entitlement effect having run; a revoke that
      // publishes while a request is pending may resolve BEFORE that effect
      // increments the generation, so also re-read the CURRENT grant
      // synchronously before every commit — never restore a `ready` phase (and
      // the paid CTA/badge) for a rider the store already denies.
      const supersededOrRevoked = () =>
        gen !== loadGenRef.current || !commuterModeGrantedNow();
      if (isInitial) {
        setPhase("loading");
        setErrorMessage(null);
      } else {
        setIsRefreshing(true);
      }

      try {
        const routes = await api.getCommuteRoutes();
        const primary = routes.find((r) => r.is_primary) ?? routes[0] ?? null;

        // A revoke (or any entitlement change) landed while we were awaiting —
        // drop this now-stale result rather than overwrite the `locked` phase.
        if (supersededOrRevoked()) return;
        setSavedRoutes(routes);

        if (!primary) {
          setRoute(null);
          setStatus(null);
          setAlternatives(null);
          setStats(null);
          setPhase("learning");
          return;
        }

        // Fan-out: status drives the primary surface; alternatives and
        // stats power the secondary cards on CommuteScreen. Light callers
        // (HomeScreen, notifications) pass `withSecondary=false` so a
        // cold start doesn't fire two extra requests whose responses
        // they never render.
        const requests: [
          Promise<CommuteStatus>,
          Promise<CommuteAlternativesResponse> | null,
          Promise<CommuteStats> | null,
        ] = [
          api.getCommuteStatus(),
          withSecondary ? api.getCommuteAlternatives() : null,
          withSecondary ? api.getCommuteStats("week") : null,
        ];
        const [statusResult, alternativesResult, statsResult] =
          await Promise.allSettled([
            requests[0],
            requests[1] ??
              Promise.resolve<CommuteAlternativesResponse | null>(null),
            requests[2] ?? Promise.resolve<CommuteStats | null>(null),
          ]);

        if (statusResult.status === "rejected") {
          // Re-throw so the outer catch routes us to the error state on
          // initial loads (the rider has nothing usable yet) or silently
          // keeps the prior data on a refresh blip.
          throw statusResult.reason;
        }

        // Re-check after the second await — the entitlement may have flipped
        // (superseded or revoked) between the routes fetch and now.
        if (supersededOrRevoked()) return;
        setRoute(primary);
        setStatus(statusResult.value);
        // Only overwrite the secondary slices when their fetch resolved.
        // On a pull-to-refresh, if `/commute/alternatives` or
        // `/commute/stats` 5xx while `/commute/status` succeeds, we
        // keep whatever was already on screen — clearing them would
        // make the cards visibly disappear and reappear on the next
        // refresh, which contradicts the `Promise.allSettled` design
        // goal stated above. On the initial load there's nothing to
        // preserve, so we still surface a fresh `null` to leave the
        // card unmounted.
        if (alternativesResult.status === "fulfilled") {
          setAlternatives(alternativesResult.value ?? null);
        } else if (isInitial) {
          setAlternatives(null);
        }
        if (statsResult.status === "fulfilled") {
          setStats(statsResult.value ?? null);
        } else if (isInitial) {
          setStats(null);
        }
        setPhase("ready");
      } catch (err) {
        // On initial/retry loads there's nothing else on screen, so show
        // the full error view. On a pull-to-refresh we keep the existing
        // data visible — the RefreshControl stopping is enough feedback
        // for a transient network blip, and tearing the rider off their
        // commute view for a temporary glitch is worse than a silent
        // miss.
        if (isInitial && !supersededOrRevoked()) {
          setPhase("error");
          setErrorMessage(
            getUserFacingErrorMessage(err, translate("Unable to load commute")),
          );
        }
      } finally {
        if (!isInitial) setIsRefreshing(false);
      }
    },
    [withSecondary],
  );

  // commuter_mode is a Pro entitlement. Gate the fetch HERE — not just in
  // CommuteScreen — so EVERY caller (HomeScreen mounts the hook at app entry,
  // notification handlers, deep links) is covered: a non-entitled rider must
  // never fire the guarded `/commute/*` requests and collect a 403. Fail
  // closed while the snapshot is unresolved (no fetch); report a terminal
  // `locked` phase once we know the entitlement is absent.
  const { enabled: commuterEnabled, isResolved: commuterResolved } =
    useFeature("commuter_mode");
  useEffect(() => {
    // Bump the generation on every entitlement change so any load() still in
    // flight from the previous state discards its results (see loadGenRef).
    loadGenRef.current += 1;
    if (!commuterResolved) return; // unresolved → fail closed, don't fetch yet
    if (!commuterEnabled) {
      setPhase("locked");
      return;
    }
    void load(true);
  }, [load, commuterResolved, commuterEnabled]);

  const refresh = useCallback(() => load(false), [load]);
  const retry = useCallback(() => load(true), [load]);

  const setPrimary = useCallback(
    async (routeId: string): Promise<void> => {
      setIsUpdatingPrimary(true);
      try {
        await api.setPrimaryCommuteRoute(routeId);
        // Refetch so the route name, hazards, alternatives, and stats
        // realign with the new primary. Calling `load(false)` keeps the
        // existing screen visible while the refresh runs — important
        // because `setPrimary` is invoked from the alternatives card,
        // which is part of the live commute view.
        await load(false);
      } finally {
        setIsUpdatingPrimary(false);
      }
    },
    [load],
  );

  // `hazard_alerts` operator kill switch (reactive, off the public
  // /config/flags fast path). When an operator kills community hazard
  // reception during a false-positive storm, strip hazards from EVERY commute
  // surface — the NEW badge (HomeScreen), the hazard list (CommuteScreen), and
  // the alternatives ranking (which weights `hazard_count` heaviest) — so bogus
  // hazards can't stay prominent or misrank routes. Mirrors the map / CarPlay /
  // notifier gates. Reactive so it takes effect while the screen is mounted.
  const hazardAlertsEnabled = useFeatureKillSwitchActive("hazard_alerts");

  const effectiveStatus = useMemo<CommuteStatus | null>(() => {
    if (!status || hazardAlertsEnabled) return status;
    return {
      ...status,
      hazards: [],
      hazard_count: 0,
      // Don't headline "hazards" with an empty list.
      status: status.status === "hazards" ? "clear" : status.status,
    };
  }, [status, hazardAlertsEnabled]);

  const effectiveAlternatives =
    useMemo<CommuteAlternativesResponse | null>(() => {
      if (!alternatives || hazardAlertsEnabled) return alternatives;
      return {
        ...alternatives,
        primary_hazard_count: 0,
        alternatives: alternatives.alternatives.map((a) => ({
          ...a,
          hazard_count: 0,
        })),
      };
    }, [alternatives, hazardAlertsEnabled]);

  const hazards = useMemo<CommuteHazardView[]>(() => {
    if (!route || !effectiveStatus) return [];
    // Prefer the in-memory cache (kept in sync by `markHazardsSeen`), and
    // fall back to a synchronous MMKV read so returning users don't see
    // every hazard flash with a NEW badge on the first paint.
    const seen =
      seenByRoute[route.id] ??
      useCommuteStore.getState().getSeenHazards(route.id);
    const currentIds = effectiveStatus.hazards.map((h) => h.id);
    const newIds = new Set(diffNewHazards(currentIds, seen));
    // Surface NEW hazards first so they're unmissable when the rider opens
    // the screen. Preserve server order within each group.
    const decorated = effectiveStatus.hazards.map((h) => ({
      ...h,
      isNew: newIds.has(h.id),
    }));
    return [...decorated].sort((a, b) => Number(b.isNew) - Number(a.isNew));
  }, [route, effectiveStatus, seenByRoute]);

  const newHazardCount = useMemo(
    () => hazards.reduce((n, h) => n + (h.isNew ? 1 : 0), 0),
    [hazards],
  );

  const acknowledge = useCallback(() => {
    if (!route || !effectiveStatus) return;
    markHazardsSeen(
      route.id,
      effectiveStatus.hazards.map((h) => h.id),
    );
  }, [route, effectiveStatus, markHazardsSeen]);

  return {
    phase,
    route,
    savedRoutes,
    status: effectiveStatus,
    hazards,
    newHazardCount,
    alternatives: effectiveAlternatives,
    stats,
    errorMessage,
    refresh,
    retry,
    acknowledge,
    setPrimary,
    isRefreshing,
    isUpdatingPrimary,
  };
}
