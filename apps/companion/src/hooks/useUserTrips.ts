import { useEffect, useMemo, useState } from "react";
import { tripsApi } from "@/lib/api";
import { useAuthStore } from "@/stores/auth";
import { useTripStore } from "@/stores/trip";
import {
  tripSummaryFromWire,
  type TripSummaryWire,
} from "@/lib/trip-from-detail";
import type { TripSummary } from "@/lib/types";

/**
 * Fetches the signed-in user's trips on mount and whenever the `userId`
 * changes. Writes into the shared `useTripStore` so other components (the
 * planner, the trip card in `/trips`, etc.) keep reading the same list.
 *
 * Encapsulates the cancellation guard, response-shape normalisation, and
 * sign-out reset that would otherwise be copy-pasted into every consumer —
 * and which were already drifting across the two collection pages.
 *
 * Returns `trips`, a loading flag, a `tripById` lookup, and an `error` flag.
 * Consumers that do destructive things based on trip presence (the
 * collection detail "missing trip" row, for instance) must not act while
 * `error` is true — otherwise a transient API outage would look
 * indistinguishable from every trip having been deleted.
 *
 * NOTE: `trips/page.tsx` also inlines this pattern and predates the hook;
 * migrate it in a follow-up PR to keep this change scoped to collections.
 */
export function useUserTrips(): {
  trips: TripSummary[];
  loading: boolean;
  error: boolean;
  tripById: Map<string, TripSummary>;
} {
  const userId = useAuthStore((s) => s.user?.id ?? null);
  const trips = useTripStore((s) => s.trips);
  const setTrips = useTripStore((s) => s.setTrips);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    // Clear the store on every userId change so the *previous* user's trips
    // can't briefly leak after sign-in/out or account switch.
    setTrips([]);
    setError(false);
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
        // The list endpoint may return either a raw array or a
        // `{ data }` envelope depending on backend version. Either
        // way, each row is a wire-shape `TripSummaryDto` (`title`,
        // `created_at`) — adapt to the companion's `TripSummary`
        // (`name`, `createdAt`) before storing so list consumers
        // don't read undefined fields.
        const body = data as { data?: TripSummaryWire[] } | TripSummaryWire[];
        const rows = Array.isArray(body) ? body : (body?.data ?? []);
        setTrips(rows.map(tripSummaryFromWire));
      })
      .catch(() => {
        if (cancelled) return;
        // Deliberately leave `trips` untouched here — a transient API
        // failure mustn't masquerade as "every trip deleted" or consumers
        // will offer destructive actions (e.g. the collection detail's
        // MissingTripRow) against perfectly valid references.
        setError(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [setTrips, userId]);

  const tripById = useMemo(() => {
    const map = new Map<string, TripSummary>();
    for (const t of trips) map.set(t.id, t);
    return map;
  }, [trips]);

  return { trips, loading, error, tripById };
}
