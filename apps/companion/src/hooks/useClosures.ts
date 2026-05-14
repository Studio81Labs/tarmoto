import { useEffect, useMemo, useState } from "react";
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

type ClosuresState = Omit<ClosuresQueryResult, "previewDate">;

const EMPTY_COUNTS: ClosureSeverityCounts = {
  full: 0,
  partial: 0,
  advisory: 0,
  total: 0,
};

export function useClosures(
  month: number,
  routes: PlannerClosureRoute[],
  options?: UseClosuresOptions,
): ClosuresQueryResult {
  const reconnectRevision = useNetworkReconnectRevision();
  const bbox = options?.bbox;
  const previewDate = useMemo(() => previewDateForMonth(month), [month]);
  const previewIso = previewDate.toISOString();
  const [state, setState] = useState<ClosuresState>({
    closures: [],
    routeClosures: [],
    counts: EMPTY_COUNTS,
    routeCounts: EMPTY_COUNTS,
    loading: true,
    routeLoading: routes.length > 0,
    error: null,
    routeError: null,
  });

  useEffect(() => {
    const ctrl = new AbortController();

    setState((current) => ({
      ...current,
      loading: true,
      error: null,
    }));

    closuresApi
      .list({ active_on: previewIso, bbox }, { signal: ctrl.signal })
      .then(({ data }) => {
        if (ctrl.signal.aborted) return;
        const closures = sortClosures(data);
        setState((current) => ({
          ...current,
          closures,
          counts: countClosuresBySeverity(closures),
          loading: false,
          error: null,
        }));
      })
      .catch((err: Error) => {
        if (ctrl.signal.aborted) return;
        setState((current) => ({
          ...current,
          closures: [],
          counts: EMPTY_COUNTS,
          loading: false,
          error: err.message || "Failed to load closures",
        }));
      });

    return () => ctrl.abort();
  }, [bbox, previewDate, previewIso, reconnectRevision]);

  useEffect(() => {
    if (routes.length === 0) {
      setState((current) =>
        current.routeClosures.length === 0 &&
        current.routeCounts.total === 0 &&
        !current.routeLoading &&
        current.routeError == null
          ? current
          : {
              ...current,
              routeClosures: [],
              routeCounts: EMPTY_COUNTS,
              routeLoading: false,
              routeError: null,
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
      routes.map((route) =>
        closuresApi.checkRoute(
          { route: route.points, active_on: previewIso },
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
            Awaited<ReturnType<typeof closuresApi.checkRoute>>
          > => result.status === "fulfilled",
        );
        const rejectedCount = results.length - fulfilled.length;
        if (fulfilled.length === 0 && rejectedCount > 0) {
          setState((current) => ({
            ...current,
            routeClosures: [],
            routeCounts: EMPTY_COUNTS,
            routeLoading: false,
            routeError: "Failed to check route closures",
          }));
          return;
        }

        const routeClosures = sortClosures(
          dedupeClosures(fulfilled.flatMap(({ value }) => value.data.closures)),
        );
        setState((current) => ({
          ...current,
          routeClosures,
          routeCounts: countClosuresBySeverity(routeClosures),
          routeLoading: false,
          routeError:
            rejectedCount > 0
              ? "Some route segments could not be checked."
              : null,
        }));
      })
      .catch((err: Error) => {
        if (ctrl.signal.aborted) return;
        setState((current) => ({
          ...current,
          routeClosures: [],
          routeCounts: EMPTY_COUNTS,
          routeLoading: false,
          routeError: err.message || "Failed to check route closures",
        }));
      });

    return () => ctrl.abort();
  }, [previewDate, previewIso, routes, reconnectRevision]);

  return {
    ...state,
    previewDate,
  };
}
