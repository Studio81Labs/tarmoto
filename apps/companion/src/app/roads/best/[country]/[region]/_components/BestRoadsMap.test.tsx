import { render, waitFor } from "@testing-library/react";
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
  Layer: () => null,
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
});
