import type { LatLng, HazardType } from "@/types";
import {
  VehicleDisplayController,
  buildHazardSearchItems,
  matchHazardTypeFromText,
  type VehicleDisplayBridge,
  type VehicleNavigationSnapshot,
} from "../vehicleDisplay";

class FakeBridge implements VehicleDisplayBridge {
  mountNavigation = jest.fn();
  unmountNavigation = jest.fn();
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

  it("opens the hazard search when the report action is pressed", () => {
    controller.sync(makeSnapshot());
    controller.handleTemplateAction("report-hazard");

    expect(bridge.openSearch).toHaveBeenCalledTimes(1);
    const items = bridge.openSearch.mock.calls[0]?.[0] as Array<{ id: string }>;
    expect(items[0]?.id).toBe("pothole");
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
