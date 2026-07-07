import { render, waitFor } from "@testing-library/react";
import { act } from "react";
import { MapCanvas } from "./MapCanvas";
import { applyTarmotoMapTheme } from "@/lib/map-style";

const mapStub = {
  addControl: vi.fn(),
  on: vi.fn(),
  addSource: vi.fn(),
  addLayer: vi.fn(),
  getLayer: vi.fn(() => ({ id: "mock-layer" })),
  setLayoutProperty: vi.fn(),
  setPaintProperty: vi.fn(),
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
  const Map = vi.fn(function MockMap() {
    return mapStub;
  });

  return {
    default: {
      Map,
      NavigationControl,
      GeolocateControl,
      ScaleControl,
    },
    NavigationControl,
    GeolocateControl,
    ScaleControl,
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
    mapStub.setPaintProperty.mockReset();
    mapStub.resize.mockReset();
    mapStub.remove.mockReset();
    vi.mocked(applyTarmotoMapTheme).mockReset();
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
});
