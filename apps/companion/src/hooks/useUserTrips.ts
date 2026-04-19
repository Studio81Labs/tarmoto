import { useEffect, useMemo, useState } from "react";
import { tripsApi } from "@/lib/api";
import { useAuthStore } from "@/stores/auth";
import { useTripStore } from "@/stores/trip";
import type { Trip } from "@/lib/types";

/**
 * Fetches the signed-in user's trips on mount and whenever the `userId`
 * changes. Writes into the shared `useTripStore` so other components (the
 * planner, the trip card in `/trips`, etc.) keep reading the same list.
 *
 * Encapsulates the cancellation guard, response-shape normalisation, and
 * sign-out reset that would otherwise be copy-pasted into every consumer —
 * and which were already drifting across the two collection pages.
 *
 * Returns `trips`, a loading flag, and a `tripById` lookup — the two pieces
 * every consumer ended up deriving on their own.
 *
 * NOTE: `trips/page.tsx` also inlines this pattern and predates the hook;
 * migrate it in a follow-up PR to keep this change scoped to collections.
 */
export function useUserTrips(): {
  trips: Trip[];
  loading: boolean;
  tripById: Map<string, Trip>;
} {
  const userId = useAuthStore((s) => s.user?.id ?? null);
  const trips = useTripStore((s) => s.trips);
  const setTrips = useTripStore((s) => s.setTrips);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Clear the store on every userId change so the *previous* user's trips
    // can't briefly leak after sign-in/out or account switch.
    setTrips([]);
    if (!userId) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    tripsApi
      .list()
      .then(({ data }) => {
        if (cancelled) return;
        const body = data as unknown as { data?: Trip[] } | Trip[];
        setTrips(Array.isArray(body) ? body : (body?.data ?? []));
      })
      .catch(() => {
        if (cancelled) return;
        setTrips([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [setTrips, userId]);

  const tripById = useMemo(() => {
    const map = new Map<string, Trip>();
    for (const t of trips) map.set(t.id, t);
    return map;
  }, [trips]);

  return { trips, loading, tripById };
}
