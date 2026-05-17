import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { closuresApi } from "@/lib/api";
import { useNetworkReconnectRevision } from "@/lib/network-status";
import {
  countClosuresBySeverity,
  dedupeClosures,
  previewDateForMonth,
  sortClosures,
  type ClosureSeverityCounts,
  type PlannerClosure,
  type PlannerClosureRoute,
} from "@/lib/closures-summary";

export interface ClosuresQueryResult {
  closures: PlannerClosure[];
  routeClosures: PlannerClosure[];
  counts: ClosureSeverityCounts;
  routeCounts: ClosureSeverityCounts;
  loading: boolean;
  routeLoading: boolean;
  error: string | null;
  routeError: string | null;
  previewDate: Date;
}

interface UseClosuresOptions {
  bbox?: string;
}

const EMPTY_COUNTS: ClosureSeverityCounts = {
  full: 0,
  partial: 0,
  advisory: 0,
  total: 0,
};

const EMPTY_CLOSURES: PlannerClosure[] = [];

export function useClosures(
  month: number,
  routes: PlannerClosureRoute[],
  options?: UseClosuresOptions,
): ClosuresQueryResult {
  const reconnectRevision = useNetworkReconnectRevision();
  const bbox = options?.bbox;
  const previewDate = useMemo(() => previewDateForMonth(month), [month]);
  const previewIso = previewDate.toISOString();

  const listQuery = useQuery({
    queryKey: ["closures", "list", previewIso, bbox, reconnectRevision],
    queryFn: async ({ signal }) => {
      const { data } = await closuresApi.list(
        { active_on: previewIso, bbox },
        { signal },
      );
      return sortClosures(data);
    },
  });

  // The route key intentionally excludes `route.label` so renaming a
  // day in the planner UI doesn't refire the per-route check — only
  // `id` + `points` actually drive the request shape.
  const routeRequestKey = useMemo(
    () => routes.map((r) => ({ id: r.id, points: r.points })),
    [routes],
  );

  // Per-route check is fanned out as Promise.allSettled so a single
  // failing segment doesn't black-hole the whole banner. The query
  // resolves to `{ closures, partial }` where `partial=true` means
  // at least one segment failed but others succeeded — surfaced to
  // the UI as a softer warning instead of a hard error.
  const routeQuery = useQuery({
    queryKey: [
      "closures",
      "check-route",
      previewIso,
      routeRequestKey,
      reconnectRevision,
    ],
    enabled: routes.length > 0,
    queryFn: async ({ signal }) => {
      const results = await Promise.allSettled(
        routeRequestKey.map(({ points }) =>
          closuresApi.checkRoute(
            { route: points, active_on: previewIso },
            { signal },
          ),
        ),
      );
      const fulfilled = results.filter(
        (
          result,
        ): result is PromiseFulfilledResult<
          Awaited<ReturnType<typeof closuresApi.checkRoute>>
        > => result.status === "fulfilled",
      );
      const rejectedCount = results.length - fulfilled.length;
      if (fulfilled.length === 0 && rejectedCount > 0) {
        throw new Error("Failed to check route closures");
      }
      const closures = sortClosures(
        dedupeClosures(fulfilled.flatMap(({ value }) => value.data.closures)),
      );
      return { closures, partial: rejectedCount > 0 };
    },
  });

  const closures = listQuery.data ?? EMPTY_CLOSURES;
  const counts = useMemo(
    () =>
      listQuery.data ? countClosuresBySeverity(listQuery.data) : EMPTY_COUNTS,
    [listQuery.data],
  );

  const routeClosures =
    routes.length > 0
      ? (routeQuery.data?.closures ?? EMPTY_CLOSURES)
      : EMPTY_CLOSURES;
  const routeCounts = useMemo(
    () =>
      routes.length > 0 && routeQuery.data
        ? countClosuresBySeverity(routeQuery.data.closures)
        : EMPTY_COUNTS,
    [routes.length, routeQuery.data],
  );

  return {
    closures,
    routeClosures,
    counts,
    routeCounts,
    loading: listQuery.isLoading,
    routeLoading: routes.length > 0 && routeQuery.isLoading,
    error: listQuery.isError
      ? (listQuery.error as Error)?.message || "Failed to load closures"
      : null,
    routeError:
      routes.length === 0
        ? null
        : routeQuery.isError
          ? (routeQuery.error as Error)?.message ||
            "Failed to check route closures"
          : routeQuery.data?.partial
            ? "Some route segments could not be checked."
            : null,
    previewDate,
  };
}
