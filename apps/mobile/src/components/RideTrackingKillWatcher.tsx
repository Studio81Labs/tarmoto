/**
 * RideTrackingKillWatcher — root-mounted incident watcher for the
 * `ride_tracking` operator kill switch.
 *
 * Mounted as a leaf in `RootNavigator` next to `RideDurationTicker` /
 * `CrashDetectionRunner`, so it observes the ride lifecycle REGARDLESS of which
 * screen is showing. This matters because the ride's GPS + sensor singletons
 * intentionally keep running when the rider backs out of the live HUD (resume
 * flow / in-progress banner). If the kill only lived on `RideActiveScreen` it
 * would have no subscriber once the HUD unmounted, and the collectors would
 * keep gathering the potentially-corrupt data the switch exists to stop.
 *
 * On a `ride_tracking` force_off while a ride is active it is telemetry-FIRST
 * (like the incident it models): release the recording handles IMMEDIATELY,
 * DISCARD the buffered readings (don't persist corrupt data), then reconcile
 * the backend off the teardown path (best-effort `/rides/:id/stop`) so a slow
 * or failing request never keeps the collectors alive and the rider isn't
 * locked out of new rides. If the `/rides/start` POST is still in flight (no id
 * yet), `stopRide()` moves the session on and that POST's success handler
 * cleans up the orphaned backend ride.
 *
 * Reactive via `useFeatureKillSwitchActive` so a foreground poll / refresh that
 * persists the kill re-renders this leaf and fires the teardown promptly.
 */
import { useEffect, useRef } from "react";
import { api } from "@/services/api";
import { locationService } from "@/services/location";
import { sensorService } from "@/services/sensors";
import { reconcileRideStop } from "@/services/rideStopReconciler";
import { useFeatureKillSwitchActive } from "@/hooks/useFeatureKillSwitch";
import { useAuthStore, useRideStore } from "@/stores";

export default function RideTrackingKillWatcher(): null {
  const isRiding = useRideStore((s) => s.isRiding);
  const stopRideAction = useRideStore((s) => s.stopRide);
  const rideTrackingActive = useFeatureKillSwitchActive("ride_tracking");
  // One-shot per ride session; re-armed when a new ride starts.
  const handledRef = useRef(false);

  useEffect(() => {
    if (!isRiding) {
      handledRef.current = false;
      return;
    }
    if (rideTrackingActive || handledRef.current) return;
    handledRef.current = true;

    // 1. Stop collecting NOW — before any network round-trip.
    locationService.stop();
    sensorService.stop(); // buffered (potentially-corrupt) readings discarded.

    // 2. Reconcile the backend off the teardown path. `reconcileRideStop`
    //    dedupes against a concurrent rider-initiated stop, treats an
    //    already-stopped ride as success, and PERSISTS a transient failure for
    //    a later drain — so a stop that can't reach the server (offline) never
    //    orphans the backend ride and locks the rider out. A null id means the
    //    start POST is still in flight; `stopRide()` below moves the session on
    //    and that POST's handler cleans up the orphaned ride.
    const id = useRideStore.getState().activeRide?.id ?? null;
    // Owner for the retry queue. Prefer the token-derived id; fall back to the
    // hydrated profile id — an upgraded install can hold valid tokens but no
    // persisted USER_ID_KEY yet (a documented legacy state), and we still need
    // an owner so the queued stop is retryable rather than silently dropped.
    const userId =
      api.getAuthenticatedUserId() ?? useAuthStore.getState().user?.id ?? null;
    if (id && userId) void reconcileRideStop(id, userId).catch(() => undefined);

    // 3. End the local ride session.
    stopRideAction();
  }, [isRiding, rideTrackingActive, stopRideAction]);

  return null;
}
