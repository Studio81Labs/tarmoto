import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, passesApi } from "@/lib/api";
import { useNetworkReconnectRevision } from "@/lib/network-status";
import {
  countByStatus,
  dedupePasses,
  partitionByStatus,
  type MountainPass,
} from "@/lib/passes-summary";
import type { PlannerClosureRoute } from "@/lib/closures-summary";

const EMPTY_ROUTES: PlannerClosureRoute[] = [];
const EMPTY_PASSES: MountainPass[] = [];

export interface PassesQueryResult {
  passes: MountainPass[];
  routePasses: MountainPass[];
  routeClosedCount: number;
  routeUnknownCount: number;
  loading: boolean;
  /**
   * True whenever the viewport list query is fetching (incl. background).
   * Optional so hand-built test fixtures needn't set it; the hook always does.
   */
  fetching?: boolean;
  routeLoading: boolean;
  error: string | null;
  routeError: string | null;
}

interface UsePassesOptions {
  bbox?: string | undefined;
  /**
   * Gates the list query. Defaults to `true`; the explorer passes
   * `false` while the Conditions toggle is off so the ambient pass
   * markers don't fetch until the rider opts in. Route checks already
   * gate on `routes.length`.
   */
  enabled?: boolean;
}

/**
 * Fetches `/passes` for the current month/bbox and (optionally) runs
 * a per-route check across `routes`. Driven by `@tanstack/react-query`
 * — cancellation, dedup, and reconnect retry come for free.
 *
 * The list query is keyed by `[forMonth, bbox]`, the route query by
 * `[forMonth, routes]`, so distinct planner panels in the same tree
 * share the same cache entry instead of refetching independently.
 */
export function usePasses(
  forMonth: number | undefined,
  routes: PlannerClosureRoute[] = EMPTY_ROUTES,
  options?: UsePassesOptions,
): PassesQueryResult {
  const reconnectRevision = useNetworkReconnectRevision();
  const bbox = options?.bbox;
  const enabled = options?.enabled ?? true;

  const listQuery = useQuery({
    queryKey: ["passes", "list", forMonth ?? null, bbox, reconnectRevision],
    enabled,
    queryFn: async ({ signal }) => {
      const query =
        forMonth != null || bbox
          ? ({
              ...(bbox ? { bbox } : {}),
              ...(forMonth != null ? { for_month: forMonth } : {}),
            } as never)
          : undefined;
      const { data, error } = await api.GET("/api/v1/passes", {
        params: {
          ...(query !== undefined ? { query } : {}),
        },
        signal,
      });
      if (error || !data) throw new Error("Failed to load passes");
      return data as MountainPass[];
    },
  });

  // The query key intentionally excludes `route.label` (and anything
  // else metadata-only): only the fields the request body actually
  // consumes (`id`, `points`) decide whether a re-render reuses the
  // cached response or kicks a new fetch. Without this filter,
  // renaming a route in the planner UI would refire the per-route
  // check.
  const routeRequestKey = useMemo(
    () => routes.map((r) => ({ id: r.id, points: r.points })),
    [routes],
  );

  const routeQuery = useQuery({
    queryKey: [
      "passes",
      "check-route",
      forMonth ?? null,
      routeRequestKey,
      reconnectRevision,
    ],
    enabled: routes.length > 0,
    queryFn: async ({ signal }) => {
      const results = await Promise.allSettled(
        routeRequestKey.map(({ points }) =>
          passesApi.checkRoute(
            {
              route: points,
              ...(forMonth !== undefined ? { for_month: forMonth } : {}),
            },
            { signal },
          ),
        ),
      );
      const fulfilled = results.filter(
        (
          result,
        ): result is PromiseFulfilledResult<
          Awaited<ReturnType<typeof passesApi.checkRoute>>
        > => result.status === "fulfilled",
      );
      const rejectedCount = results.length - fulfilled.length;
      if (fulfilled.length === 0 && rejectedCount > 0) {
        throw new Error("Failed to check route passes");
      }
      const routePasses = dedupePasses(
        fulfilled.flatMap(({ value }) => value.data.passes),
      );
      const grouped = partitionByStatus(routePasses);
      const ordered = [...grouped.closed, ...grouped.unknown, ...grouped.open];
      const counts = countByStatus(routePasses);
      return {
        passes: ordered,
        closedCount: counts.closed,
        unknownCount: counts.unknown,
        partial: rejectedCount > 0,
      };
    },
  });

  const passes = listQuery.data ?? EMPTY_PASSES;
  const routePasses =
    routes.length > 0
      ? (routeQuery.data?.passes ?? EMPTY_PASSES)
      : EMPTY_PASSES;

  return {
    passes,
    routePasses,
    routeClosedCount:
      routes.length > 0 ? (routeQuery.data?.closedCount ?? 0) : 0,
    routeUnknownCount:
      routes.length > 0 ? (routeQuery.data?.unknownCount ?? 0) : 0,
    loading: listQuery.isLoading,
    fetching: listQuery.isFetching,
    routeLoading: routes.length > 0 && routeQuery.isLoading,
    error: listQuery.isError
      ? (listQuery.error as Error)?.message || "Failed to load passes"
      : null,
    routeError:
      routes.length === 0
        ? null
        : routeQuery.isError
          ? (routeQuery.error as Error)?.message ||
            "Failed to check route passes"
          : routeQuery.data?.partial
            ? "Some route segments could not be checked."
            : null,
  };
}
