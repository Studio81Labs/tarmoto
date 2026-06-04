import { useQuery } from "@tanstack/react-query";
import type { RideStats } from "@tarmoto/shared";
import { api } from "@/lib/api";
import { useAuthStore } from "@/stores/auth";

/**
 * Aggregate KPIs for the rider's CURRENTLY-FILTERED ride set, served by
 * `GET /rides/stats`. Drives the Ride History "All rides" KPI cards.
 *
 * Pass the SAME filter-only param object the table query sends to
 * `GET /rides` (see `toFilterParams` in `useRidesQuery`) so the cards and the
 * list always reflect the same window — change a time pill or type chip and
 * both update together. Keyed on those params so each filter combination is
 * cached independently.
 */
export function useRideStats(
  params: Record<string, string | number | undefined>,
): { stats: RideStats | null; loading: boolean } {
  const userId = useAuthStore((s) => s.user?.id ?? null);
  const authReady = useAuthStore((s) => Boolean(s.accessToken));

  const query = useQuery({
    queryKey: ["ride-stats", userId, params],
    enabled: userId != null && authReady,
    queryFn: async ({ signal }) => {
      const { data, error } = await api.GET("/api/v1/rides/stats", {
        params: { query: params as never },
        signal,
      });
      if (error) throw new Error("ride stats fetch failed");
      return data as unknown as RideStats;
    },
  });

  return { stats: query.data ?? null, loading: query.isLoading };
}
