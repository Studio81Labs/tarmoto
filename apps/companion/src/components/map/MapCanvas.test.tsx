import { render, waitFor } from "@testing-library/react";
import { act } from "react";
import {
  MapCanvas,
  TARMOTO_QUALITY_LAYER,
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

const mapStub = {
  addControl: vi.fn(),
  removeControl: vi.fn(),
  on: vi.fn(),
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
  const Map = vi.fn(function MockMap() {
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
        minzoom: 10,
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
});
