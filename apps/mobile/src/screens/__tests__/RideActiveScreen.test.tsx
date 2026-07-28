import React from "react";
import { render, screen, waitFor } from "@testing-library/react-native";
import RideActiveScreen, {
  __resetPendingStartPromiseForTests,
} from "../RideActiveScreen";
import { api } from "@/services/api";
import { locationService } from "@/services/location";
import { sensorService, type ClassificationResult } from "@/services/sensors";
import { requestWithRationale } from "@/services/permissions";
import {
  isFeatureKillSwitchActive,
  isSystemSwitchEnabled,
} from "@/services/systemSwitchCache";
import type { RideResponse } from "@/types";
import { setActiveFormatContext } from "@/format";

const mockGoBack = jest.fn();
const mockStartRideAction = jest.fn();
const mockStopRideAction = jest.fn();
const mockSetActiveRide = jest.fn();
const mockUpdateDuration = jest.fn();

interface MockRideState {
  isRiding: boolean;
  activeRide: { id: string } | null;
  rideType: "free" | "commute" | "trip";
  startedAtMs: number | null;
  currentSpeed: number;
  currentQuality: ClassificationResult | null;
  distance: number;
  duration: number;
  segmentCount: number;
  startRide: typeof mockStartRideAction;
  stopRide: typeof mockStopRideAction;
  setActiveRide: typeof mockSetActiveRide;
  updateDuration: typeof mockUpdateDuration;
}

let mockState: MockRideState;

jest.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ goBack: mockGoBack }),
  useRoute: () => ({ params: { rideType: "free" } }),
}));

jest.mock("@/components/Icon", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ReactLib = require("react");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Text } = require("react-native");
  const MockIcon = ({ name }: { name?: string }) =>
    ReactLib.createElement(Text, null, `icon:${name ?? ""}`);
  return { Icon: MockIcon };
});

jest.mock("react-native-haptic-feedback", () => ({
  __esModule: true,
  default: { trigger: jest.fn() },
}));

jest.mock("@/services/api", () => ({
  api: {
    startRide: jest.fn(),
    stopRide: jest.fn(),
    submitSensorData: jest.fn(),
    getActiveBike: jest.fn().mockResolvedValue(null),
  },
}));

jest.mock("@/services/tts", () => ({
  ttsService: {
    isMuted: jest.fn(() => false),
    setMuted: jest.fn(),
  },
}));

jest.mock("@/services/sensors", () => ({
  sensorService: {
    start: jest.fn(),
    stop: jest.fn(() => ({ readings: [], tagEvents: [] })),
    tagSurface: jest.fn(() => null),
    getTagEvents: jest.fn(() => []),
    recording: false,
  },
}));

jest.mock("@/services/location", () => ({
  locationService: {
    start: jest.fn(),
    stop: jest.fn(),
    getDistance: jest.fn(() => 0),
  },
}));

jest.mock("@/services/systemSwitchCache", () => ({
  isSystemSwitchEnabled: jest.fn(() => true),
  isFeatureKillSwitchActive: jest.fn(() => true),
}));

jest.mock("@/services/permissions", () => ({
  requestWithRationale: jest.fn().mockResolvedValue("granted"),
}));

jest.mock("@/services/mlClassifier", () => ({
  getActiveModelVersion: jest.fn(() => null),
}));

jest.mock("react-native-device-info", () => ({
  __esModule: true,
  default: { getModel: jest.fn(() => "iPhone 15") },
}));

jest.mock("@thehale/react-native-keep-awake", () => ({
  activate: jest.fn(),
  deactivate: jest.fn(),
}));

// Hand-rolled Zustand-style hook mock with both `useRideStore(sel)`
// and `useRideStore.getState()` semantics — the screen relies on both.
jest.mock("@/stores", () => {
  function useRideStore(sel: (s: MockRideState) => unknown): unknown {
    return sel(mockState);
  }
  useRideStore.getState = () => mockState;
  function usePreferencesStore(
    sel: (s: { minQuality: number }) => unknown,
  ): unknown {
    return sel({ minQuality: 3 });
  }
  return { useRideStore, usePreferencesStore };
});

describe("RideActiveScreen", () => {
  const startRideMock = api.startRide as jest.MockedFunction<
    typeof api.startRide
  >;
  const stopRideMock = api.stopRide as jest.MockedFunction<typeof api.stopRide>;

  beforeEach(() => {
    // Module-level state owned by RideActiveScreen — clear between
    // specs so a never-resolving promise from one test doesn't bleed
    // into the next test's resume guard.
    __resetPendingStartPromiseForTests();
    mockGoBack.mockReset();
    mockStartRideAction.mockReset();
    mockStopRideAction.mockReset();
    mockSetActiveRide.mockReset();
    mockUpdateDuration.mockReset();
    startRideMock.mockReset();
    stopRideMock.mockReset();
    (sensorService.start as jest.Mock).mockClear();
    (sensorService.stop as jest.Mock).mockClear();
    (locationService.start as jest.Mock).mockClear();
    (locationService.stop as jest.Mock).mockClear();
    (requestWithRationale as jest.Mock).mockReset();
    (requestWithRationale as jest.Mock).mockResolvedValue("granted");
    (isSystemSwitchEnabled as jest.Mock).mockReset();
    (isSystemSwitchEnabled as jest.Mock).mockReturnValue(true);
    (isFeatureKillSwitchActive as jest.Mock).mockReset();
    (isFeatureKillSwitchActive as jest.Mock).mockReturnValue(true);
    startRideMock.mockResolvedValue({
      id: "ride-99",
      ride_type: "free",
      status: "active",
      started_at: "2026-04-25T10:00:00",
      ended_at: null,
      distance_km: 0,
      avg_speed: 0,
      avg_road_quality: 0,
      avg_curviness: null,
      bike_id: null,
    });
    mockState = {
      isRiding: true,
      activeRide: { id: "ride-99" },
      rideType: "free",
      startedAtMs: 1_700_000_000_000,
      currentSpeed: 62.4,
      currentQuality: {
        quality_class: "good",
        quality_score: 4.0,
        surface_type: "asphalt",
        rms: 0.5,
        confidence: 0.9,
        model_version: null,
      },
      distance: 12.5,
      duration: 0,
      segmentCount: 4,
      startRide: mockStartRideAction,
      stopRide: mockStopRideAction,
      setActiveRide: mockSetActiveRide,
      updateDuration: mockUpdateDuration,
    };
  });

  afterEach(() => {
    setActiveFormatContext({
      locale: "en-US",
      timeZone: "UTC",
      units: "metric",
    });
  });

  it("renders speed, distance, surface, and segment count from the ride store", async () => {
    await render(<RideActiveScreen />);

    await waitFor(() => expect(screen.getByText("62")).toBeTruthy());
    expect(screen.getByText("km/h")).toBeTruthy();
    expect(screen.getByText("12.5 km")).toBeTruthy();
    expect(screen.getByText("Good")).toBeTruthy();
    expect(screen.getByText("Asphalt")).toBeTruthy();
    expect(screen.getByText(/4 segments recorded/i)).toBeTruthy();
    expect(screen.getByLabelText("Stop ride")).toBeTruthy();
  });

  it("uses the imperial formatter for the visible speed and accessible label", async () => {
    setActiveFormatContext({
      locale: "en-US",
      timeZone: "UTC",
      units: "imperial",
    });

    await render(<RideActiveScreen />);

    await waitFor(() => expect(screen.getByText("38.8")).toBeTruthy());
    expect(screen.getByText("mph")).toBeTruthy();
    expect(screen.getByLabelText("Speed 38.8 mph")).toBeTruthy();
    expect(screen.queryByText("62")).toBeNull();
  });

  it("does not POST a new ride when resuming with an existing activeRide id", async () => {
    await render(<RideActiveScreen />);

    // Resume path: store already carries a backend id from a prior
    // mount. The screen must not double-post `/rides/start` — that
    // would register a duplicate ride every time the rider toggled tabs.
    await waitFor(() => expect(screen.getByText("12.5 km")).toBeTruthy());
    expect(startRideMock).not.toHaveBeenCalled();
  });

  it("renders the active-bike chip when the rider has one in their garage", async () => {
    (api.getActiveBike as jest.Mock).mockResolvedValueOnce({
      id: "bike-1",
      make: "Honda",
      model: "Africa Twin",
      year: 2024,
      isActive: true,
      photoUrl: null,
      icon: null,
      notes: null,
      totalKm: 0,
      totalRides: 0,
      createdAt: "2026-04-01T00:00:00.000Z",
      updatedAt: "2026-04-01T00:00:00.000Z",
    });

    await render(<RideActiveScreen />);

    // The chip carries an `accessibilityLabel` so screen readers can
    // announce the active bike before the rider tries to start.
    await waitFor(() =>
      expect(
        screen.getByLabelText("Active bike Honda Africa Twin"),
      ).toBeTruthy(),
    );
  });

  it("hides the active-bike chip when the rider has no garage yet", async () => {
    (api.getActiveBike as jest.Mock).mockResolvedValueOnce(null);

    await render(<RideActiveScreen />);

    await waitFor(() => expect(api.getActiveBike).toHaveBeenCalled());
    expect(screen.queryByLabelText(/Active bike/)).toBeNull();
  });

  it("posts a new ride and stores the resulting id when nothing is active", async () => {
    mockState.isRiding = false;
    mockState.activeRide = null;

    await render(<RideActiveScreen />);

    await waitFor(() => expect(startRideMock).toHaveBeenCalledWith("free"));
    await waitFor(() =>
      expect(mockSetActiveRide).toHaveBeenCalledWith(
        expect.objectContaining({ id: "ride-99" }),
      ),
    );
    expect(mockStartRideAction).toHaveBeenCalledWith("free");
  });

  it("starts sensor + location capture on a fresh ride start", async () => {
    mockState.isRiding = false;
    mockState.activeRide = null;
    const sensorStart = sensorService.start as jest.MockedFunction<
      typeof sensorService.start
    >;
    const locationStart = locationService.start as jest.MockedFunction<
      typeof locationService.start
    >;

    await render(<RideActiveScreen />);

    // Fresh start: both telemetry singletons must be started, otherwise
    // the HUD's live store fields (currentSpeed, distance, segmentCount,
    // currentQuality) would stay pegged at their defaults.
    await waitFor(() => expect(sensorStart).toHaveBeenCalledTimes(1));
    expect(locationStart).toHaveBeenCalledTimes(1);
  });

  it("skips sensor capture but still records GPS when sys_accel_collection is off", async () => {
    // Operator kill switch for the raw 50Hz accelerometer/gyro sampling.
    // The ride still records (GPS/location keeps running) — only the sensor
    // stream that `sys_accel_collection` gates is withheld.
    mockState.isRiding = false;
    mockState.activeRide = null;
    (isSystemSwitchEnabled as jest.Mock).mockReturnValue(false);
    const sensorStart = sensorService.start as jest.MockedFunction<
      typeof sensorService.start
    >;
    const locationStart = locationService.start as jest.MockedFunction<
      typeof locationService.start
    >;

    await render(<RideActiveScreen />);

    await waitFor(() => expect(locationStart).toHaveBeenCalledTimes(1));
    expect(isSystemSwitchEnabled).toHaveBeenCalledWith("sys_accel_collection");
    expect(sensorStart).not.toHaveBeenCalled();
  });

  it("records nothing and bounces back when ride_tracking is operator-disabled", async () => {
    mockState.isRiding = false;
    mockState.activeRide = null;
    (isFeatureKillSwitchActive as jest.Mock).mockImplementation(
      (key: string) => key !== "ride_tracking",
    );
    const sensorStart = sensorService.start as jest.MockedFunction<
      typeof sensorService.start
    >;
    const locationStart = locationService.start as jest.MockedFunction<
      typeof locationService.start
    >;

    await render(<RideActiveScreen />);

    // No recording started (no store session, no telemetry, no /rides POST),
    // and the screen bounces back like the permission-denied path.
    await waitFor(() => expect(mockGoBack).toHaveBeenCalledTimes(1));
    expect(mockStartRideAction).not.toHaveBeenCalled();
    expect(sensorStart).not.toHaveBeenCalled();
    expect(locationStart).not.toHaveBeenCalled();
    expect(startRideMock).not.toHaveBeenCalled();
    // The switch is checked BEFORE the permission prompt — don't ask the rider
    // for sensitive GPS access when recording is already disabled.
    expect(requestWithRationale).not.toHaveBeenCalled();
  });

  it("shows the surface-tag FAB on a fresh start when accel collection is on", async () => {
    mockState.isRiding = false;
    mockState.activeRide = null;

    await render(<RideActiveScreen />);

    // The FAB records tags into the running sensor session.
    await waitFor(() =>
      expect(screen.getByLabelText("Tag road surface")).toBeTruthy(),
    );
  });

  it("hides the surface-tag FAB when accel collection is off (no false capture)", async () => {
    mockState.isRiding = false;
    mockState.activeRide = null;
    (isSystemSwitchEnabled as jest.Mock).mockReturnValue(false);
    const locationStart = locationService.start as jest.MockedFunction<
      typeof locationService.start
    >;

    await render(<RideActiveScreen />);

    // Ride still records via GPS, but with no sensor session there's nowhere
    // to buffer a surface tag — hide the FAB so a tap can't fire a success
    // haptic for a tag the service silently discards.
    await waitFor(() => expect(locationStart).toHaveBeenCalledTimes(1));
    expect(screen.queryByLabelText("Tag road surface")).toBeNull();
  });

  it("does not restart telemetry on resume (singletons already running)", async () => {
    // Resume: store already has an activeRide id from a prior mount,
    // so telemetry was started by the original HUD mount and is still
    // ticking. Re-starting `locationService` here would reset
    // `totalDistance` to 0 and clobber the live distance count.
    const sensorStart = sensorService.start as jest.MockedFunction<
      typeof sensorService.start
    >;
    const locationStart = locationService.start as jest.MockedFunction<
      typeof locationService.start
    >;

    await render(<RideActiveScreen />);

    await waitFor(() => expect(screen.getByText("12.5 km")).toBeTruthy());
    expect(sensorStart).not.toHaveBeenCalled();
    expect(locationStart).not.toHaveBeenCalled();
  });

  it("does not restart telemetry mid-flight when activeRide.id hasn't landed yet", async () => {
    // Cross-mount mid-flight: mount #1 kicks off `/rides/start` with
    // a never-resolving promise (so `pendingStartPromise` stays
    // module-set), then unmounts. Mount #2 comes in with
    // `isRiding=true, activeRide=null` and must take the resume
    // path: no duplicate POST, no telemetry restart.
    mockState.isRiding = false;
    mockState.activeRide = null;
    startRideMock.mockReset();
    startRideMock.mockImplementationOnce(
      () => new Promise<RideResponse>(() => undefined),
    );
    const sensorStart = sensorService.start as jest.MockedFunction<
      typeof sensorService.start
    >;
    const locationStart = locationService.start as jest.MockedFunction<
      typeof locationService.start
    >;

    const first = await render(<RideActiveScreen />);
    await waitFor(() => expect(startRideMock).toHaveBeenCalledTimes(1));
    await first.unmount();

    sensorStart.mockClear();
    locationStart.mockClear();
    startRideMock.mockClear();
    // Simulate the in-flight state the screen leaves the store in.
    mockState.isRiding = true;
    mockState.activeRide = null;

    await render(<RideActiveScreen />);

    await waitFor(() => expect(screen.getByText("12.5 km")).toBeTruthy());
    expect(sensorStart).not.toHaveBeenCalled();
    expect(locationStart).not.toHaveBeenCalled();
    // Also no duplicate `/rides/start` POST while the prior one is in flight.
    expect(startRideMock).not.toHaveBeenCalled();
  });

  it("retries /rides/start when resuming with no backend id and no pending POST", async () => {
    // Scenario: a prior mount flipped `isRiding=true` and POSTed
    // `/rides/start`, but the POST rejected — the local store has
    // `isRiding=true, activeRide=null` and `pendingStartPromise`
    // has settled (and cleared). The rider re-opens the HUD via
    // the in-progress banner. We MUST retry the POST so a
    // subsequent stop has an id to call `/rides/:id/stop` and
    // upload sensor data; without the retry, the entire ride
    // payload would be dropped on transient start failures.
    //
    // Telemetry must NOT be restarted (the singletons are still
    // running from the original mount), and `store.startRide`
    // must NOT be re-called (would re-stamp `startedAtMs` and
    // reset distance/segmentCount mid-ride).
    mockState.isRiding = true;
    mockState.activeRide = null;
    startRideMock.mockReset();
    startRideMock.mockResolvedValue({
      id: "ride-99",
      ride_type: "free",
      status: "active",
      started_at: "2026-04-25T10:00:00",
      ended_at: null,
      distance_km: 0,
      avg_speed: 0,
      avg_road_quality: 0,
      avg_curviness: null,
      bike_id: null,
    });

    await render(<RideActiveScreen />);

    await waitFor(() => expect(startRideMock).toHaveBeenCalledWith("free"));
    expect(sensorService.start).not.toHaveBeenCalled();
    expect(locationService.start).not.toHaveBeenCalled();
    expect(mockStartRideAction).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(mockSetActiveRide).toHaveBeenCalledWith(
        expect.objectContaining({ id: "ride-99" }),
      ),
    );
  });

  it("does not commit a stale /rides/start result if the rider has already stopped", async () => {
    // Race: rider taps Start, the POST goes out, the rider backs out
    // and stops before the POST resolves. The session has moved on
    // (`startedAtMs` got cleared by `stopRide` and may have been
    // re-stamped by a fresh start). The success handler must detect
    // that and clean up the orphaned backend ride instead of writing
    // a stale id back into `setActiveRide` — otherwise the resume
    // guard on the next mount would lock the rider out of new rides.
    mockState.isRiding = false;
    mockState.activeRide = null;
    mockState.startedAtMs = null;
    // Capture the promise's resolve so the test can fire it after
    // mutating store state. Typed as a holder so TS doesn't narrow
    // it to `null` based on lexical analysis of the closure.
    const startResolver: { fn: ((ride: RideResponse) => void) | null } = {
      fn: null,
    };
    startRideMock.mockImplementationOnce(
      () =>
        new Promise<RideResponse>((resolve) => {
          startResolver.fn = resolve;
        }),
    );

    await render(<RideActiveScreen />);

    // Wait for the screen to wire up the in-flight POST.
    await waitFor(() => expect(startRideMock).toHaveBeenCalledTimes(1));

    // Simulate the rider stopping mid-flight: the store's session
    // identifier gets cleared, and a fresh start (in another mount)
    // could re-stamp it.
    mockState.startedAtMs = 1_700_000_999_999;

    // The POST resolves — late.
    startResolver.fn?.({
      id: "ride-99",
      ride_type: "free",
      status: "active",
      started_at: "2026-04-25T10:00:00",
      ended_at: null,
      distance_km: 0,
      avg_speed: 0,
      avg_road_quality: 0,
      avg_curviness: null,
      bike_id: null,
    });

    await waitFor(() => expect(stopRideMock).toHaveBeenCalledWith("ride-99"));
    expect(mockSetActiveRide).not.toHaveBeenCalled();
  });

  it("renders the duration directly from the store (no local tick)", async () => {
    // The HUD doesn't run its own ticker any more — `RideDurationTicker`
    // (root-level) is the source of truth, and the screen just renders
    // whatever `store.duration` says. That keeps the count advancing
    // when the rider backs out of the HUD mid-ride.
    mockState.duration = 125; // 2 minutes 5 seconds

    await render(<RideActiveScreen />);

    await waitFor(() => expect(screen.getByText("2:05")).toBeTruthy());
    // The HUD should never write back into the store from a local tick.
    expect(mockUpdateDuration).not.toHaveBeenCalled();
  });

  // ── Issue #280 — location permission gate on fresh ride start ──

  it("aborts the fresh ride start when location permission is denied", async () => {
    mockState.isRiding = false;
    mockState.activeRide = null;
    (requestWithRationale as jest.Mock).mockResolvedValueOnce("denied");
    const sensorStart = sensorService.start as jest.MockedFunction<
      typeof sensorService.start
    >;
    const locationStart = locationService.start as jest.MockedFunction<
      typeof locationService.start
    >;

    await render(<RideActiveScreen />);

    await waitFor(() => expect(mockGoBack).toHaveBeenCalledTimes(1));
    expect(sensorStart).not.toHaveBeenCalled();
    expect(locationStart).not.toHaveBeenCalled();
    expect(startRideMock).not.toHaveBeenCalled();
    expect(mockStartRideAction).not.toHaveBeenCalled();
  });

  it("aborts the fresh ride start when location permission is blocked", async () => {
    mockState.isRiding = false;
    mockState.activeRide = null;
    (requestWithRationale as jest.Mock).mockResolvedValueOnce("blocked");
    const locationStart = locationService.start as jest.MockedFunction<
      typeof locationService.start
    >;

    await render(<RideActiveScreen />);

    await waitFor(() => expect(mockGoBack).toHaveBeenCalledTimes(1));
    expect(locationStart).not.toHaveBeenCalled();
    expect(startRideMock).not.toHaveBeenCalled();
  });

  it("does not re-prompt for location on the resume-after-fail path", async () => {
    // Resume after a failed start: telemetry was started by the
    // original mount (singletons are still running), only the POST
    // needs retrying. Re-prompting mid-ride would be jarring and
    // prompts that have already been answered shouldn't fire again.
    mockState.isRiding = true;
    mockState.activeRide = null;

    await render(<RideActiveScreen />);

    await waitFor(() => expect(startRideMock).toHaveBeenCalledTimes(1));
    expect(requestWithRationale).not.toHaveBeenCalled();
  });
});
