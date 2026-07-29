/**
 * Drains persisted pending ride-stops on cold start and every foreground.
 *
 * A `ride_tracking` kill (or a rider stop) that couldn't reach
 * `POST /rides/:id/stop` — offline, timeout, 5xx — leaves the ride id queued in
 * `rideStopReconciler`. Without a drain the backend ride stays `active` and the
 * one-active-ride constraint locks the rider out of new rides indefinitely. So
 * retry the queue whenever the app comes to the foreground (and once on cold
 * start), gated on being signed in — the stop endpoint is authenticated.
 *
 * Strategy mirrors `privacyRefreshMonitor`. Failures stay queued for the next
 * attempt; this is best-effort and never surfaces UI.
 */

import { AppState, type AppStateStatus } from "react-native";

export interface RideStopReconcileDeps {
  /** True when the user is signed in (a pending stop belongs to them). */
  isAuthenticated: () => boolean;
  /** Retry the persisted pending ride-stops (typically `drainPendingRideStops`). */
  drain: () => Promise<void>;
}

let monitorSubscription: { remove: () => void } | null = null;

export function startRideStopReconcileMonitor(
  deps: RideStopReconcileDeps,
): () => void {
  stopRideStopReconcileMonitor();

  void drainIfAuthenticated(deps);

  const onChange = (next: AppStateStatus) => {
    if (next === "active") void drainIfAuthenticated(deps);
  };
  const subscription = AppState.addEventListener("change", onChange);
  monitorSubscription = subscription;

  return () => {
    if (monitorSubscription === subscription) {
      stopRideStopReconcileMonitor();
    } else {
      subscription.remove();
    }
  };
}

export function stopRideStopReconcileMonitor(): void {
  if (monitorSubscription) {
    monitorSubscription.remove();
    monitorSubscription = null;
  }
}

async function drainIfAuthenticated(
  deps: RideStopReconcileDeps,
): Promise<void> {
  if (!deps.isAuthenticated()) return;
  try {
    await deps.drain();
  } catch {
    // Best-effort — the queue persists, the next foreground retries.
  }
}
