import { render, waitFor } from "@testing-library/react";
import { act } from "react";
import {
  MapCanvas,
  TARMOTO_QUALITY_LAYER,
  TARMOTO_ROAD_HIT_FALLBACK_LAYER,
  TARMOTO_ROADS_SOURCE,
  TARMOTO_SURFACE_LAYER,
  TARMOTO_SURFACE_SOURCE,
} from "./MapCanvas";
import { applyTarmotoMapTheme } from "@/lib/map-style";

const killSwitch = vi.hoisted(() => ({ enabled: true }));
vi.mock("@/hooks/useEntitlements", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/useEntitlements")>()),
  // Operator kill switches fail SAFE (enabled until a confirmed `force_off`),
  // so this defaults ON and every existing case keeps exercising the path it
  // was written for. Flip `killSwitch.enabled` to simulate an operator.
  useFeatureKillSwitch: () => ({
    enabled: killSwitch.enabled,
    isResolved: true,
  }),
}));

// #1279: the scoped tile credential. Mocked at the hook boundary so the map
// tests stay free of react-query and the auth store; `riderId` drives the
// identity-change reload, `value` drives what `transformRequest` stamps.
const tileToken = vi.hoisted(() => ({
  value: null as string | null,
  // WHOSE credential the tiles carry — `null` for none. An id rather than a
  // flag, so a direct rider A → rider B switch is observable (#1279).
  riderId: null as string | null,
}));
vi.mock("@/hooks/useTileToken", () => ({
  useTileTokenSync: () => tileToken.riderId,
  getTileToken: () => tileToken.value,
}));

// The maplibre mock discards its constructor options; capture them so the
// init-time-only `transformRequest` is assertable.
const mapInit = vi.hoisted(() => ({
  options: null as Record<string, unknown> | null,
}));

const qualitySourceStub = { setTiles: vi.fn() };

const mapStub = {
  addControl: vi.fn(),
  removeControl: vi.fn(),
  on: vi.fn(),
  getSource: vi.fn(() => qualitySourceStub),
  addSource: vi.fn(),
  addLayer: vi.fn(),
  getLayer: vi.fn(() => ({ id: "mock-layer" })),
  setLayoutProperty: vi.fn(),
  setPaintProperty: vi.fn(),
  setFilter: vi.fn(),
  setLayerZoomRange: vi.fn(),
  getCenter: vi.fn(() => ({ lng: 14.5, lat: 50.1 })),
  getBounds: vi.fn(() => ({
    getWest: () => 14.1,
    getSouth: () => 49.9,
    getEast: () => 14.9,
    getNorth: () => 50.4,
  })),
  getZoom: vi.fn(() => 7),
  resize: vi.fn(),
  remove: vi.fn(),
};

const loadHandlers: Array<() => void> = [];

const useCapMock = vi.fn(() => ({
  limit: null as number | null,
  isResolved: true,
}));
vi.mock("@/hooks", () => ({ useRoadQualityZoomCap: () => useCapMock() }));

vi.mock("@/lib/map-style", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/map-style")>("@/lib/map-style");

  return {
    ...actual,
    applyTarmotoMapTheme: vi.fn(),
  };
});

vi.mock("maplibre-gl", () => {
  class NavigationControl {}
  class GeolocateControl {}
  class ScaleControl {}
  class AttributionControl {}
  const Map = vi.fn(function MockMap(options?: Record<string, unknown>) {
    mapInit.options = options ?? null;
    return mapStub;
  });

  return {
    default: {
      Map,
      NavigationControl,
      GeolocateControl,
      ScaleControl,
      AttributionControl,
    },
    NavigationControl,
    GeolocateControl,
    ScaleControl,
    AttributionControl,
  };
});

// The map is created only after the curated base-map style resolves; stub that
// fetch so it's synchronous and network-free (the maplibre mock ignores the
// style value anyway).
vi.mock("./attribution", async () => {
  const actual =
    await vi.importActual<typeof import("./attribution")>("./attribution");
  return {
    ...actual,
    loadCuratedMapStyle: vi.fn(async () => ({
      version: 8,
      sources: {},
      layers: [],
    })),
  };
});

describe("MapCanvas", () => {
  beforeAll(() => {
    class MockResizeObserver {
      observe() {}
      disconnect() {}
    }

    vi.stubGlobal("ResizeObserver", MockResizeObserver);
  });

  beforeEach(() => {
    loadHandlers.length = 0;
    // Companion ships a light-only theme; the matchMedia mock simulates a
    // browser that prefers dark so the test confirms we ignore it.
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: vi.fn().mockImplementation(() => ({
        matches: true,
        media: "(prefers-color-scheme: dark)",
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    });
    mapStub.addControl.mockReset();
    mapStub.on.mockImplementation(
      (event: string, handler: (...args: never[]) => void) => {
        if (event === "load") loadHandlers.push(handler as () => void);
      },
    );
    mapStub.addSource.mockReset();
    mapStub.addLayer.mockReset();
    mapStub.getLayer.mockReset();
    mapStub.getLayer.mockReturnValue({ id: "mock-layer" });
    mapStub.setLayoutProperty.mockReset();
    killSwitch.enabled = true;
    mapStub.setPaintProperty.mockReset();
    mapStub.setLayerZoomRange.mockReset();
    mapStub.resize.mockReset();
    mapStub.remove.mockReset();
    vi.mocked(applyTarmotoMapTheme).mockReset();
    useCapMock.mockReset();
    useCapMock.mockReturnValue({ limit: null, isResolved: true });
    mapStub.getSource.mockClear();
    qualitySourceStub.setTiles.mockReset();
    mapInit.options = null;
    tileToken.value = null;
    tileToken.riderId = null;
  });

  it("always applies the light theme and ignores the OS dark-mode preference", async () => {
    render(
      <div className="h-[400px] w-[600px]">
        <MapCanvas
          center={{ lng: 14.5, lat: 50.1 }}
          zoom={7}
          showQuality={true}
          showSurface={false}
        />
      </div>,
    );

    // The map (and its "load" handlers) appear only once the curated style
    // resolves, so wait for it before firing them.
    await waitFor(() => expect(loadHandlers.length).toBeGreaterThan(0));

    act(() => {
      for (const handler of loadHandlers) handler();
    });

    await waitFor(() => {
      expect(applyTarmotoMapTheme).toHaveBeenCalledWith(mapStub, "light");
    });

    expect(applyTarmotoMapTheme).not.toHaveBeenCalledWith(mapStub, "dark");
  });

  it("gates general overlays without hiding the shared road-map source", async () => {
    render(
      <div className="h-[400px] w-[600px]">
        <MapCanvas
          center={{ lng: 14.5, lat: 50.1 }}
          zoom={7}
          showQuality={true}
          showSurface={false}
        />
      </div>,
    );
    await waitFor(() => expect(loadHandlers.length).toBeGreaterThan(0));

    act(() => {
      for (const handler of loadHandlers) handler();
    });

    expect(mapStub.addSource).toHaveBeenCalledWith(
      TARMOTO_ROADS_SOURCE,
      expect.objectContaining({
        // PersonalRoadMap adds its own z8 layers to this source.
        minzoom: 6,
        tiles: [expect.stringMatching(/\.mvt\?layers=quality$/)],
      }),
    );
    expect(mapStub.addSource).toHaveBeenCalledWith(
      TARMOTO_SURFACE_SOURCE,
      expect.objectContaining({
        // Same floor as the quality source (#1279): PersonalRoadMap's coverage
        // layers moved here and that map opens at z8, so a z10 floor would
        // blank it at the two zooms above its own minimum.
        minzoom: 6,
        tiles: [expect.stringMatching(/\.mvt\?layers=surface$/)],
      }),
    );
    expect(mapStub.addLayer).toHaveBeenCalledWith(
      expect.objectContaining({
        id: TARMOTO_QUALITY_LAYER,
        source: TARMOTO_ROADS_SOURCE,
        minzoom: 10,
      }),
    );
    expect(mapStub.addLayer).toHaveBeenCalledWith(
      expect.objectContaining({
        id: TARMOTO_SURFACE_LAYER,
        source: TARMOTO_SURFACE_SOURCE,
        minzoom: 10,
      }),
    );
  });

  it("adds the quality overlay layer with the free maxzoom cap when limited", async () => {
    useCapMock.mockReturnValue({ limit: 12, isResolved: true });
    render(
      <MapCanvas
        center={{ lng: 0, lat: 0 }}
        zoom={7}
        showQuality
        showSurface={false}
      />,
    );
    await waitFor(() => expect(loadHandlers.length).toBeGreaterThan(0));
    act(() => {
      for (const h of loadHandlers) h();
    });
    expect(mapStub.addLayer).toHaveBeenCalledWith(
      expect.objectContaining({ id: TARMOTO_QUALITY_LAYER, maxzoom: 12 }),
    );
  });

  it("lifts the quality overlay cap for an unlimited (pro/premium) rider", async () => {
    useCapMock.mockReturnValue({ limit: null, isResolved: true });
    render(
      <MapCanvas
        center={{ lng: 0, lat: 0 }}
        zoom={7}
        showQuality
        showSurface={false}
      />,
    );
    await waitFor(() => expect(loadHandlers.length).toBeGreaterThan(0));
    act(() => {
      for (const h of loadHandlers) h();
    });
    expect(mapStub.addLayer).toHaveBeenCalledWith(
      expect.objectContaining({ id: TARMOTO_QUALITY_LAYER, maxzoom: 18 }),
    );
  });

  it("caps the quality-graded selection highlight layers at the same limit", async () => {
    // The selection glow/line render QUALITY_LINE_COLOR from source-layer
    // "quality", so a free rider selecting a segment could otherwise read its
    // quality colour past the cap. Both must carry the same maxzoom.
    useCapMock.mockReturnValue({ limit: 12, isResolved: true });
    render(
      <MapCanvas
        center={{ lng: 0, lat: 0 }}
        zoom={7}
        showQuality
        showSurface={false}
      />,
    );
    await waitFor(() => expect(loadHandlers.length).toBeGreaterThan(0));
    act(() => {
      for (const h of loadHandlers) h();
    });
    expect(mapStub.addLayer).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "tarmoto-segment-selected-glow",
        maxzoom: 12,
      }),
    );
    expect(mapStub.addLayer).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "tarmoto-segment-selected-line",
        maxzoom: 12,
      }),
    );
  });

  it("hides the quality-graded layers (no invalid range) when the cap is at/below the layer floor", async () => {
    // A resolved cap of 5 is below TARMOTO_ROADS_MIN_ZOOM (10). setLayerZoomRange
    // (10, 5) is invalid and MapLibre would reject it, leaving the previous cap
    // active and leaking quality past 5. The layers must instead be added with a
    // VALID placeholder maxzoom (min + 1 = 11) and hidden.
    useCapMock.mockReturnValue({ limit: 5, isResolved: true });
    render(
      <MapCanvas
        center={{ lng: 0, lat: 0 }}
        zoom={7}
        showQuality
        showSurface={false}
      />,
    );
    await waitFor(() => expect(loadHandlers.length).toBeGreaterThan(0));
    act(() => {
      for (const h of loadHandlers) h();
    });

    // Every quality-graded layer is added with a valid placeholder maxzoom (11),
    // never the invalid 5, and hidden.
    for (const id of [
      TARMOTO_QUALITY_LAYER,
      "tarmoto-segment-selected-glow",
      "tarmoto-segment-selected-line",
    ]) {
      const add = mapStub.addLayer.mock.calls.find(
        (c) => (c[0] as { id?: string }).id === id,
      );
      const layer = add?.[0] as {
        maxzoom?: number;
        layout?: { visibility?: string };
      };
      expect(layer.maxzoom).toBe(11);
      expect(layer.layout?.visibility).toBe("none");
    }

    // The clamp effect must NOT push an invalid (minzoom >= maxzoom) range.
    for (const call of mapStub.setLayerZoomRange.mock.calls) {
      const [, minz, maxz] = call as [string, number, number];
      expect(maxz).toBeGreaterThan(minz);
    }

    // And the quality overlay is toggled hidden by the visibility effect.
    expect(mapStub.setLayoutProperty).toHaveBeenCalledWith(
      TARMOTO_QUALITY_LAYER,
      "visibility",
      "none",
    );
  });

  it("hides the SELECTED-segment layers too when the operator kills the overlay", async () => {
    // The selected-segment effect keys off `selectedSegmentId`, not
    // `showQuality`, so folding the switch into `showQuality` alone left a
    // segment that was already selected still drawn — and the graded layers kept
    // the quality source alive, still fetching the tiles the kill was meant to
    // stop. All three selection layers must go, including the neutral outline.
    killSwitch.enabled = false;
    render(
      <MapCanvas
        center={{ lng: 0, lat: 0 }}
        zoom={12}
        showQuality
        showSurface={false}
        selectedSegmentId="seg-1"
      />,
    );
    await waitFor(() => expect(loadHandlers.length).toBeGreaterThan(0));
    act(() => {
      for (const h of loadHandlers) h();
    });

    for (const id of [
      "tarmoto-segment-selected-outline",
      "tarmoto-segment-selected-glow",
      "tarmoto-segment-selected-line",
    ]) {
      expect(mapStub.setLayoutProperty).toHaveBeenCalledWith(
        id,
        "visibility",
        "none",
      );
      expect(mapStub.setLayoutProperty).not.toHaveBeenCalledWith(
        id,
        "visibility",
        "visible",
      );
    }
  });

  it("adds the selection layers already HIDDEN when the switch is off at mount", async () => {
    // The correcting effect runs only after `setReady`. With a resolved
    // `force_off` and a segment already selected at mount, the initial
    // `addLayer` definitions would otherwise paint the selection for the window
    // between map load and that effect — a visible flash of the very overlay an
    // operator just killed.
    killSwitch.enabled = false;
    render(
      <MapCanvas
        center={{ lng: 0, lat: 0 }}
        zoom={12}
        showQuality
        showSurface={false}
        selectedSegmentId="seg-1"
      />,
    );
    await waitFor(() => expect(loadHandlers.length).toBeGreaterThan(0));
    act(() => {
      for (const h of loadHandlers) h();
    });

    // Inspect the ADD arguments, not the later effect: they are the snapshot
    // taken before `setReady`, which is exactly the window under test.
    for (const id of [
      "tarmoto-segment-selected-outline",
      "tarmoto-segment-selected-glow",
      "tarmoto-segment-selected-line",
    ]) {
      const add = mapStub.addLayer.mock.calls.find(
        (c) => (c[0] as { id?: string }).id === id,
      );
      const layer = add?.[0] as { layout?: { visibility?: string } };
      expect(layer.layout?.visibility).toBe("none");
    }
  });

  it("adds the MAIN quality and hit layers hidden when the switch resolves before the style loads", async () => {
    // The selection layers already read the ref; these two read the closure,
    // which is the same bug with a wider blast radius. `force_off` arriving
    // after the effect registered its `load` callback but before the style
    // finished loading is the ordinary case on a cold load — the flag request
    // and the tile request race. The graded overlay and its hit target would
    // both come up visible, so the kill would paint quality data and keep
    // hit-testing it until the correcting effect ran.
    // A factory, not a stored element: React bails out of a re-render when it
    // is handed the referentially identical element, and the bail-out would
    // leave the ref stale and quietly pass this test against broken code.
    const view = () => (
      <MapCanvas
        center={{ lng: 0, lat: 0 }}
        zoom={12}
        showQuality
        showSurface={false}
      />
    );
    const { rerender } = render(view());
    await waitFor(() => expect(loadHandlers.length).toBeGreaterThan(0));

    // The operator kills it in that window: after the callback was registered,
    // before the style load fires it. The re-render is what react-query does
    // when the flag request resolves, and is what carries the new value into
    // the ref the callback reads.
    killSwitch.enabled = false;
    rerender(view());
    act(() => {
      for (const h of loadHandlers) h();
    });

    for (const id of ["tarmoto-quality", "tarmoto-road-hit"]) {
      const add = mapStub.addLayer.mock.calls.find(
        (c) => (c[0] as { id?: string }).id === id,
      );
      expect(add, `${id} was never added`).toBeDefined();
      const layer = add![0] as { layout?: { visibility?: string } };
      expect(layer.layout?.visibility, id).toBe("none");
    }
  });

  it("adds an UNCAPPED neutral selection outline so selection stays visible past the cap", async () => {
    // The neutral casing carries no quality colour, so it must NOT inherit the
    // entitlement cap — otherwise selecting a road above the cap (or on a
    // surface-only / PersonalRoadMap surface, showQuality=false) opens the
    // detail drawer with no highlight on the map.
    useCapMock.mockReturnValue({ limit: 12, isResolved: true });
    render(
      <MapCanvas
        center={{ lng: 0, lat: 0 }}
        zoom={7}
        showQuality={false}
        showSurface
      />,
    );
    await waitFor(() => expect(loadHandlers.length).toBeGreaterThan(0));
    act(() => {
      for (const h of loadHandlers) h();
    });
    const outlineCall = mapStub.addLayer.mock.calls.find(
      (c) =>
        (c[0] as { id?: string }).id === "tarmoto-segment-selected-outline",
    );
    expect(outlineCall).toBeDefined();
    const outlineLayer = outlineCall![0] as {
      maxzoom?: number;
      paint?: Record<string, unknown>;
    };
    expect(outlineLayer.maxzoom).toBeUndefined();
    // Neutral colour — not the quality-graded expression.
    expect(outlineLayer.paint?.["line-color"]).toBe("#334155");
  });

  it("adds an UNCAPPED invisible road-hit layer so interaction survives the cap", async () => {
    // The hit target must NOT carry the entitlement maxzoom — snapping / tap /
    // hover keep working past the free cap — and must be invisible.
    useCapMock.mockReturnValue({ limit: 12, isResolved: true });
    render(
      <MapCanvas
        center={{ lng: 0, lat: 0 }}
        zoom={7}
        showQuality
        showSurface={false}
      />,
    );
    await waitFor(() => expect(loadHandlers.length).toBeGreaterThan(0));
    act(() => {
      for (const h of loadHandlers) h();
    });
    const hitCall = mapStub.addLayer.mock.calls.find(
      (c) => (c[0] as { id?: string }).id === "tarmoto-road-hit",
    );
    expect(hitCall).toBeDefined();
    const hitLayer = hitCall![0] as {
      maxzoom?: number;
      paint?: Record<string, unknown>;
    };
    // No entitlement cap on the hit target.
    expect(hitLayer.maxzoom).toBeUndefined();
    // Invisible.
    expect(hitLayer.paint?.["line-opacity"]).toBe(0);
  });

  // #1279 — the seam that makes the anonymous zoom clamp flippable: every map
  // in the companion goes through MapCanvas, so wiring the credential here is
  // what stops a surface being forgotten.
  describe("tile credential (#1279)", () => {
    const renderCanvas = async () => {
      const view = render(
        <MapCanvas
          center={{ lng: 14.5, lat: 50.1 }}
          zoom={7}
          showQuality
          showSurface={false}
        />,
      );
      await waitFor(() => expect(loadHandlers.length).toBeGreaterThan(0));
      act(() => {
        for (const h of loadHandlers) h();
      });
      return view;
    };

    const transformRequest = () =>
      mapInit.options?.["transformRequest"] as (
        url: string,
      ) => { url: string } | undefined;

    it("stamps backend tile requests and leaves the basemap host alone", async () => {
      tileToken.value = "tok-abc";
      tileToken.riderId = "rider-a";
      await renderCanvas();

      const transform = transformRequest();
      expect(transform).toBeTypeOf("function");

      const tileUrl = (
        mapStub.addSource.mock.calls.find(
          (c) => c[0] === TARMOTO_ROADS_SOURCE,
        )![1] as { tiles: string[] }
      ).tiles[0]!.replace("{z}/{x}/{y}", "13/4424/2782");

      expect(transform(tileUrl)?.url).toContain("tile_token=tok-abc");
      // The acceptance criterion: never a credential on a third-party host.
      expect(
        transform("https://tiles.openfreemap.org/styles/liberty"),
      ).toBeUndefined();
    });

    it("sends no credential for a signed-out visitor", async () => {
      await renderCanvas();

      expect(
        transformRequest()(
          "https://api.tarmoto.app/api/v1/roads/tiles/13/1/1.mvt",
        ),
      ).toBeUndefined();
    });

    // Since tile fetches carry identity, the backend empties the QUALITY source
    // above a capped rider's zoom — and that source also carries the invisible
    // hit target that keeps planner snapping working past the cap. Snapping is
    // deliberately not an entitlement, so a capped rider gets a second hit
    // target on the never-clamped surface source.
    describe("uncapped hit target (#1279)", () => {
      const hitFallbackVisibility = () =>
        mapStub.setLayoutProperty.mock.calls
          .filter((c) => c[0] === TARMOTO_ROAD_HIT_FALLBACK_LAYER)
          .at(-1)?.[2];

      it("adds it on the never-clamped surface source", async () => {
        useCapMock.mockReturnValue({ limit: 12, isResolved: true });
        await renderCanvas();

        const call = mapStub.addLayer.mock.calls.find(
          (c) =>
            (c[0] as { id?: string }).id === TARMOTO_ROAD_HIT_FALLBACK_LAYER,
        );
        expect(call?.[0]).toMatchObject({
          source: TARMOTO_SURFACE_SOURCE,
          "source-layer": "surface",
          paint: expect.objectContaining({ "line-opacity": 0 }),
        });
        // Uncapped, like the primary hit target it stands in for.
        expect((call?.[0] as { maxzoom?: number }).maxzoom).toBeUndefined();
      });

      it("is visible for a capped rider", async () => {
        useCapMock.mockReturnValue({ limit: 12, isResolved: true });
        await renderCanvas();

        expect(hitFallbackVisibility()).toBe("visible");
      });

      it("stays hidden for an unlimited rider, so they keep the one-source fetch", async () => {
        // MapLibre requests a source's tiles only for visible layers, so this
        // is what stops every paying rider paying for a second vector source.
        useCapMock.mockReturnValue({ limit: null, isResolved: true });
        await renderCanvas();

        expect(hitFallbackVisibility()).toBe("none");
      });

      it("keeps the neutral selection outline on the same uncapped source", async () => {
        // The outline is deliberately uncapped so selection feedback survives
        // past the cap — which only holds if its geometry does too. Reading it
        // from the clamped quality source would blank it at exactly the zooms
        // it exists for.
        useCapMock.mockReturnValue({ limit: 12, isResolved: true });
        await renderCanvas();

        const call = mapStub.addLayer.mock.calls.find(
          (c) =>
            (c[0] as { id?: string }).id === "tarmoto-segment-selected-outline",
        );
        expect(call?.[0]).toMatchObject({
          source: TARMOTO_SURFACE_SOURCE,
          "source-layer": "surface",
        });
        expect((call?.[0] as { maxzoom?: number }).maxzoom).toBeUndefined();
      });

      it("is visible while the cap is still unresolved", async () => {
        // The cap fails closed to the free floor until it resolves; snapping
        // must not silently stop working in that window.
        useCapMock.mockReturnValue({ limit: null, isResolved: false });
        await renderCanvas();

        expect(hitFallbackVisibility()).toBe("visible");
      });
    });

    it("does not reload the quality source while the identity is unchanged", async () => {
      tileToken.value = "tok-abc";
      tileToken.riderId = "rider-a";
      await renderCanvas();

      expect(qualitySourceStub.setTiles).not.toHaveBeenCalled();
    });

    it("reloads the quality source when a credential arrives late", async () => {
      // Tiles fetched before the credential landed are cached WITHOUT the
      // quality layer, and MapLibre keys its cache by tile coordinates, not by
      // URL — so without this reload a paying rider's overlay stays missing at
      // deep zoom until they happen to pan.
      const { rerender } = await renderCanvas();
      expect(qualitySourceStub.setTiles).not.toHaveBeenCalled();

      tileToken.value = "tok-late";
      tileToken.riderId = "rider-a";
      await act(async () => {
        rerender(
          <MapCanvas
            center={{ lng: 14.5, lat: 50.1 }}
            zoom={7}
            showQuality
            showSurface={false}
          />,
        );
      });

      expect(mapStub.getSource).toHaveBeenCalledWith(TARMOTO_ROADS_SOURCE);
      expect(qualitySourceStub.setTiles).toHaveBeenCalledWith([
        expect.stringMatching(/\.mvt\?layers=quality$/),
      ]);
    });

    it("reloads when one rider replaces another with no gap between them", async () => {
      // A direct A → B switch (B's token still cached) never passes through
      // "no credential", so a presence flag would miss it and leave B looking
      // at tiles fetched under A's entitlement.
      tileToken.value = "tok-a";
      tileToken.riderId = "rider-a";
      const { rerender } = await renderCanvas();
      expect(qualitySourceStub.setTiles).not.toHaveBeenCalled();

      tileToken.value = "tok-b";
      tileToken.riderId = "rider-b";
      await act(async () => {
        rerender(
          <MapCanvas
            center={{ lng: 14.5, lat: 50.1 }}
            zoom={7}
            showQuality
            showSurface={false}
          />,
        );
      });

      expect(qualitySourceStub.setTiles).toHaveBeenCalledWith([
        expect.stringMatching(/\.mvt\?layers=quality$/),
      ]);
    });

    it("reloads when the rider's zoom entitlement rises", async () => {
      // The always-visible hit layer keeps this source fetching past the cap,
      // so a capped rider's cache fills with the backend's EMPTY above-cap
      // responses. On an upgrade the layer maxzoom rises over tiles that are
      // already cached empty — without a reload the deep zoom they just paid
      // for stays blank until something unrelated evicts them.
      tileToken.value = "tok-a";
      tileToken.riderId = "rider-a";
      useCapMock.mockReturnValue({ limit: 12, isResolved: true });
      const { rerender } = await renderCanvas();
      expect(qualitySourceStub.setTiles).not.toHaveBeenCalled();

      useCapMock.mockReturnValue({ limit: null, isResolved: true });
      await act(async () => {
        rerender(
          <MapCanvas
            center={{ lng: 14.5, lat: 50.1 }}
            zoom={7}
            showQuality
            showSurface={false}
          />,
        );
      });

      expect(qualitySourceStub.setTiles).toHaveBeenCalledWith([
        expect.stringMatching(/\.mvt\?layers=quality$/),
      ]);
    });

    it("reloads when it falls, so above-cap bytes are not kept", async () => {
      tileToken.value = "tok-a";
      tileToken.riderId = "rider-a";
      useCapMock.mockReturnValue({ limit: null, isResolved: true });
      const { rerender } = await renderCanvas();
      expect(qualitySourceStub.setTiles).not.toHaveBeenCalled();

      useCapMock.mockReturnValue({ limit: 12, isResolved: true });
      await act(async () => {
        rerender(
          <MapCanvas
            center={{ lng: 14.5, lat: 50.1 }}
            zoom={7}
            showQuality
            showSurface={false}
          />,
        );
      });

      expect(qualitySourceStub.setTiles).toHaveBeenCalled();
    });

    it("does not reload when the SAME rider's token rotates", async () => {
      // Rotation is routine; reloading on it would throw away a viewport of
      // good tiles several times an hour.
      tileToken.value = "tok-1";
      tileToken.riderId = "rider-a";
      const { rerender } = await renderCanvas();

      tileToken.value = "tok-2";
      await act(async () => {
        rerender(
          <MapCanvas
            center={{ lng: 14.5, lat: 50.1 }}
            zoom={7}
            showQuality
            showSurface={false}
          />,
        );
      });

      expect(qualitySourceStub.setTiles).not.toHaveBeenCalled();
    });
  });
});
