import { useQuery } from "@tanstack/react-query";
import type { MonthlyStats } from "@tarmoto/shared";
import { api } from "@/lib/api";
import { useAuthStore } from "@/stores/auth";

/**
 * Current-month KPI snapshot for the home tiles + sync pill. Returns
 * `null` while loading or before the first fetch resolves. The page hides
 * the tile row when the month is empty (zero km), so a returning rider who
 * simply hasn't ridden this month doesn't see a wall of zeros.
 */
export function useMonthlyStats(): {
  stats: MonthlyStats | null;
  loading: boolean;
} {
  const userId = useAuthStore((s) => s.user?.id ?? null);

  const query = useQuery({
    queryKey: ["monthly-stats", userId],
    enabled: userId != null,
    queryFn: async ({ signal }) => {
      const { data, error } = await api.GET("/api/v1/users/me/stats/monthly", {
        signal,
      });
      if (error) throw new Error("monthly stats fetch failed");
      return data as unknown as MonthlyStats;
    },
  });

  return { stats: query.data ?? null, loading: query.isLoading };
}
