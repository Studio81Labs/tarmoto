import { render } from "@testing-library/react";
import { useEffect } from "react";
import {
  ROAD_MAP_DIM_LAYER_ID,
  ROAD_MAP_RIDDEN_LAYER_ID,
} from "@/lib/road-map-layer";

// Kill switches fail SAFE (enabled until a confirmed `force_off`).
const killSwitch = vi.hoisted(() => ({ enabled: true }));
vi.mock("@/hooks/useEntitlements", () => ({
  useFeatureKillSwitch: () => ({
    enabled: killSwitch.enabled,
    isResolved: true,
  }),
}));
vi.mock("@/hooks/useMapColorScheme", () => ({
  useMapColorScheme: () => "light",
}));

/**
 * A MapLibre stand-in that records the layer specs it is handed. Any method
 * this component reaches for and we have not stubbed returns a no-op mock, so
 * the fake tracks the component rather than the map API surface.
 */
const recorded = vi.hoisted(() => ({
  addLayer: [] as {
    id?: string;
    source?: string;
    "source-layer"?: string;
    layout?: { visibility?: string };
  }[],
  setLayoutProperty: [] as [string, string, string][],
}));

function makeFakeMap() {
  const base: Record<string, unknown> = {
    addLayer: (spec: {
      id?: string;
      source?: string;
      "source-layer"?: string;
      layout?: { visibility?: string };
    }) => recorded.addLayer.push(spec),
    setLayoutProperty: (id: string, key: string, value: string) =>
      recorded.setLayoutProperty.push([id, key, value]),
    getLayer: (id: string) => ({ id }),
    getSource: () => ({ setData: vi.fn() }),
    getStyle: () => ({ layers: [] }),
    getCanvas: () => ({ style: {} }),
  };
  return new Proxy(base, {
    get: (t, prop) => (prop in t ? t[prop as string] : vi.fn()),
  });
}

vi.mock("@/components/map/MapCanvas", () => ({
  TARMOTO_SURFACE_SOURCE: "tarmoto-road-surfaces",
  MapCanvas: ({ onReady }: { onReady?: (map: unknown) => void }) => {
    useEffect(() => {
      onReady?.(makeFakeMap());
    }, [onReady]);
    return <div data-testid="canvas" />;
  },
}));

import { PersonalRoadMap } from "./PersonalRoadMap";

function dimLayerVisibility(): string | undefined {
  return recorded.addLayer.find((l) => l.id === ROAD_MAP_DIM_LAYER_ID)?.layout
    ?.visibility;
}
function riddenLayerVisibility(): string | undefined {
  return recorded.addLayer.find((l) => l.id === ROAD_MAP_RIDDEN_LAYER_ID)
    ?.layout?.visibility;
}

describe("PersonalRoadMap — road_quality_overlay", () => {
  beforeEach(() => {
    recorded.addLayer.length = 0;
    recorded.setLayoutProperty.length = 0;
    killSwitch.enabled = true;
  });

  it("hides BOTH quality-source layers on a server-confirmed kill", () => {
    // The hook still reports enabled — it fails safe and its browser request
    // may never settle. Both layers draw from the `quality` source, so leaving
    // either on that hook alone keeps painting the road network and requesting
    // the killed tiles after the server has already answered.
    render(
      <PersonalRoadMap
        initialCenter={{ lat: 49.2, lng: 16.6, zoom: 10 }}
        ridden={[]}
        showCoverage
        qualityOverlayKilled
      />,
    );
    expect(dimLayerVisibility()).toBe("none");
    expect(riddenLayerVisibility()).toBe("none");
  });

  it("draws both when neither source reports a kill", () => {
    render(
      <PersonalRoadMap
        initialCenter={{ lat: 49.2, lng: 16.6, zoom: 10 }}
        ridden={[]}
        showCoverage
      />,
    );
    expect(dimLayerVisibility()).toBe("visible");
    expect(riddenLayerVisibility()).toBe("visible");
  });

  it("still hides them when only the CLIENT hook confirms the kill", () => {
    // The hook keeps its job: it polls, so it catches a flip made after
    // render, and covers a SERVER flags request that failed and fell back.
    killSwitch.enabled = false;
    render(
      <PersonalRoadMap
        initialCenter={{ lat: 49.2, lng: 16.6, zoom: 10 }}
        ridden={[]}
        showCoverage
      />,
    );
    expect(dimLayerVisibility()).toBe("none");
    expect(riddenLayerVisibility()).toBe("none");
  });
});

/**
 * #1279 — coverage geometry must not ride the entitlement-clamped tiles.
 *
 * Once tile fetches carry identity the backend withholds the `quality` layer
 * above the requester's `road_quality_max_zoom`, so a free rider — and, after
 * the anonymous-clamp flip, every visitor of a PUBLIC shared road map — would
 * see this map go blank from z13 up, which is the whole point of the page.
 * Ridden/unridden is exploration data, not paid quality detail.
 */
describe("PersonalRoadMap \u2014 coverage geometry source", () => {
  beforeEach(() => {
    recorded.addLayer.length = 0;
    recorded.setLayoutProperty.length = 0;
    killSwitch.enabled = true;
  });

  const coverageLayers = () =>
    recorded.addLayer.filter(
      (l) =>
        l.id === ROAD_MAP_DIM_LAYER_ID || l.id === ROAD_MAP_RIDDEN_LAYER_ID,
    );

  const renderMap = () =>
    render(
      <PersonalRoadMap
        initialCenter={{ lat: 49.2, lng: 16.6, zoom: 10 }}
        ridden={[]}
        showCoverage
      />,
    );

  it("draws both coverage layers from the never-clamped surface layer", () => {
    renderMap();

    const layers = coverageLayers();
    expect(layers).toHaveLength(2);
    for (const layer of layers) {
      expect(layer.source).toBe("tarmoto-road-surfaces");
      expect(layer["source-layer"]).toBe("surface");
    }
  });

  it("keeps them off the quality source and its clamped layer", () => {
    renderMap();

    for (const layer of coverageLayers()) {
      expect(layer.source).not.toBe("tarmoto-roads");
      expect(layer["source-layer"]).not.toBe("quality");
    }
  });
});
