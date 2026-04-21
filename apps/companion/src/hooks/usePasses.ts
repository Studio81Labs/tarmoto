import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { MountainPass } from "@/lib/passes-summary";

export interface PassesQueryResult {
  passes: MountainPass[];
  loading: boolean;
  error: string | null;
}

/**
 * Fetches `/passes?for_month=<month>` and re-runs whenever `forMonth`
 * changes. `forMonth` is 1..12; omit (pass `undefined`) to let the backend
 * fall back to the current UTC month.
 *
 * Mirrors the AbortController pattern used by `useRidesQuery` so an in-flight
 * request from a stale month can't clobber a newer one.
 */
export function usePasses(forMonth: number | undefined): PassesQueryResult {
  const [state, setState] = useState<PassesQueryResult>({
    passes: [],
    loading: true,
    error: null,
  });

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
          setState({
            passes: [],
            loading: false,
            error: "Failed to load passes",
          });
          return;
        }
        setState({
          passes: data as MountainPass[],
          loading: false,
          error: null,
        });
      })
      .catch((err: Error) => {
        if (ctrl.signal.aborted) return;
        setState({ passes: [], loading: false, error: err.message });
      });
    return () => ctrl.abort();
  }, [forMonth]);

  return state;
}
