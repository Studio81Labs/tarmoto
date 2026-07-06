import { describe, expect, it, vi } from "vitest";
import { mockPoisByCategories } from "../mocks/pois";
import { plannerApi } from "../api";
import { poiApi } from "@/lib/api";

vi.mock("@/lib/api", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/api")>()),
  poiApi: {
    getInBbox: vi.fn(),
    getAlongRoute: vi.fn(),
    getAccommodations: vi.fn(),
  },
}));

const getInBboxMock = vi.mocked(poiApi.getInBbox);

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

  it("keeps mountain_pass / twisty_highlight on their non-OSM source", async () => {
    // These two categories are not in the `pois` store, so the store call is
    // skipped entirely and they still come from their own source.
    const pois = await plannerApi.getPoisByCategories(BESKYDY_BBOX, [
      "mountain_pass",
      "twisty_highlight",
    ]);
    expect(pois.length).toBeGreaterThan(0);
    expect(pois.some((p) => p.meta?.twistyScore !== undefined)).toBe(true);
    expect(getInBboxMock).not.toHaveBeenCalled();
  });

  it("reads OSM categories from the store via /poi/in-bbox and maps kinds back", async () => {
    getInBboxMock.mockResolvedValue({
      data: {
        count: 2,
        pois: [
          {
            id: "a",
            source: "osm",
            external_id: "osm:node:1",
            name: "Shell",
            kind: "fuel_station",
            lat: 49.5,
            lng: 18.4,
            website: null,
            phone: null,
            opening_hours: null,
            address_street: null,
            address_city: "Frýdek",
            address_postcode: null,
            address_country: "CZ",
            cuisine: null,
            brand: "Shell",
            stars: null,
            osm_url: "https://www.openstreetmap.org/node/1",
            last_imported_at: "2026-07-06T00:00:00.000Z",
          },
          {
            id: "b",
            source: "osm",
            external_id: "osm:node:2",
            name: "Koliba",
            kind: "restaurant",
            lat: 49.6,
            lng: 18.5,
            website: null,
            phone: null,
            opening_hours: null,
            address_street: null,
            address_city: "Rožnov",
            address_postcode: null,
            address_country: "CZ",
            cuisine: "regional",
            brand: null,
            stars: null,
            osm_url: "https://www.openstreetmap.org/node/2",
            last_imported_at: "2026-07-06T00:00:00.000Z",
          },
        ],
      },
    });

    const pois = await plannerApi.getPoisByCategories(BESKYDY_BBOX, [
      "fuel",
      "food",
    ]);

    // Called with the bbox corners + the store kinds mapped from the categories.
    expect(getInBboxMock).toHaveBeenCalledWith(
      expect.objectContaining({
        minLng: 18.0,
        minLat: 49.35,
        maxLng: 18.9,
        maxLat: 49.65,
        kinds: expect.arrayContaining([
          "fuel_station",
          "restaurant",
          "fast_food",
          "ice_cream",
        ]),
      }),
      undefined,
    );
    // Store kinds map back to the companion categories; source is osm.
    expect(pois.map((p) => p.category).sort()).toEqual(["food", "fuel"]);
    expect(pois.every((p) => p.source === "osm")).toBe(true);
    expect(pois.find((p) => p.category === "fuel")?.meta?.brand).toBe("Shell");
  });
});
