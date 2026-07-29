/**
 * useVehicleNavigationDisplay — head-unit projection gate.
 *
 * Pins the operator-kill-switch contract added for SP4: when `enabled` is
 * false (either `basic_navigation` or `carplay_android_auto` force_off) the
 * hook stops any live vehicle display and never syncs a fresh snapshot, so the
 * route + maneuvers come off the head unit.
 */

import { renderHook } from "@testing-library/react-native";
import { useVehicleNavigationDisplay } from "../useVehicleNavigationDisplay";
import {
  syncVehicleNavigationDisplay,
  stopVehicleNavigationDisplay,
} from "@/services/vehicleDisplay";
import type { LatLng } from "@/types";

jest.mock("@/services/vehicleDisplay", () => ({
  syncVehicleNavigationDisplay: jest.fn(),
  stopVehicleNavigationDisplay: jest.fn(),
}));

jest.mock("@/services/api", () => ({
  api: { reportHazard: jest.fn() },
}));

const mockedSync = syncVehicleNavigationDisplay as jest.Mock;
const mockedStop = stopVehicleNavigationDisplay as jest.Mock;

const polyline: LatLng[] = [
  { lat: 49.5, lng: 18.1 },
  { lat: 49.6, lng: 18.2 },
];

function baseOptions(enabled: boolean, projectionEnabled = true) {
  return {
    enabled,
    projectionEnabled,
    title: "Home → Work",
    polyline,
    tick: null,
    liveLocation: null,
    nextManeuver: null,
  };
}

describe("useVehicleNavigationDisplay — kill-switch gate", () => {
  beforeEach(() => {
    mockedSync.mockReset();
    mockedStop.mockReset();
  });

  it("syncs the projection when enabled with a usable polyline", async () => {
    await renderHook(() => useVehicleNavigationDisplay(baseOptions(true)));
    expect(mockedSync).toHaveBeenCalledTimes(1);
  });

  it("soft-stops (ride-board fallback) when basic_navigation is disabled", async () => {
    await renderHook(() =>
      useVehicleNavigationDisplay(baseOptions(false, true)),
    );
    expect(mockedSync).not.toHaveBeenCalled();
    expect(mockedStop).toHaveBeenCalled();
    // Soft stop → no hard flag, so the controller restores the ride board.
    expect(mockedStop).not.toHaveBeenCalledWith(true);
  });

  it("hard-stops to the inert root when carplay projection is disabled", async () => {
    await renderHook(() =>
      // basic_navigation on, carplay projection OFF → hard kill.
      useVehicleNavigationDisplay(baseOptions(true, false)),
    );
    expect(mockedSync).not.toHaveBeenCalled();
    expect(mockedStop).toHaveBeenCalledWith(true);
  });

  it("tears the projection down when a live display is disabled mid-session", async () => {
    const { rerender } = await renderHook(
      (props: { enabled: boolean }) =>
        useVehicleNavigationDisplay(baseOptions(props.enabled)),
      { initialProps: { enabled: true } },
    );
    expect(mockedSync).toHaveBeenCalledTimes(1);
    mockedStop.mockClear();

    await rerender({ enabled: false });
    expect(mockedStop).toHaveBeenCalled();
  });
});
