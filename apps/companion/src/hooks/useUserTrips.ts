import { useEffect, useMemo, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
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
 * page's optimistic-mutation flows (duplicate / move / delete /
 * folder-delete) can drop the cache after a successful API
 * round-trip — without that, a hook consumer remounting within
 * `staleTime` would serve the pre-mutation cache through React
 * Query and let the write-through effect copy it back over the
 * freshly-mutated store.
 */
export const USER_TRIPS_QUERY_KEY = (userId: string | null) =>
  ["user-trips", userId] as const;

/**
 * Fetches the signed-in user's trips on mount and whenever the
 * `userId` changes. Driven by `@tanstack/react-query`: cancellation,
 * dedup, and stale-while-revalidate cache semantics come for free.
 *
 * Account-switch safety:
 * - The React Query cache key includes `userId`, so cached A data
 *   is never served on B's first render.
 * - The Zustand `trips` field is gated on `tripsOwnerId === userId`
 *   AT RENDER TIME, so even if the store still holds A's rows
 *   when B mounts, the hook returns `[]` until B's data lands.
 *   The post-commit clear effect zeroes the store for subsequent
 *   reads.
 *
 * Mutation safety: the trips page's optimistic flows call
 * `queryClient.removeQueries({ queryKey: USER_TRIPS_QUERY_KEY })`
 * (not invalidateQueries — invalidate keeps the stale data
 * available until refetch lands, which would let this write-
 * through overwrite the post-mutation store).
 */
export function useUserTrips(options?: { enabled?: boolean }): {
  trips: TripSummary[];
  loading: boolean;
  error: boolean;
  tripById: Map<string, TripSummary>;
} {
  const userId = useAuthStore((s) => s.user?.id ?? null);
  const setTrips = useTripStore((s) => s.setTrips);
  const storeTrips = useTripStore((s) => s.trips);
  const tripsOwnerId = useTripStore((s) => s.tripsOwnerId);
  const queryClient = useQueryClient();
  // Defaults to on; the explorer passes `false` while the My-trips overlay is
  // off so opening Explorer doesn't fire the (geospatial) trip-outline list.
  const enabled = userId != null && (options?.enabled ?? true);

  const query = useQuery({
    queryKey: USER_TRIPS_QUERY_KEY(userId),
    enabled,
    queryFn: async ({ signal }) => {
      const { data, error } = await api.GET("/api/v1/trips", { signal });
      if (error) throw new Error("trips fetch failed");
      return data;
    },
  });

  // Clear the previous account's trips on an actual userId change
  // (mount-with-A → mount-with-B, or sign-out). On initial mount
  // there's no prior user to clean up — running `removeQueries`
  // there would drop the query this very mount just kicked off
  // and defeat React Query's `staleTime`.
  const prevUserIdRef = useRef<string | null>(null);
  useEffect(() => {
    const prev = prevUserIdRef.current;
    prevUserIdRef.current = userId;
    if (prev === userId) return;
    // Always mark the store as owned by the new id (or null) so
    // the render-time gate below can short-circuit immediately —
    // the upcoming write-through repopulates if there's data.
    setTrips([], userId);
    // Drop only the PREVIOUS user's cached query, not the current
    // user's freshly-registered observer.
    if (prev !== null) {
      queryClient.removeQueries({
        queryKey: USER_TRIPS_QUERY_KEY(prev),
      });
    }
  }, [userId, setTrips, queryClient]);

  // Write-through into the Zustand store. The list endpoint may
  // return either a raw array or a `{ data: [] }` envelope
  // depending on backend version — both branches yield
  // `TripSummaryWire[]` and the adapter normalises to the
  // companion's camelCase shape. Each write also marks the store
  // as owned by the current `userId` so the render-time gate
  // returns the freshly-fetched rows immediately.
  useEffect(() => {
    if (!userId || !query.data) return;
    const body = query.data as unknown as
      { data?: TripSummaryWire[] } | TripSummaryWire[];
    const rows = Array.isArray(body) ? body : (body?.data ?? []);
    setTrips(rows.map(tripSummaryFromWire), userId);
  }, [query.data, userId, setTrips]);

  // Render-time owner gate. If the store still holds the previous
  // account's trips (the post-commit clear hasn't run yet), return
  // `[]` so callers can't briefly see or act on the wrong user's
  // data. `tripsOwnerId` flips to the new `userId` synchronously
  // inside `setTrips`, ahead of `query.data` landing.
  const trips =
    tripsOwnerId !== null && tripsOwnerId === userId ? storeTrips : [];

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
