import type { StyleSpecification } from "maplibre-gl";
import {
  BASE_MAP_ATTRIBUTION,
  isCuratableBaseMap,
  OSM_ATTRIBUTION,
  loadCuratedMapStyle,
} from "./attribution";

const STYLE_URL = "https://tiles.example.org/style";
const TILEJSON_URL = "https://tiles.example.org/planet";

type TestSource = {
  type: string;
  url?: string;
  tiles?: string[];
  attribution?: string;
  minzoom?: number;
  maxzoom?: number;
  bounds?: number[];
};

type Route = { ok?: boolean; body?: unknown } | "throw";

function stubFetch(routes: Record<string, Route>): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      const route = routes[input];
      if (route === undefined) throw new Error(`unexpected fetch: ${input}`);
      if (route === "throw") throw new Error(`network error: ${input}`);
      return { ok: route.ok ?? true, json: async () => route.body } as Response;
    }),
  );
}

/** Narrow the union return to a named, test-shaped source on a style object. */
function sourceOf(style: StyleSpecification | string, id: string): TestSource {
  if (typeof style === "string") {
    throw new Error("expected a curated style object, got a url string");
  }
  const src = (style.sources as unknown as Record<string, TestSource>)[id];
  if (!src) throw new Error(`source "${id}" not found on curated style`);
  return src;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("loadCuratedMapStyle", () => {
  it("inlines a TileJSON-backed source and drops its url + attribution", async () => {
    stubFetch({
      [STYLE_URL]: {
        body: {
          version: 8,
          sources: { basemap: { type: "vector", url: TILEJSON_URL } },
          layers: [],
        },
      },
      [TILEJSON_URL]: {
        body: {
          tiles: ["https://tiles.example.org/planet/{z}/{x}/{y}.pbf"],
          minzoom: 0,
          maxzoom: 14,
          bounds: [-180, -85, 180, 85],
          attribution: "OpenFreeMap © OpenMapTiles Data from OpenStreetMap",
        },
      },
    });

    const src = sourceOf(await loadCuratedMapStyle(STYLE_URL), "basemap");

    expect(src.url).toBeUndefined();
    expect(src.attribution).toBeUndefined();
    expect(src.tiles).toEqual([
      "https://tiles.example.org/planet/{z}/{x}/{y}.pbf",
    ]);
    expect(src.minzoom).toBe(0);
    expect(src.maxzoom).toBe(14);
    expect(src.bounds).toEqual([-180, -85, 180, 85]);
  });

  it("strips inline attribution from a source that has no url", async () => {
    stubFetch({
      [STYLE_URL]: {
        body: {
          version: 8,
          sources: {
            hills: {
              type: "raster",
              tiles: ["https://tiles.example.org/hills/{z}/{x}/{y}.png"],
              attribution: "© Someone",
            },
          },
          layers: [],
        },
      },
    });

    const src = sourceOf(await loadCuratedMapStyle(STYLE_URL), "hills");

    expect(src.attribution).toBeUndefined();
    expect(src.tiles).toHaveLength(1);
  });

  it("falls back to the url when the style response is not ok", async () => {
    stubFetch({ [STYLE_URL]: { ok: false } });
    expect(await loadCuratedMapStyle(STYLE_URL)).toBe(STYLE_URL);
  });

  it("falls back to the url when the style fetch throws", async () => {
    stubFetch({ [STYLE_URL]: "throw" });
    expect(await loadCuratedMapStyle(STYLE_URL)).toBe(STYLE_URL);
  });

  it("keeps a source url (so the map still renders) when its TileJSON fetch throws", async () => {
    stubFetch({
      [STYLE_URL]: {
        body: {
          version: 8,
          sources: { basemap: { type: "vector", url: TILEJSON_URL } },
          layers: [],
        },
      },
      [TILEJSON_URL]: "throw",
    });

    const src = sourceOf(await loadCuratedMapStyle(STYLE_URL), "basemap");

    expect(src.url).toBe(TILEJSON_URL);
  });
});

describe("base map attribution", () => {
  it("credits OpenStreetMap first (raw data → tile schema → tile host)", () => {
    expect(BASE_MAP_ATTRIBUTION[0]).toBe(OSM_ATTRIBUTION);
  });

  it("keeps the OSM credit as a substring of the joined row so MapLibre dedupes the POI layer's copy", () => {
    // MapLibre drops any attribution entry that is a substring of a longer one.
    // The POI GeoJSON source reuses OSM_ATTRIBUTION verbatim, so it must live
    // inside the joined base-map string for that dedupe to collapse the two.
    expect(BASE_MAP_ATTRIBUTION.join(" | ")).toContain(OSM_ATTRIBUTION);
  });
});

describe("isCuratableBaseMap", () => {
  it("curates OpenFreeMap-hosted styles and passes any other provider through", () => {
    expect(
      isCuratableBaseMap("https://tiles.openfreemap.org/styles/liberty"),
    ).toBe(true);
    expect(isCuratableBaseMap("https://openfreemap.org/styles/liberty")).toBe(
      true,
    );
    // A different (commercial) provider must keep its own required attribution.
    expect(
      isCuratableBaseMap("https://api.maptiler.com/maps/streets/style.json"),
    ).toBe(false);
    // A look-alike host must not be treated as OpenFreeMap.
    expect(isCuratableBaseMap("https://notopenfreemap.org/style")).toBe(false);
    // A malformed / relative URL is not curatable.
    expect(isCuratableBaseMap("/local/style.json")).toBe(false);
  });
});
