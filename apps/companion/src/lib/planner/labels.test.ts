import { describe, expect, it, vi } from "vitest";
import type { Translate } from "@/i18n";
import {
  hasCustomWaypointName,
  isLegacyGeneratedWaypointName,
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
      "xx:Unnamed",
    );
    expect(
      poiDisplayName({ category: "fuel", name: "Shell" }, translated),
    ).toBe("Shell");
  });
});
