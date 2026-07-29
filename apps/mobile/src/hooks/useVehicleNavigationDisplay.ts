import { useEffect } from "react";
import { api } from "@/services/api";
import { isFeatureKillSwitchActive } from "@/services/systemSwitchCache";
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
   * Whether turn-by-turn is enabled (`basic_navigation`). `false` stops the
   * projection and falls back to the ride-status board (turn-by-turn off, the
   * ride still records). Defaults to `true`.
   */
  enabled?: boolean;
  /**
   * Whether head-unit projection as a whole is enabled (`carplay_android_auto`).
   * `false` HARD-stops the projection to the inert idle root — no ride board
   * fallback — so the operator kill switch leaves no Tarmoto nav surface.
   * Defaults to `true`.
   */
  projectionEnabled?: boolean;
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
  const projectionEnabled = options.projectionEnabled ?? true;

  useEffect(() => {
    if (!projectionEnabled) {
      // `carplay_android_auto` kill — HARD-stop to the inert idle root (no ride
      // board fallback), so no Tarmoto nav surface remains on the head unit.
      stopVehicleNavigationDisplay(true);
      return;
    }
    if (!enabled || options.polyline.length < 2) {
      // `basic_navigation` kill (or an unusable polyline): stop turn-by-turn;
      // the controller falls back to the ride-status board if a ride is active.
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
      // Operator kill switch (`hazard_reporting`): the head-unit quick-report
      // is a direct `api.reportHazard` POST that never opens the guarded
      // HazardReportScreen, so gate it here too — otherwise a CarPlay/Android
      // Auto report still submits during an abuse-wave kill. Synchronous read
      // at invocation time reflects the live switch state.
      if (!isFeatureKillSwitchActive("hazard_reporting")) return;
      await api.reportHazard(location.lat, location.lng, type);
    });
  }, [
    enabled,
    projectionEnabled,
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
