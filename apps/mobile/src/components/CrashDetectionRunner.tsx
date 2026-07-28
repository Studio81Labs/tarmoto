/**
 * CrashDetectionRunner — root-mounted leaf that wires the crash detector
 * to the live ride.
 *
 * Returns null. Pattern mirrors `CarPlayRideMirror` and
 * `RideDurationTicker`: a leaf component sits at the navigator root so
 * its high-frequency subscriptions don't re-render the whole tree.
 *
 * Lifecycle:
 *   1. Run only when `useAuthStore.user.preferences.crash_detection` is
 *      `true` AND `useRideStore.isRiding` is `true`. (US-12 AC #1: "runs
 *      while a ride is active when crash_detection is enabled".)
 *   2. Subscribe to the raw 50 Hz reading stream and feed it into a
 *      `CrashDetector` instance. On a positive trigger, snapshot the
 *      ride id / location / speed and flip `useCrashStore` into the
 *      countdown phase — `CrashAlertOverlay` (also at root) takes it
 *      from there.
 *   3. Tear down the subscription on unmount, on ride stop, or on a
 *      preference flip — the detector singleton is reset so a future
 *      ride starts clean.
 */
import React, { useEffect, useRef } from "react";
import { CrashDetector, type CrashEvent } from "@/services/crashDetector";
import { sensorService } from "@/services/sensors";
import { isFeatureKillSwitchActive } from "@/services/systemSwitchCache";
import { useAuthStore, useCrashStore, useRideStore } from "@/stores";

export default function CrashDetectionRunner(): React.ReactElement | null {
  const isRiding = useRideStore((s) => s.isRiding);
  const crashDetectionEnabled = useAuthStore(
    (s) => s.user?.preferences?.crash_detection ?? false,
  );
  // Subscribe to the phase as a derived boolean so this effect re-runs
  // when the alert overlay clears back to idle. Earlier we only checked
  // `phase !== "idle"` once at subscribe time with no `phase` dep, so
  // any non-idle phase that lingered while `isRiding` / preference
  // stayed stable would silently disable the detector for the rest of
  // the ride. (Bugbot 4ee09bc2.)
  const isPhaseIdle = useCrashStore((s) => s.phase === "idle");
  const detectorRef = useRef<CrashDetector | null>(null);

  useEffect(() => {
    if (!isRiding || !crashDetectionEnabled || !isPhaseIdle) return;
    // Operator kill switch (`crash_detection`, off the public /config/flags
    // fast path): don't subscribe the detector at all when an operator has
    // force-disabled it — e.g. a false-SOS storm. Read at subscribe time; the
    // POST-time gate in CrashAlertOverlay is the belt-and-braces safety net for
    // a kill that lands mid-ride while a countdown is already armed.
    if (!isFeatureKillSwitchActive("crash_detection")) return;

    const detector = new CrashDetector();
    detectorRef.current = detector;

    detector.onCrash((event: CrashEvent) => {
      const ride = useRideStore.getState();
      const crashStore = useCrashStore.getState();
      if (crashStore.phase !== "idle") return;
      // `event.speedAtImpactMps` is captured by the detector at the
      // moment the spike begins, so by the time onCrash fires (5s
      // later, after the immobility window) we still have the rider's
      // pre-impact speed. Reading `ride.currentSpeed` here would
      // report ~0 km/h because the rider is by definition stationary
      // for the trigger to fire. (Bugbot 00350521.)
      const speedKmh =
        event.speedAtImpactMps !== null ? event.speedAtImpactMps * 3.6 : null;
      crashStore.startCountdown({
        triggeredAt: event.triggeredAt,
        rideId: ride.activeRide?.id ?? null,
        lat: ride.location?.lat ?? null,
        lng: ride.location?.lng ?? null,
        speedAtImpact: speedKmh,
      });
    });

    const unsubscribe = sensorService.subscribeReadings((reading) => {
      detector.feed(reading);
    });

    return () => {
      unsubscribe();
      detector.onCrash(null);
      detector.reset();
      if (detectorRef.current === detector) {
        detectorRef.current = null;
      }
    };
  }, [isRiding, crashDetectionEnabled, isPhaseIdle]);

  return null;
}
