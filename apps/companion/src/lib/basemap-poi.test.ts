import type { Map as MapLibreMap, MapGeoJSONFeature } from "maplibre-gl";
import {
  basemapPlaceCategoryLabel,
  basemapPlaceMapsUrl,
  getBasemapPoiLayerIds,
  readBasemapPlace,
  topBasemapPlaceAt,
} from "./basemap-poi";

function poiFeature(
  props: Record<string, unknown>,
  coords: [number, number] = [16.6, 49.2],
  geometryType: "Point" | "LineString" = "Point",
): MapGeoJSONFeature {
  return {
    geometry: { type: geometryType, coordinates: coords },
    properties: props,
    layer: { id: "poi_r7" },
  } as unknown as MapGeoJSONFeature;
}

describe("getBasemapPoiLayerIds", () => {
  it("returns only symbol layers backed by the OMT poi source-layer", () => {
    const map = {
      getStyle: () => ({
        layers: [
          { id: "poi_r1", type: "symbol", "source-layer": "poi" },
          { id: "poi_r7", type: "symbol", "source-layer": "poi" },
          { id: "roads", type: "line", "source-layer": "transportation" },
          { id: "poi_circles", type: "circle", "source-layer": "poi" },
          { id: "place_labels", type: "symbol", "source-layer": "place" },
        ],
      }),
    } as unknown as MapLibreMap;
    expect(getBasemapPoiLayerIds(map)).toEqual(["poi_r1", "poi_r7"]);
  });

  it("is safe when the style has no layers yet", () => {
    const map = { getStyle: () => undefined } as unknown as MapLibreMap;
    expect(getBasemapPoiLayerIds(map)).toEqual([]);
  });
});

describe("basemapPlaceCategoryLabel", () => {
  it("prefers a curated label for the subclass", () => {
    expect(basemapPlaceCategoryLabel("leisure", "picnic_site")).toBe(
      "Picnic area",
    );
    expect(basemapPlaceCategoryLabel("amenity", "waste_basket")).toBe(
      "Waste bin",
    );
  });

  it("falls back to a curated class label, then a title-cased subclass", () => {
    expect(basemapPlaceCategoryLabel("park", undefined)).toBe("Park");
    expect(basemapPlaceCategoryLabel("shop", "bike_repair_station")).toBe(
      "Bike Repair Station",
    );
  });

  it("degrades to a generic label when nothing is known", () => {
    expect(basemapPlaceCategoryLabel(undefined, undefined)).toBe("Place");
  });
});

describe("basemapPlaceMapsUrl", () => {
  it("searches by name and coordinates", () => {
    const url = basemapPlaceMapsUrl("Brněnská oblast", 49.2, 16.6);
    expect(url).toContain("google.com/maps/search/");
    expect(url).toContain(encodeURIComponent("Brněnská oblast 49.2,16.6"));
  });
});

describe("readBasemapPlace", () => {
  it("projects a named point feature", () => {
    const place = readBasemapPlace(
      poiFeature(
        { name: "Zbýšov", class: "railway", subclass: "station" },
        [16.6, 49.2],
      ),
    );
    expect(place).toEqual({
      name: "Zbýšov",
      category: "Station",
      categoryKey: "Station",
      lng: 16.6,
      lat: 49.2,
      mapsUrl: expect.stringContaining("google.com/maps"),
    });
  });

  it("leaves categoryKey null for an unrecognised subclass (title-cased fallback)", () => {
    const place = readBasemapPlace(
      poiFeature({ name: "Odd", subclass: "helipad" }),
    );
    expect(place).toMatchObject({ category: "Helipad", categoryKey: null });
  });

  it("projects an unnamed POI with an empty name (category becomes the title)", () => {
    const place = readBasemapPlace(
      poiFeature({ class: "amenity", subclass: "parking" }),
    );
    expect(place).toMatchObject({
      name: "",
      category: "Parking",
      categoryKey: "Parking",
    });
    // A whitespace-only name trims to empty too.
    expect(
      readBasemapPlace(poiFeature({ name: "   ", subclass: "bench" }))?.name,
    ).toBe("");
  });

  it("returns null for a non-point geometry", () => {
    expect(
      readBasemapPlace(
        poiFeature({ name: "Park" }, [16.6, 49.2], "LineString"),
      ),
    ).toBeNull();
  });
});

describe("topBasemapPlaceAt", () => {
  const point = { x: 10, y: 10 };

  it("returns the topmost place under the cursor", () => {
    const map = {
      getLayer: (id: string) => (id === "poi_r7" ? ({} as never) : undefined),
      queryRenderedFeatures: () => [
        poiFeature({ name: "Park", class: "leisure", subclass: "park" }),
        poiFeature({ name: "Below", class: "amenity" }),
      ],
    } as unknown as MapLibreMap;
    expect(topBasemapPlaceAt(map, point, ["poi_r7", "poi_missing"])?.name).toBe(
      "Park",
    );
  });

  it("returns null when no POI layer is present", () => {
    const map = {
      getLayer: () => undefined,
      queryRenderedFeatures: () => [],
    } as unknown as MapLibreMap;
    expect(topBasemapPlaceAt(map, point, ["poi_r7"])).toBeNull();
  });
});
