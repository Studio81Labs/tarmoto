/**
 * CrashDetectionRunner — wires the live ride to the crash detector
 * (US-12 AC #1 lifecycle).
 *
 * The detector logic itself is exhaustively covered in
 * `services/__tests__/crashDetector.test.ts`. These tests pin the
 * runner's *integration* contract with the stores and the sensor
 * subscription: when does it subscribe, when does it tear down, and
 * how does a triggered event hand off into `useCrashStore`.
 */
import React from "react";
import { act, render } from "@testing-library/react-native";
import CrashDetectionRunner from "../CrashDetectionRunner";
import { useAuthStore, useCrashStore, useRideStore } from "@/stores";
import { sensorService } from "@/services/sensors";
import type { User } from "@/types";

jest.mock("@/services/sensors", () => ({
  sensorService: {
    subscribeReadings: jest.fn(),
  },
}));

const mockedSensors = sensorService as jest.Mocked<typeof sensorService>;

function userWithCrashDetection(enabled: boolean): User {
  return {
    id: "u1",
    email: "rider@tarmoto.app",
    display_name: "Rider",
    created_at: "2026-04-25T10:00:00Z",
    preferences: {
      units: "metric",
      daily_km: 200,
      min_quality: 3,
      road_types: [],
      record_gps: true,
      crash_detection: enabled,
    },
  };
}

describe("CrashDetectionRunner", () => {
  let unsubscribe: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    unsubscribe = jest.fn();
    mockedSensors.subscribeReadings.mockReturnValue(unsubscribe);
    useCrashStore.setState({ phase: "idle", alert: null, errorMessage: null });
    useRideStore.setState({
      activeRide: null,
      isRiding: false,
      rideType: "free",
      startedAtMs: null,
      currentSpeed: 0,
      currentQuality: null,
      location: null,
      distance: 0,
      duration: 0,
      segmentCount: 0,
      recentRides: [],
    });
    useAuthStore.setState({
      user: null,
      isAuthenticated: false,
      isLoading: false,
    });
  });

  it("does nothing when no ride is active", () => {
    useAuthStore.getState().setUser(userWithCrashDetection(true));
    render(<CrashDetectionRunner />);
    expect(mockedSensors.subscribeReadings).not.toHaveBeenCalled();
  });

  it("does nothing when crash detection is disabled", () => {
    useAuthStore.getState().setUser(userWithCrashDetection(false));
    act(() => useRideStore.getState().startRide("free"));
    render(<CrashDetectionRunner />);
    expect(mockedSensors.subscribeReadings).not.toHaveBeenCalled();
  });

  it("subscribes when a ride starts with the preference enabled", () => {
    useAuthStore.getState().setUser(userWithCrashDetection(true));
    act(() => useRideStore.getState().startRide("free"));
    render(<CrashDetectionRunner />);
    expect(mockedSensors.subscribeReadings).toHaveBeenCalledTimes(1);
  });

  it("unsubscribes on ride stop", () => {
    useAuthStore.getState().setUser(userWithCrashDetection(true));
    act(() => useRideStore.getState().startRide("free"));
    render(<CrashDetectionRunner />);

    act(() => useRideStore.getState().stopRide());

    expect(unsubscribe).toHaveBeenCalled();
  });

  it("flips the crash store into countdown when the detector fires", () => {
    useAuthStore.getState().setUser(userWithCrashDetection(true));
    act(() => {
      useRideStore.setState({
        isRiding: true,
        startedAtMs: Date.now(),
        rideType: "free",
        activeRide: { id: "ride-7" } as never,
        currentSpeed: 72,
        location: {
          lat: 49.82,
          lng: 18.26,
          speed: 72,
          accuracy: 5,
          altitude: 200,
          timestamp: Date.now(),
        } as never,
      });
    });

    // Capture the listener so we can simulate the detector callback.
    let registered: ((reading: never) => void) | null = null;
    mockedSensors.subscribeReadings.mockImplementation((listener) => {
      registered = listener as never;
      return unsubscribe;
    });

    render(<CrashDetectionRunner />);
    expect(registered).not.toBeNull();

    // Drive a synthetic crash sequence: a sustained 5g spike plus 6
    // seconds of stillness. The runner's CrashDetector instance reads
    // these inputs and ought to call into useCrashStore.startCountdown.
    const G = 9.81;
    let t = 0;
    act(() => {
      // Spike well above the 4g default for 200ms.
      for (; t <= 200; t += 20) {
        registered!({
          t,
          ax: 0,
          ay: 0,
          az: 5 * G + G,
        } as never);
      }
      // Stillness for 6 seconds.
      for (; t <= 6_220; t += 20) {
        registered!({
          t,
          ax: 0,
          ay: 0,
          az: 0.05 + G,
        } as never);
      }
    });

    const state = useCrashStore.getState();
    expect(state.phase).toBe("countdown");
    expect(state.alert?.rideId).toBe("ride-7");
    expect(state.alert?.lat).toBe(49.82);
    expect(state.alert?.speedAtImpact).toBe(72);
  });
});
