import type { Map as MapLibreMap } from "maplibre-gl";
import type { Poi } from "@/lib/planner/types";
import {
  ensurePoiLayers,
  poisToFeatureCollection,
  setPoiSourceData,
  POI_SOURCE,
  POI_PIN_LAYER,
  POI_CLUSTER_LAYER,
  POI_CLUSTER_COUNT_LAYER,
} from "./PoiPinLayer";

function poi(over: Partial<Poi> = {}): Poi {
  return {
    id: "p1",
    category: "fuel",
    source: "osm",
    name: "Shell",
    lat: 49.1,
    lng: 14.5,
    ...over,
  };
}

describe("poisToFeatureCollection", () => {
  it("maps each POI to a Point feature carrying id/category/name/source", () => {
    const fc = poisToFeatureCollection([
      poi(),
      poi({
        id: "p2",
        category: "cafe",
        source: "fsq",
        name: "Bean",
        lat: 50,
        lng: 15,
      }),
    ]);
    expect(fc.type).toBe("FeatureCollection");
    expect(fc.features).toHaveLength(2);
    expect(fc.features[0]).toMatchObject({
      type: "Feature",
      geometry: { type: "Point", coordinates: [14.5, 49.1] },
      properties: {
        poiId: "p1",
        category: "fuel",
        name: "Shell",
        source: "osm",
      },
    });
    expect(fc.features[1]?.properties).toEqual({
      poiId: "p2",
      category: "cafe",
      name: "Bean",
      source: "fsq",
    });
  });

  it("returns an empty collection for no POIs", () => {
    expect(poisToFeatureCollection([]).features).toEqual([]);
  });
});

function mapStub() {
  const layers = new Set<string>();
  const sources = new Set<string>();
  const addLayer = vi.fn((spec: { id: string }, _beforeId?: string) =>
    layers.add(spec.id),
  );
  const addSource = vi.fn((id: string) => sources.add(id));
  const setData = vi.fn();
  const map = {
    hasImage: vi.fn(() => true), // skip async image rasterization in jsdom
    addImage: vi.fn(),
    getLayer: vi.fn((id: string) => (layers.has(id) ? { id } : undefined)),
    getSource: vi.fn((id: string) =>
      sources.has(id) ? { setData } : undefined,
    ),
    addLayer,
    addSource,
  } as unknown as MapLibreMap;
  return { map, addLayer, addSource, setData };
}

describe("ensurePoiLayers", () => {
  it("registers the clustered source + cluster/count/pin layers", () => {
    const { map, addLayer, addSource } = mapStub();
    ensurePoiLayers(map);
    expect(addSource).toHaveBeenCalledWith(
      POI_SOURCE,
      expect.objectContaining({ type: "geojson", cluster: true }),
    );
    const layerIds = addLayer.mock.calls.map((c) => c[0].id);
    expect(layerIds).toEqual([
      POI_CLUSTER_LAYER,
      POI_CLUSTER_COUNT_LAYER,
      POI_PIN_LAYER,
    ]);
  });

  it("is idempotent — a second call adds nothing", () => {
    const { map, addLayer, addSource } = mapStub();
    ensurePoiLayers(map);
    addLayer.mockClear();
    addSource.mockClear();
    ensurePoiLayers(map);
    expect(addSource).not.toHaveBeenCalled();
    expect(addLayer).not.toHaveBeenCalled();
  });

  it("slots layers before `beforeId` when that layer exists", () => {
    const { map, addLayer } = mapStub();
    map.addLayer({ id: "route-pins" } as never);
    addLayer.mockClear();
    ensurePoiLayers(map, "route-pins");
    for (const call of addLayer.mock.calls) {
      expect(call[1]).toBe("route-pins");
    }
  });
});

describe("setPoiSourceData", () => {
  it("pushes the feature collection onto the source", () => {
    const { map, setData } = mapStub();
    ensurePoiLayers(map);
    setPoiSourceData(map, [poi()]);
    expect(setData).toHaveBeenCalledWith(
      expect.objectContaining({ type: "FeatureCollection" }),
    );
  });
});
