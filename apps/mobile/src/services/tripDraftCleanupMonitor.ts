/**
 * Drains persisted orphaned trip-draft deletes on cold start and every foreground.
 *
 * A `trip_planning` kill mid-create can leave a `draft` persisted (it counts
 * against `max_active_trips`) whose cleanup delete failed for the same outage
 * that triggered the kill. Without a drain that draft sits in the rider's sole
 * Free slot with no in-app way to remove it. So retry the queue whenever the app
 * comes to the foreground (and once on cold start), gated on being signed in —
 * `DELETE /trips/:id` is authenticated.
 *
 * Mirrors `rideStopReconcileMonitor`. Failures stay queued for the next attempt;
 * best-effort, never surfaces UI.
 */

import { AppState, type AppStateStatus } from "react-native";

export interface TripDraftCleanupDeps {
  /** True when the user is signed in (the delete is authenticated). */
  isAuthenticated: () => boolean;
  /** Retry the persisted orphaned-draft deletes (typically `drainTripDraftCleanups`). */
  drain: () => Promise<void>;
}

let monitorSubscription: { remove: () => void } | null = null;

export function startTripDraftCleanupMonitor(
  deps: TripDraftCleanupDeps,
): () => void {
  stopTripDraftCleanupMonitor();

  void drainIfAuthenticated(deps);

  const onChange = (next: AppStateStatus) => {
    if (next === "active") void drainIfAuthenticated(deps);
  };
  const subscription = AppState.addEventListener("change", onChange);
  monitorSubscription = subscription;

  return () => {
    if (monitorSubscription === subscription) {
      stopTripDraftCleanupMonitor();
    } else {
      subscription.remove();
    }
  };
}

export function stopTripDraftCleanupMonitor(): void {
  if (monitorSubscription) {
    monitorSubscription.remove();
    monitorSubscription = null;
  }
}

async function drainIfAuthenticated(deps: TripDraftCleanupDeps): Promise<void> {
  if (!deps.isAuthenticated()) return;
  try {
    await deps.drain();
  } catch {
    // Best-effort — the queue persists, the next foreground retries.
  }
}
