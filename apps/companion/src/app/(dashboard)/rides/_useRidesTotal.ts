"use client";
import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { api } from "@/lib/api";
import { useAuthStore } from "@/stores/auth";
import { parseTimeWindow, windowStartISO } from "./_components/TimeWindowPills";

/**
 * Lightweight rides-count hook for the shared `RidesScaffold` tab
 * badge. Fetches a single page with `limit=1` so the total comes
 * back without pulling the full list (the All rides page itself
 * uses the heavier `useRidesQuery` and overrides this via the
 * scaffold's `allRidesBadge` prop).
 *
 * Honours the shared `?window=` pill so the `All rides · N` badge
 * matches the windowed list the tab links to — otherwise a rider on
 * `/rides/road-map?window=30d` would see an all-time count and then
 * land on a smaller 30-day list.
 *
 * Gated on auth-store hydration so the request doesn't race
 * `AuthSync` — same pattern as `useRidesQuery` and `useUserTrips`.
 */
export function useRidesTotal(): number | null {
  const authReady = useAuthStore((s) => Boolean(s.accessToken));
  const params = useSearchParams();
  const window = parseTimeWindow(params.get("window"));
  const [total, setTotal] = useState<number | null>(null);
  useEffect(() => {
    if (!authReady) return;
    const ctrl = new AbortController();
    const startedFrom = windowStartISO(window);
    const query: Record<string, string | number> = { limit: 1 };
    if (startedFrom) query.started_from = startedFrom;
    api
      .GET("/api/v1/rides", {
        params: { query: query as never },
        signal: ctrl.signal,
      })
      .then(({ data, error }) => {
        if (ctrl.signal.aborted || error) return;
        const d = data as unknown as { total?: number };
        setTotal(d.total ?? 0);
      })
      .catch(() => {
        // Silent: tab badge is decorative; leaving as null hides it.
      });
    return () => ctrl.abort();
  }, [authReady, window]);
  return total;
}
