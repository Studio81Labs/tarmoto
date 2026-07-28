/**
 * RideTrackingKillWatcher — root-mounted `ride_tracking` incident teardown.
 *
 * The point of this component (vs the screen-scoped effect it replaced) is that
 * it survives the live HUD unmounting: the GPS/sensor singletons keep running
 * for the resume flow, so a mid-ride kill must be caught here regardless of
 * which screen is mounted. It is telemetry-FIRST: release the collectors
 * immediately, reconcile the backend off the teardown path.
 */
import React from "react";
import { render, waitFor } from "@testing-library/react-native";
import RideTrackingKillWatcher from "../RideTrackingKillWatcher";
import { useRideStore } from "@/stores";
import { locationService } from "@/services/location";
import { sensorService } from "@/services/sensors";
import { api } from "@/services/api";
import { useFeatureKillSwitchActive } from "@/hooks/useFeatureKillSwitch";
import type { RideResponse } from "@/types";

jest.mock("@/services/location", () => ({
  locationService: { stop: jest.fn() },
}));
jest.mock("@/services/sensors", () => ({
  sensorService: { stop: jest.fn(() => ({ readings: [], tagEvents: [] })) },
}));
jest.mock("@/services/api", () => ({
  api: { stopRide: jest.fn() },
}));
jest.mock("@/hooks/useFeatureKillSwitch", () => ({
  useFeatureKillSwitchActive: jest.fn(() => true),
}));

const mockedKill = useFeatureKillSwitchActive as jest.MockedFunction<
  typeof useFeatureKillSwitchActive
>;
const stopRideApi = api.stopRide as jest.MockedFunction<typeof api.stopRide>;
const locationStop = locationService.stop as jest.Mock;
const sensorStop = sensorService.stop as jest.Mock;

function killRideTracking(): void {
  mockedKill.mockImplementation((key) => key !== "ride_tracking");
}

describe("RideTrackingKillWatcher", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedKill.mockReturnValue(true);
    stopRideApi.mockResolvedValue({ id: "ride-99" } as RideResponse);
    useRideStore.setState({
      isRiding: false,
      activeRide: null,
      startedAtMs: null,
    });
  });

  it("does nothing while ride_tracking is active", async () => {
    useRideStore.setState({
      isRiding: true,
      activeRide: { id: "r1" } as never,
    });
    await render(<RideTrackingKillWatcher />);
    expect(locationStop).not.toHaveBeenCalled();
    expect(sensorStop).not.toHaveBeenCalled();
  });

  it("does nothing when no ride is active even if killed", async () => {
    killRideTracking();
    useRideStore.setState({ isRiding: false });
    await render(<RideTrackingKillWatcher />);
    expect(locationStop).not.toHaveBeenCalled();
  });

  it("stops telemetry + reconciles backend + ends the session on a mid-ride kill", async () => {
    killRideTracking();
    useRideStore.setState({
      isRiding: true,
      activeRide: { id: "ride-99" } as never,
    });

    await render(<RideTrackingKillWatcher />);

    // Telemetry released immediately.
    expect(locationStop).toHaveBeenCalledTimes(1);
    expect(sensorStop).toHaveBeenCalledTimes(1);
    // Backend reconciled and the local session ended.
    await waitFor(() => expect(stopRideApi).toHaveBeenCalledWith("ride-99"));
    expect(useRideStore.getState().isRiding).toBe(false);
  });

  it("releases telemetry even when the backend stop hangs (never resolves)", async () => {
    killRideTracking();
    stopRideApi.mockImplementation(
      () => new Promise<RideResponse>(() => undefined),
    );
    useRideStore.setState({
      isRiding: true,
      activeRide: { id: "ride-99" } as never,
    });

    await render(<RideTrackingKillWatcher />);

    // Not blocked on the network — collectors are released and the session
    // ends regardless.
    expect(locationStop).toHaveBeenCalledTimes(1);
    expect(sensorStop).toHaveBeenCalledTimes(1);
    expect(useRideStore.getState().isRiding).toBe(false);
  });

  it("swallows a rejected backend stop", async () => {
    killRideTracking();
    stopRideApi.mockRejectedValue(new Error("server unreachable"));
    useRideStore.setState({
      isRiding: true,
      activeRide: { id: "ride-99" } as never,
    });

    await render(<RideTrackingKillWatcher />);

    expect(locationStop).toHaveBeenCalledTimes(1);
    expect(useRideStore.getState().isRiding).toBe(false);
    // Let the rejected promise settle without an unhandled rejection.
    await waitFor(() => expect(stopRideApi).toHaveBeenCalled());
  });

  it("stops telemetry without a backend call when the start POST is still in flight", async () => {
    killRideTracking();
    // Ride recording but no backend id yet (start POST in flight).
    useRideStore.setState({ isRiding: true, activeRide: null });

    await render(<RideTrackingKillWatcher />);

    expect(locationStop).toHaveBeenCalledTimes(1);
    expect(sensorStop).toHaveBeenCalledTimes(1);
    // No id → no direct stop call (the in-flight POST handler cleans up).
    expect(stopRideApi).not.toHaveBeenCalled();
    expect(useRideStore.getState().isRiding).toBe(false);
  });
});
