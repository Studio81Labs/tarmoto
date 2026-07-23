import { describe, expect, it, vi } from "vitest";
import { PLANNER_POI_CATEGORIES } from "@tarmoto/shared";
import type { Translate } from "@/i18n";
import {
  dayPlanBoundaryDisplayName,
  hasCustomWaypointName,
  isLegacyGeneratedWaypointName,
  poiCategoryDisplayName,
  poiDisplayName,
  waypointDisplayName,
} from "./labels";

const translated = vi.fn<Translate>((key) => `xx:${key}`);

describe("planner display labels", () => {
  it("keeps generated waypoint roles semantic and translates them at display", () => {
    expect(
      waypointDisplayName({ type: "start", name: undefined }, translated),
    ).toBe("xx:Start");
    expect(
      waypointDisplayName({ type: "via", name: "Via 2" }, translated),
    ).toBe("xx:Via");
    expect(
      waypointDisplayName(
        {
          type: "via",
          name: undefined,
          poiCategory: "twisty_highlight",
        },
        translated,
      ),
    ).toBe("xx:Twisty highlight");
    expect(waypointDisplayName({ type: "end", name: "Brno" }, translated)).toBe(
      "Brno",
    );
  });

  it("preserves source-owned labels even when they match legacy roles", () => {
    expect(
      waypointDisplayName(
        { type: "start", name: "Start", nameIsSource: true },
        translated,
      ),
    ).toBe("Start");
    expect(
      waypointDisplayName(
        { type: "via", name: "Via 1", poiCategory: "viewpoint" },
        translated,
      ),
    ).toBe("Via 1");
    expect(hasCustomWaypointName("End", true)).toBe(true);
  });

  it("renders semantic day-plan boundaries without treating fallback copy as data", () => {
    expect(
      dayPlanBoundaryDisplayName(
        "",
        undefined,
        "biker_hotel",
        "end",
        translated,
      ),
    ).toBe("xx:Biker hotel");
    expect(
      dayPlanBoundaryDisplayName(
        "250 km",
        undefined,
        undefined,
        "end",
        translated,
      ),
    ).toBe("250 km");
    expect(
      dayPlanBoundaryDisplayName("Start", true, undefined, "end", translated),
    ).toBe("Start");
  });

  it("recognizes only legacy generated names as migration sentinels", () => {
    expect(isLegacyGeneratedWaypointName("Start")).toBe(true);
    expect(isLegacyGeneratedWaypointName("End")).toBe(true);
    expect(isLegacyGeneratedWaypointName("Reroute via")).toBe(true);
    expect(hasCustomWaypointName("Praha")).toBe(true);
    expect(hasCustomWaypointName("Finish")).toBe(false);
  });

  it("catalogs source-owned POI fallbacks while preserving proper names", () => {
    expect(
      poiDisplayName({ category: "twisty_highlight", name: "" }, translated),
    ).toBe("xx:Twisty highlight");
    expect(poiDisplayName({ category: "fuel", name: "" }, translated)).toBe(
      "xx:Fuel",
    );
    expect(
      poiDisplayName({ category: "fuel", name: "Shell" }, translated),
    ).toBe("Shell");
  });

  it("catalogs every persisted semantic POI category", () => {
    expect(
      PLANNER_POI_CATEGORIES.map((category) =>
        poiCategoryDisplayName(category, translated),
      ),
    ).toEqual([
      "xx:Fuel",
      "xx:Food & drinks",
      "xx:Cafe",
      "xx:Viewpoint",
      "xx:Campground",
      "xx:Biker hotel",
      "xx:Mountain pass",
      "xx:Twisty highlight",
    ]);
  });
});
