import { useEffect } from "react";
import { api } from "@/services/api";
import {
  syncVehicleNavigationDisplay,
  stopVehicleNavigationDisplay,
  type VehicleNavigationSnapshot,
} from "@/services/vehicleDisplay";
import type { Maneuver, NavTick } from "@/services/navigation";
import { useRideStore } from "@/stores";
import type { LatLng } from "@/types";

export interface UseVehicleNavigationDisplayOptions {
  /**
   * Whether the head-unit navigation projection may run. Gates the
   * `basic_navigation` + `carplay_android_auto` operator kill switches:
   * `false` stops any live vehicle display and skips syncing, so a killed
   * switch tears the route + maneuvers off the head unit. Defaults to `true`
   * so existing callers keep projecting.
   */
  enabled?: boolean;
  title: string;
  polyline: LatLng[];
  tick: NavTick | null;
  liveLocation: LatLng | null;
  nextManeuver: Maneuver | null;
}

export function useVehicleNavigationDisplay(
  options: UseVehicleNavigationDisplayOptions,
): void {
  const currentSpeed = useRideStore((state) => state.currentSpeed);
  const distanceKm = useRideStore((state) => state.distance);
  const durationSeconds = useRideStore((state) => state.duration);
  const rideType = useRideStore((state) => state.rideType);
  const storeLocation = useRideStore((state) => state.location);

  useEffect(() => {
    return () => {
      stopVehicleNavigationDisplay();
    };
  }, []);

  const enabled = options.enabled ?? true;

  useEffect(() => {
    if (!enabled || options.polyline.length < 2) {
      // Operator kill switch (or an unusable polyline): stop any live head-unit
      // projection and don't sync a fresh snapshot.
      stopVehicleNavigationDisplay();
      return;
    }

    const snapshot: VehicleNavigationSnapshot = {
      title: options.title,
      polyline: options.polyline,
      currentLocation:
        options.liveLocation ??
        (storeLocation
          ? { lat: storeLocation.lat, lng: storeLocation.lng }
          : null),
      nextManeuver: options.nextManeuver
        ? {
            type: options.nextManeuver.type,
            ...(options.nextManeuver.roadName !== undefined
              ? { roadName: options.nextManeuver.roadName }
              : {}),
          }
        : null,
      distanceToNextM: options.tick?.distanceToNextM ?? 0,
      remainingM: options.tick?.remainingM ?? 0,
      offRoute: options.tick?.offRoute ?? false,
      offRouteDistanceM: options.tick?.offRouteDistanceM ?? 0,
      rideStats: {
        rideType,
        speedKmh: currentSpeed,
        distanceKm,
        durationSeconds,
      },
      banner: null,
    };

    syncVehicleNavigationDisplay(snapshot, async (location, type) => {
      await api.reportHazard(location.lat, location.lng, type);
    });
  }, [
    enabled,
    options.title,
    options.polyline,
    options.tick,
    options.liveLocation,
    options.nextManeuver,
    storeLocation,
    rideType,
    currentSpeed,
    distanceKm,
    durationSeconds,
  ]);
}
