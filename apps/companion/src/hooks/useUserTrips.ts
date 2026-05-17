import { useEffect, useMemo } from "react";
import { $api } from "@/lib/api";
import { useAuthStore } from "@/stores/auth";
import { useTripStore } from "@/stores/trip";
import {
  tripSummaryFromWire,
  type TripSummaryWire,
} from "@/lib/trip-from-detail";
import type { TripSummary } from "@/lib/types";

/**
 * Fetches the signed-in user's trips on mount and whenever the `userId`
 * changes. Internally driven by `openapi-react-query`'s `useQuery` — the
 * hook handles cancellation, dedup, and stale-while-revalidate cache
 * semantics; we keep the Zustand store as a write-through cache so
 * `(dashboard)/trips/page.tsx`'s optimistic add/move/delete flows
 * (which mutate `useTripStore.trips` directly) keep working without
 * threading state through React Query mutations.
 *
 * Returns `trips`, a loading flag, a `tripById` lookup, and an `error`
 * flag. Consumers that do destructive things based on trip presence
 * must not act while `error` is true — otherwise a transient API outage
 * looks indistinguishable from every trip having been deleted.
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

  const query = $api.useQuery(
    "get",
    "/api/v1/trips",
    {},
    { enabled: userId != null },
  );

  // Write-through into the Zustand store. The list endpoint may return
  // either a raw array or a `{ data: [] }` envelope depending on
  // backend version — both branches yield `TripSummaryWire[]` and the
  // adapter normalises to the companion's camelCase shape.
  useEffect(() => {
    if (!userId) {
      setTrips([]);
      return;
    }
    if (!query.data) return;
    const body = query.data as unknown as
      | { data?: TripSummaryWire[] }
      | TripSummaryWire[];
    const rows = Array.isArray(body) ? body : (body?.data ?? []);
    setTrips(rows.map(tripSummaryFromWire));
  }, [query.data, userId, setTrips]);

  // Clear on sign-out so a brief stale read doesn't surface the
  // previous account's trips between sign-out and sign-in.
  useEffect(() => {
    if (!userId) setTrips([]);
  }, [userId, setTrips]);

  const tripById = useMemo(() => {
    const map = new Map<string, TripSummary>();
    for (const t of trips) map.set(t.id, t);
    return map;
  }, [trips]);

  return {
    trips,
    loading: query.isLoading,
    // React Query exposes `isError` for fetch failures (network, 5xx,
    // 401 once `onUnauthorized` has cleared the session). The
    // optimistic-update consumers in `(dashboard)/trips/page.tsx`
    // gate destructive prompts on this flag.
    error: query.isError,
    tripById,
  };
}
