import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useAuthStore } from "@/stores/auth";
import type { RideListResponse, UserRide } from "./useUserRides";

/**
 * The signed-in user's most recent rides (newest first), capped at `limit`.
 * Distinct from `useUserRides` (which pages the whole history for the
 * collections picker) — the home screen only needs the last handful, so
 * this issues a single small `sort=started_at desc` query.
 *
 * Upper-bounded at today (`started_to`) so future-dated rides (clock skew /
 * GPX import) can't fill the capped result and push real rides off the
 * page, leaving the windowed table empty. Deliberately NO `started_from`
 * lower bound: the unwindowed result is the home screen's returning-rider
 * signal, and bounding the low end would misclassify a rider whose last
 * ride predates 30 days as first-time (the page windows the display to 30
 * days separately).
 */
export function useRecentRides(limit: number): {
  rides: UserRide[];
  loading: boolean;
  error: boolean;
} {
  const userId = useAuthStore((s) => s.user?.id ?? null);

  const query = useQuery({
    queryKey: ["recent-rides", userId, limit],
    enabled: userId != null,
    queryFn: async ({ signal }) => {
      // Full ISO instant. The backend reads a timestamped `started_to` as an
      // exact `<= now` bound (a date-only value would widen to end-of-day and
      // still admit later-today future rides), so future-dated rides never
      // occupy a slot in this capped page and can't starve the window.
      const startedTo = new Date().toISOString();
      const { data, error } = await api.GET("/api/v1/rides", {
        params: {
          query: {
            limit,
            sort: "started_at",
            order: "desc",
            started_to: startedTo,
          },
        },
        signal,
      });
      if (error) throw new Error("recent rides fetch failed");
      return (data as unknown as RideListResponse).rides ?? [];
    },
  });

  return {
    rides: query.data ?? [],
    loading: query.isLoading,
    error: query.isError,
  };
}
