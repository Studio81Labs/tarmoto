import { useEffect, useMemo, useState } from "react";
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

interface RideListResponse {
  rides: UserRide[];
  total: number;
}

const PAGE_SIZE = 100;
const MAX_PAGES = 10;

/**
 * Fetches the signed-in user's recent rides (up to `PAGE_SIZE * MAX_PAGES`)
 * for the route-collections picker. Mirrors `useUserTrips` semantics: the
 * `error` flag distinguishes a transient API failure from "no rides", so the
 * detail page can suppress destructive prompts (e.g. removing missing-ride
 * rows) while the fetch is genuinely broken.
 *
 * The cap matches `fetchAllRides` (the stats helper) — riders with that many
 * recorded rides curate manually anyway, and the picker has its own search
 * field for narrowing within the loaded list.
 */
export function useUserRides(): {
  rides: UserRide[];
  loading: boolean;
  error: boolean;
  rideById: Map<string, UserRide>;
} {
  const userId = useAuthStore((s) => s.user?.id ?? null);
  const [rides, setRides] = useState<UserRide[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    setRides([]);
    setError(false);
    if (!userId) {
      setLoading(false);
      return;
    }
    const ctrl = new AbortController();
    setLoading(true);

    (async () => {
      const collected: UserRide[] = [];
      try {
        for (let page = 0; page < MAX_PAGES; page += 1) {
          const { data, error: apiError } = await api.GET("/api/v1/rides", {
            params: {
              query: { limit: PAGE_SIZE, offset: page * PAGE_SIZE },
            },
            signal: ctrl.signal,
          });
          if (ctrl.signal.aborted) return;
          if (apiError) throw new Error("rides fetch failed");
          const d = data as unknown as RideListResponse;
          const batch = d.rides ?? [];
          collected.push(...batch);
          const total = d.total ?? collected.length;
          if (collected.length >= total || batch.length < PAGE_SIZE) break;
        }
        if (!ctrl.signal.aborted) setRides(collected);
      } catch {
        if (!ctrl.signal.aborted) setError(true);
      } finally {
        if (!ctrl.signal.aborted) setLoading(false);
      }
    })();

    return () => ctrl.abort();
  }, [userId]);

  const rideById = useMemo(() => {
    const map = new Map<string, UserRide>();
    for (const r of rides) map.set(r.id, r);
    return map;
  }, [rides]);

  return { rides, loading, error, rideById };
}
