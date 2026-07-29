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

import type { Hazard, HazardType } from "@/types";
import { setActiveFormatContext } from "@/format";
import {
  __resetCarPlayStateForTest,
  __setCarPlayBridgeForTest,
  buildHazardAlertSnapshot,
  buildQuickActionItems,
  buildRideStatusItems,
  disableCarPlayProjection,
  dismissHazardAlertOnVehicleDisplay,
  distanceMetersBetween,
  enableCarPlayProjection,
  formatDistanceKm,
  formatDuration,
  formatHazardAlertText,
  formatHazardDistance,
  formatQualityDetail,
  formatRideTypeTitle,
  formatSpeedKmh,
  hazardTypeLabel,
  mirrorClosestHazardAlert,
  mountQuickActions,
  mountRideStatusBoard,
  presentHazardAlertOnVehicleDisplay,
  resumeRideStatusBoard,
  selectClosestHazard,
  suspendRideStatusBoard,
  unmountQuickActions,
  unmountRideStatusBoard,
  type HazardAlertSnapshot,
  type QuickActionItem,
  type RideStatusBoard,
  type StatusBoardItem,
  type VehicleStatusBridge,
} from "../carplay";

interface FakeBridge extends VehicleStatusBridge {
  mount: jest.Mock;
  update: jest.Mock;
  clear: jest.Mock;
  presentAlert: jest.Mock;
  dismissAlert: jest.Mock;
  mountActions: jest.Mock;
  unmountActions: jest.Mock;
  showInert: jest.Mock;
  /** Capture the latest callbacks the controller registered. */
  lastAlertCallbacks: { onConfirm: () => void; onDismiss: () => void } | null;
  lastActionsHandler: ((id: QuickActionItem["id"]) => void) | null;
  /** Fire any disconnect callbacks the controller has registered. */
  fireDisconnect: () => void;
  /** Fire any connect callbacks the controller has registered. */
  fireConnect: () => void;
}

function createFakeBridge(): FakeBridge {
  const mount = jest.fn<void, [{ title: string; items: StatusBoardItem[] }]>();
  const update = jest.fn<void, [StatusBoardItem[]]>();
  const clear = jest.fn();
  const presentAlert = jest.fn<
    void,
    [HazardAlertSnapshot, { onConfirm: () => void; onDismiss: () => void }]
  >();
  const dismissAlert = jest.fn();
  const mountActions = jest.fn<
    void,
    [QuickActionItem[], (id: QuickActionItem["id"]) => void]
  >();
  const unmountActions = jest.fn();
  const showInert = jest.fn();
  const disconnectListeners = new Set<() => void>();
  const connectListeners = new Set<() => void>();
  const fake: FakeBridge = {
    mount,
    update,
    clear,
    presentAlert,
    dismissAlert,
    mountActions,
    unmountActions,
    showInert,
    lastAlertCallbacks: null,
    lastActionsHandler: null,
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
    presentHazardAlert: (snapshot, callbacks) => {
      presentAlert(snapshot, callbacks);
      fake.lastAlertCallbacks = callbacks;
    },
    dismissHazardAlert: () => {
      dismissAlert();
    },
    mountQuickActions: (items, handler) => {
      mountActions(items, handler);
      fake.lastActionsHandler = handler;
    },
    unmountQuickActions: () => {
      unmountActions();
    },
    showInertRoot: () => {
      showInert();
    },
    fireDisconnect: () => {
      for (const cb of disconnectListeners) cb();
    },
    fireConnect: () => {
      for (const cb of connectListeners) cb();
    },
  };
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
  setActiveFormatContext({ locale: "en-US", timeZone: "UTC", units: "metric" });
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

  it("clamps zero / negative / non-finite to localized zero", () => {
    expect(formatDistanceKm(0)).toBe("0 km");
    expect(formatDistanceKm(-2)).toBe("0 km");
    expect(formatDistanceKm(NaN)).toBe("0 km");
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

  it("carplay_android_auto kill: shows the inert root, blocks all mounts, restores on enable", () => {
    disableCarPlayProjection();
    // The existing surface is replaced with the inert idle root.
    expect(bridge.showInert).toHaveBeenCalledTimes(1);

    // Every mount path is blocked while disabled — no interactive surface.
    expect(mountRideStatusBoard(makeBoard({ speedKmh: 30 }))).toBe(false);
    expect(bridge.mount).not.toHaveBeenCalled();
    expect(
      mountQuickActions(
        buildQuickActionItems({ isRiding: true, hasCommuteRoute: false }),
        () => {},
      ),
    ).toBe(false);
    expect(bridge.mountActions).not.toHaveBeenCalled();

    // Re-enable → mounts resume.
    enableCarPlayProjection();
    expect(mountRideStatusBoard(makeBoard({ speedKmh: 30 }))).toBe(true);
    expect(bridge.mount).toHaveBeenCalledTimes(1);
  });

  it("disableCarPlayProjection is idempotent", () => {
    disableCarPlayProjection();
    disableCarPlayProjection();
    expect(bridge.showInert).toHaveBeenCalledTimes(1);
  });

  it("reapplies the inert root when a head unit connects while projection is disabled", () => {
    // Models a kill that landed while no head unit was connected: a later
    // connection must still get the inert root (the crash-on-connect surface),
    // even though the flag is already set so `disableCarPlayProjection` no-ops.
    disableCarPlayProjection();
    bridge.showInert.mockClear();

    bridge.fireConnect();
    expect(bridge.showInert).toHaveBeenCalledTimes(1);
  });

  it("does not reapply the inert root on connect when projection is enabled", () => {
    bridge.showInert.mockClear();
    bridge.fireConnect();
    expect(bridge.showInert).not.toHaveBeenCalled();
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

// ── Hazard alert formatters ──

describe("distanceMetersBetween", () => {
  it("returns 0 for identical points", () => {
    expect(
      distanceMetersBetween({ lat: 49.5, lng: 18.1 }, { lat: 49.5, lng: 18.1 }),
    ).toBe(0);
  });

  it("matches a known great-circle distance to within 1%", () => {
    // Ostrava (49.82, 18.26) → Prague (50.08, 14.43). Real-world ~280 km.
    const meters = distanceMetersBetween(
      { lat: 49.82, lng: 18.26 },
      { lat: 50.08, lng: 14.43 },
    );
    expect(meters).toBeGreaterThan(275_000);
    expect(meters).toBeLessThan(285_000);
  });
});

describe("hazardTypeLabel", () => {
  it.each<[HazardType, string]>([
    ["pothole", "Pothole"],
    ["gravel", "Loose gravel"],
    ["oil_spill", "Oil spill"],
    ["roadworks", "Roadworks"],
    ["animals", "Animals"],
    ["police", "Police"],
    ["flooding", "Flooding"],
    ["ice", "Ice"],
    ["other", "Hazard"],
  ])("maps %s to %s", (type, label) => {
    expect(hazardTypeLabel(type)).toBe(label);
  });
});

describe("formatHazardDistance", () => {
  it("rounds to 50 m granularity below 1 km", () => {
    expect(formatHazardDistance(123)).toBe("100 m ahead");
    expect(formatHazardDistance(180)).toBe("200 m ahead");
    expect(formatHazardDistance(950)).toBe("950 m ahead");
  });

  it("renders locale-aware kilometres at and above 1 km", () => {
    expect(formatHazardDistance(1000)).toBe("1 km ahead");
    expect(formatHazardDistance(1500)).toBe("1.5 km ahead");
  });

  it("honors imperial units for short and long hazard distances", () => {
    setActiveFormatContext({
      locale: "en-US",
      timeZone: "UTC",
      units: "imperial",
    });

    expect(formatHazardDistance(123)).toBe("328 ft ahead");
    expect(formatHazardDistance(1500)).toBe("0.9 mi ahead");
  });

  it("collapses very close hazards to a single readable word", () => {
    // Sub-25 m rounds to 0 at 50 m granularity — render "Right here"
    // so the rider doesn't see a confusing "0 m ahead" on the bike
    // display when the hazard is essentially under the front wheel.
    expect(formatHazardDistance(15)).toBe("Right here");
    expect(formatHazardDistance(0)).toBe("Right here");
  });

  it("falls back to 'Nearby' for non-finite / negative inputs", () => {
    expect(formatHazardDistance(NaN)).toBe("Nearby");
    expect(formatHazardDistance(-5)).toBe("Nearby");
    expect(formatHazardDistance(Infinity)).toBe("Nearby");
  });
});

describe("selectClosestHazard", () => {
  const riderLocation = { lat: 49.5, lng: 18.1 };

  it("returns the closest hazard from a list", () => {
    const hazards = [
      makeHazard({ id: "far", lat: 49.8, lng: 18.5 }),
      makeHazard({ id: "near", lat: 49.501, lng: 18.101 }),
      makeHazard({ id: "mid", lat: 49.6, lng: 18.2 }),
    ];
    const result = selectClosestHazard(hazards, riderLocation);
    expect(result?.hazard.id).toBe("near");
    // Rough sanity check on the distance — ~140 m for a 0.001/0.001
    // delta near 50° latitude.
    expect(result?.distanceMeters).toBeGreaterThan(0);
    expect(result?.distanceMeters).toBeLessThan(200);
  });

  it("returns null when there's no fix or no hazards", () => {
    expect(selectClosestHazard([], riderLocation)).toBeNull();
    expect(selectClosestHazard([makeHazard()], null)).toBeNull();
  });
});

describe("buildHazardAlertSnapshot", () => {
  it("projects the hazard fields the bridge cares about", () => {
    const hazard = makeHazard({
      id: "hz-7",
      hazard_type: "ice",
      note: "Black ice patch",
      road_name: "B500",
    });
    expect(buildHazardAlertSnapshot(hazard, 320)).toEqual({
      id: "hz-7",
      hazard_type: "ice",
      distanceMeters: 320,
      note: "Black ice patch",
      roadName: "B500",
    });
  });
});

describe("formatHazardAlertText", () => {
  it("composes title + subtitle from label, distance, road, and note", () => {
    const snapshot = buildHazardAlertSnapshot(
      makeHazard({
        hazard_type: "gravel",
        note: "Lots of loose stones",
        road_name: "B500",
      }),
      450,
    );
    expect(formatHazardAlertText(snapshot)).toEqual({
      title: "Loose gravel",
      subtitle: "450 m ahead · on B500 · Lots of loose stones",
    });
  });

  it("omits missing road / note segments", () => {
    const snapshot = buildHazardAlertSnapshot(
      makeHazard({ hazard_type: "pothole", note: null, road_name: null }),
      120,
    );
    expect(formatHazardAlertText(snapshot)).toEqual({
      title: "Pothole",
      subtitle: "100 m ahead",
    });
  });

  it("uses complete subtitle messages for road-only and note-only alerts", () => {
    const withRoad = buildHazardAlertSnapshot(
      makeHazard({ road_name: "B500", note: null }),
      320,
    );
    const withNote = buildHazardAlertSnapshot(
      makeHazard({ road_name: null, note: "Deep edge" }),
      320,
    );

    expect(formatHazardAlertText(withRoad).subtitle).toBe(
      "300 m ahead · on B500",
    );
    expect(formatHazardAlertText(withNote).subtitle).toBe(
      "300 m ahead · Deep edge",
    );
  });
});

// ── Hazard alert lifecycle ──

describe("hazard alert lifecycle", () => {
  let bridge: FakeBridge;

  beforeEach(() => {
    bridge = createFakeBridge();
    __setCarPlayBridgeForTest(bridge);
  });

  function makeSnapshot(
    overrides: Partial<HazardAlertSnapshot> = {},
  ): HazardAlertSnapshot {
    return {
      id: "hz-1",
      hazard_type: "pothole",
      distanceMeters: 320,
      note: null,
      roadName: null,
      ...overrides,
    };
  }

  it("presents the alert once per hazard id and dedupes subsequent ticks", () => {
    expect(presentHazardAlertOnVehicleDisplay(makeSnapshot())).toBe(true);
    expect(bridge.presentAlert).toHaveBeenCalledTimes(1);

    // Same hazard, different distance (closer) — dedupe by id, no
    // re-present so the rider doesn't see the alert flash on every
    // ride-tick approaching the pothole.
    expect(
      presentHazardAlertOnVehicleDisplay(makeSnapshot({ distanceMeters: 200 })),
    ).toBe(true);
    expect(bridge.presentAlert).toHaveBeenCalledTimes(1);

    // Different hazard id — fresh present.
    expect(
      presentHazardAlertOnVehicleDisplay(
        makeSnapshot({ id: "hz-2", hazard_type: "gravel" }),
      ),
    ).toBe(true);
    expect(bridge.presentAlert).toHaveBeenCalledTimes(2);
  });

  it("returns false when the head unit is not connected", () => {
    const offlineBridge = createFakeBridge();
    offlineBridge.isAvailable = () => false;
    __setCarPlayBridgeForTest(offlineBridge);

    expect(presentHazardAlertOnVehicleDisplay(makeSnapshot())).toBe(false);
    expect(offlineBridge.presentAlert).not.toHaveBeenCalled();
  });

  it("remembers a rider's explicit dismiss and refuses to re-present that hazard", () => {
    presentHazardAlertOnVehicleDisplay(makeSnapshot({ id: "hz-1" }));
    bridge.lastAlertCallbacks?.onDismiss();

    // Same hazard cycles back through the nearby list — the controller
    // must NOT re-present it on the bike display, otherwise the rider
    // who dismissed it would see the same alert resurface every time
    // they pass within range. Confirm-then-rebound is the right behavior
    // (handled by the next test) but explicit-dismiss is sticky.
    expect(
      presentHazardAlertOnVehicleDisplay(makeSnapshot({ id: "hz-1" })),
    ).toBe(false);
    expect(bridge.presentAlert).toHaveBeenCalledTimes(1);
  });

  it("snoozes a confirmed hazard so it does not bounce back on the next tick", () => {
    presentHazardAlertOnVehicleDisplay(makeSnapshot({ id: "hz-1" }));
    bridge.lastAlertCallbacks?.onConfirm();

    // After confirm, the same hazard is in the confirmed set.
    // `presentHazardAlertOnVehicleDisplay` returns `false` for it on
    // every subsequent tick — without this guard, the next ride-tick
    // (~1 Hz) would re-call into the bridge and the rider would see
    // the alert flash again 1 second after they confirmed.
    expect(
      presentHazardAlertOnVehicleDisplay(makeSnapshot({ id: "hz-1" })),
    ).toBe(false);
    expect(bridge.presentAlert).toHaveBeenCalledTimes(1);
  });

  it("clears the dismissed and confirmed hazard sets when a ride ends", () => {
    // Simulate a morning commute: rider dismisses hazard A and
    // confirms hazard B. Both ids end up in their respective tracking
    // sets at module scope.
    presentHazardAlertOnVehicleDisplay(makeSnapshot({ id: "hz-A" }));
    bridge.lastAlertCallbacks?.onDismiss();
    presentHazardAlertOnVehicleDisplay(makeSnapshot({ id: "hz-B" }));
    bridge.lastAlertCallbacks?.onConfirm();
    expect(bridge.presentAlert).toHaveBeenCalledTimes(2);

    // Mid-ride: the same hazards are sticky-suppressed.
    expect(
      presentHazardAlertOnVehicleDisplay(makeSnapshot({ id: "hz-A" })),
    ).toBe(false);
    expect(
      presentHazardAlertOnVehicleDisplay(makeSnapshot({ id: "hz-B" })),
    ).toBe(false);

    // End of the ride. Hazard tracking is per-ride: the evening
    // commute should not silently inherit this morning's dismissals.
    unmountRideStatusBoard();

    // Same hazards on a fresh ride — both should be alert-eligible
    // again so the rider doesn't miss known hazards just because they
    // already saw them on a prior ride within the same app session.
    expect(
      presentHazardAlertOnVehicleDisplay(makeSnapshot({ id: "hz-A" })),
    ).toBe(true);
    expect(
      presentHazardAlertOnVehicleDisplay(makeSnapshot({ id: "hz-B" })),
    ).toBe(true);
    expect(bridge.presentAlert).toHaveBeenCalledTimes(4);
  });

  it("dismissHazardAlertOnVehicleDisplay is idempotent and clears active id", () => {
    dismissHazardAlertOnVehicleDisplay();
    expect(bridge.dismissAlert).not.toHaveBeenCalled();

    presentHazardAlertOnVehicleDisplay(makeSnapshot());
    dismissHazardAlertOnVehicleDisplay();
    expect(bridge.dismissAlert).toHaveBeenCalledTimes(1);

    dismissHazardAlertOnVehicleDisplay();
    expect(bridge.dismissAlert).toHaveBeenCalledTimes(1);
  });

  it("resets the active hazard id on a head-unit reconnect", () => {
    presentHazardAlertOnVehicleDisplay(makeSnapshot({ id: "hz-1" }));
    expect(bridge.presentAlert).toHaveBeenCalledTimes(1);

    bridge.fireDisconnect();

    // After reconnect, the previous template is gone — re-presenting
    // the same hazard id must succeed since the bike display has no
    // standing alert for it any more.
    presentHazardAlertOnVehicleDisplay(makeSnapshot({ id: "hz-1" }));
    expect(bridge.presentAlert).toHaveBeenCalledTimes(2);
  });
});

// ── Quick actions ──

describe("buildQuickActionItems", () => {
  it("emits Start Commute pre-ride when the rider has a saved route", () => {
    const items = buildQuickActionItems({
      isRiding: false,
      hasCommuteRoute: true,
    });
    expect(items.map((i) => i.id)).toEqual(["start-commute"]);
  });

  it("emits an empty list pre-ride when there's no commute route", () => {
    expect(
      buildQuickActionItems({ isRiding: false, hasCommuteRoute: false }),
    ).toEqual([]);
  });

  it("emits an empty list mid-ride so the live ride board is never replaced", () => {
    // Mid-ride the rider's primary head-unit surface is the live ride
    // status board (or the navigation map template). A quick-actions
    // list-template would call setRootTemplate and replace it,
    // leaving the bike display stuck on a static menu — which is
    // exactly the regression a P1 review caught. Mid-ride affordances
    // (report hazard, stop ride) are reachable from the navigation
    // map template's existing surface, so this list is pre-ride only.
    expect(
      buildQuickActionItems({ isRiding: true, hasCommuteRoute: true }),
    ).toEqual([]);
    expect(
      buildQuickActionItems({ isRiding: true, hasCommuteRoute: false }),
    ).toEqual([]);
  });
});

describe("quick-actions lifecycle", () => {
  let bridge: FakeBridge;
  let onActionPressed: jest.Mock;

  beforeEach(() => {
    bridge = createFakeBridge();
    __setCarPlayBridgeForTest(bridge);
    onActionPressed = jest.fn();
  });

  function items(ids: QuickActionItem["id"][]): QuickActionItem[] {
    return ids.map((id) => ({ id, text: id, detailText: id }));
  }

  it("mounts on first call and diff-skips identical re-mounts", () => {
    expect(mountQuickActions(items(["start-commute"]), onActionPressed)).toBe(
      true,
    );
    expect(bridge.mountActions).toHaveBeenCalledTimes(1);

    // Same items — should diff-skip to respect AA's host rate-limit on
    // template updates.
    expect(mountQuickActions(items(["start-commute"]), onActionPressed)).toBe(
      true,
    );
    expect(bridge.mountActions).toHaveBeenCalledTimes(1);

    // Different items — re-mount.
    expect(
      mountQuickActions(items(["report-hazard", "stop-ride"]), onActionPressed),
    ).toBe(true);
    expect(bridge.mountActions).toHaveBeenCalledTimes(2);
  });

  it("returns false and unmounts when given an empty list", () => {
    mountQuickActions(items(["start-commute"]), onActionPressed);
    expect(mountQuickActions([], onActionPressed)).toBe(false);
    expect(bridge.unmountActions).toHaveBeenCalledTimes(1);
  });

  it("forwards the rider's action selection to the host callback", () => {
    mountQuickActions(items(["start-commute"]), onActionPressed);
    bridge.lastActionsHandler?.("start-commute");
    expect(onActionPressed).toHaveBeenCalledWith("start-commute");
  });

  it("unmount is idempotent and short-circuits when the head unit is offline", () => {
    unmountQuickActions();
    expect(bridge.unmountActions).not.toHaveBeenCalled();

    mountQuickActions(items(["start-commute"]), onActionPressed);
    unmountQuickActions();
    expect(bridge.unmountActions).toHaveBeenCalledTimes(1);

    // Second unmount is a no-op so a stop dispatched twice doesn't
    // double-pop the head unit's screen stack.
    unmountQuickActions();
    expect(bridge.unmountActions).toHaveBeenCalledTimes(1);
  });
});

// ── mirrorClosestHazardAlert orchestrator ──

describe("mirrorClosestHazardAlert", () => {
  let bridge: FakeBridge;
  const riderLocation = { lat: 49.5, lng: 18.1 };

  beforeEach(() => {
    bridge = createFakeBridge();
    __setCarPlayBridgeForTest(bridge);
  });

  function nearby(): Hazard {
    // Roughly ~140 m from the rider.
    return makeHazard({ id: "near", lat: 49.501, lng: 18.101 });
  }

  function farAway(): Hazard {
    // Roughly ~14 km from the rider — outside any reasonable alert radius.
    return makeHazard({ id: "far", lat: 49.6, lng: 18.2 });
  }

  it("presents the closest non-dismissed hazard within radius", () => {
    expect(
      mirrorClosestHazardAlert([nearby(), farAway()], riderLocation, 750),
    ).toBe("presented");
    expect(bridge.presentAlert).toHaveBeenCalledTimes(1);
    expect(bridge.presentAlert.mock.calls[0]?.[0].id).toBe("near");
  });

  it("does nothing on a no-fix tick (returns 'noop')", () => {
    expect(mirrorClosestHazardAlert([nearby()], null, 750)).toBe("noop");
    expect(bridge.presentAlert).not.toHaveBeenCalled();
  });

  it("dismisses any standing alert when nothing is in range", () => {
    mirrorClosestHazardAlert([nearby()], riderLocation, 750);
    expect(bridge.presentAlert).toHaveBeenCalledTimes(1);

    // Rider moves on — the only hazard left in the nearby list is far
    // away, so the standing alert must be dismissed.
    expect(mirrorClosestHazardAlert([farAway()], riderLocation, 750)).toBe(
      "dismissed",
    );
    expect(bridge.dismissAlert).toHaveBeenCalledTimes(1);
  });

  it("skips a dismissed-but-still-closest hazard so a fresh one in range still alerts", () => {
    // Step 1: rider sees the nearby hazard, taps Dismiss on the head
    // unit. The dismissed-id is now sticky.
    mirrorClosestHazardAlert([nearby()], riderLocation, 750);
    bridge.lastAlertCallbacks?.onDismiss();
    expect(bridge.presentAlert).toHaveBeenCalledTimes(1);

    // Step 2: a *new* hazard enters the nearby list within range.
    // Without the dismissed-id filter, `selectClosestHazard` would
    // still return the dismissed `near` (closest by geometry), the
    // present call would no-op, and the new hazard would never get
    // surfaced. With the filter, the new hazard wins and gets
    // alerted.
    const fresh = makeHazard({
      id: "fresh",
      lat: 49.502,
      lng: 18.102,
      hazard_type: "gravel",
    });
    expect(
      mirrorClosestHazardAlert([nearby(), fresh], riderLocation, 750),
    ).toBe("presented");
    expect(bridge.presentAlert).toHaveBeenCalledTimes(2);
    expect(bridge.presentAlert.mock.calls[1]?.[0].id).toBe("fresh");
  });

  it("a confirmed hazard does not re-fire on the next orchestrator tick while still in range", () => {
    mirrorClosestHazardAlert([nearby()], riderLocation, 750);
    bridge.lastAlertCallbacks?.onConfirm();
    expect(bridge.presentAlert).toHaveBeenCalledTimes(1);

    // Same hazard, still within radius, next ~1 Hz tick. Without the
    // confirmed-set guard the orchestrator would walk back into
    // `presentHazardAlertOnVehicleDisplay` (its same-id dedupe is
    // off because confirm cleared `activeHazardAlertId`) and the
    // rider would see the alert flash again ~1 sec after tapping
    // Confirm.
    expect(mirrorClosestHazardAlert([nearby()], riderLocation, 750)).toBe(
      "noop",
    );
    expect(bridge.presentAlert).toHaveBeenCalledTimes(1);
  });

  it("re-fires the alert when a confirmed hazard exits and re-enters proximity", () => {
    mirrorClosestHazardAlert([nearby()], riderLocation, 750);
    bridge.lastAlertCallbacks?.onConfirm();
    expect(bridge.presentAlert).toHaveBeenCalledTimes(1);

    // Rider rides away — hazard leaves the radius. The orchestrator
    // clears the confirmed entry as a side effect of the radius pass.
    expect(mirrorClosestHazardAlert([farAway()], riderLocation, 750)).toBe(
      "noop",
    );

    // Rider doubles back, hazard is in range again. Should re-alert.
    expect(mirrorClosestHazardAlert([nearby()], riderLocation, 750)).toBe(
      "presented",
    );
    expect(bridge.presentAlert).toHaveBeenCalledTimes(2);
  });

  it("clears confirmed entries when a hazard disappears from the nearby list entirely", () => {
    mirrorClosestHazardAlert([nearby()], riderLocation, 750);
    bridge.lastAlertCallbacks?.onConfirm();

    // Server expires the hazard mid-ride — it drops out of nearby.
    // The orchestrator should clear its confirmed entry so a fresh
    // hazard reusing that id later (very unlikely but defensive)
    // would not be silently snoozed.
    mirrorClosestHazardAlert([], riderLocation, 750);

    expect(mirrorClosestHazardAlert([nearby()], riderLocation, 750)).toBe(
      "presented",
    );
    expect(bridge.presentAlert).toHaveBeenCalledTimes(2);
  });

  it("clears a stale standing alert when the closest in-range hazard is now dismissed-only", () => {
    // Step 1: alert about hazard A.
    const hazardA = makeHazard({
      id: "A",
      lat: 49.501,
      lng: 18.101,
    });
    const hazardB = makeHazard({
      id: "B",
      lat: 49.502,
      lng: 18.102,
    });

    mirrorClosestHazardAlert([hazardB], riderLocation, 750);
    expect(bridge.presentAlert).toHaveBeenCalledTimes(1);

    // Step 2: the rider dismisses B, then moves so B drops out and A
    // (which the rider also dismissed earlier in some scenario) stays
    // in range. The orchestrator must clear the standing alert from
    // step 1 even though A is still within radius — because A is
    // dismissed and B is gone, there's nothing eligible to keep the
    // alert open for.
    bridge.lastAlertCallbacks?.onDismiss();
    // Simulate A also being dismissed: present then dismiss to mark it.
    mirrorClosestHazardAlert([hazardA], riderLocation, 750);
    bridge.lastAlertCallbacks?.onDismiss();
    bridge.dismissAlert.mockClear();

    expect(mirrorClosestHazardAlert([hazardA], riderLocation, 750)).toBe(
      "noop",
    );
    expect(bridge.presentAlert).toHaveBeenCalledTimes(2);
    expect(bridge.dismissAlert).not.toHaveBeenCalled();
  });
});
