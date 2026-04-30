/**
 * Vehicle ride-status board tests — US-17 AC #3.
 *
 * The native head-unit surfaces are platform-specific: CarPlay is
 * iOS-only and requires Apple-issued entitlements; Android Auto needs a
 * real head unit or the Desktop Head Unit emulator. Neither path can be
 * validated live in CI, so these tests focus on what the bridge
 * contract guarantees regardless of environment:
 *
 *   - Pure formatters survive the noisy edge cases the ride store
 *     produces (sub-1 km/h GPS jitter, classifier null states, NaN
 *     from a malformed sensor window).
 *   - Mount/update/unmount drives the injected bridge fake the way
 *     the controller will drive it on the device, so wiring
 *     regressions surface here instead of on a bike at 80 km/h.
 *   - Both connect and disconnect lifecycle hooks reset the local
 *     mount flag so iOS' disconnect-driven reset and Android's
 *     connect-driven reset (where AA may not emit a clean disconnect
 *     when the host restarts) both keep the next ride-tick honest.
 */

import {
  __resetCarPlayStateForTest,
  __setCarPlayBridgeForTest,
  buildRideStatusItems,
  type VehicleStatusBridge,
  formatDistanceKm,
  formatDuration,
  formatQualityDetail,
  formatRideTypeTitle,
  formatSpeedKmh,
  mountRideStatusBoard,
  resumeRideStatusBoard,
  type RideStatusBoard,
  suspendRideStatusBoard,
  unmountRideStatusBoard,
} from "../carplay";

interface FakeBridge extends VehicleStatusBridge {
  mount: jest.Mock;
  update: jest.Mock;
  clear: jest.Mock;
  /** Fire any disconnect callbacks the controller has registered. */
  fireDisconnect: () => void;
  /** Fire any connect callbacks the controller has registered. */
  fireConnect: () => void;
}

function createFakeBridge(): FakeBridge {
  const mount = jest.fn();
  const update = jest.fn();
  const clear = jest.fn();
  const disconnectListeners = new Set<() => void>();
  const connectListeners = new Set<() => void>();
  return {
    mount,
    update,
    clear,
    isAvailable: () => true,
    mountStatusBoard: mount,
    updateStatusBoard: update,
    clearStatusBoard: clear,
    subscribeDisconnect: (cb) => {
      disconnectListeners.add(cb);
      return () => disconnectListeners.delete(cb);
    },
    subscribeConnect: (cb) => {
      connectListeners.add(cb);
      return () => connectListeners.delete(cb);
    },
    fireDisconnect: () => {
      for (const cb of disconnectListeners) cb();
    },
    fireConnect: () => {
      for (const cb of connectListeners) cb();
    },
  };
}

function makeBoard(overrides: Partial<RideStatusBoard> = {}): RideStatusBoard {
  return {
    speedKmh: 53,
    distanceKm: 12.4,
    durationSeconds: 32 * 60 + 5,
    qualityScore: 3.7,
    qualityConfidence: 0.92,
    rideType: "free",
    ...overrides,
  };
}

afterEach(() => {
  __setCarPlayBridgeForTest(null);
});

describe("formatSpeedKmh", () => {
  it("rounds to whole km/h when riding", () => {
    expect(formatSpeedKmh(53.4)).toBe("53 km/h");
    expect(formatSpeedKmh(53.6)).toBe("54 km/h");
  });

  it("collapses sub-1 km/h GPS jitter to em-dash", () => {
    expect(formatSpeedKmh(0)).toBe("—");
    expect(formatSpeedKmh(0.4)).toBe("—");
    expect(formatSpeedKmh(0.99)).toBe("—");
  });

  it("treats negative or non-finite values as no-reading", () => {
    expect(formatSpeedKmh(-5)).toBe("—");
    expect(formatSpeedKmh(NaN)).toBe("—");
    expect(formatSpeedKmh(Infinity)).toBe("—");
  });
});

describe("formatDistanceKm", () => {
  it("renders one decimal even at low km", () => {
    expect(formatDistanceKm(0.7)).toBe("0.7 km");
    expect(formatDistanceKm(12.456)).toBe("12.5 km");
  });

  it("clamps zero / negative / non-finite to 0.0", () => {
    expect(formatDistanceKm(0)).toBe("0.0 km");
    expect(formatDistanceKm(-2)).toBe("0.0 km");
    expect(formatDistanceKm(NaN)).toBe("0.0 km");
  });
});

describe("formatDuration", () => {
  it("renders mm:ss under an hour", () => {
    expect(formatDuration(0)).toBe("0:00");
    expect(formatDuration(5)).toBe("0:05");
    expect(formatDuration(75)).toBe("1:15");
    expect(formatDuration(59 * 60 + 59)).toBe("59:59");
  });

  it("switches to h:mm:ss past the hour", () => {
    expect(formatDuration(3600)).toBe("1:00:00");
    expect(formatDuration(3600 + 23 * 60 + 4)).toBe("1:23:04");
  });

  it("floors fractional seconds", () => {
    expect(formatDuration(75.9)).toBe("1:15");
  });

  it("handles non-finite gracefully", () => {
    expect(formatDuration(NaN)).toBe("0:00");
    expect(formatDuration(-10)).toBe("0:00");
  });
});

describe("formatRideTypeTitle", () => {
  it("maps known ride types", () => {
    expect(formatRideTypeTitle("free")).toBe("Free ride");
    expect(formatRideTypeTitle("commute")).toBe("Commute");
    expect(formatRideTypeTitle("trip")).toBe("Trip");
  });
});

describe("formatQualityDetail", () => {
  it("explains the pre-classification state", () => {
    expect(formatQualityDetail(null, null)).toBe("Reading surface…");
    expect(formatQualityDetail(null, 0.5)).toBe("Reading surface…");
  });

  it("appends confidence percent when both are present", () => {
    expect(formatQualityDetail(3.7, 0.92)).toBe("Good · 92% conf");
    expect(formatQualityDetail(4.6, 1)).toBe("Excellent · 100% conf");
    expect(formatQualityDetail(1.2, 0)).toBe("Very Poor · 0% conf");
  });

  it("clamps confidence outside 0..1", () => {
    expect(formatQualityDetail(2.7, -0.2)).toBe("Fair · 0% conf");
    expect(formatQualityDetail(2.7, 1.5)).toBe("Fair · 100% conf");
  });

  it("falls back to bare label when confidence is non-finite", () => {
    expect(formatQualityDetail(2, NaN)).toBe("Poor");
    expect(formatQualityDetail(4, Infinity)).toBe("Good");
  });
});

describe("buildRideStatusItems", () => {
  it("emits the four-row board in stable order", () => {
    const items = buildRideStatusItems(makeBoard());
    expect(items.map((i) => i.title)).toEqual([
      "Speed",
      "Distance",
      "Duration",
      "Surface",
    ]);
  });

  it("threads the snapshot fields through their formatters", () => {
    const items = buildRideStatusItems(
      makeBoard({
        speedKmh: 0,
        distanceKm: 1.234,
        durationSeconds: 65,
        qualityScore: null,
        qualityConfidence: null,
      }),
    );
    expect(items.find((i) => i.title === "Speed")?.detail).toBe("—");
    expect(items.find((i) => i.title === "Distance")?.detail).toBe("1.2 km");
    expect(items.find((i) => i.title === "Duration")?.detail).toBe("1:05");
    expect(items.find((i) => i.title === "Surface")?.detail).toBe(
      "Reading surface…",
    );
  });
});

describe("ride status board lifecycle", () => {
  let bridge: FakeBridge;

  beforeEach(() => {
    bridge = createFakeBridge();
    __setCarPlayBridgeForTest(bridge);
  });

  it("mounts the template once, then updates items on subsequent calls", () => {
    mountRideStatusBoard(makeBoard({ speedKmh: 30 }));
    expect(bridge.mount).toHaveBeenCalledTimes(1);
    expect(bridge.update).not.toHaveBeenCalled();

    const firstCall = bridge.mount.mock.calls[0]?.[0] as {
      title: string;
      items: { title: string; detail: string }[];
    };
    expect(firstCall.title).toBe("Free ride");
    expect(firstCall.items.find((i) => i.title === "Speed")?.detail).toBe(
      "30 km/h",
    );

    // Re-mount call while already mounted falls through to update path
    // so the bike display never blanks during a hot reload / refocus.
    mountRideStatusBoard(makeBoard({ speedKmh: 31 }));
    expect(bridge.mount).toHaveBeenCalledTimes(1);
    expect(bridge.update).toHaveBeenCalledTimes(1);
  });

  it("titles the template by ride type", () => {
    mountRideStatusBoard(makeBoard({ rideType: "commute" }));
    const config = bridge.mount.mock.calls[0]?.[0] as { title: string };
    expect(config.title).toBe("Commute");
  });

  it("re-issues mount when the ride type changes mid-mount", () => {
    // Seed mount with free-ride title.
    mountRideStatusBoard(makeBoard({ rideType: "free" }));
    expect(bridge.mount).toHaveBeenCalledTimes(1);

    // Same ride type on the next mount call → items-only update, no
    // mount re-issue (that would flicker the bike display).
    mountRideStatusBoard(makeBoard({ rideType: "free", speedKmh: 42 }));
    expect(bridge.mount).toHaveBeenCalledTimes(1);
    expect(bridge.update).toHaveBeenCalledTimes(1);

    // Ride type flips → re-issue mount so the title refreshes.
    mountRideStatusBoard(makeBoard({ rideType: "commute" }));
    expect(bridge.mount).toHaveBeenCalledTimes(2);
    const secondMount = bridge.mount.mock.calls[1]?.[0] as { title: string };
    expect(secondMount.title).toBe("Commute");
  });

  it("skips native traffic when the head unit is not available", () => {
    // Bridge reports disconnected — every lifecycle op should no-op
    // without touching mount / update / clear.
    const offlineBridge = createFakeBridge();
    offlineBridge.isAvailable = () => false;
    __setCarPlayBridgeForTest(offlineBridge);

    expect(mountRideStatusBoard(makeBoard())).toBe(false);
    expect(offlineBridge.mount).not.toHaveBeenCalled();

    // Subsequent ride-tick while still disconnected — same short-
    // circuit, so neither mount nor update should fire.
    expect(mountRideStatusBoard(makeBoard({ speedKmh: 80 }))).toBe(false);
    expect(offlineBridge.mount).not.toHaveBeenCalled();
    expect(offlineBridge.update).not.toHaveBeenCalled();

    unmountRideStatusBoard();
    expect(offlineBridge.clear).not.toHaveBeenCalled();
  });

  it("re-issues mount after a head-unit disconnect/reconnect", () => {
    // First mount on initial connect.
    mountRideStatusBoard(makeBoard());
    expect(bridge.mount).toHaveBeenCalledTimes(1);

    // Same-title mount → items-only update path (no second mount).
    mountRideStatusBoard(makeBoard({ speedKmh: 42 }));
    expect(bridge.mount).toHaveBeenCalledTimes(1);
    expect(bridge.update).toHaveBeenCalledTimes(1);

    // Head unit disconnects mid-ride — the native template scene is
    // destroyed. The bridge fires its disconnect listeners, which the
    // controller uses to reset its mount flag.
    bridge.fireDisconnect();

    // Reconnect: next ride-tick comes in. We must re-issue mount
    // (NOT items-update) because the previous template no longer
    // exists on the native side. Otherwise the bike display stays
    // blank for the rest of the ride.
    mountRideStatusBoard(makeBoard({ speedKmh: 50 }));
    expect(bridge.mount).toHaveBeenCalledTimes(2);
  });

  it("treats a fresh connect as a reset (Android-Auto-friendly)", () => {
    // Android Auto's `Session.onDestroy` doesn't emit a `didDisconnect`
    // through the package. Instead, when the host restarts and a new
    // session begins, `didConnect` fires again. The controller must
    // treat that as a signal to drop the local mount flag so the next
    // ride-tick re-issues mount against the new template id.
    mountRideStatusBoard(makeBoard());
    expect(bridge.mount).toHaveBeenCalledTimes(1);

    bridge.fireConnect();

    mountRideStatusBoard(makeBoard({ speedKmh: 60 }));
    expect(bridge.mount).toHaveBeenCalledTimes(2);
  });

  it("unmount is idempotent and resets the mount flag", () => {
    unmountRideStatusBoard();
    expect(bridge.clear).not.toHaveBeenCalled();

    mountRideStatusBoard(makeBoard());
    unmountRideStatusBoard();
    expect(bridge.clear).toHaveBeenCalledTimes(1);

    // Second unmount does nothing — the next ride must mount cleanly.
    unmountRideStatusBoard();
    expect(bridge.clear).toHaveBeenCalledTimes(1);

    mountRideStatusBoard(makeBoard());
    expect(bridge.mount).toHaveBeenCalledTimes(2);
  });

  it("__resetCarPlayStateForTest forces the next call to re-mount", () => {
    mountRideStatusBoard(makeBoard());
    bridge.mount.mockClear();

    __resetCarPlayStateForTest();
    mountRideStatusBoard(makeBoard());
    expect(bridge.mount).toHaveBeenCalledTimes(1);
  });

  it("can suspend and later resume the ride-status board", () => {
    suspendRideStatusBoard();

    expect(mountRideStatusBoard(makeBoard())).toBe(false);
    expect(bridge.mount).not.toHaveBeenCalled();

    resumeRideStatusBoard();
    expect(mountRideStatusBoard(makeBoard())).toBe(true);
    expect(bridge.mount).toHaveBeenCalledTimes(1);
  });
});
