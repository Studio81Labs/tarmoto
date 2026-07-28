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
import { buildFeatureSnapshot, buildLimitSnapshot } from "@tarmoto/shared";
import React from "react";
import { act, render } from "@testing-library/react-native";
import CrashDetectionRunner from "../CrashDetectionRunner";
import { useAuthStore, useCrashStore, useRideStore } from "@/stores";
import { sensorService } from "@/services/sensors";
import { useFeatureKillSwitchActive } from "@/hooks/useFeatureKillSwitch";
import type { User } from "@/types";

jest.mock("@/services/sensors", () => ({
  sensorService: {
    subscribeReadings: jest.fn(),
  },
}));

jest.mock("@/hooks/useFeatureKillSwitch", () => ({
  useFeatureKillSwitchActive: jest.fn(() => true),
}));

const mockedSensors = sensorService as jest.Mocked<typeof sensorService>;
const mockedKillSwitch = useFeatureKillSwitchActive as jest.MockedFunction<
  typeof useFeatureKillSwitchActive
>;

function userWithCrashDetection(enabled: boolean): User {
  return {
    id: "u1",
    email: "rider@tarmoto.app",
    display_name: "Rider",
    phone: null,
    avatar_url: null,
    bio: null,
    language: "en",
    home_region: null,
    home_location: null,
    work_location: null,
    subscription_tier: "free",
    features: buildFeatureSnapshot("free", {}, {}),
    limits: buildLimitSnapshot("free", {}, {}),
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
    mockedKillSwitch.mockReturnValue(true);
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

  it("does nothing when no ride is active", async () => {
    useAuthStore.getState().setUser(userWithCrashDetection(true));
    await render(<CrashDetectionRunner />);
    expect(mockedSensors.subscribeReadings).not.toHaveBeenCalled();
  });

  it("does nothing when crash detection is disabled", async () => {
    useAuthStore.getState().setUser(userWithCrashDetection(false));
    await act(() => useRideStore.getState().startRide("free"));
    await render(<CrashDetectionRunner />);
    expect(mockedSensors.subscribeReadings).not.toHaveBeenCalled();
  });

  it("subscribes when a ride starts with the preference enabled", async () => {
    useAuthStore.getState().setUser(userWithCrashDetection(true));
    await act(() => useRideStore.getState().startRide("free"));
    await render(<CrashDetectionRunner />);
    expect(mockedSensors.subscribeReadings).toHaveBeenCalledTimes(1);
  });

  it("does not subscribe when the operator kill switch is force-disabled", async () => {
    // Even with the rider preference on and a live ride, an operator
    // `crash_detection` force_off (e.g. false-SOS storm) must keep the
    // detector from ever subscribing.
    mockedKillSwitch.mockImplementation((key) => key !== "crash_detection");
    useAuthStore.getState().setUser(userWithCrashDetection(true));
    await act(() => useRideStore.getState().startRide("free"));
    await render(<CrashDetectionRunner />);
    expect(mockedSensors.subscribeReadings).not.toHaveBeenCalled();
  });

  it("unsubscribes on ride stop", async () => {
    useAuthStore.getState().setUser(userWithCrashDetection(true));
    await act(() => useRideStore.getState().startRide("free"));
    await render(<CrashDetectionRunner />);

    await act(() => useRideStore.getState().stopRide());

    expect(unsubscribe).toHaveBeenCalled();
  });

  it("re-subscribes when the alert phase returns to idle mid-ride", async () => {
    // Bugbot 4ee09bc2: previously the effect only re-evaluated on
    // [isRiding, crashDetectionEnabled] changes. If the rider entered
    // a non-idle phase (countdown / dispatched / failed) and later
    // dismissed it, the effect's deps hadn't changed and the runner
    // never re-attached the listener — crash detection silently went
    // dark for the rest of the ride.
    useAuthStore.getState().setUser(userWithCrashDetection(true));
    await act(() => useRideStore.getState().startRide("free"));

    await render(<CrashDetectionRunner />);
    expect(mockedSensors.subscribeReadings).toHaveBeenCalledTimes(1);

    // Simulate a triggered countdown that the rider dismisses.
    await act(() => {
      useCrashStore.getState().startCountdown({
        triggeredAt: 1,
        rideId: null,
        lat: null,
        lng: null,
        speedAtImpact: null,
      });
    });
    // Subscription torn down while the alert is up.
    expect(unsubscribe).toHaveBeenCalledTimes(1);

    await act(() => useCrashStore.getState().reset());

    // Phase back to idle → runner must re-subscribe so the detector
    // is live for the rest of the ride.
    expect(mockedSensors.subscribeReadings).toHaveBeenCalledTimes(2);
  });

  it("flips the crash store into countdown when the detector fires", async () => {
    useAuthStore.getState().setUser(userWithCrashDetection(true));
    await act(() => {
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

    await render(<CrashDetectionRunner />);
    expect(registered).not.toBeNull();

    // Drive a synthetic crash sequence: a sustained 5g spike plus 6
    // seconds of stillness. The runner's CrashDetector instance reads
    // these inputs and ought to call into useCrashStore.startCountdown.
    // The first reading carries the rider's pre-impact speed (20 m/s
    // ≈ 72 km/h); the rest report 0 to simulate the rider going down.
    // The detector is responsible for snapshotting the spike-onset
    // speed so the alert payload reflects pre-impact velocity even
    // though the immobility window has elapsed by the time we fire.
    const G = 9.81;
    let t = 0;
    await act(() => {
      // Spike well above the 4g default for 200ms.
      registered!({
        t,
        ax: 0,
        ay: 0,
        az: 5 * G + G,
        speed: 20,
      } as never);
      for (t = 20; t <= 200; t += 20) {
        registered!({
          t,
          ax: 0,
          ay: 0,
          az: 5 * G + G,
          speed: 0,
        } as never);
      }
      // Stillness for 6 seconds.
      for (; t <= 6_220; t += 20) {
        registered!({
          t,
          ax: 0,
          ay: 0,
          az: 0.05 + G,
          speed: 0,
        } as never);
      }
    });

    const state = useCrashStore.getState();
    expect(state.phase).toBe("countdown");
    expect(state.alert?.rideId).toBe("ride-7");
    expect(state.alert?.lat).toBe(49.82);
    // 20 m/s * 3.6 = 72 km/h captured from the impact reading, not
    // from the post-immobility ride store value (which would be 0).
    expect(state.alert?.speedAtImpact).toBeCloseTo(72, 5);
  });
});
