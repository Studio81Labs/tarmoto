import { describe, expect, it } from "vitest";
import { mockPoisByCategories } from "../mocks/pois";
import { plannerApi } from "../api";

// Czech Republic-ish bbox: [west, south, east, north]
const CZ_BBOX: [number, number, number, number] = [12.0, 48.5, 19.0, 51.1];
const BESKYDY_BBOX: [number, number, number, number] = [
  18.0, 49.35, 18.9, 49.65,
];

describe("mockPoisByCategories (revision 4 §B)", () => {
  it("filters by category and bbox", () => {
    const fuel = mockPoisByCategories(BESKYDY_BBOX, ["fuel"]);
    expect(fuel.length).toBeGreaterThan(0);
    expect(fuel.every((p) => p.category === "fuel")).toBe(true);
    expect(
      fuel.every(
        (p) =>
          p.lng >= BESKYDY_BBOX[0] &&
          p.lng <= BESKYDY_BBOX[2] &&
          p.lat >= BESKYDY_BBOX[1] &&
          p.lat <= BESKYDY_BBOX[3],
      ),
    ).toBe(true);
  });

  it("is multi-category: several categories return their pins together", () => {
    const mixed = mockPoisByCategories(CZ_BBOX, ["fuel", "viewpoint", "cafe"]);
    const categories = new Set(mixed.map((p) => p.category));
    expect(categories).toEqual(new Set(["fuel", "viewpoint", "cafe"]));
  });

  it("covers all three sources behind the one resolver", () => {
    const all = mockPoisByCategories(CZ_BBOX, [
      "fuel",
      "food",
      "cafe",
      "viewpoint",
      "campground",
      "biker_hotel",
      "mountain_pass",
      "twisty_highlight",
    ]);
    const sources = new Set(all.map((p) => p.source));
    expect(sources).toEqual(new Set(["osm", "passes", "tarmoto"]));
    // Category→source mapping honoured (§B).
    for (const poi of all) {
      if (poi.category === "mountain_pass") expect(poi.source).toBe("passes");
      else if (poi.category === "twisty_highlight")
        expect(poi.source).toBe("tarmoto");
      else expect(poi.source).toBe("osm");
    }
  });

  it("returns nothing for an empty category selection", () => {
    expect(mockPoisByCategories(CZ_BBOX, [])).toEqual([]);
  });

  it("is exposed through plannerApi.getPoisByCategories", async () => {
    const pois = await plannerApi.getPoisByCategories(BESKYDY_BBOX, [
      "mountain_pass",
      "twisty_highlight",
    ]);
    expect(pois.length).toBeGreaterThan(0);
    expect(pois.some((p) => p.meta?.twistyScore !== undefined)).toBe(true);
  });
});
