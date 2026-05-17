import { useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useAuthStore } from "@/stores/auth";
import { useTripStore } from "@/stores/trip";
import {
  tripSummaryFromWire,
  type TripSummaryWire,
} from "@/lib/trip-from-detail";
import type { TripSummary } from "@/lib/types";

/**
 * Stable query key for the user-trips list. Exported so the trips
 * page's optimistic-mutation flows (duplicate / move / delete) can
 * invalidate the cache after a successful API round-trip — without
 * the invalidate, a remount within React Query's `staleTime` would
 * serve the pre-mutation cache back into the Zustand store and
 * silently undo the user's edit.
 */
export const USER_TRIPS_QUERY_KEY = (userId: string | null) =>
  ["user-trips", userId] as const;

/**
 * Fetches the signed-in user's trips on mount and whenever the
 * `userId` changes. Driven by `@tanstack/react-query`: cancellation,
 * dedup, and stale-while-revalidate cache semantics come for free.
 *
 * The cache key includes `userId`, so switching accounts can't
 * serve the previous user's trips to the new one even within the
 * default `staleTime` window.
 *
 * The Zustand store is kept as a write-through cache because
 * `(dashboard)/trips/page.tsx`'s optimistic mutations operate on
 * the store directly. After every mutation that page also calls
 * `queryClient.invalidateQueries({ queryKey: USER_TRIPS_QUERY_KEY })`
 * so a subsequent remount refetches instead of clobbering the
 * post-mutation store with stale cache.
 *
 * Returns `trips`, a loading flag, a `tripById` lookup, and an
 * `error` flag. Consumers that do destructive things based on trip
 * presence must not act while `error` is true — a transient API
 * outage shouldn't look like every trip was deleted.
 */
export function useUserTrips(): {
  trips: TripSummary[];
  loading: boolean;
  error: boolean;
  tripById: Map<string, TripSummary>;
} {
  const userId = useAuthStore((s) => s.user?.id ?? null);
  const setTrips = useTripStore((s) => s.setTrips);
  const trips = useTripStore((s) => s.trips);

  const query = useQuery({
    queryKey: USER_TRIPS_QUERY_KEY(userId),
    enabled: userId != null,
    queryFn: async ({ signal }) => {
      const { data, error } = await api.GET("/api/v1/trips", { signal });
      if (error) throw new Error("trips fetch failed");
      return data;
    },
  });

  // Clear the previous account's trips on every `userId` change
  // (including A→B account switches, not just sign-out). Without
  // this, the load window of the new user's fetch would briefly
  // serve the previous user's trips out of the Zustand store —
  // the React Query cache is user-keyed, but the store is global.
  useEffect(() => {
    setTrips([]);
  }, [userId, setTrips]);

  // Write-through into the Zustand store. The list endpoint may
  // return either a raw array or a `{ data: [] }` envelope depending
  // on backend version — both branches yield `TripSummaryWire[]` and
  // the adapter normalises to the companion's camelCase shape.
  useEffect(() => {
    if (!userId || !query.data) return;
    const body = query.data as unknown as
      | { data?: TripSummaryWire[] }
      | TripSummaryWire[];
    const rows = Array.isArray(body) ? body : (body?.data ?? []);
    setTrips(rows.map(tripSummaryFromWire));
  }, [query.data, userId, setTrips]);

  const tripById = useMemo(() => {
    const map = new Map<string, TripSummary>();
    for (const t of trips) map.set(t.id, t);
    return map;
  }, [trips]);

  return {
    trips,
    loading: query.isLoading,
    // React Query exposes `isError` for fetch failures (network,
    // 5xx, 401 once `onUnauthorized` has cleared the session). The
    // optimistic-update consumers in `(dashboard)/trips/page.tsx`
    // gate destructive prompts on this flag.
    error: query.isError,
    tripById,
  };
}
