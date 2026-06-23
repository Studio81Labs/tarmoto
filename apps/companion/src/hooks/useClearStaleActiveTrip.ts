import { useEffect } from "react";
import { useTripStore } from "@/stores/trip";

/**
 * Drop any trip left in the shared planner store by a previously opened or
 * edited trip.
 *
 * `activeTrip` lives in a module-level Zustand store that the planner never
 * resets on unmount, so after you open/edit a saved trip it lingers. Without
 * this, the "Create trip" entry points (which navigate to `/trips/planner`
 * with no `?tripId=`) would reopen that stale route instead of a blank
 * canvas. Call this from the trip-browsing hubs (`/trips`, the dashboard)
 * that you pass through on the way to creating a new trip; arriving there
 * means you're no longer editing a specific trip.
 *
 * Guarded so a genuine first visit (already-null store) stays a no-op.
 */
export function useClearStaleActiveTrip() {
  useEffect(() => {
    const store = useTripStore.getState();
    if (store.activeTrip) store.setActiveTrip(null);
  }, []);
}
