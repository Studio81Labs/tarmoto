"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useAuthStore } from "@/stores/auth";

/**
 * Lightweight rides-count hook for the shared `RidesScaffold` tab
 * badge. Fetches a single page with `limit=1` so the total comes
 * back without pulling the full list (the All rides page itself
 * uses the heavier `useRidesQuery` and overrides this via the
 * scaffold's `allRidesBadge` prop).
 *
 * Gated on auth-store hydration so the request doesn't race
 * `AuthSync` — same pattern as `useRidesQuery` and `useUserTrips`.
 */
export function useRidesTotal(): number | null {
  const authReady = useAuthStore((s) => Boolean(s.accessToken));
  const [total, setTotal] = useState<number | null>(null);
  useEffect(() => {
    if (!authReady) return;
    const ctrl = new AbortController();
    api
      .GET("/api/v1/rides", {
        params: { query: { limit: 1 } as never },
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
  }, [authReady]);
  return total;
}
