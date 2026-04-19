/**
 * CarPlay bridge tests — US-17 AC #3.
 *
 * The native CarPlay surface is iOS-only and requires Apple-issued
 * entitlements to validate live, so these tests focus on what the
 * bridge contract guarantees regardless of environment:
 *
 *   - Pure formatters survive the noisy edge cases the ride store
 *     produces (sub-1 km/h GPS jitter, classifier null states, NaN
 *     from a malformed sensor window).
 *   - Mount/update/unmount drives the injected bridge fake the way the
 *     hook will drive it on the device, so wiring regressions surface
 *     here instead of on a bike at 80 km/h.
 */

import {
  __resetCarPlayStateForTest,
  __setCarPlayBridgeForTest,
  buildRideStatusItems,
  type CarPlayBridge,
  formatDistanceKm,
  formatDuration,
  formatQualityDetail,
  formatRideTypeTitle,
  formatSpeedKmh,
  mountRideStatusBoard,
  type RideStatusBoard,
  unmountRideStatusBoard,
  updateRideStatusBoard,
} from "../carplay";

interface FakeBridge extends CarPlayBridge {
  setRoot: jest.Mock;
  updateItems: jest.Mock;
  clear: jest.Mock;
}

function createFakeBridge(): FakeBridge {
  const setRoot = jest.fn();
  const updateItems = jest.fn();
  const clear = jest.fn();
  return {
    setRoot,
    updateItems,
    clear,
    isAvailable: () => true,
    setRootInformationTemplate: setRoot,
    updateInformationTemplateItems: updateItems,
    clearRootTemplate: clear,
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
    expect(bridge.setRoot).toHaveBeenCalledTimes(1);
    expect(bridge.updateItems).not.toHaveBeenCalled();

    const firstCall = bridge.setRoot.mock.calls[0]?.[0] as {
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
    expect(bridge.setRoot).toHaveBeenCalledTimes(1);
    expect(bridge.updateItems).toHaveBeenCalledTimes(1);
  });

  it("titles the template by ride type", () => {
    mountRideStatusBoard(makeBoard({ rideType: "commute" }));
    const config = bridge.setRoot.mock.calls[0]?.[0] as { title: string };
    expect(config.title).toBe("Commute");
  });

  it("re-issues setRootTemplate when the ride type changes mid-mount", () => {
    // Seed mount with free-ride title.
    mountRideStatusBoard(makeBoard({ rideType: "free" }));
    expect(bridge.setRoot).toHaveBeenCalledTimes(1);

    // Same ride type on the next mount call → items-only update, no
    // setRoot re-issue (that would flicker the bike display).
    mountRideStatusBoard(makeBoard({ rideType: "free", speedKmh: 42 }));
    expect(bridge.setRoot).toHaveBeenCalledTimes(1);
    expect(bridge.updateItems).toHaveBeenCalledTimes(1);

    // Ride type flips → re-issue setRootTemplate so the title refreshes.
    mountRideStatusBoard(makeBoard({ rideType: "commute" }));
    expect(bridge.setRoot).toHaveBeenCalledTimes(2);
    const secondSetRoot = bridge.setRoot.mock.calls[1]?.[0] as {
      title: string;
    };
    expect(secondSetRoot.title).toBe("Commute");
  });

  it("skips native traffic when CarPlay is not available", () => {
    // Bridge reports disconnected — every lifecycle op should no-op
    // without touching setRoot / updateItems / clear.
    const offlineBridge = createFakeBridge();
    offlineBridge.isAvailable = () => false;
    __setCarPlayBridgeForTest(offlineBridge);

    expect(mountRideStatusBoard(makeBoard())).toBe(false);
    expect(offlineBridge.setRoot).not.toHaveBeenCalled();

    updateRideStatusBoard(makeBoard({ speedKmh: 80 }));
    expect(offlineBridge.updateItems).not.toHaveBeenCalled();

    unmountRideStatusBoard();
    expect(offlineBridge.clear).not.toHaveBeenCalled();
  });

  it("updates only when a template is mounted", () => {
    // No mount yet — update is a no-op so the rider doesn't see ghost
    // template content if the hook fires a tick before the mount effect.
    updateRideStatusBoard(makeBoard());
    expect(bridge.updateItems).not.toHaveBeenCalled();

    mountRideStatusBoard(makeBoard());
    bridge.updateItems.mockClear();

    updateRideStatusBoard(makeBoard({ distanceKm: 99 }));
    expect(bridge.updateItems).toHaveBeenCalledTimes(1);
    const items = bridge.updateItems.mock.calls[0]?.[0] as {
      title: string;
      detail: string;
    }[];
    expect(items.find((i) => i.title === "Distance")?.detail).toBe("99.0 km");
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
    expect(bridge.setRoot).toHaveBeenCalledTimes(2);
  });

  it("__resetCarPlayStateForTest forces the next call to re-mount", () => {
    mountRideStatusBoard(makeBoard());
    bridge.setRoot.mockClear();

    __resetCarPlayStateForTest();
    mountRideStatusBoard(makeBoard());
    expect(bridge.setRoot).toHaveBeenCalledTimes(1);
  });
});
