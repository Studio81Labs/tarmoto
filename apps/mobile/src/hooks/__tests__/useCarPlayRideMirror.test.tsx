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
import type { Hazard } from "@/types";

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

function resetStores(): void {
  // Drop ride + hazard state between cases so a leak from a previous
  // case can't make the next one pass spuriously.
  act(() => {
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

  beforeEach(() => {
    bridge = createFakeBridge();
    __setCarPlayBridgeForTest(bridge);
    resetStores();
  });

  afterEach(() => {
    __setCarPlayBridgeForTest(null);
    __resetCarPlayStateForTest();
  });

  it("mounts the ride status board when isRiding flips on, unmounts when off", () => {
    const { unmount } = renderHook(() => useCarPlayRideMirror());
    expect(bridge.mountStatusBoard).not.toHaveBeenCalled();

    act(() => {
      useRideStore.setState({
        isRiding: true,
        rideType: "free",
        currentSpeed: 53,
        distance: 12.4,
        duration: 1925,
      });
    });
    expect(bridge.mountStatusBoard).toHaveBeenCalledTimes(1);

    act(() => {
      useRideStore.setState({ isRiding: false });
    });
    expect(bridge.clearStatusBoard).toHaveBeenCalledTimes(1);

    unmount();
  });

  it("presents a hazard alert mid-ride only when one is within the alert radius", () => {
    renderHook(() => useCarPlayRideMirror());

    act(() => {
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
    act(() => {
      useHazardStore.setState({
        nearbyHazards: [makeHazard({ id: "far", lat: 49.6, lng: 18.2 })],
        routeHazards: [],
      });
    });
    expect(bridge.presentHazardAlert).not.toHaveBeenCalled();

    // Hazard inside the radius — alert fires.
    act(() => {
      useHazardStore.setState({
        nearbyHazards: [makeHazard({ id: "near", lat: 49.503, lng: 18.103 })],
        routeHazards: [],
      });
    });
    expect(bridge.presentHazardAlert).toHaveBeenCalledTimes(1);
    expect(bridge.presentHazardAlert.mock.calls[0]?.[0].id).toBe("near");

    // Same hazard re-emitted — controller dedupes by id, no flicker.
    act(() => {
      useHazardStore.setState({
        nearbyHazards: [makeHazard({ id: "near", lat: 49.503, lng: 18.103 })],
        routeHazards: [],
      });
    });
    expect(bridge.presentHazardAlert).toHaveBeenCalledTimes(1);
  });

  it("dismisses the hazard alert when no hazards remain in range", () => {
    renderHook(() => useCarPlayRideMirror());

    act(() => {
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
    act(() => {
      useHazardStore.setState({ nearbyHazards: [], routeHazards: [] });
    });
    expect(bridge.dismissHazardAlert).toHaveBeenCalledTimes(1);
  });

  it("dismisses the hazard alert when isRiding flips off", () => {
    renderHook(() => useCarPlayRideMirror());

    act(() => {
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

    act(() => {
      useRideStore.setState({ isRiding: false });
    });
    expect(bridge.dismissHazardAlert).toHaveBeenCalledTimes(1);
  });

  it("mounts the Start Commute quick action pre-ride and pivots to Stop/Report mid-ride", () => {
    const onQuickAction = jest.fn();
    renderHook(() =>
      useCarPlayRideMirror({ onQuickAction, hasCommuteRoute: true }),
    );

    expect(bridge.mountQuickActions).toHaveBeenCalledTimes(1);
    const preRideItems = bridge.mountQuickActions.mock.calls[0]?.[0];
    expect(preRideItems?.map((i) => i.id)).toEqual(["start-commute"]);

    act(() => {
      useRideStore.setState({ isRiding: true, rideType: "commute" });
    });
    expect(bridge.mountQuickActions).toHaveBeenCalledTimes(2);
    const midRideItems = bridge.mountQuickActions.mock.calls[1]?.[0];
    expect(midRideItems?.map((i) => i.id)).toEqual([
      "report-hazard",
      "stop-ride",
    ]);
  });

  it("does not mount quick actions when the host hasn't supplied a callback", () => {
    renderHook(() => useCarPlayRideMirror({ hasCommuteRoute: true }));
    expect(bridge.mountQuickActions).not.toHaveBeenCalled();
  });

  it("forwards quick-action selections back to the host callback", () => {
    const onQuickAction = jest.fn();
    renderHook(() =>
      useCarPlayRideMirror({ onQuickAction, hasCommuteRoute: true }),
    );

    const handler = bridge.mountQuickActions.mock.calls[0]?.[1];
    expect(handler).toBeDefined();
    handler?.("start-commute");
    expect(onQuickAction).toHaveBeenCalledWith("start-commute");
  });

  it("cleans up all three surfaces on hook unmount (hot-reload safe)", () => {
    const { unmount } = renderHook(() =>
      useCarPlayRideMirror({ onQuickAction: jest.fn(), hasCommuteRoute: true }),
    );

    act(() => {
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

    unmount();
    expect(bridge.clearStatusBoard).toHaveBeenCalledTimes(1);
    expect(bridge.dismissHazardAlert).toHaveBeenCalledTimes(1);
    expect(bridge.unmountQuickActions).toHaveBeenCalledTimes(1);
  });
});
