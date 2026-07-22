import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { getUserFacingErrorMessage } from "@/i18n";
import { useTranslation } from "@/i18n/I18nProvider";
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
  /**
   * True whenever the viewport list query is fetching (incl. background).
   * Optional so hand-built test fixtures needn't set it; the hook always does.
   */
  fetching?: boolean;
  routeLoading: boolean;
  error: string | null;
  routeError: string | null;
  previewDate: Date;
}

interface UseClosuresOptions {
  bbox?: string | undefined;
  /**
   * Overrides the month-derived preview date when set. Trip planner
   * passes month-of-year (so closures preview reflects a future
   * trip) and computes a 15th-of-month proxy; /explore lets the
   * rider pick an exact date and threads it through directly.
   */
  previewDate?: Date;
  /**
   * Gates the list query. Defaults to `true`; the explorer passes
   * `false` while the Conditions toggle is off so an ambient marker
   * consumer doesn't fetch the whole viewport's closures until the
   * rider opts in. Route checks are unaffected (they already gate on
   * `routes.length`).
   */
  enabled?: boolean;
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
  const t = useTranslation();
  const reconnectRevision = useNetworkReconnectRevision();
  const bbox = options?.bbox;
  const enabled = options?.enabled ?? true;
  const previewDateOverride = options?.previewDate;
  const previewDate = useMemo(
    () => previewDateOverride ?? previewDateForMonth(month),
    [previewDateOverride, month],
  );
  const previewIso = previewDate.toISOString();

  const listQuery = useQuery({
    queryKey: ["closures", "list", previewIso, bbox, reconnectRevision],
    enabled,
    queryFn: async ({ signal }) => {
      const { data } = await closuresApi.list(
        { active_on: previewIso, ...(bbox !== undefined ? { bbox } : {}) },
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

  // Send every route chunk in one spatial request so the backend can count
  // each matching closure once, including matches beyond its returned-row cap.
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
      const [firstRoute, ...additionalRoutes] = routeRequestKey;
      if (!firstRoute) throw new Error("No route to check");
      const { data } = await closuresApi.checkRoute(
        {
          route: firstRoute.points,
          ...(additionalRoutes.length > 0
            ? {
                additional_routes: additionalRoutes.map(({ points }) => ({
                  points,
                })),
              }
            : {}),
          active_on: previewIso,
        },
        { signal },
      );
      const closures = sortClosures(dedupeClosures(data.closures));
      const counts: ClosureSeverityCounts = {
        full: data.full_count,
        partial: data.partial_count,
        advisory: data.advisory_count,
        total: data.full_count + data.partial_count + data.advisory_count,
      };
      return { closures, counts };
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
        ? routeQuery.data.counts
        : EMPTY_COUNTS,
    [routes.length, routeQuery.data],
  );

  return {
    closures,
    routeClosures,
    counts,
    routeCounts,
    loading: listQuery.isLoading,
    fetching: listQuery.isFetching,
    routeLoading: routes.length > 0 && routeQuery.isLoading,
    error: listQuery.isError
      ? getUserFacingErrorMessage(listQuery.error, t("Failed to load closures"))
      : null,
    routeError:
      routes.length === 0
        ? null
        : routeQuery.isError
          ? getUserFacingErrorMessage(
              routeQuery.error,
              t("Failed to check route closures"),
            )
          : null,
    previewDate,
  };
}
