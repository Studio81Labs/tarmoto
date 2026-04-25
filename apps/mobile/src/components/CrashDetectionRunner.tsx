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
import { useAuthStore, useCrashStore, useRideStore } from "@/stores";

export default function CrashDetectionRunner(): React.ReactElement | null {
  const isRiding = useRideStore((s) => s.isRiding);
  const crashDetectionEnabled = useAuthStore(
    (s) => s.user?.preferences?.crash_detection ?? false,
  );
  const detectorRef = useRef<CrashDetector | null>(null);

  useEffect(() => {
    if (!isRiding || !crashDetectionEnabled) return;
    // Already showing a crash alert from a prior trigger — don't fire
    // a second one over the top.
    if (useCrashStore.getState().phase !== "idle") return;

    const detector = new CrashDetector();
    detectorRef.current = detector;

    detector.onCrash((event: CrashEvent) => {
      const ride = useRideStore.getState();
      const crashStore = useCrashStore.getState();
      if (crashStore.phase !== "idle") return;
      crashStore.startCountdown({
        triggeredAt: event.triggeredAt,
        rideId: ride.activeRide?.id ?? null,
        lat: ride.location?.lat ?? null,
        lng: ride.location?.lng ?? null,
        // Use the last known speed — by the time the immobility window
        // has elapsed (5s), the rider's speed is already 0. The peak
        // happens at impact, so the most useful value is the speed
        // captured just before the spike.
        speedAtImpact: ride.currentSpeed ?? null,
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
  }, [isRiding, crashDetectionEnabled]);

  return null;
}
