import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useAuthStore } from "@/stores/auth";
import type { RideListResponse, UserRide } from "./useUserRides";

/**
 * The signed-in user's most recent rides (newest first), capped at `limit`.
 * Distinct from `useUserRides` (which pages the whole history for the
 * collections picker) — the home screen only needs the last handful, so
 * this issues a single small `sort=started_at desc` query.
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
      const { data, error } = await api.GET("/api/v1/rides", {
        params: { query: { limit, sort: "started_at", order: "desc" } },
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
