import { render, screen, waitFor } from "@testing-library/react";
import { forwardRef, useImperativeHandle } from "react";
import { BestRoadsMap } from "./BestRoadsMap";
import { applyTarmotoMapTheme } from "@/lib/map-style";

const mockFitBounds = vi.fn();
const mockMap = {
  getLayer: vi.fn(),
};

let layersReady = false;
let themedAfterLoad = false;
let loadMap: (() => void) | null = null;

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

vi.mock("@/lib/map-style", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/map-style")>("@/lib/map-style");

  return {
    ...actual,
    applyTarmotoMapTheme: vi.fn((map: typeof mockMap) => {
      if (map.getLayer("background")) {
        themedAfterLoad = true;
      }
    }),
  };
});

vi.mock("react-map-gl/maplibre", () => ({
  Map: forwardRef(function MockMap(
    props: {
      onLoad?: () => void;
      children?: React.ReactNode;
    },
    ref: React.ForwardedRef<{
      getMap: () => typeof mockMap;
      fitBounds: typeof mockFitBounds;
    }>,
  ) {
    useImperativeHandle(ref, () => ({
      getMap: () => mockMap,
      fitBounds: mockFitBounds,
    }));

    loadMap = () => {
      layersReady = true;
      props.onLoad?.();
    };

    return <div data-testid="best-roads-map">{props.children}</div>;
  }),
  Source: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  Layer: ({ id }: { id?: string }) => <div data-testid={`layer-${id}`} />,
  Marker: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}));

describe("BestRoadsMap", () => {
  beforeEach(() => {
    layersReady = false;
    themedAfterLoad = false;
    loadMap = null;
    mockFitBounds.mockReset();
    mockMap.getLayer.mockReset();
    mockMap.getLayer.mockImplementation((layerId: string) =>
      layersReady && layerId === "background" ? { id: layerId } : undefined,
    );
    vi.mocked(applyTarmotoMapTheme).mockClear();
    killSwitch.enabled = true;
  });

  it("applies the basemap theme after the style load event even when the map ref exists earlier", async () => {
    render(
      <BestRoadsMap
        bbox={[14.1, 49.9, 14.9, 50.4]}
        center={{ lat: 50.1, lng: 14.5 }}
        defaultZoom={7}
        roads={[
          {
            id: "road-1",
            road_name: "Alpine pass",
            quality_score: 4.7,
            geometry: [
              { lat: 50.1, lng: 14.5 },
              { lat: 50.2, lng: 14.6 },
            ],
          },
        ]}
      />,
    );

    expect(themedAfterLoad).toBe(false);

    loadMap?.();

    await waitFor(() => {
      expect(themedAfterLoad).toBe(true);
    });
  });

  const bestRoads = () => (
    <BestRoadsMap
      bbox={[14.1, 49.9, 14.9, 50.4]}
      center={{ lat: 50.1, lng: 14.5 }}
      defaultZoom={7}
      roads={[
        {
          id: "road-1",
          road_name: "Alpine pass",
          quality_score: 4.7,
          geometry: [
            { lat: 50.1, lng: 14.5 },
            { lat: 50.2, lng: 14.6 },
          ],
        },
      ]}
    />
  );

  it("draws the ranked quality overlay normally", () => {
    render(bestRoads());
    expect(screen.getByTestId("layer-best-roads-line")).toBeInTheDocument();
    expect(screen.getByText("1")).toBeInTheDocument();
  });

  it("removes the whole overlay when the operator kills road quality", () => {
    // This is the ONE road-quality surface an anonymous visitor sees, and it is
    // a standalone react-map-gl map, so it never passed through the `MapCanvas`
    // gate every other map on the companion goes through.
    killSwitch.enabled = false;
    render(bestRoads());
    expect(screen.queryByTestId("layer-best-roads-line")).toBeNull();
    // The rank pins go too: the ranking IS a quality ranking, and numbered pins
    // floating over a basemap with no roads drawn would read as broken rather
    // than as switched off.
    expect(screen.queryByText("1")).toBeNull();
    // The map itself stays — the region is still shown, just without the data.
    expect(screen.getByTestId("best-roads-map")).toBeInTheDocument();
  });

  it("restores the overlay on a live flip back", () => {
    killSwitch.enabled = false;
    const { rerender } = render(bestRoads());
    expect(screen.queryByTestId("layer-best-roads-line")).toBeNull();

    killSwitch.enabled = true;
    // A fresh element: React bails out of a re-render given the identical one.
    rerender(bestRoads());
    expect(screen.getByTestId("layer-best-roads-line")).toBeInTheDocument();
  });
});
