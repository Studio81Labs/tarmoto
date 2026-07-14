import type { Map as MapLibreMap } from "maplibre-gl";
import type { FeatureCollection } from "geojson";
import type { PlannerClosure } from "@/lib/closures-summary";
import type { MountainPass } from "@/lib/passes-summary";
import {
  ensureConditionLayers,
  setConditionSourceData,
  CLOSURE_LINE_SOURCE,
  CLOSURE_MARKER_SOURCE,
  PASS_MARKER_SOURCE,
  PASS_MARKER_LAYER,
} from "./ConditionMarkerLayer";

function closure(over: Partial<PlannerClosure> = {}): PlannerClosure {
  return {
    id: "c1",
    title: "Bridge works",
    reason: "roadworks",
    severity: "partial",
    geometry: [
      { lat: 49, lng: 14 },
      { lat: 49.1, lng: 14.1 },
    ],
    detour: null,
    country_code: "CZ",
    region: null,
    starts_at: null,
    ends_at: null,
    notes: null,
    ...over,
  } as unknown as PlannerClosure;
}

function pass(over: Partial<MountainPass> = {}): MountainPass {
  return {
    id: "p1",
    name: "Grimsel",
    country_code: "CH",
    region: null,
    lat: 46.5,
    lng: 8.3,
    elevation_m: 2164,
    status: "closed",
    ...over,
  } as unknown as MountainPass;
}

/** Fake map recording the last `setData` per source id. */
function fakeMap() {
  const setData: Record<string, FeatureCollection> = {};
  const sources: Record<string, { setData: (fc: FeatureCollection) => void }> =
    {};
  for (const id of [
    CLOSURE_LINE_SOURCE,
    CLOSURE_MARKER_SOURCE,
    PASS_MARKER_SOURCE,
  ]) {
    sources[id] = {
      setData: (fc: FeatureCollection) => {
        setData[id] = fc;
      },
    };
  }
  const map = {
    getSource: (id: string) => sources[id],
  } as unknown as MapLibreMap;
  return { map, setData };
}

describe("setConditionSourceData", () => {
  it("projects closures into the line + marker sources and passes into the pass source", () => {
    const { map, setData } = fakeMap();

    setConditionSourceData(map, {
      closures: [closure()],
      passes: [pass()],
    });

    // Closure line: one LineString across the closure's geometry.
    const line = setData[CLOSURE_LINE_SOURCE]!;
    expect(line.features).toHaveLength(1);
    expect(line.features[0]!.geometry.type).toBe("LineString");

    // Closure marker: a Point at the first geometry vertex, carrying severity/reason.
    const marker = setData[CLOSURE_MARKER_SOURCE]!;
    expect(marker.features).toHaveLength(1);
    expect(marker.features[0]!.geometry).toEqual({
      type: "Point",
      coordinates: [14, 49],
    });
    expect(marker.features[0]!.properties).toMatchObject({
      id: "c1",
      severity: "partial",
      reason: "roadworks",
    });

    // Pass marker: a Point at the pass with its status (drives the open/closed filter).
    const passSrc = setData[PASS_MARKER_SOURCE]!;
    expect(passSrc.features).toHaveLength(1);
    expect(passSrc.features[0]!.properties).toMatchObject({
      id: "p1",
      status: "closed",
    });
  });

  it("drops a single-vertex closure from the line source but keeps its marker", () => {
    const { map, setData } = fakeMap();

    setConditionSourceData(map, {
      closures: [closure({ geometry: [{ lat: 49, lng: 14 }] })],
      passes: [],
    });

    expect(setData[CLOSURE_LINE_SOURCE]!.features).toHaveLength(0);
    expect(setData[CLOSURE_MARKER_SOURCE]!.features).toHaveLength(1);
  });

  it("no-ops for a source that isn't on the map yet", () => {
    const map = { getSource: () => undefined } as unknown as MapLibreMap;
    expect(() =>
      setConditionSourceData(map, { closures: [closure()], passes: [pass()] }),
    ).not.toThrow();
  });
});

/** Fake map that records the layer spec passed to each `addLayer` by id. */
function layerCapturingMap() {
  const layers: Record<string, { filter?: unknown }> = {};
  const map = {
    hasImage: () => true, // skip the sprite install entirely
    addImage: () => {},
    getSource: () => undefined, // force addSource for every source
    addSource: () => {},
    getLayer: () => undefined, // force addLayer for every layer
    addLayer: (spec: { id: string; filter?: unknown }) => {
      layers[spec.id] = spec;
    },
  } as unknown as MapLibreMap;
  return { map, layers };
}

describe("ensureConditionLayers pass filter", () => {
  it("hides open passes by default (ambient-awareness view)", () => {
    const { map, layers } = layerCapturingMap();

    ensureConditionLayers(map);

    expect(layers[PASS_MARKER_LAYER]!.filter).toEqual([
      "!=",
      ["get", "status"],
      "open",
    ]);
  });

  it("includes open passes when opted in (/explore markers every pass)", () => {
    const { map, layers } = layerCapturingMap();

    ensureConditionLayers(map, undefined, { includeOpenPasses: true });

    expect(layers[PASS_MARKER_LAYER]!.filter).toBeUndefined();
  });
});
