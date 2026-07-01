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

  useEffect(() => {
    if (options.polyline.length < 2) {
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
