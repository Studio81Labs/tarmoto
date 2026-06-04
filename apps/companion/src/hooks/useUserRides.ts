import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useAuthStore } from "@/stores/auth";

/**
 * Lightweight ride summary returned by `GET /api/v1/rides`. Mirrors the
 * `RideSummaryDto` shape on the backend — kept inline here so the collections
 * picker doesn't need to reach into `useRidesQuery` (its `RideSummary`
 * interface is private to the rides dashboard).
 */
export interface UserRide {
  id: string;
  name: string | null;
  status: string;
  ride_type: string;
  started_at: string;
  ended_at: string | null;
  distance_km: number | null;
  duration_min: number | null;
  avg_speed: number | null;
  avg_road_quality: number | null;
}

export interface RideListResponse {
  rides: UserRide[];
  total: number;
}

const PAGE_SIZE = 100;
const MAX_PAGES = 10;

/**
 * Fetches the signed-in user's recent rides (up to `PAGE_SIZE * MAX_PAGES`)
 * for the route-collections picker. Mirrors `useUserTrips` semantics: the
 * `error` flag distinguishes a transient API failure from "no rides", so
 * the detail page can suppress destructive prompts (e.g. removing
 * missing-ride rows) while the fetch is genuinely broken.
 *
 * The cap matches `fetchAllRides` (the stats helper) — riders with that
 * many recorded rides curate manually anyway, and the picker has its own
 * search field for narrowing within the loaded list. Driven by
 * `@tanstack/react-query` so cancellation, dedup, and stale-while-
 * revalidate semantics come for free; the page-loop runs inside the
 * `queryFn` because React Query's `useInfiniteQuery` API is overkill
 * when the picker always wants the accumulated result anyway.
 */
export function useUserRides(): {
  rides: UserRide[];
  loading: boolean;
  error: boolean;
  rideById: Map<string, UserRide>;
} {
  const userId = useAuthStore((s) => s.user?.id ?? null);

  const query = useQuery({
    queryKey: ["user-rides", userId],
    enabled: userId != null,
    queryFn: async ({ signal }) => {
      const collected: UserRide[] = [];
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const { data, error: apiError } = await api.GET("/api/v1/rides", {
          params: {
            query: { limit: PAGE_SIZE, offset: page * PAGE_SIZE },
          },
          signal,
        });
        if (apiError) throw new Error("rides fetch failed");
        const d = data as unknown as RideListResponse;
        const batch = d.rides ?? [];
        collected.push(...batch);
        const total = d.total ?? collected.length;
        if (collected.length >= total || batch.length < PAGE_SIZE) break;
      }
      return collected;
    },
  });

  const rides = query.data ?? [];

  const rideById = useMemo(() => {
    const map = new Map<string, UserRide>();
    for (const r of rides) map.set(r.id, r);
    return map;
  }, [rides]);

  return {
    rides,
    loading: query.isLoading,
    error: query.isError,
    rideById,
  };
}
