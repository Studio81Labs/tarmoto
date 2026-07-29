jest.mock("@/services/systemSwitchCache", () => ({
  isFeatureKillSwitchActive: jest.fn(() => true),
}));

import type { LatLng, HazardType } from "@/types";
import { setActiveFormatContext } from "@/format";
import { setActiveLocale } from "@/i18n";
import {
  VehicleDisplayController,
  buildHazardSearchItems,
  buildNavigationPaneItems,
  formatNavDistanceMeters,
  formatNextManeuverRow,
  matchHazardTypeFromText,
  type VehicleDisplayBridge,
  type VehicleNavigationSnapshot,
} from "../vehicleDisplay";
import { isFeatureKillSwitchActive } from "@/services/systemSwitchCache";

function makeReportHazardMock() {
  return jest.fn<Promise<void>, [LatLng, HazardType]>().mockResolvedValue();
}

class FakeBridge implements VehicleDisplayBridge {
  mountNavigation = jest.fn();
  unmountNavigation = jest.fn();
  syncNavigation = jest.fn();
  openSearch = jest.fn();
  updateSearch = jest.fn();
  closeSearch = jest.fn();
  showBanner = jest.fn();
}

function makeSnapshot(
  overrides: Partial<VehicleNavigationSnapshot> = {},
): VehicleNavigationSnapshot {
  return {
    title: "Sunday Alps",
    polyline: [
      { lat: 49.5, lng: 18.1 },
      { lat: 49.6, lng: 18.2 },
    ],
    currentLocation: { lat: 49.55, lng: 18.15 },
    nextManeuver: {
      type: "turn-right",
      roadName: "B500",
    },
    distanceToNextM: 320,
    remainingM: 12400,
    offRoute: false,
    offRouteDistanceM: 0,
    rideStats: {
      rideType: "trip",
      speedKmh: 62,
      distanceKm: 44.3,
      durationSeconds: 4020,
    },
    banner: null,
    ...overrides,
  };
}

describe("matchHazardTypeFromText", () => {
  it.each<[string, HazardType]>([
    ["pothole", "pothole"],
    ["loose gravel ahead", "gravel"],
    ["oil spill on the road", "oil_spill"],
    ["road works", "roadworks"],
    ["animal on roadway", "animals"],
    ["ice patch", "ice"],
    ["flooded lane", "flooding"],
    ["police checkpoint", "police"],
  ])("matches '%s' to %s", (query, expected) => {
    expect(matchHazardTypeFromText(query)).toBe(expected);
  });

  it("returns null for an unrelated phrase", () => {
    expect(matchHazardTypeFromText("beautiful scenery")).toBeNull();
  });

  it("matches localized Turkish casing with the active locale", () => {
    const translate = (key: string) => (key === "Pothole" ? "Işık" : key);
    expect(matchHazardTypeFromText("IŞIK", translate as never, "tr")).toBe(
      "pothole",
    );
    expect(
      buildHazardSearchItems("IŞIK", translate as never, "tr")[0]?.id,
    ).toBe("pothole");
  });
});

describe("buildHazardSearchItems", () => {
  it("prioritises the strongest query match first", () => {
    const items = buildHazardSearchItems("gravel");
    expect(items[0]?.id).toBe("gravel");
    expect(items[0]?.text).toBe("Gravel");
  });

  it("falls back to the full hazard catalog when the query is empty", () => {
    const items = buildHazardSearchItems("");
    expect(items.map((item) => item.id)).toEqual([
      "pothole",
      "gravel",
      "oil_spill",
      "roadworks",
      "animals",
      "police",
      "flooding",
      "ice",
      "other",
    ]);
  });
});

describe("VehicleDisplayController", () => {
  let bridge: FakeBridge;
  let reports: Array<{ location: LatLng; type: HazardType }>;
  let controller: VehicleDisplayController;

  beforeEach(() => {
    setActiveLocale("en");
    setActiveFormatContext({
      locale: "en",
      timeZone: "UTC",
      units: "metric",
    });
    (isFeatureKillSwitchActive as jest.Mock).mockReturnValue(true);
    bridge = new FakeBridge();
    reports = [];
    controller = new VehicleDisplayController({
      bridge,
      reportHazard: async (location, type) => {
        reports.push({ location, type });
      },
    });
  });

  it("mounts the vehicle navigation surface on the first sync", () => {
    controller.sync(makeSnapshot());
    expect(bridge.mountNavigation).toHaveBeenCalledTimes(1);

    controller.sync(makeSnapshot({ distanceToNextM: 150 }));
    expect(bridge.mountNavigation).toHaveBeenCalledTimes(1);
  });

  it("forwards every snapshot tick to syncNavigation for native pane updates", () => {
    // The Android Auto path needs every snapshot to push the pane
    // natively (the React component is iOS-only). On iOS the bridge
    // implementation no-ops syncNavigation since the React surface
    // re-renders from the store automatically — the fake just records
    // that the controller did call it on every tick.
    const first = makeSnapshot();
    const second = makeSnapshot({ distanceToNextM: 150 });
    controller.sync(first);
    controller.sync(second);

    expect(bridge.syncNavigation).toHaveBeenCalledTimes(2);
    expect(bridge.syncNavigation.mock.calls[0]?.[0]).toEqual(first);
    expect(bridge.syncNavigation.mock.calls[1]?.[0]).toEqual(second);
  });

  it("opens the hazard search when the report action is pressed", () => {
    controller.sync(makeSnapshot());
    controller.handleTemplateAction("report-hazard");

    expect(bridge.openSearch).toHaveBeenCalledTimes(1);
    const items = bridge.openSearch.mock.calls[0]?.[0] as Array<{ id: string }>;
    expect(items[0]?.id).toBe("pothole");
  });

  it("does NOT open the hazard search when hazard_reporting is killed (mid-session action tap)", async () => {
    (isFeatureKillSwitchActive as jest.Mock).mockReturnValue(false);
    controller.sync(makeSnapshot());
    controller.handleTemplateAction("report-hazard");

    // A stale Report action from a template built pre-kill must not open the
    // search — no apparently-working workflow that silently drops the report.
    expect(bridge.openSearch).not.toHaveBeenCalled();
  });

  it("submits a spoken hazard query against the current location", async () => {
    controller.sync(makeSnapshot());

    const ok = await controller.submitSearchQuery("Loose gravel ahead");

    expect(ok).toBe(true);
    expect(reports).toEqual([
      {
        location: { lat: 49.55, lng: 18.15 },
        type: "gravel",
      },
    ]);
    expect(bridge.closeSearch).toHaveBeenCalledTimes(1);
    expect(bridge.showBanner).toHaveBeenCalledWith(
      "Hazard reported: Gravel",
      "success",
    );
  });

  it("drops a head-unit report silently when hazard_reporting is killed (no POST, no false success banner)", async () => {
    (isFeatureKillSwitchActive as jest.Mock).mockReturnValue(false);
    controller.sync(makeSnapshot());

    const ok = await controller.submitSearchQuery("Loose gravel ahead");

    expect(ok).toBe(false);
    // No report POSTed, and crucially NO "Hazard reported" banner — a bare
    // callback no-op would still have shown the success confirmation.
    expect(reports).toEqual([]);
    expect(bridge.showBanner).not.toHaveBeenCalled();
    // The search UI is still dismissed so the head unit returns to nav.
    expect(bridge.closeSearch).toHaveBeenCalled();
  });

  it("submits a localized hazard label", async () => {
    const localizedController = new VehicleDisplayController({
      bridge,
      reportHazard: async (location, type) => {
        reports.push({ location, type });
      },
      translate: (key) => (key === "Pothole" ? "Výtluk" : key),
    });
    localizedController.sync(makeSnapshot());

    const ok = await localizedController.submitSearchQuery("výtluk");

    expect(ok).toBe(true);
    expect(reports).toEqual([
      {
        location: { lat: 49.55, lng: 18.15 },
        type: "pothole",
      },
    ]);
  });

  it("uses the regional locale when matching a spoken hazard query", async () => {
    setActiveFormatContext({
      locale: "tr",
      timeZone: "Europe/Istanbul",
      units: "metric",
    });
    controller.sync(makeSnapshot());
    controller.handleSearchTextChange("İCY");

    const ok = await controller.submitSearchQuery("İCY");

    expect(bridge.updateSearch).toHaveBeenCalledWith([
      expect.objectContaining({ id: "ice" }),
    ]);
    expect(ok).toBe(true);
    expect(reports).toEqual([
      {
        location: { lat: 49.55, lng: 18.15 },
        type: "ice",
      },
    ]);
  });

  it("refuses to report when there is no live location fix", async () => {
    controller.sync(makeSnapshot({ currentLocation: null }));

    const ok = await controller.submitSearchQuery("pothole");

    expect(ok).toBe(false);
    expect(reports).toEqual([]);
    expect(bridge.showBanner).toHaveBeenCalledWith(
      "Waiting for GPS before reporting a hazard.",
      "danger",
    );
  });

  it("lets the rider choose a suggestion row after search refinement", async () => {
    controller.sync(makeSnapshot());
    controller.handleTemplateAction("report-hazard");
    controller.handleSearchTextChange("oil");

    await controller.selectSearchItem(0);

    expect(reports).toEqual([
      {
        location: { lat: 49.55, lng: 18.15 },
        type: "oil_spill",
      },
    ]);
  });

  it("tears down search + nav surfaces on stop", () => {
    controller.sync(makeSnapshot());
    controller.handleTemplateAction("report-hazard");

    controller.stop();

    expect(bridge.closeSearch).toHaveBeenCalledTimes(1);
    expect(bridge.unmountNavigation).toHaveBeenCalledTimes(1);
  });
});

describe("formatNavDistanceMeters", () => {
  it("rounds to 10 m granularity below 1 km", () => {
    expect(formatNavDistanceMeters(0)).toBe("0 m");
    expect(formatNavDistanceMeters(7)).toBe("10 m");
    expect(formatNavDistanceMeters(324)).toBe("320 m");
    expect(formatNavDistanceMeters(326)).toBe("330 m");
  });

  it("renders one-decimal kilometres at and above 1 km", () => {
    expect(formatNavDistanceMeters(1000)).toBe("1 km");
    expect(formatNavDistanceMeters(1500)).toBe("1.5 km");
    expect(formatNavDistanceMeters(12345)).toBe("12.4 km");
  });

  it("never produces '1000 m' on the boundary (995–999 m → 1.0 km)", () => {
    // Without the post-round threshold check, Math.round(995/10)*10
    // would render "1000 m", then snap back to "990 m" on the next
    // tick — a backwards-looking flicker at a glance from the bike.
    expect(formatNavDistanceMeters(995)).toBe("1 km");
    expect(formatNavDistanceMeters(999)).toBe("1 km");
  });

  it("collapses non-finite / negative inputs to '0 m'", () => {
    expect(formatNavDistanceMeters(-5)).toBe("0 m");
    expect(formatNavDistanceMeters(NaN)).toBe("0 m");
    expect(formatNavDistanceMeters(Infinity)).toBe("0 m");
  });
});

describe("formatNextManeuverRow", () => {
  it("renders the upcoming maneuver as 'Verb in distance' with the road name on the detail line", () => {
    expect(
      formatNextManeuverRow(
        makeSnapshot({
          distanceToNextM: 320,
          nextManeuver: { type: "turn-right", roadName: "B500" },
        }),
      ),
    ).toEqual({ title: "Turn right in 320 m", detail: "onto B500" });
  });

  it("falls back to the trip title when the maneuver has no road name", () => {
    expect(
      formatNextManeuverRow(
        makeSnapshot({
          title: "Sunday Alps",
          distanceToNextM: 1500,
          nextManeuver: { type: "turn-left" },
        }),
      ),
    ).toEqual({ title: "Turn left in 1.5 km", detail: "Sunday Alps" });
  });

  it("collapses to 'Continue' when there is no upcoming maneuver", () => {
    expect(
      formatNextManeuverRow(
        makeSnapshot({ nextManeuver: null, title: "Sunday Alps" }),
      ),
    ).toEqual({ title: "Continue", detail: "Sunday Alps" });
  });

  it("surfaces off-route state ahead of the maneuver row", () => {
    expect(
      formatNextManeuverRow(
        makeSnapshot({
          offRoute: true,
          offRouteDistanceM: 230,
          nextManeuver: { type: "turn-right", roadName: "B500" },
        }),
      ),
    ).toEqual({ title: "Off route", detail: "230 m from path" });
  });
});

describe("buildNavigationPaneItems", () => {
  it("emits exactly four rows in maneuver/speed/distance/duration order", () => {
    // Android Auto's MapTemplate caps the pane at 4 rows. Adding a
    // fifth would silently drop on the host, so we lock the count
    // here to catch accidental regressions.
    const items = buildNavigationPaneItems(makeSnapshot());
    expect(items).toHaveLength(4);
    expect(items.map((item) => item.title)).toEqual([
      "Turn right in 320 m",
      "Speed",
      "Distance",
      "Duration",
    ]);
  });

  it("threads ride stats through their formatters", () => {
    const items = buildNavigationPaneItems(
      makeSnapshot({
        rideStats: {
          rideType: "trip",
          speedKmh: 0,
          distanceKm: 0,
          durationSeconds: 0,
        },
      }),
    );
    expect(items.find((item) => item.title === "Speed")?.detail).toBe("—");
    expect(items.find((item) => item.title === "Distance")?.detail).toBe(
      "0 km",
    );
    expect(items.find((item) => item.title === "Duration")?.detail).toBe(
      "0:00",
    );
  });
});

describe("vehicle display runtime bridge", () => {
  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  it("removes CarPlay emitter subscriptions when navigation stops", () => {
    const removeFns: jest.Mock[] = [];

    jest.isolateModules(() => {
      jest.doMock("react-native", () => ({
        Platform: { OS: "ios" },
      }));
      jest.doMock("react-native-carplay", () => {
        const addListener = jest.fn((_event: string, _handler: unknown) => {
          const remove = jest.fn();
          removeFns.push(remove);
          return { remove };
        });

        return {
          CarPlay: {
            connected: true,
            emitter: { addListener },
            setRootTemplate: jest.fn(),
            pushTemplate: jest.fn(),
            popTemplate: jest.fn(),
            bridge: {
              reactToUpdatedSearchText: jest.fn(),
              reactToSelectedResult: jest.fn(),
            },
          },
          MapTemplate: class {
            config: unknown;
            constructor(config: unknown) {
              this.config = config;
            }
            updateConfig(config: unknown) {
              this.config = config;
            }
          },
          SearchTemplate: class {
            constructor(_: unknown) {}
            updateTemplate(_: unknown) {}
          },
          InformationTemplate: class {
            constructor(_: unknown) {}
          },
        };
      });
      jest.doMock("../carplay", () => ({
        formatSpeedKmh: (kmh: number) =>
          Number.isFinite(kmh) && kmh >= 1 ? `${Math.round(kmh)} km/h` : "—",
        formatDistanceKm: (km: number) =>
          Number.isFinite(km) && km > 0 ? `${km.toFixed(1)} km` : "0.0 km",
        mountRideStatusBoard: jest.fn(),
        resumeRideStatusBoard: jest.fn(),
        suspendRideStatusBoard: jest.fn(),
      }));
      jest.doMock("@/components/VehicleDisplaySurface", () => "VehicleDisplay");

      const { syncVehicleNavigationDisplay, stopVehicleNavigationDisplay } =
        require("../vehicleDisplay") as typeof import("../vehicleDisplay");

      syncVehicleNavigationDisplay(makeSnapshot(), makeReportHazardMock());
      stopVehicleNavigationDisplay();
    });

    expect(removeFns).toHaveLength(5);
    for (const remove of removeFns) {
      expect(remove).toHaveBeenCalledTimes(1);
    }
  });

  it("restores the ride-status board on nav stop ONLY when a ride is active", () => {
    const mountBoard = jest.fn();
    const resumeBoard = jest.fn();

    jest.isolateModules(() => {
      jest.doMock("react-native", () => ({
        Platform: { OS: "ios" },
      }));
      jest.doMock("react-native-carplay", () => ({
        CarPlay: {
          connected: true,
          emitter: { addListener: () => ({ remove: jest.fn() }) },
          setRootTemplate: jest.fn(),
          pushTemplate: jest.fn(),
          popTemplate: jest.fn(),
          bridge: {
            reactToUpdatedSearchText: jest.fn(),
            reactToSelectedResult: jest.fn(),
          },
        },
        MapTemplate: class {
          constructor(_: unknown) {}
          updateConfig(_: unknown) {}
        },
        SearchTemplate: class {
          constructor(_: unknown) {}
          updateTemplate(_: unknown) {}
        },
        InformationTemplate: class {
          constructor(_: unknown) {}
        },
      }));
      jest.doMock("../carplay", () => ({
        formatSpeedKmh: (kmh: number) => `${Math.round(kmh)} km/h`,
        formatDistanceKm: (km: number) => `${km.toFixed(1)} km`,
        mountRideStatusBoard: mountBoard,
        resumeRideStatusBoard: resumeBoard,
        suspendRideStatusBoard: jest.fn(),
      }));
      jest.doMock("@/components/VehicleDisplaySurface", () => "VehicleDisplay");

      const { useRideStore } = require("@/stores") as typeof import("@/stores");
      const { syncVehicleNavigationDisplay, stopVehicleNavigationDisplay } =
        require("../vehicleDisplay") as typeof import("../vehicleDisplay");

      // Not riding (e.g. previewing a commute alternative) → the soft stop must
      // NOT resurrect a bogus ride board from the nav snapshot.
      useRideStore.setState({ isRiding: false });
      syncVehicleNavigationDisplay(makeSnapshot(), makeReportHazardMock());
      stopVehicleNavigationDisplay();
      expect(mountBoard).not.toHaveBeenCalled();
      // ...but the ride-board suspension MUST still be lifted, or a ride
      // started later this session could never mount its board.
      expect(resumeBoard).toHaveBeenCalled();

      // Riding → turn-by-turn off falls back to the live ride board.
      useRideStore.setState({ isRiding: true });
      syncVehicleNavigationDisplay(makeSnapshot(), makeReportHazardMock());
      stopVehicleNavigationDisplay();
      expect(mountBoard).toHaveBeenCalledTimes(1);
    });
  });

  it("pushes the next-maneuver pane to the Android map template via updateConfig", () => {
    // Android Auto path: the bridge synthesises a Pane from the
    // navigation snapshot and pushes it through the package's
    // `updateConfig` so the head unit shows the next maneuver and
    // ride stats natively. iOS skips this path because the
    // React-component map surface re-renders from the store.
    const updateConfig = jest.fn();
    let lastMapConfig: { id?: string; pane?: unknown } | null = null;

    jest.isolateModules(() => {
      jest.doMock("react-native", () => ({
        Platform: { OS: "android" },
      }));
      jest.doMock("react-native-carplay", () => {
        const addListener = jest.fn(() => ({ remove: jest.fn() }));
        return {
          CarPlay: {
            connected: true,
            emitter: { addListener },
            setRootTemplate: jest.fn(),
            pushTemplate: jest.fn(),
            popTemplate: jest.fn(),
            bridge: {
              reactToUpdatedSearchText: jest.fn(),
              reactToSelectedResult: jest.fn(),
            },
          },
          MapTemplate: class {
            config: unknown;
            constructor(config: { id?: string }) {
              this.config = config;
              lastMapConfig = config;
            }
            updateConfig = (config: { id?: string; pane?: unknown }) => {
              this.config = config;
              lastMapConfig = config;
              updateConfig(config);
            };
          },
          SearchTemplate: class {
            constructor(_: unknown) {}
            updateTemplate(_: unknown) {}
          },
          InformationTemplate: class {
            constructor(_: unknown) {}
          },
          // PaneTemplate is the Android-Auto idle fallback root — the
          // bridge reaches for it when navigation tears down without a
          // live ride snapshot to fall back to. Must be present in the
          // Android test mock or the bridge crashes.
          PaneTemplate: class {
            constructor(_: unknown) {}
          },
        };
      });
      jest.doMock("../carplay", () => ({
        formatSpeedKmh: (kmh: number) =>
          Number.isFinite(kmh) && kmh >= 1 ? `${Math.round(kmh)} km/h` : "—",
        formatDistanceKm: (km: number) =>
          Number.isFinite(km) && km > 0 ? `${km.toFixed(1)} km` : "0.0 km",
        mountRideStatusBoard: jest.fn(),
        resumeRideStatusBoard: jest.fn(),
        suspendRideStatusBoard: jest.fn(),
      }));
      jest.doMock("@/components/VehicleDisplaySurface", () => "VehicleDisplay");

      const { syncVehicleNavigationDisplay, stopVehicleNavigationDisplay } =
        require("../vehicleDisplay") as typeof import("../vehicleDisplay");

      syncVehicleNavigationDisplay(
        makeSnapshot({
          distanceToNextM: 320,
          nextManeuver: { type: "turn-right", roadName: "B500" },
        }),
        makeReportHazardMock(),
      );

      // Same snapshot should be diff-skipped to respect AA's host
      // rate-limit on template updates.
      syncVehicleNavigationDisplay(
        makeSnapshot({
          distanceToNextM: 320,
          nextManeuver: { type: "turn-right", roadName: "B500" },
        }),
        makeReportHazardMock(),
      );

      // A real change (closer to the maneuver) should refresh.
      syncVehicleNavigationDisplay(
        makeSnapshot({
          distanceToNextM: 150,
          nextManeuver: { type: "turn-right", roadName: "B500" },
        }),
        makeReportHazardMock(),
      );

      stopVehicleNavigationDisplay();
    });

    expect(updateConfig).toHaveBeenCalledTimes(2);
    const lastCall = updateConfig.mock.calls.at(-1)?.[0] as {
      pane: { items: Array<{ id: string; text: string; detailText: string }> };
    };
    expect(lastCall.pane.items[0]).toEqual({
      id: "nav-row-0",
      text: "Turn right in 150 m",
      detailText: "onto B500",
    });
    expect(lastCall.pane.items.map((row) => row.text)).toEqual([
      "Turn right in 150 m",
      "Speed",
      "Distance",
      "Duration",
    ]);
    expect(lastMapConfig).not.toBeNull();
  });

  it("does not push native pane updates on iOS (the React surface re-renders from the store)", () => {
    const updateConfig = jest.fn();

    jest.isolateModules(() => {
      jest.doMock("react-native", () => ({
        Platform: { OS: "ios" },
      }));
      jest.doMock("react-native-carplay", () => {
        const addListener = jest.fn(() => ({ remove: jest.fn() }));
        return {
          CarPlay: {
            connected: true,
            emitter: { addListener },
            setRootTemplate: jest.fn(),
            pushTemplate: jest.fn(),
            popTemplate: jest.fn(),
            bridge: {
              reactToUpdatedSearchText: jest.fn(),
              reactToSelectedResult: jest.fn(),
            },
          },
          MapTemplate: class {
            config: unknown;
            constructor(config: unknown) {
              this.config = config;
            }
            updateConfig = (config: unknown) => {
              this.config = config;
              updateConfig(config);
            };
          },
          SearchTemplate: class {
            constructor(_: unknown) {}
            updateTemplate(_: unknown) {}
          },
          InformationTemplate: class {
            constructor(_: unknown) {}
          },
        };
      });
      jest.doMock("../carplay", () => ({
        formatSpeedKmh: (kmh: number) =>
          Number.isFinite(kmh) && kmh >= 1 ? `${Math.round(kmh)} km/h` : "—",
        formatDistanceKm: (km: number) =>
          Number.isFinite(km) && km > 0 ? `${km.toFixed(1)} km` : "0.0 km",
        mountRideStatusBoard: jest.fn(),
        resumeRideStatusBoard: jest.fn(),
        suspendRideStatusBoard: jest.fn(),
      }));
      jest.doMock("@/components/VehicleDisplaySurface", () => "VehicleDisplay");

      const { syncVehicleNavigationDisplay, stopVehicleNavigationDisplay } =
        require("../vehicleDisplay") as typeof import("../vehicleDisplay");

      syncVehicleNavigationDisplay(makeSnapshot(), makeReportHazardMock());
      syncVehicleNavigationDisplay(
        makeSnapshot({ distanceToNextM: 220 }),
        makeReportHazardMock(),
      );
      stopVehicleNavigationDisplay();
    });

    expect(updateConfig).not.toHaveBeenCalled();
  });
});

describe("showVehicleDisplayBanner", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("resets the dismissal timer when a newer banner is shown", () => {
    const setBanner = jest.fn();
    const getState = jest.fn(() => ({ setBanner }));

    jest.isolateModules(() => {
      jest.doMock("@/stores/vehicleDisplay", () => ({
        useVehicleDisplayStore: { getState },
      }));

      const { showVehicleDisplayBanner: showBanner } =
        require("../vehicleDisplay") as typeof import("../vehicleDisplay");

      showBanner("First", "success");
      jest.advanceTimersByTime(2000);
      showBanner("Second", "danger");
      jest.advanceTimersByTime(2999);
      expect(setBanner).toHaveBeenCalledTimes(2);

      jest.advanceTimersByTime(1);
    });

    expect(setBanner.mock.calls).toEqual([
      [{ message: "First", tone: "success" }],
      [{ message: "Second", tone: "danger" }],
      [null],
    ]);
  });
});
