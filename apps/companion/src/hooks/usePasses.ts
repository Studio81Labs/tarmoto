import { useEffect, useMemo, useRef, useState } from "react";
import { api, passesApi } from "@/lib/api";
import {
  countByStatus,
  dedupePasses,
  partitionByStatus,
  type MountainPass,
} from "@/lib/passes-summary";
import type { PlannerClosureRoute } from "@/lib/closures-summary";

const EMPTY_ROUTES: PlannerClosureRoute[] = [];
const EMPTY_ROUTE_PASSES: MountainPass[] = [];
const EMPTY_ROUTE_POINTS: PlannerClosureRoute["points"][] = [];

export interface PassesQueryResult {
  passes: MountainPass[];
  routePasses: MountainPass[];
  routeClosedCount: number;
  routeUnknownCount: number;
  loading: boolean;
  routeLoading: boolean;
  error: string | null;
  routeError: string | null;
}

interface PassesState extends PassesQueryResult {
  routeQueryKey: string | null;
}

function buildRouteQueryKey(
  forMonth: number | undefined,
  routes: PlannerClosureRoute[],
): string | null {
  if (routes.length === 0) return null;

  return JSON.stringify({
    forMonth: forMonth ?? null,
    routes: routes.map((route) => ({
      id: route.id,
      points: route.points,
    })),
  });
}

/**
 * Fetches `/passes?for_month=<month>` and re-runs whenever `forMonth`
 * changes. `forMonth` is 1..12; omit (pass `undefined`) to let the backend
 * fall back to the current UTC month.
 *
 * Mirrors the AbortController pattern used by `useRidesQuery` so an in-flight
 * request from a stale month can't clobber a newer one.
 */
export function usePasses(
  forMonth: number | undefined,
  routes: PlannerClosureRoute[] = EMPTY_ROUTES,
): PassesQueryResult {
  const routeQueryKey = useMemo(
    () => buildRouteQueryKey(forMonth, routes),
    [forMonth, routes],
  );
  const routePointsRef =
    useRef<PlannerClosureRoute["points"][]>(EMPTY_ROUTE_POINTS);
  const routePointsQueryKeyRef = useRef<string | null>(null);

  if (routePointsQueryKeyRef.current !== routeQueryKey) {
    routePointsQueryKeyRef.current = routeQueryKey;
    routePointsRef.current =
      routeQueryKey == null
        ? EMPTY_ROUTE_POINTS
        : routes.map((route) => route.points);
  }

  const routePoints = routePointsRef.current;
  const [state, setState] = useState<PassesState>({
    passes: [],
    routePasses: [],
    routeClosedCount: 0,
    routeUnknownCount: 0,
    loading: true,
    routeLoading: routes.length > 0,
    error: null,
    routeError: null,
    routeQueryKey,
  });

  const hasPendingRouteCheck =
    routeQueryKey != null && state.routeQueryKey !== routeQueryKey;

  useEffect(() => {
    if (routePoints.length === 0) {
      setState((current) =>
        current.routePasses.length === 0 &&
        current.routeClosedCount === 0 &&
        current.routeUnknownCount === 0 &&
        !current.routeLoading &&
        current.routeError == null &&
        current.routeQueryKey == null
          ? current
          : {
              ...current,
              routePasses: EMPTY_ROUTE_PASSES,
              routeClosedCount: 0,
              routeUnknownCount: 0,
              routeLoading: false,
              routeError: null,
              routeQueryKey: null,
            },
      );
      return;
    }

    const ctrl = new AbortController();
    setState((current) => ({
      ...current,
      routeLoading: true,
      routeError: null,
    }));

    Promise.allSettled(
      routePoints.map((points) =>
        passesApi.checkRoute(
          {
            route: points,
            for_month: forMonth,
          },
          { signal: ctrl.signal },
        ),
      ),
    )
      .then((results) => {
        if (ctrl.signal.aborted) return;

        const fulfilled = results.filter(
          (
            result,
          ): result is PromiseFulfilledResult<
            Awaited<ReturnType<typeof passesApi.checkRoute>>
          > => result.status === "fulfilled",
        );
        const rejectedCount = results.length - fulfilled.length;

        if (fulfilled.length === 0 && rejectedCount > 0) {
          setState((current) => ({
            ...current,
            routePasses: EMPTY_ROUTE_PASSES,
            routeClosedCount: 0,
            routeUnknownCount: 0,
            routeLoading: false,
            routeError: "Failed to check route passes",
            routeQueryKey,
          }));
          return;
        }

        const routePasses = dedupePasses(
          fulfilled.flatMap(({ value }) => value.data.passes),
        );
        const grouped = partitionByStatus(routePasses);
        const orderedRoutePasses = [
          ...grouped.closed,
          ...grouped.unknown,
          ...grouped.open,
        ];
        const counts = countByStatus(routePasses);

        setState((current) => ({
          ...current,
          routePasses: orderedRoutePasses,
          routeClosedCount: counts.closed,
          routeUnknownCount: counts.unknown,
          routeLoading: false,
          routeError:
            rejectedCount > 0
              ? "Some route segments could not be checked."
              : null,
          routeQueryKey,
        }));
      })
      .catch((err: Error) => {
        if (ctrl.signal.aborted) return;
        setState((current) => ({
          ...current,
          routePasses: EMPTY_ROUTE_PASSES,
          routeClosedCount: 0,
          routeUnknownCount: 0,
          routeLoading: false,
          routeError: err.message || "Failed to check route passes",
          routeQueryKey,
        }));
      });

    return () => ctrl.abort();
  }, [forMonth, routePoints, routeQueryKey]);

  useEffect(() => {
    const ctrl = new AbortController();
    setState((s) => ({ ...s, loading: true, error: null }));
    api
      .GET("/api/v1/passes", {
        params: {
          query:
            forMonth != null ? ({ for_month: forMonth } as never) : undefined,
        },
        signal: ctrl.signal,
      })
      .then(({ data, error }) => {
        if (ctrl.signal.aborted) return;
        if (error || !data) {
          setState((current) => ({
            ...current,
            passes: [],
            loading: false,
            error: "Failed to load passes",
          }));
          return;
        }
        setState((current) => ({
          ...current,
          passes: data as MountainPass[],
          loading: false,
          error: null,
        }));
      })
      .catch((err: Error) => {
        if (ctrl.signal.aborted) return;
        setState((current) => ({
          ...current,
          passes: [],
          loading: false,
          error: err.message,
        }));
      });
    return () => ctrl.abort();
  }, [forMonth]);

  return {
    ...state,
    routeLoading: state.routeLoading || hasPendingRouteCheck,
    routeError: hasPendingRouteCheck ? null : state.routeError,
  };
}
