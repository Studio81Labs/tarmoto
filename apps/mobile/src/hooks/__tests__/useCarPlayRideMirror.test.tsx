/**
 * useCarPlayRideMirror — unified-bridge tests.
 *
 * Pins the cross-cutting US-17 AC #6 contract: the hook is the single
 * place where ride state (speed, distance, duration, current
 * maneuver, road quality, active hazards) crosses from Zustand into
 * the platform-agnostic `services/carplay` controller. Three lifecycle
 * bands the test covers:
 *
 *   1. Ride status board — mounts when riding, unmounts when stopped.
 *   2. Hazard alerts — present the closest within radius, dismiss when
 *      none in range, never re-fire on the same id within a single
 *      proximity window.
 *   3. Quick actions — pre-ride Start Commute, mid-ride Stop / Report.
 *
 * The bridge underneath is replaced with the carplay-test fake so the
 * test reads what the hook *would* dispatch onto the bike display
 * without standing up native modules.
 */

import { act, renderHook } from "@testing-library/react-native";
import * as carplay from "@/services/carplay";
import {
  __resetCarPlayStateForTest,
  __setCarPlayBridgeForTest,
  type QuickActionItem,
  type StatusBoardItem,
  type VehicleStatusBridge,
  type HazardAlertSnapshot,
} from "@/services/carplay";
import { useCarPlayRideMirror } from "../useCarPlayRideMirror";
import { useHazardStore, useRideStore } from "@/stores";
import { useFeatureKillSwitchActive } from "@/hooks/useFeatureKillSwitch";
import type { Hazard } from "@/types";

jest.mock("@/hooks/useFeatureKillSwitch", () => ({
  useFeatureKillSwitchActive: jest.fn(() => true),
}));

const mockedKillSwitch = useFeatureKillSwitchActive as jest.MockedFunction<
  typeof useFeatureKillSwitchActive
>;

interface FakeBridge extends VehicleStatusBridge {
  mountStatusBoard: jest.Mock<
    void,
    [{ title: string; items: StatusBoardItem[] }]
  >;
  updateStatusBoard: jest.Mock<void, [StatusBoardItem[]]>;
  clearStatusBoard: jest.Mock;
  presentHazardAlert: jest.Mock<
    void,
    [HazardAlertSnapshot, { onConfirm: () => void; onDismiss: () => void }]
  >;
  dismissHazardAlert: jest.Mock;
  mountQuickActions: jest.Mock<
    void,
    [QuickActionItem[], (id: QuickActionItem["id"]) => void]
  >;
  unmountQuickActions: jest.Mock;
  showInertRoot: jest.Mock;
  lastAlertCallbacks: { onConfirm: () => void; onDismiss: () => void } | null;
}

function createFakeBridge(): FakeBridge {
  const fake: FakeBridge = {
    mountStatusBoard: jest.fn(),
    updateStatusBoard: jest.fn(),
    clearStatusBoard: jest.fn(),
    presentHazardAlert: jest.fn(),
    dismissHazardAlert: jest.fn(),
    mountQuickActions: jest.fn(),
    unmountQuickActions: jest.fn(),
    showInertRoot: jest.fn(),
    isAvailable: () => true,
    subscribeDisconnect: () => () => undefined,
    subscribeConnect: () => () => undefined,
    lastAlertCallbacks: null,
  };
  fake.presentHazardAlert.mockImplementation((_, callbacks) => {
    fake.lastAlertCallbacks = callbacks;
  });
  return fake;
}

function makeHazard(overrides: Partial<Hazard> = {}): Hazard {
  return {
    id: "hz-1",
    lat: 49.5,
    lng: 18.1,
    hazard_type: "pothole",
    severity: "medium",
    note: null,
    photo_url: null,
    confirmations: 1,
    reporter: null,
    road_name: null,
    created_at: "2026-01-01T00:00:00Z",
    expires_at: "2026-12-31T00:00:00Z",
    ...overrides,
  };
}

async function resetStores(): Promise<void> {
  // Drop ride + hazard state between cases so a leak from a previous
  // case can't make the next one pass spuriously.
  await act(() => {
    useRideStore.setState({
      isRiding: false,
      rideType: "free",
      currentSpeed: 0,
      distance: 0,
      duration: 0,
      currentQuality: null,
      location: null,
      activeRide: null,
      startedAtMs: null,
      maxLeanDeg: 0,
      leanCalibrating: true,
    });
    useHazardStore.setState({ nearbyHazards: [], routeHazards: [] });
  });
}

describe("useCarPlayRideMirror — unified bridge", () => {
  let bridge: FakeBridge;

  beforeEach(async () => {
    bridge = createFakeBridge();
    __setCarPlayBridgeForTest(bridge);
    mockedKillSwitch.mockReset();
    mockedKillSwitch.mockReturnValue(true);
    await resetStores();
  });

  afterEach(() => {
    __setCarPlayBridgeForTest(null);
    __resetCarPlayStateForTest();
  });

  it("mounts the ride status board when isRiding flips on, unmounts when off", async () => {
    const { unmount } = await renderHook(() => useCarPlayRideMirror());
    expect(bridge.mountStatusBoard).not.toHaveBeenCalled();

    await act(() => {
      useRideStore.setState({
        isRiding: true,
        rideType: "free",
        currentSpeed: 53,
        distance: 12.4,
        duration: 1925,
      });
    });
    expect(bridge.mountStatusBoard).toHaveBeenCalledTimes(1);

    await act(() => {
      useRideStore.setState({ isRiding: false });
    });
    expect(bridge.clearStatusBoard).toHaveBeenCalledTimes(1);

    await unmount();
  });

  it("kills the whole projection to an inert root when carplay_android_auto is off", async () => {
    mockedKillSwitch.mockImplementation(
      (key) => key !== "carplay_android_auto",
    );
    const { rerender } = await renderHook(() => useCarPlayRideMirror());

    // The orchestration effect swapped the head-unit root for the inert idle.
    expect(bridge.showInertRoot).toHaveBeenCalled();

    // Bands are blocked — a live ride mounts nothing on the head unit.
    await act(() => {
      useRideStore.setState({
        isRiding: true,
        rideType: "free",
        currentSpeed: 20,
        distance: 3,
        duration: 120,
      });
    });
    expect(bridge.mountStatusBoard).not.toHaveBeenCalled();

    // Re-enable → the board mounts (ride still active).
    mockedKillSwitch.mockImplementation(() => true);
    await rerender({});
    expect(bridge.mountStatusBoard).toHaveBeenCalled();
  });

  it("does not run ride-end cleanup when carplay flips off mid-ride", async () => {
    // A mid-ride projection kill must NOT invoke `unmountRideStatusBoard`
    // (→ bridge.clearStatusBoard), which is the ride-END cleanup that clears
    // the per-ride dismissed/confirmed hazard sets — otherwise a hazard the
    // rider already dismissed would re-alert when projection comes back.
    const { rerender } = await renderHook(() => useCarPlayRideMirror());
    await act(() => {
      useRideStore.setState({
        isRiding: true,
        rideType: "free",
        currentSpeed: 30,
        distance: 5,
        duration: 300,
      });
    });
    expect(bridge.mountStatusBoard).toHaveBeenCalled();

    // Flip carplay OFF while the ride is still active.
    mockedKillSwitch.mockImplementation(
      (key) => key !== "carplay_android_auto",
    );
    await rerender({});

    // Projection goes inert, but the ride-end cleanup must not fire.
    expect(bridge.showInertRoot).toHaveBeenCalled();
    expect(bridge.clearStatusBoard).not.toHaveBeenCalled();
  });

  it("runs the ride-end cleanup even when the ride ends while carplay is killed", async () => {
    // Board mounts on a live ride, then carplay is killed mid-ride, then the
    // ride ends while still killed. The ride-END cleanup (which clears the
    // per-ride hazard dedup) must still run so a dismissed hazard doesn't leak
    // into the next ride.
    const unmountSpy = jest.spyOn(carplay, "unmountRideStatusBoard");
    const { rerender } = await renderHook(() => useCarPlayRideMirror());
    await act(() => {
      useRideStore.setState({
        isRiding: true,
        rideType: "free",
        currentSpeed: 30,
        distance: 5,
        duration: 300,
      });
    });
    expect(bridge.mountStatusBoard).toHaveBeenCalled();

    // Kill carplay mid-ride.
    mockedKillSwitch.mockImplementation(
      (key) => key !== "carplay_android_auto",
    );
    await rerender({});
    unmountSpy.mockClear();

    // End the ride while carplay is still off.
    await act(() => {
      useRideStore.setState({ isRiding: false });
    });

    expect(unmountSpy).toHaveBeenCalled();
    unmountSpy.mockRestore();
  });

  it("suppresses the CarPlay hazard mirror when hazard_alerts is disabled", async () => {
    // CarPlay itself stays on; only the hazard band follows the hazard_alerts
    // kill switch, keeping the bike display in lockstep with the phone.
    mockedKillSwitch.mockImplementation((key) => key !== "hazard_alerts");
    await renderHook(() => useCarPlayRideMirror());

    await act(() => {
      useRideStore.setState({
        isRiding: true,
        rideType: "free",
        location: {
          lat: 49.5,
          lng: 18.1,
          speed: 30,
          accuracy: 5,
          altitude: 250,
          timestamp: Date.now(),
        },
      });
    });
    // Status board (band 1) still mounts — CarPlay is on.
    expect(bridge.mountStatusBoard).toHaveBeenCalled();

    // A hazard well inside the radius must NOT present on the head unit.
    await act(() => {
      useHazardStore.setState({
        nearbyHazards: [makeHazard({ id: "near", lat: 49.503, lng: 18.103 })],
        routeHazards: [],
      });
    });
    expect(bridge.presentHazardAlert).not.toHaveBeenCalled();
  });

  it("presents a hazard alert mid-ride only when one is within the alert radius", async () => {
    await renderHook(() => useCarPlayRideMirror());

    await act(() => {
      useRideStore.setState({
        isRiding: true,
        rideType: "free",
        location: {
          lat: 49.5,
          lng: 18.1,
          speed: 30,
          accuracy: 5,
          altitude: 250,
          timestamp: Date.now(),
        },
      });
    });

    // Hazard well outside the 750 m alert radius — no alert.
    await act(() => {
      useHazardStore.setState({
        nearbyHazards: [makeHazard({ id: "far", lat: 49.6, lng: 18.2 })],
        routeHazards: [],
      });
    });
    expect(bridge.presentHazardAlert).not.toHaveBeenCalled();

    // Hazard inside the radius — alert fires.
    await act(() => {
      useHazardStore.setState({
        nearbyHazards: [makeHazard({ id: "near", lat: 49.503, lng: 18.103 })],
        routeHazards: [],
      });
    });
    expect(bridge.presentHazardAlert).toHaveBeenCalledTimes(1);
    expect(bridge.presentHazardAlert.mock.calls[0]?.[0].id).toBe("near");

    // Same hazard re-emitted — controller dedupes by id, no flicker.
    await act(() => {
      useHazardStore.setState({
        nearbyHazards: [makeHazard({ id: "near", lat: 49.503, lng: 18.103 })],
        routeHazards: [],
      });
    });
    expect(bridge.presentHazardAlert).toHaveBeenCalledTimes(1);
  });

  it("dismisses the hazard alert when no hazards remain in range", async () => {
    await renderHook(() => useCarPlayRideMirror());

    await act(() => {
      useRideStore.setState({
        isRiding: true,
        rideType: "free",
        location: {
          lat: 49.5,
          lng: 18.1,
          speed: 30,
          accuracy: 5,
          altitude: 250,
          timestamp: Date.now(),
        },
      });
      useHazardStore.setState({
        nearbyHazards: [makeHazard({ id: "near", lat: 49.503, lng: 18.103 })],
        routeHazards: [],
      });
    });
    expect(bridge.presentHazardAlert).toHaveBeenCalledTimes(1);

    // Hazard cleared from the nearby list — alert template should be
    // dismissed so the bike display goes back to the ride board.
    await act(() => {
      useHazardStore.setState({ nearbyHazards: [], routeHazards: [] });
    });
    expect(bridge.dismissHazardAlert).toHaveBeenCalledTimes(1);
  });

  it("dismisses the hazard alert when isRiding flips off", async () => {
    await renderHook(() => useCarPlayRideMirror());

    await act(() => {
      useRideStore.setState({
        isRiding: true,
        rideType: "free",
        location: {
          lat: 49.5,
          lng: 18.1,
          speed: 30,
          accuracy: 5,
          altitude: 250,
          timestamp: Date.now(),
        },
      });
      useHazardStore.setState({
        nearbyHazards: [makeHazard({ id: "near", lat: 49.503, lng: 18.103 })],
        routeHazards: [],
      });
    });
    expect(bridge.presentHazardAlert).toHaveBeenCalledTimes(1);

    await act(() => {
      useRideStore.setState({ isRiding: false });
    });
    expect(bridge.dismissHazardAlert).toHaveBeenCalledTimes(1);
  });

  it("mounts Start Commute pre-ride and unmounts (does not pivot) mid-ride", async () => {
    const onQuickAction = jest.fn();
    await renderHook(() =>
      useCarPlayRideMirror({ onQuickAction, hasCommuteRoute: true }),
    );

    expect(bridge.mountQuickActions).toHaveBeenCalledTimes(1);
    const preRideItems = bridge.mountQuickActions.mock.calls[0]?.[0];
    expect(preRideItems?.map((i) => i.id)).toEqual(["start-commute"]);

    await act(() => {
      useRideStore.setState({ isRiding: true, rideType: "commute" });
    });
    // Mid-ride the quick-actions list goes empty so the live ride
    // status board (which owns setRootTemplate while riding) isn't
    // clobbered. The hook unmounts the quick-actions surface — it
    // does NOT call mountQuickActions a second time.
    expect(bridge.mountQuickActions).toHaveBeenCalledTimes(1);
    expect(bridge.unmountQuickActions).toHaveBeenCalledTimes(1);
  });

  it("does not mount quick actions when the host hasn't supplied a callback", async () => {
    await renderHook(() => useCarPlayRideMirror({ hasCommuteRoute: true }));
    expect(bridge.mountQuickActions).not.toHaveBeenCalled();
  });

  it("forwards quick-action selections back to the host callback", async () => {
    const onQuickAction = jest.fn();
    await renderHook(() =>
      useCarPlayRideMirror({ onQuickAction, hasCommuteRoute: true }),
    );

    const handler = bridge.mountQuickActions.mock.calls[0]?.[1];
    expect(handler).toBeDefined();
    handler?.("start-commute");
    expect(onQuickAction).toHaveBeenCalledWith("start-commute");
  });

  it("cleans up all three surfaces on hook unmount (hot-reload safe)", async () => {
    const { unmount } = await renderHook(() =>
      useCarPlayRideMirror({ onQuickAction: jest.fn(), hasCommuteRoute: true }),
    );

    await act(() => {
      useRideStore.setState({
        isRiding: true,
        rideType: "free",
        location: {
          lat: 49.5,
          lng: 18.1,
          speed: 30,
          accuracy: 5,
          altitude: 250,
          timestamp: Date.now(),
        },
      });
      useHazardStore.setState({
        nearbyHazards: [makeHazard({ id: "near", lat: 49.503, lng: 18.103 })],
        routeHazards: [],
      });
    });

    await unmount();
    expect(bridge.clearStatusBoard).toHaveBeenCalledTimes(1);
    expect(bridge.dismissHazardAlert).toHaveBeenCalledTimes(1);
    expect(bridge.unmountQuickActions).toHaveBeenCalledTimes(1);
  });
});
