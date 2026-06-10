import { useQuery } from "@tanstack/react-query";
import type { ContributionStats } from "@tarmoto/shared";
import { api } from "@/lib/api";
import { useAuthStore } from "@/stores/auth";

/**
 * The rider's road-quality contribution for the sidebar "Your contribution"
 * badge. Returns `null` while loading or before the first fetch. The badge
 * hides itself when the rider hasn't mapped anything yet (`km_mapped === 0`),
 * and drops the regional line when `percentile` / `home_region` are null, so
 * a rider with no home region set doesn't see a half-empty card.
 */
export function useContribution(): {
  contribution: ContributionStats | null;
  loading: boolean;
  error: boolean;
} {
  const userId = useAuthStore((s) => s.user?.id ?? null);

  const query = useQuery({
    queryKey: ["contribution", userId],
    enabled: userId != null,
    queryFn: async ({ signal }) => {
      const { data, error } = await api.GET("/api/v1/users/me/contribution", {
        signal,
      });
      if (error) throw new Error("contribution fetch failed");
      return data as unknown as ContributionStats;
    },
  });

  return {
    contribution: query.data ?? null,
    loading: query.isLoading,
    error: query.isError,
  };
}
