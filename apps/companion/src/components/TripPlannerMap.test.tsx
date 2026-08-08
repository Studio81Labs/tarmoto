import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { createRef, forwardRef, useEffect, useImperativeHandle } from "react";
import { expression } from "@maplibre/maplibre-gl-style-spec";
import { TripPlannerMap, type TripPlannerMapHandle } from "./TripPlannerMap";
import type { Trip } from "@/lib/types";
import { createRegionDrawControl } from "@/components/map/RegionDrawControl";
import { useClosures } from "@/hooks/useClosures";
import { usePasses } from "@/hooks/usePasses";
import { buildTripClosureRoutes } from "@/lib/closures-summary";
import { useTripStore } from "@/stores/trip";
import { poiApi } from "@/lib/api";
import { fetchFunZoneDetail, fetchFunZonesInBbox } from "@/lib/discover";

const mockCanvas = {
  style: { cursor: "" },
  getBoundingClientRect: () => ({
    left: 0,
    top: 0,
    right: 800,
    bottom: 600,
    width: 800,
    height: 600,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  }),
};
// Current map zoom the tap-for-detail cap gate reads via `map.getZoom()`.
let plannerZoom = 12;
const mockMap = {
  addSource: vi.fn(),
  getSource: vi.fn(),
  addLayer: vi.fn(),
  getLayer: vi.fn(),
  getStyle: vi.fn(),
  getZoom: vi.fn(() => plannerZoom),
  on: vi.fn(),
  off: vi.fn(),
  queryRenderedFeatures: vi.fn(),
  querySourceFeatures: vi.fn(),
  setPaintProperty: vi.fn(),
  setLayoutProperty: vi.fn(),
  setFilter: vi.fn(),
  fitBounds: vi.fn(),
  getCanvas: vi.fn(() => mockCanvas),
  flyTo: vi.fn(),
  getBounds: vi.fn(() => ({
    getWest: () => 12.0,
    getSouth: () => 48.5,
    getEast: () => 19.0,
    getNorth: () => 51.1,
  })),
  unproject: vi.fn((point: [number, number]) => ({
    lng: point[0] / 100,
    lat: point[1] / 100,
  })),
} as const;

const drawControl = {
  start: vi.fn(),
  cancel: vi.fn(),
  clearDrawn: vi.fn(),
  setDrawn: vi.fn(),
  destroy: vi.fn(),
  getMode: vi.fn(() => "idle" as const),
  hitTest: vi.fn(() => false),
};

let lastDrawOptions: {
  onRegionDrawn: (bbox: [number, number, number, number]) => void;
  onRegionCleared?: () => void;
  onModeChange?: (mode: "idle" | "drawing" | "editing") => void;
} | null = null;

vi.mock("@/components/map/MapCanvas", () => ({
  TARMOTO_QUALITY_LAYER: "tarmoto-quality",
  TARMOTO_ROAD_HIT_LAYER: "tarmoto-road-hit",
  TARMOTO_SURFACE_LAYER: "tarmoto-surface",
  SURFACE_COLORS: {
    asphalt: "#3B82F6",
    concrete: "#6B7280",
    cobblestone: "#A78BFA",
    gravel: "#D97706",
    dirt: "#92400E",
    unknown: "#64748B",
  },
  MapCanvas: forwardRef(function MockMapCanvas(
    props: {
      showQuality: boolean;
      showSurface: boolean;
      onReady?: (map: typeof mockMap) => void;
      children?: React.ReactNode;
    },
    ref: React.ForwardedRef<{ map: typeof mockMap | null }>,
  ) {
    useImperativeHandle(ref, () => ({
      map: mockMap,
    }));

    useEffect(() => {
      props.onReady?.(mockMap);
    }, [props]);

    return (
      <div
        data-testid="planner-map-canvas"
        data-show-quality={String(props.showQuality)}
        data-show-surface={String(props.showSurface)}
      >
        {props.children}
      </div>
    );
  }),
}));

vi.mock("@/components/map/RegionDrawControl", () => ({
  createRegionDrawControl: vi.fn((_map, options) => {
    lastDrawOptions = options;
    return drawControl;
  }),
}));

// Controllable road-quality zoom cap for the tap-for-detail gate. Unlimited by
// default (maxzoom 18) so pre-existing tap-for-detail tests are unaffected.
const zoomCap = vi.hoisted(() => ({
  limit: null as number | null,
  isResolved: true,
}));
const aerialSwitch = vi.hoisted(() => ({ enabled: true }));
vi.mock("@/hooks", () => ({
  useRoadQualityZoomCap: () => ({
    limit: zoomCap.limit,
    isResolved: zoomCap.isResolved,
  }),
  useSystemSwitch: () => ({
    enabled: aerialSwitch.enabled,
    isResolved: true,
  }),
}));

vi.mock("@/hooks/useClosures", () => ({
  useClosures: vi.fn(),
}));

vi.mock("@/hooks/usePasses", () => ({
  usePasses: vi.fn(),
}));

vi.mock("@/lib/closures-summary", async () => {
  const actual = await vi.importActual<typeof import("@/lib/closures-summary")>(
    "@/lib/closures-summary",
  );

  return {
    ...actual,
    buildTripClosureRoutes: vi.fn(actual.buildTripClosureRoutes),
  };
});

vi.mock("@/lib/discover", () => ({
  fetchFunZonesInBbox: vi.fn(),
  fetchFunZoneDetail: vi.fn(),
}));

// Category POIs now come from the offline store (`/poi/in-bbox`, #856) instead
// of the mock fixtures. Return one viewpoint when it's requested so the
// viewport-fetch scenario still has a pin to click; empty otherwise so other
// tests don't get unexpected pins.
vi.mock("@/lib/api", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/api")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      // Planner waypoint search + pin naming now hit the real geocode
      // endpoints; return a deterministic Jihlava match so the address-search
      // test doesn't depend on a live Nominatim. Other paths (incl. reverse)
      // resolve empty, which the seam turns into a coordinate label.
      GET: vi.fn(async (path: string) => {
        if (path === "/api/v1/geocode") {
          return {
            data: {
              results: [
                {
                  label: "Jihlava",
                  lat: 49.3961,
                  lng: 15.5912,
                  importance: 0.7,
                },
              ],
            },
            error: undefined,
          };
        }
        return { data: undefined, error: undefined };
      }),
    },
    poiApi: {
      ...actual.poiApi,
      getInBbox: vi.fn(async (params: { kinds?: string[] }) => ({
        data: {
          count: params.kinds?.includes("viewpoint") ? 1 : 0,
          pois: params.kinds?.includes("viewpoint")
            ? [
                {
                  id: "view-vysocina-1",
                  source: "osm",
                  external_id: "osm:node:100",
                  name: "Devět skal vista",
                  kind: "viewpoint",
                  lat: 49.66,
                  lng: 15.93,
                  website: null,
                  phone: null,
                  opening_hours: null,
                  address_street: null,
                  address_city: null,
                  address_postcode: null,
                  address_country: null,
                  cuisine: null,
                  brand: null,
                  stars: null,
                  osm_url: "https://www.openstreetmap.org/node/100",
                  maps_url:
                    "https://www.google.com/maps/search/?api=1&query=devet-skal",
                  last_imported_at: "2026-07-06T00:00:00.000Z",
                },
              ]
            : [],
        },
      })),
    },
  };
});

function trip(): Trip {
  return {
    id: "trip-1",
    name: "Planner test trip",
    status: "draft",
    num_days: 1,
    createdAt: "2026-04-01T09:00:00Z",
    updatedAt: "2026-04-14T09:00:00Z",
    parameters: {
      days: 1,
      dailyKmTarget: 240,
      roadPreference: "curvy",
      surfacePreference: ["asphalt"],
      avoidHighways: true,
      avoidTolls: false,
      avoidUnpaved: true,
      minQuality: 3,
    },
    collaborators: [],
    days: [
      {
        dayNumber: 1,
        title: "Day one",
        distanceKm: 120,
        durationMinutes: 180,
        elevationGain: 800,
        avgQuality: 4.1,
        waypoints: [
          {
            id: "start-1",
            name: "Start",
            location: { lng: 14.41, lat: 50.08 },
            type: "start",
          },
          {
            id: "end-1",
            name: "End",
            location: { lng: 14.61, lat: 50.19 },
            type: "end",
          },
        ],
        routeGeometry: {
          type: "LineString",
          coordinates: [
            [14.41, 50.08],
            [14.49, 50.12],
            [14.61, 50.19],
          ],
        },
      },
    ],
  };
}

describe("TripPlannerMap", () => {
  const useClosuresMock = vi.mocked(useClosures);
  const usePassesMock = vi.mocked(usePasses);
  const buildTripClosureRoutesMock = vi.mocked(buildTripClosureRoutes);

  beforeEach(() => {
    vi.useRealTimers();
    vi.mocked(createRegionDrawControl).mockClear();
    lastDrawOptions = null;
    drawControl.start.mockReset();
    drawControl.cancel.mockReset();
    drawControl.clearDrawn.mockReset();
    // Mirror production: clearDrawn() fires the onRegionCleared
    // callback so consumers don't need to reset their own state.
    drawControl.clearDrawn.mockImplementation(() => {
      lastDrawOptions?.onRegionCleared?.();
    });
    drawControl.setDrawn.mockReset();
    drawControl.destroy.mockReset();
    drawControl.hitTest.mockReset();
    drawControl.hitTest.mockReturnValue(false);
    drawControl.getMode.mockReturnValue("idle");
    mockMap.addSource.mockReset();
    mockMap.getSource.mockReset();
    mockMap.addLayer.mockReset();
    mockMap.getLayer.mockReset();
    mockMap.getLayer.mockImplementation((id) =>
      id === "fun-zones-selected" ? ({ id } as never) : undefined,
    );
    mockMap.getStyle.mockReset();
    // No basemap POI layers by default — tests that need them override this.
    mockMap.getStyle.mockReturnValue({ layers: [] });
    mockMap.on.mockReset();
    mockMap.off.mockReset();
    // Reset the tap-for-detail cap gate to its permissive default.
    zoomCap.limit = null;
    zoomCap.isResolved = true;
    aerialSwitch.enabled = true;
    plannerZoom = 12;
    mockMap.getZoom.mockReset();
    mockMap.getZoom.mockImplementation(() => plannerZoom);
    mockMap.queryRenderedFeatures.mockReset();
    mockMap.querySourceFeatures.mockReset();
    mockMap.setPaintProperty.mockReset();
    mockMap.setLayoutProperty.mockReset();
    mockMap.setFilter.mockReset();
    mockMap.fitBounds.mockReset();
    mockMap.unproject.mockReset();
    mockMap.unproject.mockImplementation((point: [number, number]) => ({
      lng: point[0] / 100,
      lat: point[1] / 100,
    }));
    vi.mock("@/hooks/useEntitlements", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@/hooks/useEntitlements")>()),
      // Operator kill switches fail SAFE (enabled until a confirmed `force_off`),
      // so this mirrors the production default and keeps every existing case
      // exercising the path it was written for. The switch has its own tests.
      useFeatureKillSwitch: () => ({ enabled: true, isResolved: true }),
    }));
    mockCanvas.style.cursor = "";
    buildTripClosureRoutesMock.mockClear();
    useClosuresMock.mockReset();
    useClosuresMock.mockReturnValue({
      closures: [],
      routeClosures: [],
      counts: { full: 0, partial: 0, advisory: 0, total: 0 },
      routeCounts: { full: 0, partial: 0, advisory: 0, total: 0 },
      loading: false,
      routeLoading: false,
      error: null,
      routeError: null,
      previewDate: new Date("2026-07-15T12:00:00Z"),
    });
    usePassesMock.mockReset();
    usePassesMock.mockReturnValue({
      passes: [],
      routePasses: [],
      routeClosedCount: 0,
      routeUnknownCount: 0,
      loading: false,
      routeLoading: false,
      error: null,
      routeError: null,
    });
    vi.mocked(fetchFunZonesInBbox).mockReset();
    vi.mocked(fetchFunZoneDetail).mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("switches the line-coloring mode between road quality and surface", () => {
    // The recolor effect no-ops unless the route layer exists on the map.
    mockMap.getLayer.mockImplementation((layerId: string) =>
      layerId === "trip-planner-route-line" ? { id: layerId } : undefined,
    );
    render(<TripPlannerMap trip={trip()} month={7} />);

    // Quality is the default mode; the tile overlay follows the mode.
    const canvas = screen.getByTestId("planner-map-canvas");
    expect(canvas).toHaveAttribute("data-show-quality", "true");
    expect(canvas).toHaveAttribute("data-show-surface", "false");

    fireEvent.click(
      screen.getByRole("button", { name: "Colour the route line by surface" }),
    );
    expect(canvas).toHaveAttribute("data-show-quality", "false");
    expect(canvas).toHaveAttribute("data-show-surface", "true");
    // The route line itself recolors via a surface match expression.
    const lineColorCalls = mockMap.setPaintProperty.mock.calls.filter(
      ([layerId, prop]) =>
        layerId === "trip-planner-route-line" && prop === "line-color",
    );
    expect(lineColorCalls.at(-1)?.[2]?.[1]).toEqual(["get", "surface"]);

    fireEvent.click(
      screen.getByRole("button", {
        name: "Colour the route line by road quality",
      }),
    );
    expect(canvas).toHaveAttribute("data-show-quality", "true");
    expect(canvas).toHaveAttribute("data-show-surface", "false");
  });

  it("toggles the active line-coloring mode off entirely on re-click", () => {
    mockMap.getLayer.mockImplementation((layerId: string) =>
      layerId === "trip-planner-route-line" ||
      layerId === "trip-planner-route-overview-line"
        ? { id: layerId }
        : undefined,
    );
    render(<TripPlannerMap trip={trip()} month={7} />);

    const canvas = screen.getByTestId("planner-map-canvas");
    const qualityButton = screen.getByRole("button", {
      name: "Colour the route line by road quality",
    });
    expect(qualityButton).toHaveAttribute("aria-pressed", "true");
    // The route legend for the active mode is visible while quality is on.
    expect(screen.getByText("Good+")).toBeInTheDocument();

    // Re-clicking the active mode disables the layer: no tile overlays,
    // neutral ink route line, and the legend info box disappears.
    fireEvent.click(qualityButton);
    expect(qualityButton).toHaveAttribute("aria-pressed", "false");
    expect(canvas).toHaveAttribute("data-show-quality", "false");
    expect(canvas).toHaveAttribute("data-show-surface", "false");
    const lineColorCalls = mockMap.setPaintProperty.mock.calls.filter(
      ([layerId, prop]) =>
        layerId === "trip-planner-route-line" && prop === "line-color",
    );
    expect(lineColorCalls.at(-1)?.[2]).toBe("#0E0E10");
    const overviewColorCalls = mockMap.setPaintProperty.mock.calls.filter(
      ([layerId, prop]) =>
        layerId === "trip-planner-route-overview-line" && prop === "line-color",
    );
    expect(overviewColorCalls.at(-1)?.[2]).toBe("#0E0E10");
    expect(screen.queryByText("Good+")).not.toBeInTheDocument();

    // Clicking it again re-enables the layer.
    fireEvent.click(qualityButton);
    expect(qualityButton).toHaveAttribute("aria-pressed", "true");
    expect(canvas).toHaveAttribute("data-show-quality", "true");
    expect(screen.getByText("Good+")).toBeInTheDocument();
  });

  it("swaps to the aerial basemap independently of the coloring mode", () => {
    // setAerialBasemapVisible no-ops unless the aerial layer exists.
    mockMap.getLayer.mockImplementation((layerId: string) =>
      layerId === "planner-aerial" ? { id: layerId } : undefined,
    );
    render(<TripPlannerMap trip={trip()} month={7} />);

    const canvas = screen.getByTestId("planner-map-canvas");
    fireEvent.click(screen.getByRole("button", { name: "Aerial" }));

    // Aerial raster becomes visible…
    expect(mockMap.setLayoutProperty).toHaveBeenCalledWith(
      "planner-aerial",
      "visibility",
      "visible",
    );
    // …and the all-roads tile overlays are hidden over imagery, while the
    // coloring mode itself is untouched (still quality).
    expect(canvas).toHaveAttribute("data-show-quality", "false");
    expect(canvas).toHaveAttribute("data-show-surface", "false");

    fireEvent.click(screen.getByRole("button", { name: "Map" }));
    expect(mockMap.setLayoutProperty).toHaveBeenLastCalledWith(
      "planner-aerial",
      "visibility",
      "none",
    );
    expect(canvas).toHaveAttribute("data-show-quality", "true");
  });

  it("hides the aerial toggle and keeps the base map on 'map' when sys_aerial_basemap is killed", () => {
    aerialSwitch.enabled = false;
    mockMap.getLayer.mockImplementation((layerId: string) =>
      layerId === "planner-aerial" ? { id: layerId } : undefined,
    );
    render(<TripPlannerMap trip={trip()} month={7} />);

    // No Map/Aerial toggle at all.
    expect(
      screen.queryByRole("group", { name: "Basemap" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Aerial" }),
    ).not.toBeInTheDocument();
    // The aerial raster is forced hidden and the quality line stays drawn.
    expect(mockMap.setLayoutProperty).toHaveBeenCalledWith(
      "planner-aerial",
      "visibility",
      "none",
    );
    expect(screen.getByTestId("planner-map-canvas")).toHaveAttribute(
      "data-show-quality",
      "true",
    );
  });

  describe("tap-for-detail quality zoom cap gate", () => {
    const tapEvent = {
      point: { x: 100, y: 100 },
      originalEvent: { clientX: 100, clientY: 100 },
    };
    // Passing closuresData + passesData routes through the direct
    // TripPlannerMapContent branch, which forwards onOpenSegmentDetail (the
    // fetched branch drops it).
    const closuresData = {
      closures: [],
      routeClosures: [],
      counts: { full: 0, partial: 0, advisory: 0, total: 0 },
      routeCounts: { full: 0, partial: 0, advisory: 0, total: 0 },
      loading: false,
      routeLoading: false,
      error: null,
      routeError: null,
      previewDate: new Date("2026-07-15T12:00:00Z"),
    } as never;
    const passesData = {
      passes: [],
      routePasses: [],
      routeClosedCount: 0,
      routeUnknownCount: 0,
      loading: false,
      routeLoading: false,
      error: null,
      routeError: null,
    } as never;
    // Capture the MAP-LEVEL click handlers (second arg is a function, not a
    // layer id). The tap-for-detail handler is the FIRST one registered.
    function captureMapClick() {
      const handlers: Array<(e: unknown) => void> = [];
      mockMap.on.mockImplementation((event, layerOrHandler) => {
        if (event === "click" && typeof layerOrHandler === "function") {
          handlers.push(layerOrHandler as (e: unknown) => void);
        }
        return mockMap;
      });
      mockMap.off.mockImplementation(() => mockMap);
      return () => handlers;
    }

    // handleReady must complete (so the region-draw control is created and the
    // handler's `idle` guard passes) — hence getLayer truthy for all. The blocking
    // query returns nothing; the overlay hit query returns one segment.
    function primeSegmentHit() {
      mockMap.getLayer.mockReturnValue({ id: "x" } as never);
      mockMap.queryRenderedFeatures.mockImplementation(
        (_pt: unknown, opts?: { layers?: string[] }) => {
          const layers = opts?.layers ?? [];
          return (
            layers.includes("tarmoto-road-hit") ||
            layers.includes("tarmoto-surface")
              ? [
                  {
                    properties: { id: "seg-1" },
                    geometry: { type: "LineString", coordinates: [] },
                  },
                ]
              : []
          ) as never;
        },
      );
    }

    it("does NOT open the segment detail drawer past the resolved quality cap", () => {
      zoomCap.limit = 12; // finite → overlay maxzoom 12
      plannerZoom = 14; // past the cap — overlay hidden
      primeSegmentHit();
      const onOpenSegmentDetail = vi.fn();
      const getHandlers = captureMapClick();
      render(
        <TripPlannerMap
          trip={trip()}
          month={7}
          closuresData={closuresData}
          passesData={passesData}
          onMoveWaypoint={vi.fn()}
          onOpenSegmentDetail={onOpenSegmentDetail}
        />,
      );
      act(() => getHandlers().forEach((h) => h(tapEvent)));
      // Snapping still uses the uncapped layer, but the gated quality detail
      // must not open past the cap (the gate returns before the overlay query).
      expect(onOpenSegmentDetail).not.toHaveBeenCalled();
    });

    it("opens the segment detail drawer below the cap", () => {
      zoomCap.limit = 12;
      plannerZoom = 11; // below the cap — overlay visible
      primeSegmentHit();
      const onOpenSegmentDetail = vi.fn();
      const getHandlers = captureMapClick();
      render(
        <TripPlannerMap
          trip={trip()}
          month={7}
          closuresData={closuresData}
          passesData={passesData}
          onMoveWaypoint={vi.fn()}
          onOpenSegmentDetail={onOpenSegmentDetail}
        />,
      );
      act(() => getHandlers().forEach((h) => h(tapEvent)));
      expect(onOpenSegmentDetail).toHaveBeenCalledWith("seg-1");
    });
  });

  describe("basemap (OpenStreetMap) POIs", () => {
    const POI_LAYER = "poi_label";
    const namedPoiClick = {
      features: [
        {
          geometry: { type: "Point", coordinates: [16.6, 49.2] },
          properties: { name: "Zbýšov", class: "railway", subclass: "station" },
        },
      ],
      point: { x: 100, y: 100 },
      originalEvent: { clientX: 100, clientY: 100 },
    };

    // Capture the layer-specific `click` handlers handleReady registers.
    function captureLayerClicks() {
      const clicks = new Map<string, (event: unknown) => void>();
      mockMap.on.mockImplementation((event, layerOrHandler, maybeHandler) => {
        if (
          event === "click" &&
          typeof layerOrHandler === "string" &&
          typeof maybeHandler === "function"
        ) {
          clicks.set(layerOrHandler, maybeHandler as (e: unknown) => void);
        }
        return mockMap;
      });
      mockMap.off.mockImplementation(() => mockMap);
      return clicks;
    }
    function withBasemapPoiLayer() {
      mockMap.getStyle.mockReturnValue({
        layers: [{ id: POI_LAYER, type: "symbol", "source-layer": "poi" }],
      });
    }

    it("opens the shared place card with add-as-stop on the editable planner", () => {
      withBasemapPoiLayer();
      mockMap.queryRenderedFeatures.mockReturnValue([]); // no markers under cursor
      const clicks = captureLayerClicks();
      render(
        <TripPlannerMap trip={trip()} month={7} onMoveWaypoint={vi.fn()} />,
      );
      act(() => clicks.get(POI_LAYER)?.(namedPoiClick));
      expect(screen.getByText("Zbýšov")).toBeInTheDocument();
      expect(screen.getByText("Station")).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: /add as via/i }),
      ).toBeInTheDocument();
    });

    it("is info-only (no placement actions) on a read-only preview", () => {
      withBasemapPoiLayer();
      mockMap.queryRenderedFeatures.mockReturnValue([]);
      const clicks = captureLayerClicks();
      render(<TripPlannerMap trip={trip()} month={7} />); // no onMoveWaypoint
      act(() => clicks.get(POI_LAYER)?.(namedPoiClick));
      expect(screen.getByText("Zbýšov")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /add as via/i })).toBeNull();
    });

    it("yields to our own markers under the cursor (no place card)", () => {
      withBasemapPoiLayer();
      // A marker layer is present AND a feature is under the cursor.
      mockMap.getLayer.mockReturnValue({} as never);
      mockMap.queryRenderedFeatures.mockReturnValue([{ properties: {} }]);
      const clicks = captureLayerClicks();
      render(
        <TripPlannerMap trip={trip()} month={7} onMoveWaypoint={vi.fn()} />,
      );
      act(() => clicks.get(POI_LAYER)?.(namedPoiClick));
      expect(screen.queryByText("Zbýšov")).toBeNull();
    });

    const unnamedParkingClick = {
      features: [
        {
          geometry: { type: "Point", coordinates: [16.6, 49.2] },
          properties: { class: "amenity", subclass: "parking" },
        },
      ],
      point: { x: 100, y: 100 },
      originalEvent: { clientX: 100, clientY: 100 },
    };

    it("opens an unnamed POI titled by its category", () => {
      withBasemapPoiLayer();
      mockMap.queryRenderedFeatures.mockReturnValue([]);
      const clicks = captureLayerClicks();
      render(
        <TripPlannerMap trip={trip()} month={7} onMoveWaypoint={vi.fn()} />,
      );
      act(() => clicks.get(POI_LAYER)?.(unnamedParkingClick));
      expect(screen.getByText("Parking")).toBeInTheDocument();
    });

    it("adds an unnamed POI as a waypoint named by its category", () => {
      withBasemapPoiLayer();
      mockMap.queryRenderedFeatures.mockReturnValue([]);
      useTripStore.setState({ activeTrip: trip(), selectedDayIndex: 0 });
      const clicks = captureLayerClicks();
      render(
        <TripPlannerMap trip={trip()} month={7} onMoveWaypoint={vi.fn()} />,
      );
      act(() => clicks.get(POI_LAYER)?.(unnamedParkingClick));
      fireEvent.click(screen.getByRole("button", { name: /Add as via/ }));
      const waypoints =
        useTripStore.getState().activeTrip?.days[0]?.waypoints ?? [];
      // No blank name — the category becomes the saved waypoint's name.
      expect(waypoints.find((w) => w.type === "via")?.name).toBe("Parking");
    });

    it("preserves a basemap source name that resembles a legacy via role", () => {
      withBasemapPoiLayer();
      mockMap.queryRenderedFeatures.mockReturnValue([]);
      useTripStore.setState({ activeTrip: trip(), selectedDayIndex: 0 });
      const clicks = captureLayerClicks();
      render(
        <TripPlannerMap trip={trip()} month={7} onMoveWaypoint={vi.fn()} />,
      );
      act(() =>
        clicks.get(POI_LAYER)?.({
          ...namedPoiClick,
          features: [
            {
              ...namedPoiClick.features[0],
              properties: {
                ...namedPoiClick.features[0]!.properties,
                name: "Via 1",
              },
            },
          ],
        }),
      );
      fireEvent.click(screen.getByRole("button", { name: /Add as via/ }));

      const inserted = useTripStore
        .getState()
        .activeTrip?.days[0]?.waypoints.find(
          (waypoint) => waypoint.name === "Via 1",
        );
      expect(inserted?.nameIsSource).toBe(true);
      expect(
        useTripStore
          .getState()
          .saveWaypoints()
          .find((waypoint) => waypoint.name === "Via 1")?.name,
      ).toBe("Via 1");
    });

    it("closes the place card when another marker opens its popover", () => {
      withBasemapPoiLayer();
      mockMap.queryRenderedFeatures.mockReturnValue([]);
      const clicks = captureLayerClicks();
      render(
        <TripPlannerMap trip={trip()} month={7} onMoveWaypoint={vi.fn()} />,
      );
      act(() => clicks.get(POI_LAYER)?.(namedPoiClick));
      expect(screen.getByText("Zbýšov")).toBeInTheDocument();
      // Opening a hazard popover must replace the place card (one active menu).
      act(() =>
        clicks.get("tarmoto-hazard-bg")?.({
          features: [
            {
              geometry: { type: "Point", coordinates: [16.7, 49.3] },
              properties: {
                hazard_type: "pothole",
                severity: "high",
                confirmations: 0,
                created_at: "2026-05-01T10:00:00.000Z",
              },
            },
          ],
          point: { x: 120, y: 120 },
          originalEvent: { clientX: 120, clientY: 120 },
        }),
      );
      expect(screen.queryByText("Zbýšov")).toBeNull();
    });
  });

  it("snaps right-click contextmenu onto nearby road geometry before showing the placement menu", () => {
    // Road snap is now triggered by contextmenu (right-click), not left-click.
    const eventHandlers = new Map<string, (event: unknown) => void>();
    mockMap.on.mockImplementation((event, layerOrHandler, maybeHandler) => {
      if (typeof layerOrHandler === "string") return mockMap;
      eventHandlers.set(
        event,
        (maybeHandler ?? layerOrHandler) as (event: unknown) => void,
      );
      return mockMap;
    });
    mockMap.off.mockImplementation((event) => {
      eventHandlers.delete(event);
      return mockMap;
    });
    mockMap.queryRenderedFeatures.mockReturnValue([
      {
        geometry: {
          type: "LineString",
          coordinates: [
            [14.41, 50.1],
            [14.47, 50.1],
          ],
        },
        properties: {
          quality_score: 4.5,
        },
      },
    ]);

    render(<TripPlannerMap trip={trip()} month={7} onMoveWaypoint={vi.fn()} />);

    act(() => {
      eventHandlers.get("contextmenu")?.({
        preventDefault: vi.fn(),
        point: { x: 180, y: 140 },
        lngLat: { lng: 14.435, lat: 50.106 },
        // Real MapLibre MapMouseEvent carries the DOM event; the menu is
        // positioned from its viewport clientX/clientY.
        originalEvent: { clientX: 180, clientY: 140 },
      });
    });

    // The context menu should appear with a snapped coord rendered in the DOM.
    // (The menu items are always rendered; snap happens silently in state.)
    expect(screen.getByRole("menu")).toBeInTheDocument();
    // queryRenderedFeatures was called for snap — confirm road-snap path ran.
    expect(mockMap.queryRenderedFeatures).toHaveBeenCalled();
  });

  it("bases the placement menu on the SELECTED day, not day 0", () => {
    const eventHandlers = new Map<string, (event: unknown) => void>();
    mockMap.on.mockImplementation((event, layerOrHandler, maybeHandler) => {
      if (typeof layerOrHandler === "string") return mockMap;
      eventHandlers.set(
        event,
        (maybeHandler ?? layerOrHandler) as (event: unknown) => void,
      );
      return mockMap;
    });
    mockMap.off.mockImplementation((event) => {
      eventHandlers.delete(event);
      return mockMap;
    });
    mockMap.queryRenderedFeatures.mockReturnValue([]);

    // Day 1 is complete (start + end); day 2 is empty. With Day 2 selected, the
    // menu must offer "Set start here" — NOT day 1's "Set as new start".
    useTripStore.setState({
      activeTrip: {
        id: "t-2day",
        name: "Two day",
        status: "draft",
        num_days: 2,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        parameters: {
          days: 2,
          dailyKmTarget: 250,
          roadPreference: "mixed",
          surfacePreference: ["asphalt"],
          avoidHighways: true,
          avoidTolls: false,
          avoidUnpaved: true,
          minQuality: 3,
        },
        collaborators: [{ userId: "u", displayName: "You", role: "owner" }],
        days: [
          {
            dayNumber: 1,
            waypoints: [
              {
                id: "w1",
                type: "start",
                name: "Start",
                location: { lng: 14.4, lat: 50.1 },
              },
              {
                id: "w2",
                type: "end",
                name: "End",
                location: { lng: 14.5, lat: 50.2 },
              },
            ],
            distanceKm: 0,
            durationMinutes: 0,
            elevationGain: 0,
            avgQuality: 0,
            segments: [],
          },
          {
            dayNumber: 2,
            waypoints: [],
            distanceKm: 0,
            durationMinutes: 0,
            elevationGain: 0,
            avgQuality: 0,
            segments: [],
          },
        ],
      } as never,
    });

    render(
      <TripPlannerMap
        trip={trip()}
        month={7}
        selectedDayNumber={2}
        onMoveWaypoint={vi.fn()}
      />,
    );

    act(() => {
      eventHandlers.get("contextmenu")?.({
        preventDefault: vi.fn(),
        point: { x: 180, y: 140 },
        lngLat: { lng: 14.435, lat: 50.106 },
        originalEvent: { clientX: 180, clientY: 140 },
      });
    });

    expect(screen.getByText("Set start here")).toBeInTheDocument();
    expect(screen.queryByText("Set as new start")).not.toBeInTheDocument();
  });

  it("does not install the placement context menu on a read-only (non-editable) map", () => {
    // A read-only map (e.g. the trip-detail page) passes no onMoveWaypoint, so
    // the placement listeners must NOT install — a right-click there must not
    // open the menu / mutate the shared trip store.
    const eventHandlers = new Map<string, (event: unknown) => void>();
    mockMap.on.mockImplementation((event, layerOrHandler, maybeHandler) => {
      if (typeof layerOrHandler === "string") return mockMap;
      eventHandlers.set(
        event,
        (maybeHandler ?? layerOrHandler) as (event: unknown) => void,
      );
      return mockMap;
    });

    render(<TripPlannerMap trip={trip()} month={7} />);

    expect(eventHandlers.has("contextmenu")).toBe(false);
  });

  it("shows the map toolbar (search + POI chips) only on editable maps", () => {
    const { unmount } = render(
      <TripPlannerMap trip={trip()} month={7} onMoveWaypoint={vi.fn()} />,
    );
    expect(screen.getByLabelText("Address search")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Twisty highlights/ }),
    ).toBeInTheDocument();
    unmount();

    render(<TripPlannerMap trip={trip()} month={7} />);
    expect(screen.queryByLabelText("Address search")).toBeNull();
    expect(
      screen.queryByRole("button", { name: /Twisty highlights/ }),
    ).toBeNull();
  });

  it("searchAndPois shows the toolbar on a read-only map with an info-only POI popover", () => {
    // Trip preview: the toolbar renders for browsing, but picking a POI
    // pin must never offer route mutations — the popover keeps the info
    // header (and Maps link) only.
    const ref = createRef<TripPlannerMapHandle>();
    render(<TripPlannerMap ref={ref} trip={trip()} month={7} searchAndPois />);

    expect(screen.getByLabelText("Address search")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Twisty highlights/ }),
    ).toBeInTheDocument();

    act(() =>
      ref.current?.openPoiPopover({
        id: "fuel-1",
        name: "ONO Brno",
        category: "fuel",
        source: "osm",
        lat: 49.2,
        lng: 16.6,
      }),
    );
    expect(screen.getByText("ONO Brno")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Add as via/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Set as start/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Set as finish/ })).toBeNull();
  });

  it("POI chips are multi-select and drive the SHARED store slice", () => {
    render(<TripPlannerMap trip={trip()} month={7} onMoveWaypoint={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: /^Fuel/ }));
    fireEvent.click(screen.getByRole("button", { name: /Mountain passes/ }));

    const active = useTripStore.getState().activePoiCategories;
    expect(active.has("fuel")).toBe(true);
    expect(active.has("mountain_pass")).toBe(true);
    expect(screen.getByRole("button", { name: /^Fuel/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("fetches category POIs for the viewport, opens the pin popover and adds a via BEFORE any route exists", async () => {
    const layerHandlers = new Map<string, (event: unknown) => void>();
    mockMap.on.mockImplementation((event, layerOrHandler, maybeHandler) => {
      if (typeof layerOrHandler === "string" && maybeHandler) {
        layerHandlers.set(
          `${event}:${layerOrHandler}`,
          maybeHandler as (event: unknown) => void,
        );
      }
      return mockMap;
    });
    const setData = vi.fn();
    mockMap.getSource.mockReturnValue({ setData } as never);
    // Only start + finish, NO route geometry — the §E critical scenario.
    const bareTrip = {
      ...trip(),
      days: [{ ...trip().days[0]!, routeGeometry: undefined, segments: [] }],
    };
    useTripStore.setState({
      activeTrip: bareTrip,
      selectedDayIndex: 0,
      activePoiCategories: new Set(["viewpoint"]),
    });

    const { rerender } = render(
      <TripPlannerMap trip={bareTrip} month={7} onMoveWaypoint={vi.fn()} />,
    );

    // Debounced viewport fetch lands in the clustered source.
    await waitFor(
      () =>
        expect(setData).toHaveBeenCalledWith(
          expect.objectContaining({
            features: expect.arrayContaining([
              expect.objectContaining({
                properties: expect.objectContaining({
                  category: "viewpoint",
                  poiId: "view-vysocina-1",
                }),
              }),
            ]),
          }),
        ),
      { timeout: 2000 },
    );

    // Pin click -> popover with name, provenance and Add as via.
    act(() => {
      layerHandlers.get("click:trip-planner-poi-pins")?.({
        features: [{ properties: { poiId: "view-vysocina-1" } }],
        originalEvent: { clientX: 320, clientY: 240 },
      });
    });
    expect(screen.getByText("Devět skal vista")).toBeInTheDocument();
    expect(
      screen.getByText(/Sights & viewpoints · OpenStreetMap/i),
    ).toBeInTheDocument();
    // The popover offers all three roles (rider feedback), not just via.
    expect(
      screen.getByRole("button", { name: "Set as start" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Set as finish" }),
    ).toBeInTheDocument();

    // The popover surfaces the Google Maps detail link (#872) so web riders
    // can open photos / reviews — critical for this contactless viewpoint
    // (no website, no phone) that the backend now keeps because maps_url
    // makes it actionable.
    const mapsLink = screen.getByRole("link", {
      name: /View on Google Maps/i,
    });
    expect(mapsLink).toHaveAttribute(
      "href",
      "https://www.google.com/maps/search/?api=1&query=devet-skal",
    );
    expect(mapsLink).toHaveAttribute("target", "_blank");

    fireEvent.click(screen.getByRole("button", { name: /Add as via/ }));

    const waypoints =
      useTripStore.getState().activeTrip?.days[0]?.waypoints ?? [];
    expect(waypoints.map((w) => w.type)).toEqual(["start", "via", "end"]);
    expect(waypoints[1]?.name).toBe("Devět skal vista");

    // A placed POI renders ONLY as its waypoint circle — the refetch
    // drops its POI pin so two pins never stack (rider feedback). The
    // page re-renders the map with the updated trip; mirror that here.
    setData.mockClear();
    rerender(
      <TripPlannerMap
        trip={useTripStore.getState().activeTrip}
        month={7}
        onMoveWaypoint={vi.fn()}
      />,
    );
    await waitFor(
      () => {
        expect(setData).toHaveBeenCalled();
        const lastCall = setData.mock.calls.at(-1)?.[0] as {
          features: Array<{ properties: { poiId: string } }>;
        };
        expect(
          lastCall.features.some(
            (f) => f.properties.poiId === "view-vysocina-1",
          ),
        ).toBe(false);
      },
      { timeout: 2000 },
    );
  });

  it("address search flies to the pick and opens the placement menu instead of placing", async () => {
    useTripStore.setState({ activeTrip: trip(), selectedDayIndex: 0 });
    render(<TripPlannerMap trip={trip()} month={7} onMoveWaypoint={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("Address search"), {
      target: { value: "Jihlava" },
    });
    const option = await screen.findByRole(
      "option",
      { name: /Jihlava/ },
      { timeout: 2000 },
    );
    fireEvent.click(option);

    // Nothing placed — the rider decides the role in the menu.
    expect(useTripStore.getState().activeTrip?.days[0]?.waypoints).toEqual(
      trip().days[0]!.waypoints,
    );
    expect(mockMap.flyTo).toHaveBeenCalledWith(
      expect.objectContaining({
        center: [15.5912, 49.3961],
        duration: 1200,
      }),
    );
    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(screen.getByText("Set start here")).toBeInTheDocument();
    expect(screen.getByText("Add via here")).toBeInTheDocument();
    expect(screen.getByText("Set end here")).toBeInTheDocument();
  });

  it("opens the point dialog on LEFT click of a plain waypoint", () => {
    const layerHandlers = new Map<string, (event: unknown) => void>();
    mockMap.on.mockImplementation((event, layerOrHandler, maybeHandler) => {
      if (typeof layerOrHandler === "string" && maybeHandler) {
        layerHandlers.set(
          `${event}:${layerOrHandler}`,
          maybeHandler as (event: unknown) => void,
        );
      }
      return mockMap;
    });

    render(<TripPlannerMap trip={trip()} month={7} onMoveWaypoint={vi.fn()} />);

    act(() => {
      layerHandlers.get("click:trip-planner-waypoint-pin")?.({
        features: [
          {
            properties: {
              waypointId: "wp-1",
              waypointType: "start",
              label: "Bormio",
            },
            geometry: { type: "Point", coordinates: [10.37, 46.47] },
          },
        ],
        lngLat: { lng: 10.37, lat: 46.47 },
        originalEvent: { clientX: 200, clientY: 200 },
      });
    });

    expect(
      screen.getByRole("dialog", { name: "Waypoint details" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Bormio")).toBeInTheDocument();
  });

  it("reopens the POI popover from a placed waypoint and offers Remove from route", () => {
    const layerHandlers = new Map<string, (event: unknown) => void>();
    mockMap.on.mockImplementation((event, layerOrHandler, maybeHandler) => {
      if (typeof layerOrHandler === "string" && maybeHandler) {
        layerHandlers.set(
          `${event}:${layerOrHandler}`,
          maybeHandler as (event: unknown) => void,
        );
      }
      return mockMap;
    });
    const onRemoveWaypoint = vi.fn();

    render(
      <TripPlannerMap
        trip={trip()}
        month={7}
        onMoveWaypoint={vi.fn()}
        onRemoveWaypoint={onRemoveWaypoint}
      />,
    );

    act(() => {
      layerHandlers.get("click:trip-planner-waypoint-pin")?.({
        features: [
          {
            properties: {
              waypointId: "poi-view-vysocina-1-1751700000000",
              poiCategory: "viewpoint",
              label: "Devět skal vista",
            },
            geometry: { type: "Point", coordinates: [16.0369, 49.6395] },
          },
        ],
        lngLat: { lng: 16.0369, lat: 49.6395 },
        originalEvent: { clientX: 400, clientY: 300 },
      });
    });

    expect(screen.getByText("Devět skal vista")).toBeInTheDocument();
    expect(
      screen.getByText(/Sights & viewpoints · OpenStreetMap/i),
    ).toBeInTheDocument();
    // Already placed -> remove action instead of Add as via.
    expect(screen.queryByRole("button", { name: /Add as via/ })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Remove from route" }));
    expect(onRemoveWaypoint).toHaveBeenCalledWith(
      "poi-view-vysocina-1-1751700000000",
    );
  });

  it("keeps the Google Maps link on a placed POI's popover by resolving the POI by id", async () => {
    // A placed POI is filtered out of the pin layer, so its popover is
    // reopened from the WAYPOINT pin — whose properties carry no POI meta.
    // The original POI (with its maps_url) must be resolved from the
    // retained by-id lookup, or a contactless placed POI loses its only
    // detail link.
    const layerHandlers = new Map<string, (event: unknown) => void>();
    mockMap.on.mockImplementation((event, layerOrHandler, maybeHandler) => {
      if (typeof layerOrHandler === "string" && maybeHandler) {
        layerHandlers.set(
          `${event}:${layerOrHandler}`,
          maybeHandler as (event: unknown) => void,
        );
      }
      return mockMap;
    });
    const setData = vi.fn();
    mockMap.getSource.mockReturnValue({ setData } as never);
    // Clear prior call history so the fetch wait tracks THIS test's fetch,
    // not a stale call from an earlier test (the mock impl is preserved).
    vi.mocked(poiApi.getInBbox).mockClear();

    // The viewpoint is already placed as a via — a "used" POI: dropped from
    // the pin layer but still clickable as its waypoint circle.
    const placed = trip();
    placed.days[0]!.waypoints.splice(1, 0, {
      id: "poi-view-vysocina-1-1751700000000",
      name: "Devět skal vista",
      location: { lng: 15.93, lat: 49.66 },
      type: "via",
    });
    useTripStore.setState({
      activeTrip: placed,
      selectedDayIndex: 0,
      activePoiCategories: new Set(["viewpoint"]),
    });

    render(
      <TripPlannerMap
        trip={placed}
        month={7}
        onMoveWaypoint={vi.fn()}
        onRemoveWaypoint={vi.fn()}
      />,
    );

    // Wait for the viewport POI fetch itself (setData also fires for the
    // route/waypoint sources, so it is not a reliable signal), then flush
    // its resolution so the by-id lookup is populated before the click.
    await waitFor(
      () => expect(vi.mocked(poiApi.getInBbox)).toHaveBeenCalled(),
      { timeout: 2000 },
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    act(() => {
      layerHandlers.get("click:trip-planner-waypoint-pin")?.({
        features: [
          {
            properties: {
              waypointId: "poi-view-vysocina-1-1751700000000",
              poiCategory: "viewpoint",
              label: "Devět skal vista",
            },
            geometry: { type: "Point", coordinates: [15.93, 49.66] },
          },
        ],
        lngLat: { lng: 15.93, lat: 49.66 },
        originalEvent: { clientX: 400, clientY: 300 },
      });
    });

    // Placed → Remove action, AND the Maps link resolved from the lookup.
    expect(
      screen.getByRole("button", { name: "Remove from route" }),
    ).toBeInTheDocument();
    const mapsLink = screen.getByRole("link", {
      name: /View on Google Maps/i,
    });
    expect(mapsLink).toHaveAttribute(
      "href",
      "https://www.google.com/maps/search/?api=1&query=devet-skal",
    );
  });

  it("keeps the Maps link on a POI placed as start/finish (endpoint waypoint id has no poiId)", async () => {
    // "Set as start/finish" keeps the planner endpoint id (e.g. `start-1`),
    // not `poi-<id>-...`, so the by-id lookup misses — resolve the original
    // POI by its placement coordinates instead, as usedPois already does.
    const layerHandlers = new Map<string, (event: unknown) => void>();
    mockMap.on.mockImplementation((event, layerOrHandler, maybeHandler) => {
      if (typeof layerOrHandler === "string" && maybeHandler) {
        layerHandlers.set(
          `${event}:${layerOrHandler}`,
          maybeHandler as (event: unknown) => void,
        );
      }
      return mockMap;
    });
    const setData = vi.fn();
    mockMap.getSource.mockReturnValue({ setData } as never);
    vi.mocked(poiApi.getInBbox).mockClear();

    // The viewpoint is the day's START — a used-by-coordinates POI whose
    // waypoint id is the planner endpoint id, not `poi-<id>-...`.
    const placed = trip();
    placed.days[0]!.waypoints[0] = {
      id: "start-1",
      name: "Devět skal vista",
      location: { lng: 15.93, lat: 49.66 },
      type: "start",
    };
    useTripStore.setState({
      activeTrip: placed,
      selectedDayIndex: 0,
      activePoiCategories: new Set(["viewpoint"]),
    });

    render(
      <TripPlannerMap
        trip={placed}
        month={7}
        onMoveWaypoint={vi.fn()}
        onRemoveWaypoint={vi.fn()}
      />,
    );

    await waitFor(
      () => expect(vi.mocked(poiApi.getInBbox)).toHaveBeenCalled(),
      { timeout: 2000 },
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    act(() => {
      layerHandlers.get("click:trip-planner-waypoint-pin")?.({
        features: [
          {
            properties: {
              waypointId: "start-1",
              poiCategory: "viewpoint",
              label: "Devět skal vista",
            },
            geometry: { type: "Point", coordinates: [15.93, 49.66] },
          },
        ],
        lngLat: { lng: 15.93, lat: 49.66 },
        originalEvent: { clientX: 400, clientY: 300 },
      });
    });

    const mapsLink = screen.getByRole("link", {
      name: /View on Google Maps/i,
    });
    expect(mapsLink).toHaveAttribute(
      "href",
      "https://www.google.com/maps/search/?api=1&query=devet-skal",
    );
  });

  it("keeps a placed POI's Maps link after its category is toggled off", async () => {
    // Toggling the category off calls applyPois([]); panning away drops the
    // POI from a later fetch. Either must NOT evict a still-placed POI from
    // the by-id lookup, or its waypoint popover loses the Maps link.
    const layerHandlers = new Map<string, (event: unknown) => void>();
    mockMap.on.mockImplementation((event, layerOrHandler, maybeHandler) => {
      if (typeof layerOrHandler === "string" && maybeHandler) {
        layerHandlers.set(
          `${event}:${layerOrHandler}`,
          maybeHandler as (event: unknown) => void,
        );
      }
      return mockMap;
    });
    const setData = vi.fn();
    mockMap.getSource.mockReturnValue({ setData } as never);
    vi.mocked(poiApi.getInBbox).mockClear();

    const placed = trip();
    placed.days[0]!.waypoints.splice(1, 0, {
      id: "poi-view-vysocina-1-1751700000000",
      name: "Devět skal vista",
      location: { lng: 15.93, lat: 49.66 },
      type: "via",
    });
    useTripStore.setState({
      activeTrip: placed,
      selectedDayIndex: 0,
      activePoiCategories: new Set(["viewpoint"]),
    });

    render(
      <TripPlannerMap
        trip={placed}
        month={7}
        onMoveWaypoint={vi.fn()}
        onRemoveWaypoint={vi.fn()}
      />,
    );

    await waitFor(
      () => expect(vi.mocked(poiApi.getInBbox)).toHaveBeenCalled(),
      { timeout: 2000 },
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // Toggle the viewpoint category off → applyPois([]).
    await act(async () => {
      useTripStore.setState({ activePoiCategories: new Set() });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    act(() => {
      layerHandlers.get("click:trip-planner-waypoint-pin")?.({
        features: [
          {
            properties: {
              waypointId: "poi-view-vysocina-1-1751700000000",
              poiCategory: "viewpoint",
              label: "Devět skal vista",
            },
            geometry: { type: "Point", coordinates: [15.93, 49.66] },
          },
        ],
        lngLat: { lng: 15.93, lat: 49.66 },
        originalEvent: { clientX: 400, clientY: 300 },
      });
    });

    const mapsLink = screen.getByRole("link", {
      name: /View on Google Maps/i,
    });
    expect(mapsLink).toHaveAttribute(
      "href",
      "https://www.google.com/maps/search/?api=1&query=devet-skal",
    );
  });

  it("resolves an endpoint POI by category so same-coordinate venues do not cross-bind", async () => {
    // A fuel station and a café can be imported at the same OSM node. An
    // endpoint waypoint id carries no poiId, so the coordinate fallback must
    // also match the waypoint category, or reopening the fuel endpoint binds
    // to the café's name/category/Maps link.
    const sharedPoi = (
      over: Record<string, unknown>,
    ): Record<string, unknown> => ({
      source: "osm",
      external_id: "osm:node:1",
      name: null,
      lat: 49.66,
      lng: 15.93,
      website: null,
      phone: null,
      opening_hours: null,
      address_street: null,
      address_city: null,
      address_postcode: null,
      address_country: null,
      cuisine: null,
      brand: null,
      stars: null,
      osm_url: null,
      last_imported_at: "2026-07-06T00:00:00.000Z",
      ...over,
    });
    const layerHandlers = new Map<string, (event: unknown) => void>();
    mockMap.on.mockImplementation((event, layerOrHandler, maybeHandler) => {
      if (typeof layerOrHandler === "string" && maybeHandler) {
        layerHandlers.set(
          `${event}:${layerOrHandler}`,
          maybeHandler as (event: unknown) => void,
        );
      }
      return mockMap;
    });
    const setData = vi.fn();
    mockMap.getSource.mockReturnValue({ setData } as never);
    vi.mocked(poiApi.getInBbox).mockClear();
    // Café first, fuel second — a coord-only match would wrongly pick the café.
    vi.mocked(poiApi.getInBbox).mockResolvedValueOnce({
      data: {
        count: 2,
        pois: [
          sharedPoi({
            id: "cafe-x",
            kind: "cafe",
            name: "Kavárna",
            maps_url: "https://www.google.com/maps/search/?api=1&query=cafe-x",
          }),
          sharedPoi({
            id: "fuel-x",
            kind: "fuel_station",
            name: "MOL",
            brand: "MOL",
            maps_url: "https://www.google.com/maps/search/?api=1&query=fuel-x",
          }),
        ],
      },
    } as never);

    const placed = trip();
    placed.days[0]!.waypoints[0] = {
      id: "start-1",
      name: "MOL",
      location: { lng: 15.93, lat: 49.66 },
      type: "start",
    };
    useTripStore.setState({
      activeTrip: placed,
      selectedDayIndex: 0,
      activePoiCategories: new Set(["fuel", "cafe"]),
    });

    render(
      <TripPlannerMap
        trip={placed}
        month={7}
        onMoveWaypoint={vi.fn()}
        onRemoveWaypoint={vi.fn()}
      />,
    );

    await waitFor(
      () => expect(vi.mocked(poiApi.getInBbox)).toHaveBeenCalled(),
      { timeout: 2000 },
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    act(() => {
      layerHandlers.get("click:trip-planner-waypoint-pin")?.({
        features: [
          {
            properties: {
              waypointId: "start-1",
              poiCategory: "fuel",
              label: "MOL",
            },
            geometry: { type: "Point", coordinates: [15.93, 49.66] },
          },
        ],
        lngLat: { lng: 15.93, lat: 49.66 },
        originalEvent: { clientX: 400, clientY: 300 },
      });
    });

    // Must bind to the FUEL POI at that coordinate, not the café.
    const mapsLink = screen.getByRole("link", {
      name: /View on Google Maps/i,
    });
    expect(mapsLink).toHaveAttribute(
      "href",
      "https://www.google.com/maps/search/?api=1&query=fuel-x",
    );
  });

  it("adds a route-wide stop to its OWNING day, not the selected one", () => {
    // The STOPS tab opens this popover for stops anywhere along a
    // multi-day trip: adding one must target the day whose route passes
    // the POI — Day 1 being selected must not force its leg through a
    // Day 2 stop.
    const base = trip();
    const twoDayTrip = {
      ...base,
      days: [
        base.days[0]!,
        {
          ...base.days[0]!,
          dayNumber: 2,
          waypoints: [
            {
              id: "d2-start",
              name: "Brno",
              location: { lng: 16.6, lat: 49.19 },
              type: "start" as const,
            },
            {
              id: "d2-end",
              name: "Olomouc",
              location: { lng: 17.25, lat: 49.59 },
              type: "end" as const,
            },
          ],
          routeGeometry: {
            type: "LineString" as const,
            coordinates: [
              [16.6, 49.19],
              [16.9, 49.35],
              [17.25, 49.59],
            ],
          },
        },
      ],
    };
    useTripStore.setState({ activeTrip: twoDayTrip, selectedDayIndex: 0 });

    const ref = createRef<TripPlannerMapHandle>();
    render(
      <TripPlannerMap
        ref={ref}
        trip={twoDayTrip}
        month={7}
        onMoveWaypoint={vi.fn()}
      />,
    );

    // A stop sitting on Day 2's leg (near its middle vertex).
    act(() =>
      ref.current?.openPoiPopover({
        id: "d2-cafe",
        name: "Kavárna u trasy",
        category: "cafe",
        source: "osm",
        lat: 49.36,
        lng: 16.91,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: /Add as via/ }));

    const days = useTripStore.getState().activeTrip!.days;
    expect(days[1]!.waypoints.map((w) => w.name)).toContain("Kavárna u trasy");
    expect(days[0]!.waypoints.map((w) => w.name)).not.toContain(
      "Kavárna u trasy",
    );
  });

  it("inserts an early-route stop BEFORE later vias, not before the finish", () => {
    // Day 1 already has a late via — an early stop appended before the
    // finish would make the next reroute backtrack through that via.
    const base = trip();
    const dayWithLateVia = {
      ...base.days[0]!,
      waypoints: [
        base.days[0]!.waypoints[0]!,
        {
          id: "late-via",
          name: "Late via",
          location: { lng: 14.49, lat: 50.12 },
          type: "via" as const,
        },
        base.days[0]!.waypoints[base.days[0]!.waypoints.length - 1]!,
      ],
    };
    const viaTrip = { ...base, days: [dayWithLateVia] };
    useTripStore.setState({ activeTrip: viaTrip, selectedDayIndex: 0 });

    const ref = createRef<TripPlannerMapHandle>();
    render(
      <TripPlannerMap
        ref={ref}
        trip={viaTrip}
        month={7}
        onMoveWaypoint={vi.fn()}
      />,
    );

    // A stop near the FIRST leg of the route (before the late via).
    act(() =>
      ref.current?.openPoiPopover({
        id: "early-fuel",
        name: "Early fuel",
        category: "fuel",
        source: "osm",
        lat: 50.09,
        lng: 14.43,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: /Add as via/ }));

    const names = useTripStore
      .getState()
      .activeTrip!.days[0]!.waypoints.map((w) => w.name);
    expect(names).toEqual(["Start", "Early fuel", "Late via", "End"]);
  });

  it("drives region drawing through the handle — no in-map pills remain", () => {
    // Rider feedback: the BUILD column's Fun-Zone checkbox owns the
    // draw flow; the map exposes start/cancel imperatively and mirrors
    // the mode back through onDrawModeChange.
    const ref = createRef<TripPlannerMapHandle>();
    const onDrawModeChange = vi.fn();
    const onDrawnRegionChange = vi.fn();
    render(
      <TripPlannerMap
        ref={ref}
        trip={trip()}
        month={7}
        onDrawnRegionChange={onDrawnRegionChange}
        onDrawModeChange={onDrawModeChange}
      />,
    );

    expect(
      screen.queryByRole("button", {
        name: /draw region|cancel drawing|clear region|redraw region/i,
      }),
    ).not.toBeInTheDocument();

    act(() => ref.current?.startRegionDraw());
    expect(drawControl.start).toHaveBeenCalledTimes(1);

    act(() => {
      lastDrawOptions?.onModeChange?.("drawing");
    });
    expect(onDrawModeChange).toHaveBeenCalledWith("drawing");
    expect(
      screen.getByText(/Click and drag on the map to outline a region\./),
    ).toBeInTheDocument();

    act(() => {
      lastDrawOptions?.onRegionDrawn([14.4, 50.08, 14.7, 50.3]);
      lastDrawOptions?.onModeChange?.("idle");
    });
    expect(onDrawnRegionChange).toHaveBeenCalledWith([14.4, 50.08, 14.7, 50.3]);
    expect(onDrawModeChange).toHaveBeenCalledWith("idle");
    // No persistent instruction box lingers after the region exists.
    expect(
      screen.queryByText(/Drag the region to move it/),
    ).not.toBeInTheDocument();

    act(() => ref.current?.cancelRegionDraw());
    expect(drawControl.cancel).toHaveBeenCalledTimes(1);
  });

  it("dismisses the outline hint the moment the drag begins", () => {
    const eventHandlers = new Map<string, (event: unknown) => void>();
    mockMap.on.mockImplementation((event, layerOrHandler, maybeHandler) => {
      if (typeof layerOrHandler !== "string") {
        eventHandlers.set(event, layerOrHandler as (event: unknown) => void);
      } else if (maybeHandler) {
        eventHandlers.set(
          `${event}:${layerOrHandler}`,
          maybeHandler as (event: unknown) => void,
        );
      }
      return mockMap;
    });

    render(<TripPlannerMap trip={trip()} month={7} />);

    act(() => {
      lastDrawOptions?.onModeChange?.("drawing");
    });
    expect(
      screen.getByText(/Click and drag on the map to outline a region\./),
    ).toBeInTheDocument();

    act(() => {
      eventHandlers.get("mousedown")?.({});
    });
    expect(
      screen.queryByText(/Click and drag on the map to outline a region\./),
    ).not.toBeInTheDocument();
  });

  it("shows the placement hint only until the trip has its first point", () => {
    const emptyTrip = {
      ...trip(),
      days: [{ ...trip().days[0]!, waypoints: [] }],
    };
    const { rerender } = render(
      <TripPlannerMap trip={emptyTrip} month={7} onMoveWaypoint={vi.fn()} />,
    );
    expect(
      screen.getByText(
        /Click the map to add points\. We snap to nearby roads when visible\./,
      ),
    ).toBeInTheDocument();

    // First point placed → hint gone…
    rerender(
      <TripPlannerMap trip={trip()} month={7} onMoveWaypoint={vi.fn()} />,
    );
    expect(screen.queryByText(/Click the map to add points/)).toBeNull();

    // …and it stays gone for this trip even if every point is removed.
    rerender(
      <TripPlannerMap trip={emptyTrip} month={7} onMoveWaypoint={vi.fn()} />,
    );
    expect(screen.queryByText(/Click the map to add points/)).toBeNull();
  });

  it("never shows the placement hint on read-only maps", () => {
    const emptyTrip = {
      ...trip(),
      days: [{ ...trip().days[0]!, waypoints: [] }],
    };
    render(<TripPlannerMap trip={emptyTrip} month={7} />);
    expect(screen.queryByText(/Click the map to add points/)).toBeNull();
  });

  it("fetches Fun Zones for the drawn region and feeds the map layer", async () => {
    const zones = [
      {
        id: "zone-1",
        name: "Stelvio sweepers",
        composite_score: 4.6,
        road_count: 12,
        total_curve_km: 48,
        avg_quality: 4.2,
        best_season: "summer",
        boundary: [
          { lng: 10.3, lat: 46.45 },
          { lng: 10.6, lat: 46.45 },
          { lng: 10.6, lat: 46.7 },
          { lng: 10.3, lat: 46.7 },
          { lng: 10.3, lat: 46.45 },
        ],
      },
    ];
    vi.mocked(fetchFunZonesInBbox).mockResolvedValueOnce(zones as never);
    const setData = vi.fn();
    mockMap.getSource.mockReturnValue({ setData } as never);

    render(<TripPlannerMap trip={trip()} month={7} />);

    act(() => {
      lastDrawOptions?.onRegionDrawn([10.3, 46.45, 10.6, 46.7]);
      lastDrawOptions?.onModeChange?.("idle");
    });

    await waitFor(() =>
      expect(fetchFunZonesInBbox).toHaveBeenCalledWith(
        [10.3, 46.45, 10.6, 46.7],
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      ),
    );
    // Zones land on the map layer; the in-map info card was removed, so
    // no list UI renders.
    await waitFor(() =>
      expect(setData).toHaveBeenCalledWith(
        expect.objectContaining({
          features: [
            expect.objectContaining({
              properties: expect.objectContaining({ id: "zone-1" }),
            }),
          ],
        }),
      ),
    );
    expect(screen.queryByText(/Stelvio sweepers/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Planner map/)).not.toBeInTheDocument();
  });

  it("selects a Fun Zone map feature inside the drawn region", async () => {
    let funZoneClickHandler: ((event: unknown) => void) | undefined;
    mockMap.on.mockImplementation((event, layerOrHandler, maybeHandler) => {
      if (event === "click" && layerOrHandler === "fun-zones-fill") {
        funZoneClickHandler = maybeHandler as (event: unknown) => void;
      }
      return mockMap;
    });
    drawControl.hitTest.mockReturnValue(true);

    render(<TripPlannerMap trip={trip()} month={7} />);

    act(() => {
      funZoneClickHandler?.({
        point: { x: 200, y: 200 },
        features: [{ properties: { id: "zone-1" } }],
      });
    });

    await waitFor(() =>
      expect(mockMap.setFilter).toHaveBeenCalledWith("fun-zones-selected", [
        "==",
        ["get", "id"],
        "zone-1",
      ]),
    );
    expect(drawControl.hitTest).not.toHaveBeenCalled();
  });

  it("does not add a waypoint when selecting a Fun Zone outside the drawn region", async () => {
    const handleAddWaypoint = vi.fn();
    let funZoneClickHandler: ((event: unknown) => void) | undefined;
    let mapClickHandler: ((event: unknown) => void) | undefined;
    mockMap.on.mockImplementation((event, layerOrHandler, maybeHandler) => {
      if (event === "click" && layerOrHandler === "fun-zones-fill") {
        funZoneClickHandler = maybeHandler as (event: unknown) => void;
      } else if (event === "click" && typeof layerOrHandler !== "string") {
        mapClickHandler = layerOrHandler as (event: unknown) => void;
      }
      return mockMap;
    });
    drawControl.hitTest.mockReturnValue(false);
    mockMap.queryRenderedFeatures.mockReturnValue([]);

    render(
      <TripPlannerMap
        trip={trip()}
        month={7}
        onAddWaypoint={handleAddWaypoint}
      />,
    );

    act(() => {
      const event = {
        point: { x: 200, y: 200 },
        lngLat: { lng: 10.65, lat: 46.75 },
        features: [{ properties: { id: "zone-1" } }],
      };
      funZoneClickHandler?.(event);
      mapClickHandler?.(event);
    });

    await waitFor(() =>
      expect(mockMap.setFilter).toHaveBeenCalledWith("fun-zones-selected", [
        "==",
        ["get", "id"],
        "zone-1",
      ]),
    );
    expect(handleAddWaypoint).not.toHaveBeenCalled();
  });

  it("clears Fun Zone results when the drawn region is cleared", async () => {
    vi.mocked(fetchFunZonesInBbox).mockResolvedValueOnce([
      {
        id: "zone-1",
        name: "Stelvio sweepers",
        composite_score: 4.6,
        road_count: 12,
        total_curve_km: 48,
        avg_quality: 4.2,
        best_season: "summer",
        boundary: [
          { lng: 10.3, lat: 46.45 },
          { lng: 10.6, lat: 46.45 },
          { lng: 10.6, lat: 46.7 },
          { lng: 10.3, lat: 46.7 },
          { lng: 10.3, lat: 46.45 },
        ],
      },
    ] as never);

    const setData = vi.fn();
    mockMap.getSource.mockReturnValue({ setData } as never);

    render(<TripPlannerMap trip={trip()} month={7} />);

    act(() => {
      lastDrawOptions?.onRegionDrawn([10.3, 46.45, 10.6, 46.7]);
      lastDrawOptions?.onModeChange?.("idle");
    });
    await waitFor(() => expect(fetchFunZonesInBbox).toHaveBeenCalled());
    await waitFor(() =>
      expect(setData).toHaveBeenCalledWith(
        expect.objectContaining({
          features: [expect.objectContaining({ type: "Feature" })],
        }),
      ),
    );

    setData.mockClear();
    fireEvent.keyDown(window, { key: "Delete" });

    await waitFor(() =>
      expect(setData).toHaveBeenCalledWith(
        expect.objectContaining({ features: [] }),
      ),
    );
  });

  it("clears the drawn region when the rider presses Delete or Backspace", () => {
    render(<TripPlannerMap trip={trip()} month={7} />);

    act(() => {
      lastDrawOptions?.onRegionDrawn([14.4, 50.08, 14.7, 50.3]);
      lastDrawOptions?.onModeChange?.("idle");
    });

    fireEvent.keyDown(window, { key: "Delete" });
    expect(drawControl.clearDrawn).toHaveBeenCalledTimes(1);

    // After clearing, Backspace must not trigger another clearDrawn call.
    fireEvent.keyDown(window, { key: "Backspace" });
    expect(drawControl.clearDrawn).toHaveBeenCalledTimes(1);
  });

  it("does not clear the drawn region when Delete fires from a text field", () => {
    render(
      <div>
        {/* eslint-disable-next-line no-restricted-syntax -- bare fixture
            input standing in for "any focused text field". */}
        <input data-testid="trip-name" />
        <TripPlannerMap trip={trip()} month={7} />
      </div>,
    );

    act(() => {
      lastDrawOptions?.onRegionDrawn([14.4, 50.08, 14.7, 50.3]);
      lastDrawOptions?.onModeChange?.("idle");
    });

    const input = screen.getByTestId("trip-name") as HTMLInputElement;
    input.focus();
    fireEvent.keyDown(input, { key: "Delete" });
    expect(drawControl.clearDrawn).not.toHaveBeenCalled();
  });

  it("opens the context menu inside a drawn region (waypoints are placeable there)", () => {
    // Rider feedback: a drafted route lives INSIDE the drawn region, so
    // right-click placement must work there. Region move/resize are
    // left-drag gestures and never conflict with right-click.
    const eventHandlers = new Map<string, (event: unknown) => void>();
    mockMap.on.mockImplementation((event, layerOrHandler, maybeHandler) => {
      if (typeof layerOrHandler === "string") return mockMap;
      eventHandlers.set(
        event,
        (maybeHandler ?? layerOrHandler) as (event: unknown) => void,
      );
      return mockMap;
    });
    mockMap.off.mockImplementation((event) => {
      eventHandlers.delete(event);
      return mockMap;
    });
    drawControl.hitTest.mockReturnValue(true);
    // Placement road-snap queries rendered features on right-click.
    mockMap.queryRenderedFeatures.mockReturnValue([]);

    render(<TripPlannerMap trip={trip()} month={7} onMoveWaypoint={vi.fn()} />);

    act(() => {
      lastDrawOptions?.onRegionDrawn([14.4, 50.08, 14.7, 50.3]);
      lastDrawOptions?.onModeChange?.("idle");
    });

    act(() => {
      eventHandlers.get("contextmenu")?.({
        preventDefault: vi.fn(),
        point: { x: 200, y: 200 },
        lngLat: { lng: 14.55, lat: 50.2 },
        originalEvent: { clientX: 200, clientY: 200 },
      });
    });

    expect(screen.getByRole("menu")).toBeInTheDocument();
  });

  it("does NOT auto-refit when waypoint changes mutate bounds on the same trip (#559)", () => {
    // Regression #559: clicking the map to add / move a waypoint
    // used to refit the bounds and rip the user's zoom/pan away.
    // The auto-fit is now one-shot per `trip.id`; only the explicit
    // Fit-to-route button below should refit on subsequent edits.
    const { rerender } = render(<TripPlannerMap trip={trip()} month={7} />);

    return waitFor(() => {
      expect(mockMap.fitBounds).toHaveBeenCalledTimes(1);
    }).then(() => {
      mockMap.fitBounds.mockClear();

      rerender(
        <TripPlannerMap
          trip={{
            ...trip(),
            days: [
              {
                ...trip().days[0]!,
                waypoints: [
                  {
                    id: "start-1",
                    name: "Start",
                    location: { lng: 15.11, lat: 50.58 },
                    type: "start",
                  },
                  {
                    id: "end-1",
                    name: "End",
                    location: { lng: 15.61, lat: 50.79 },
                    type: "end",
                  },
                ],
                routeGeometry: {
                  type: "LineString",
                  coordinates: [
                    [15.11, 50.58],
                    [15.28, 50.67],
                    [15.61, 50.79],
                  ],
                },
              },
            ],
          }}
          month={7}
        />,
      );

      // Give React a tick to flush effects before asserting the
      // negative — `waitFor` would only catch a delayed call.
      return new Promise<void>((resolve) => setTimeout(resolve, 20)).then(
        () => {
          expect(mockMap.fitBounds).not.toHaveBeenCalled();
        },
      );
    });
  });

  it("auto-fits again when the trip identity changes (different trip.id)", () => {
    const { rerender } = render(<TripPlannerMap trip={trip()} month={7} />);

    return waitFor(() => {
      expect(mockMap.fitBounds).toHaveBeenCalledTimes(1);
    }).then(() => {
      mockMap.fitBounds.mockClear();

      rerender(
        <TripPlannerMap trip={{ ...trip(), id: "trip-other" }} month={7} />,
      );

      return waitFor(() => {
        expect(mockMap.fitBounds).toHaveBeenCalledTimes(1);
      });
    });
  });

  it("refits when fitRouteToken bumps (same trip id, route geometry swap)", async () => {
    // Scenario: user picks a different generated route option —
    // `trip.id` stays the same but the route geometry can change
    // dramatically. The page bumps `fitRouteToken` so the map
    // re-frames the new bounds; the per-trip-id auto-fit alone
    // would let the new geometry render off-screen.
    const { rerender } = render(
      <TripPlannerMap trip={trip()} month={7} fitRouteToken={0} />,
    );

    await waitFor(() => {
      expect(mockMap.fitBounds).toHaveBeenCalledTimes(1);
    });
    mockMap.fitBounds.mockClear();

    rerender(<TripPlannerMap trip={trip()} month={7} fitRouteToken={1} />);

    await waitFor(() => {
      expect(mockMap.fitBounds).toHaveBeenCalledTimes(1);
    });
  });

  it("refits via the imperative fitRoute handle (toolbar Fit route)", async () => {
    // The in-map Fit-to-route pill was dropped — the toolbar button is
    // the single fit control, wired through the ref handle.
    const ref = createRef<TripPlannerMapHandle>();
    render(<TripPlannerMap ref={ref} trip={trip()} month={7} />);

    await waitFor(() => {
      expect(mockMap.fitBounds).toHaveBeenCalledTimes(1);
    });
    mockMap.fitBounds.mockClear();
    expect(
      screen.queryByRole("button", { name: /fit map to the whole route/i }),
    ).not.toBeInTheDocument();

    act(() => {
      ref.current?.fitRoute();
    });

    expect(mockMap.fitBounds).toHaveBeenCalledTimes(1);
    expect(mockMap.fitBounds).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ padding: 72, duration: 1200, maxZoom: 11 }),
    );
  });

  it("destroys the previous draw control before reinitializing onReady", () => {
    const { rerender } = render(<TripPlannerMap trip={trip()} month={7} />);

    const initialCreateCalls = vi.mocked(createRegionDrawControl).mock.calls
      .length;
    const initialDestroyCalls = drawControl.destroy.mock.calls.length;

    rerender(<TripPlannerMap trip={trip()} month={7} />);

    expect(drawControl.destroy.mock.calls.length).toBe(initialDestroyCalls + 1);
    expect(vi.mocked(createRegionDrawControl).mock.calls.length).toBe(
      initialCreateCalls + 1,
    );
  });

  it("loads closures and passes for the selected month using the trip route", () => {
    render(<TripPlannerMap trip={trip()} month={7} />);

    expect(useClosuresMock).toHaveBeenCalledWith(7, [
      {
        id: "day-1",
        label: "Day 1 · Day one",
        points: [
          { lng: 14.41, lat: 50.08 },
          { lng: 14.49, lat: 50.12 },
          { lng: 14.61, lat: 50.19 },
        ],
      },
    ]);
    expect(usePassesMock).toHaveBeenCalledWith(7, [
      {
        id: "day-1",
        label: "Day 1 · Day one",
        points: [
          { lng: 14.41, lat: 50.08 },
          { lng: 14.49, lat: 50.12 },
          { lng: 14.61, lat: 50.19 },
        ],
      },
    ]);
  });

  it("registers closure/pass overlay sources for the map layers", () => {
    useClosuresMock.mockReturnValue({
      closures: [
        {
          id: "closure-1",
          title: "Stelvio summit roadworks",
          reason: "roadworks",
          severity: "partial",
          geometry: [
            { lng: 10.45, lat: 46.53 },
            { lng: 10.47, lat: 46.55 },
          ],
          detour: [
            { lng: 10.4, lat: 46.5 },
            { lng: 10.42, lat: 46.52 },
          ],
          country_code: "IT",
          region: "Lombardy",
          starts_at: "2026-07-01T00:00:00Z",
          ends_at: "2026-07-21T00:00:00Z",
          notes: "Signal-controlled single-lane traffic",
          source: "official",
          created_by: null,
          created_at: "2026-06-01T00:00:00Z",
          updated_at: "2026-06-15T00:00:00Z",
        },
      ],
      routeClosures: [],
      counts: { full: 0, partial: 1, advisory: 0, total: 1 },
      routeCounts: { full: 0, partial: 0, advisory: 0, total: 0 },
      loading: false,
      routeLoading: false,
      error: null,
      routeError: null,
      previewDate: new Date("2026-07-15T12:00:00Z"),
    });
    usePassesMock.mockReturnValue({
      passes: [
        {
          id: "pass-1",
          name: "Stelvio Pass",
          country_code: "IT",
          region: "Lombardy",
          lat: 46.53,
          lng: 10.45,
          elevation_m: 2757,
          typical_open_month: 6,
          typical_close_month: 10,
          status: "open",
          status_overridden: false,
          notes: null,
          last_updated: "2026-06-15T00:00:00Z",
        },
      ],
      routePasses: [],
      routeClosedCount: 0,
      routeUnknownCount: 0,
      loading: false,
      routeLoading: false,
      error: null,
      routeError: null,
    });

    render(<TripPlannerMap trip={trip()} month={7} />);

    // The in-map info card was removed — conditions surface on the map
    // (overlay sources below) and in the CONDITIONS panel tab.
    expect(screen.queryByText("Conditions for July")).not.toBeInTheDocument();

    expect(mockMap.addSource).toHaveBeenCalledWith(
      "trip-planner-closure-lines",
      expect.objectContaining({ type: "geojson" }),
    );
    expect(mockMap.addSource).toHaveBeenCalledWith(
      "trip-planner-pass-markers",
      expect.objectContaining({ type: "geojson" }),
    );
  });

  it("registers the segment-highlight source and renders nothing when no segment is focused", () => {
    useTripStore.setState({
      activeTrip: null,
      focusedSegmentId: null,
      hoveredSegmentId: null,
      undoStack: [],
      redoStack: [],
      canUndo: false,
      canRedo: false,
    });

    render(<TripPlannerMap trip={trip()} month={7} />);

    const highlightCalls = mockMap.addSource.mock.calls.filter(
      ([sourceId]) => sourceId === "trip-planner-segment-highlight",
    );
    expect(highlightCalls.length).toBeGreaterThan(0);
    const lastData = highlightCalls.at(-1)?.[1] as {
      data: { features: unknown[] };
    };
    expect(lastData.data.features).toEqual([]);

    expect(mockMap.addLayer).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "trip-planner-segment-highlight-glow",
        source: "trip-planner-segment-highlight",
        type: "line",
      }),
    );
    expect(mockMap.addLayer).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "trip-planner-segment-highlight-line",
        source: "trip-planner-segment-highlight",
        type: "line",
      }),
    );
  });

  it("uses a MapLibre-valid line-width for the route line (one zoom subexpression)", () => {
    // Regression for #719: the route line's `line-width` was a `case`
    // wrapping two zoom interpolations, which MapLibre rejects ("Only one
    // zoom-based step or interpolate subexpression may be used"). That
    // threw at addLayer and aborted the whole planner layer setup, so no
    // route ever rendered. Compile it with MapLibre's real parser here so
    // any future invalid expression fails the test rather than the map.
    render(<TripPlannerMap trip={trip()} month={7} />);

    const routeLayer = mockMap.addLayer.mock.calls
      .map((c) => c[0] as { id?: string; paint?: Record<string, unknown> })
      .find((l) => l?.id === "trip-planner-route-line");
    expect(routeLayer).toBeDefined();

    // createPropertyExpression (not createExpression) enforces the zoom-curve
    // rule that this bug violated.
    const compiled = expression.createPropertyExpression(
      routeLayer!.paint!["line-width"],
      {
        type: "number",
        "property-type": "data-driven",
        expression: { interpolated: true, parameters: ["zoom", "feature"] },
      } as Parameters<typeof expression.createPropertyExpression>[1],
    );
    expect(compiled.result).toBe("success");
  });

  it("uses a continuous overview line below the detailed route zoom", () => {
    render(<TripPlannerMap trip={trip()} month={7} />);

    expect(mockMap.addSource).toHaveBeenCalledWith(
      "trip-planner-route-overview",
      expect.objectContaining({ type: "geojson" }),
    );
    expect(mockMap.addLayer).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "trip-planner-route-casing",
        source: "trip-planner-route-overview",
      }),
    );
    expect(mockMap.addLayer).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "trip-planner-route-overview-line",
        source: "trip-planner-route-overview",
        maxzoom: 10,
      }),
    );
    expect(mockMap.addLayer).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "trip-planner-route-line",
        source: "trip-planner-route",
        minzoom: 10,
      }),
    );
  });

  it("publishes the focused segment's geometry as a highlight feature", async () => {
    useTripStore.setState({
      activeTrip: null,
      focusedSegmentId: null,
      hoveredSegmentId: null,
      undoStack: [],
      redoStack: [],
      canUndo: false,
      canRedo: false,
    });

    const tripWithSegments: Trip = {
      ...trip(),
      days: [
        {
          ...trip().days[0]!,
          segments: [
            {
              id: "seg-1",
              dayNumber: 1,
              orderInDay: 0,
              distanceKm: 6,
              qualityScore: 4,
              qualityTier: "good",
              surfaceType: "asphalt",
              curvinessScore: 50,
              elevationProfile: [],
              photos: [],
              activeHazards: [],
            },
            {
              id: "seg-2",
              dayNumber: 1,
              orderInDay: 1,
              distanceKm: 6,
              qualityScore: 4.2,
              qualityTier: "good",
              surfaceType: "asphalt",
              curvinessScore: 60,
              elevationProfile: [],
              photos: [],
              activeHazards: [],
            },
          ],
        },
      ],
    };

    render(<TripPlannerMap trip={tripWithSegments} month={7} />);

    act(() => {
      useTripStore.getState().focusSegment("seg-2");
    });

    await waitFor(() => {
      const highlightCalls = mockMap.addSource.mock.calls.filter(
        ([sourceId]) => sourceId === "trip-planner-segment-highlight",
      );
      const lastData = highlightCalls.at(-1)?.[1] as {
        data: { features: Array<{ properties: { segmentId: string } }> };
      };
      expect(lastData.data.features).toHaveLength(1);
      expect(lastData.data.features[0]?.properties.segmentId).toBe("seg-2");
    });

    // Clearing the focus drops the highlight feature.
    act(() => {
      useTripStore.getState().focusSegment(null);
    });

    await waitFor(() => {
      const highlightCalls = mockMap.addSource.mock.calls.filter(
        ([sourceId]) => sourceId === "trip-planner-segment-highlight",
      );
      const lastData = highlightCalls.at(-1)?.[1] as {
        data: { features: unknown[] };
      };
      expect(lastData.data.features).toEqual([]);
    });
  });

  it("commits a waypoint move when the rider drags an existing marker", () => {
    const handleMoveWaypoint = vi.fn();
    const layerHandlers = new Map<string, (event: unknown) => void>();
    const mapHandlers = new Map<string, (event: unknown) => void>();
    mockMap.on.mockImplementation(
      (event: string, layerOrHandler: unknown, maybeHandler?: unknown) => {
        if (typeof layerOrHandler === "string") {
          layerHandlers.set(
            `${event}:${layerOrHandler}`,
            maybeHandler as (event: unknown) => void,
          );
        } else {
          mapHandlers.set(event, layerOrHandler as (event: unknown) => void);
        }
        return mockMap;
      },
    );
    mockMap.off.mockImplementation((event: string, layerOrHandler: unknown) => {
      if (typeof layerOrHandler === "string") {
        layerHandlers.delete(`${event}:${layerOrHandler}`);
      } else {
        mapHandlers.delete(event);
      }
      return mockMap;
    });
    mockMap.queryRenderedFeatures.mockReturnValue([]);

    render(
      <TripPlannerMap
        trip={trip()}
        month={7}
        onMoveWaypoint={handleMoveWaypoint}
      />,
    );

    const preventDefault = vi.fn();
    act(() => {
      layerHandlers.get("mousedown:trip-planner-waypoint-pin")?.({
        preventDefault,
        features: [
          {
            properties: { dayNumber: 1, waypointId: "start-1" },
          },
        ],
        point: { x: 100, y: 100 },
        lngLat: { lng: 14.41, lat: 50.08 },
      });
    });
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(mockCanvas.style.cursor).toBe("grabbing");

    act(() => {
      mapHandlers.get("mouseup")?.({
        point: { x: 220, y: 130 },
        lngLat: { lng: 14.5, lat: 50.12 },
        preventDefault: vi.fn(),
      });
    });

    expect(handleMoveWaypoint).toHaveBeenCalledWith(1, "start-1", {
      lng: 14.5,
      lat: 50.12,
    });
    expect(mockCanvas.style.cursor).toBe("");
  });

  it("survives a parent re-render mid-drag and still routes the drop to the latest callback", () => {
    const layerHandlers = new Map<string, (event: unknown) => void>();
    const mapHandlers = new Map<string, (event: unknown) => void>();
    mockMap.on.mockImplementation(
      (event: string, layerOrHandler: unknown, maybeHandler?: unknown) => {
        if (typeof layerOrHandler === "string") {
          layerHandlers.set(
            `${event}:${layerOrHandler}`,
            maybeHandler as (event: unknown) => void,
          );
        } else {
          mapHandlers.set(event, layerOrHandler as (event: unknown) => void);
        }
        return mockMap;
      },
    );
    mockMap.off.mockImplementation((event: string, layerOrHandler: unknown) => {
      if (typeof layerOrHandler === "string") {
        layerHandlers.delete(`${event}:${layerOrHandler}`);
      } else {
        mapHandlers.delete(event);
      }
      return mockMap;
    });
    mockMap.queryRenderedFeatures.mockReturnValue([]);

    const firstMove = vi.fn();
    const secondMove = vi.fn();
    const { rerender } = render(
      <TripPlannerMap trip={trip()} month={7} onMoveWaypoint={firstMove} />,
    );

    // Begin a real drag (past click tolerance) with the first callback
    // installed.
    act(() => {
      layerHandlers.get("mousedown:trip-planner-waypoint-pin")?.({
        preventDefault: vi.fn(),
        features: [{ properties: { dayNumber: 1, waypointId: "start-1" } }],
        point: { x: 100, y: 100 },
        lngLat: { lng: 14.41, lat: 50.08 },
      });
      mapHandlers.get("mousemove")?.({
        preventDefault: vi.fn(),
        point: { x: 200, y: 160 },
        lngLat: { lng: 14.48, lat: 50.12 },
      });
    });

    // Parent re-renders mid-drag with a brand-new callback identity
    // (e.g. the planner page rerendered because a collab cursor or
    // suggestion update flowed through the trip session hook).
    rerender(
      <TripPlannerMap trip={trip()} month={7} onMoveWaypoint={secondMove} />,
    );

    act(() => {
      mapHandlers.get("mouseup")?.({
        point: { x: 220, y: 180 },
        lngLat: { lng: 14.5, lat: 50.13 },
        preventDefault: vi.fn(),
      });
    });

    // The drag must complete and route to the latest callback —
    // before the ref-bounce, `onMoveWaypoint` was a dep so this rerender
    // discarded the in-flight `active` state and the drop did nothing.
    expect(firstMove).not.toHaveBeenCalled();
    expect(secondMove).toHaveBeenCalledTimes(1);
    expect(secondMove).toHaveBeenCalledWith(1, "start-1", {
      lng: 14.5,
      lat: 50.13,
    });
  });

  it("does not start a waypoint drag when the pointer is not over a waypoint", () => {
    const handleMoveWaypoint = vi.fn();
    const layerHandlers = new Map<string, (event: unknown) => void>();
    const mapHandlers = new Map<string, (event: unknown) => void>();
    mockMap.on.mockImplementation(
      (event: string, layerOrHandler: unknown, maybeHandler?: unknown) => {
        if (typeof layerOrHandler === "string") {
          layerHandlers.set(
            `${event}:${layerOrHandler}`,
            maybeHandler as (event: unknown) => void,
          );
        } else {
          mapHandlers.set(event, layerOrHandler as (event: unknown) => void);
        }
        return mockMap;
      },
    );
    mockMap.off.mockImplementation((event: string, layerOrHandler: unknown) => {
      if (typeof layerOrHandler === "string") {
        layerHandlers.delete(`${event}:${layerOrHandler}`);
      } else {
        mapHandlers.delete(event);
      }
      return mockMap;
    });

    render(
      <TripPlannerMap
        trip={trip()}
        month={7}
        onMoveWaypoint={handleMoveWaypoint}
      />,
    );

    const preventDefault = vi.fn();
    act(() => {
      layerHandlers.get("mousedown:trip-planner-waypoint-pin")?.({
        preventDefault,
        features: [],
        point: { x: 100, y: 100 },
        lngLat: { lng: 14.41, lat: 50.08 },
      });
    });
    expect(preventDefault).not.toHaveBeenCalled();

    act(() => {
      mapHandlers.get("mouseup")?.({
        point: { x: 220, y: 130 },
        lngLat: { lng: 14.5, lat: 50.12 },
        preventDefault: vi.fn(),
      });
    });
    expect(handleMoveWaypoint).not.toHaveBeenCalled();
  });

  it("swallows the synthetic click that follows a tap-without-drag on a waypoint", () => {
    const handleAddWaypoint = vi.fn();
    const handleMoveWaypoint = vi.fn();
    const layerHandlers = new Map<string, (event: unknown) => void>();
    const mapHandlers = new Map<string, (event: unknown) => void>();
    mockMap.on.mockImplementation(
      (event: string, layerOrHandler: unknown, maybeHandler?: unknown) => {
        if (typeof layerOrHandler === "string") {
          layerHandlers.set(
            `${event}:${layerOrHandler}`,
            maybeHandler as (event: unknown) => void,
          );
        } else {
          mapHandlers.set(event, layerOrHandler as (event: unknown) => void);
        }
        return mockMap;
      },
    );
    mockMap.off.mockImplementation((event: string, layerOrHandler: unknown) => {
      if (typeof layerOrHandler === "string") {
        layerHandlers.delete(`${event}:${layerOrHandler}`);
      } else {
        mapHandlers.delete(event);
      }
      return mockMap;
    });
    mockMap.queryRenderedFeatures.mockReturnValue([]);

    render(
      <TripPlannerMap
        trip={trip()}
        month={7}
        onAddWaypoint={handleAddWaypoint}
        onMoveWaypoint={handleMoveWaypoint}
      />,
    );

    act(() => {
      layerHandlers.get("mousedown:trip-planner-waypoint-pin")?.({
        preventDefault: vi.fn(),
        features: [{ properties: { dayNumber: 1, waypointId: "start-1" } }],
        point: { x: 100, y: 100 },
        lngLat: { lng: 14.41, lat: 50.08 },
      });
      mapHandlers.get("mouseup")?.({
        point: { x: 100, y: 100 },
        lngLat: { lng: 14.41, lat: 50.08 },
        preventDefault: vi.fn(),
      });
      mapHandlers.get("click")?.({
        point: { x: 100, y: 100 },
        lngLat: { lng: 14.41, lat: 50.08 },
      });
    });

    expect(handleAddWaypoint).not.toHaveBeenCalled();

    // A subsequent unrelated map click passes through (swallow flag cleared).
    // Left-click no longer adds waypoints (context-menu does), but it must
    // not be eaten by a stale swallow flag from the previous drag/tap.
    act(() => {
      mapHandlers.get("click")?.({
        point: { x: 320, y: 220 },
        lngLat: { lng: 14.55, lat: 50.15 },
      });
    });
    // click handler ran without crashing — swallow flag was properly cleared.
    expect(handleAddWaypoint).not.toHaveBeenCalled();
  });

  it("does not swallow the next legitimate click after a real waypoint drag", () => {
    const handleAddWaypoint = vi.fn();
    const handleMoveWaypoint = vi.fn();
    const layerHandlers = new Map<string, (event: unknown) => void>();
    const mapHandlers = new Map<string, (event: unknown) => void>();
    mockMap.on.mockImplementation(
      (event: string, layerOrHandler: unknown, maybeHandler?: unknown) => {
        if (typeof layerOrHandler === "string") {
          layerHandlers.set(
            `${event}:${layerOrHandler}`,
            maybeHandler as (event: unknown) => void,
          );
        } else {
          mapHandlers.set(event, layerOrHandler as (event: unknown) => void);
        }
        return mockMap;
      },
    );
    mockMap.off.mockImplementation((event: string, layerOrHandler: unknown) => {
      if (typeof layerOrHandler === "string") {
        layerHandlers.delete(`${event}:${layerOrHandler}`);
      } else {
        mapHandlers.delete(event);
      }
      return mockMap;
    });
    mockMap.queryRenderedFeatures.mockReturnValue([]);

    render(
      <TripPlannerMap
        trip={trip()}
        month={7}
        onAddWaypoint={handleAddWaypoint}
        onMoveWaypoint={handleMoveWaypoint}
      />,
    );

    act(() => {
      layerHandlers.get("mousedown:trip-planner-waypoint-pin")?.({
        preventDefault: vi.fn(),
        features: [{ properties: { dayNumber: 1, waypointId: "start-1" } }],
        point: { x: 100, y: 100 },
        lngLat: { lng: 14.41, lat: 50.08 },
      });
      // Move well past MapLibre's 3 px clickTolerance — no synthetic
      // click will be emitted on mouseup, so the swallow flag must clear.
      mapHandlers.get("mousemove")?.({
        preventDefault: vi.fn(),
        point: { x: 220, y: 180 },
        lngLat: { lng: 14.5, lat: 50.13 },
      });
      mapHandlers.get("mouseup")?.({
        point: { x: 240, y: 200 },
        lngLat: { lng: 14.55, lat: 50.15 },
        preventDefault: vi.fn(),
      });
    });

    expect(handleMoveWaypoint).toHaveBeenCalledTimes(1);
    expect(handleAddWaypoint).not.toHaveBeenCalled();

    act(() => {
      mapHandlers.get("click")?.({
        point: { x: 320, y: 240 },
        lngLat: { lng: 14.6, lat: 50.18 },
      });
    });

    // Left-click no longer adds waypoints (context-menu does), but the swallow
    // flag must have been cleared by the drag so the click handler runs freely.
    expect(handleAddWaypoint).not.toHaveBeenCalled();
  });

  it("clears click suppression at MapLibre's 3 px boundary so a 4 px drag still allows the next map click", () => {
    const handleAddWaypoint = vi.fn();
    const handleMoveWaypoint = vi.fn();
    const layerHandlers = new Map<string, (event: unknown) => void>();
    const mapHandlers = new Map<string, (event: unknown) => void>();
    mockMap.on.mockImplementation(
      (event: string, layerOrHandler: unknown, maybeHandler?: unknown) => {
        if (typeof layerOrHandler === "string") {
          layerHandlers.set(
            `${event}:${layerOrHandler}`,
            maybeHandler as (event: unknown) => void,
          );
        } else {
          mapHandlers.set(event, layerOrHandler as (event: unknown) => void);
        }
        return mockMap;
      },
    );
    mockMap.off.mockImplementation((event: string, layerOrHandler: unknown) => {
      if (typeof layerOrHandler === "string") {
        layerHandlers.delete(`${event}:${layerOrHandler}`);
      } else {
        mapHandlers.delete(event);
      }
      return mockMap;
    });
    mockMap.queryRenderedFeatures.mockReturnValue([]);

    render(
      <TripPlannerMap
        trip={trip()}
        month={7}
        onAddWaypoint={handleAddWaypoint}
        onMoveWaypoint={handleMoveWaypoint}
      />,
    );

    // 4 px gesture: above MapLibre's 3 px clickTolerance so it will NOT
    // emit a synthetic click. Our threshold must match exactly,
    // otherwise the gap (3 < dist <= 4) keeps the swallow flag armed.
    act(() => {
      layerHandlers.get("mousedown:trip-planner-waypoint-pin")?.({
        preventDefault: vi.fn(),
        features: [{ properties: { dayNumber: 1, waypointId: "start-1" } }],
        point: { x: 100, y: 100 },
        lngLat: { lng: 14.41, lat: 50.08 },
      });
      mapHandlers.get("mousemove")?.({
        preventDefault: vi.fn(),
        point: { x: 104, y: 100 },
        lngLat: { lng: 14.413, lat: 50.08 },
      });
      mapHandlers.get("mouseup")?.({
        point: { x: 104, y: 100 },
        lngLat: { lng: 14.413, lat: 50.08 },
        preventDefault: vi.fn(),
      });
    });

    expect(handleMoveWaypoint).toHaveBeenCalledTimes(1);

    // MapLibre would not have fired a synthetic click for a 4 px drag.
    // Our swallow flag must have been cleared at the 3 px tolerance boundary
    // so the rider's next click is not accidentally eaten.
    act(() => {
      mapHandlers.get("click")?.({
        point: { x: 320, y: 240 },
        lngLat: { lng: 14.6, lat: 50.18 },
      });
    });

    // Left-click no longer adds waypoints; the swallow flag cleared so the
    // click handler ran (no crash, no swallowing of future events).
    expect(handleAddWaypoint).not.toHaveBeenCalled();
  });

  it("keeps the move and touchmove listeners attached after a no-op drop", () => {
    const handleMoveWaypoint = vi.fn();
    const layerHandlers = new Map<string, (event: unknown) => void>();
    const mapHandlers = new Map<string, (event: unknown) => void>();
    mockMap.on.mockImplementation(
      (event: string, layerOrHandler: unknown, maybeHandler?: unknown) => {
        if (typeof layerOrHandler === "string") {
          layerHandlers.set(
            `${event}:${layerOrHandler}`,
            maybeHandler as (event: unknown) => void,
          );
        } else {
          mapHandlers.set(event, layerOrHandler as (event: unknown) => void);
        }
        return mockMap;
      },
    );
    mockMap.off.mockImplementation((event: string, layerOrHandler: unknown) => {
      if (typeof layerOrHandler === "string") {
        layerHandlers.delete(`${event}:${layerOrHandler}`);
      } else {
        mapHandlers.delete(event);
      }
      return mockMap;
    });
    mockMap.queryRenderedFeatures.mockReturnValue([]);

    render(
      <TripPlannerMap
        trip={trip()}
        month={7}
        onMoveWaypoint={handleMoveWaypoint}
      />,
    );

    expect(mapHandlers.has("mousemove")).toBe(true);
    expect(mapHandlers.has("touchmove")).toBe(true);

    // Real drag past tolerance that returns to the original location —
    // exercises the no-op-store-update path so we can verify the
    // listeners stay attached even when React does not re-render.
    act(() => {
      layerHandlers.get("mousedown:trip-planner-waypoint-pin")?.({
        preventDefault: vi.fn(),
        features: [{ properties: { dayNumber: 1, waypointId: "start-1" } }],
        point: { x: 100, y: 100 },
        lngLat: { lng: 14.41, lat: 50.08 },
      });
      mapHandlers.get("mousemove")?.({
        preventDefault: vi.fn(),
        point: { x: 220, y: 180 },
        lngLat: { lng: 14.5, lat: 50.13 },
      });
      mapHandlers.get("mouseup")?.({
        point: { x: 100, y: 100 },
        lngLat: { lng: 14.41, lat: 50.08 },
        preventDefault: vi.fn(),
      });
    });

    expect(handleMoveWaypoint).toHaveBeenCalledTimes(1);
    // The crucial regression guard for #482 review: if these listeners
    // were detached on drop, the next drag would lose preventDefault and
    // MapLibre would pan the canvas instead of moving the waypoint.
    expect(mapHandlers.has("mousemove")).toBe(true);
    expect(mapHandlers.has("touchmove")).toBe(true);

    const preventDefault = vi.fn();
    act(() => {
      mapHandlers.get("mousemove")?.({
        preventDefault,
        point: { x: 100, y: 100 },
      });
    });
    expect(preventDefault).not.toHaveBeenCalled();

    act(() => {
      layerHandlers.get("mousedown:trip-planner-waypoint-pin")?.({
        preventDefault: vi.fn(),
        features: [{ properties: { dayNumber: 1, waypointId: "start-1" } }],
        point: { x: 100, y: 100 },
        lngLat: { lng: 14.41, lat: 50.08 },
      });
      mapHandlers.get("mousemove")?.({
        preventDefault,
        point: { x: 100, y: 100 },
      });
    });
    expect(preventDefault).toHaveBeenCalled();
  });

  it("clears click suppression when a touch gesture on a waypoint is cancelled", () => {
    const handleAddWaypoint = vi.fn();
    const handleMoveWaypoint = vi.fn();
    const layerHandlers = new Map<string, (event: unknown) => void>();
    const mapHandlers = new Map<string, (event: unknown) => void>();
    mockMap.on.mockImplementation(
      (event: string, layerOrHandler: unknown, maybeHandler?: unknown) => {
        if (typeof layerOrHandler === "string") {
          layerHandlers.set(
            `${event}:${layerOrHandler}`,
            maybeHandler as (event: unknown) => void,
          );
        } else {
          mapHandlers.set(event, layerOrHandler as (event: unknown) => void);
        }
        return mockMap;
      },
    );
    mockMap.off.mockImplementation((event: string, layerOrHandler: unknown) => {
      if (typeof layerOrHandler === "string") {
        layerHandlers.delete(`${event}:${layerOrHandler}`);
      } else {
        mapHandlers.delete(event);
      }
      return mockMap;
    });
    mockMap.queryRenderedFeatures.mockReturnValue([]);

    render(
      <TripPlannerMap
        trip={trip()}
        month={7}
        onAddWaypoint={handleAddWaypoint}
        onMoveWaypoint={handleMoveWaypoint}
      />,
    );

    // Touch a waypoint, never move past tolerance, then cancel —
    // common when an OS gesture (e.g. system back swipe) interrupts.
    act(() => {
      layerHandlers.get("touchstart:trip-planner-waypoint-pin")?.({
        preventDefault: vi.fn(),
        features: [{ properties: { dayNumber: 1, waypointId: "start-1" } }],
        point: { x: 100, y: 100 },
        lngLat: { lng: 14.41, lat: 50.08 },
      });
      window.dispatchEvent(new Event("touchcancel"));
    });

    expect(handleMoveWaypoint).not.toHaveBeenCalled();

    // The cancelled touch never produces the synthetic click that would normally
    // clear `swallowNextClickRef`, so `cancelDrag` must clear it itself.
    // The rider's next map click must not be swallowed.
    act(() => {
      mapHandlers.get("click")?.({
        point: { x: 320, y: 240 },
        lngLat: { lng: 14.6, lat: 50.18 },
      });
    });

    // Left-click no longer adds waypoints; but the click handler must run
    // without the event being swallowed (swallow flag was cleared by cancelDrag).
    expect(handleAddWaypoint).not.toHaveBeenCalled();
  });

  it("finishes a drag on a window-level mouseup that lands outside the canvas", () => {
    const handleMoveWaypoint = vi.fn();
    const layerHandlers = new Map<string, (event: unknown) => void>();
    const mapHandlers = new Map<string, (event: unknown) => void>();
    mockMap.on.mockImplementation(
      (event: string, layerOrHandler: unknown, maybeHandler?: unknown) => {
        if (typeof layerOrHandler === "string") {
          layerHandlers.set(
            `${event}:${layerOrHandler}`,
            maybeHandler as (event: unknown) => void,
          );
        } else {
          mapHandlers.set(event, layerOrHandler as (event: unknown) => void);
        }
        return mockMap;
      },
    );
    mockMap.off.mockImplementation((event: string, layerOrHandler: unknown) => {
      if (typeof layerOrHandler === "string") {
        layerHandlers.delete(`${event}:${layerOrHandler}`);
      } else {
        mapHandlers.delete(event);
      }
      return mockMap;
    });
    mockMap.queryRenderedFeatures.mockReturnValue([]);

    render(
      <TripPlannerMap
        trip={trip()}
        month={7}
        onMoveWaypoint={handleMoveWaypoint}
      />,
    );

    act(() => {
      layerHandlers.get("mousedown:trip-planner-waypoint-pin")?.({
        preventDefault: vi.fn(),
        features: [{ properties: { dayNumber: 1, waypointId: "start-1" } }],
        point: { x: 100, y: 100 },
        lngLat: { lng: 14.41, lat: 50.08 },
      });
      mapHandlers.get("mousemove")?.({
        preventDefault: vi.fn(),
        point: { x: 200, y: 160 },
        lngLat: { lng: 14.5, lat: 50.12 },
      });
    });

    // Release outside the map canvas — only the window listener fires.
    // clientX 1200 is past the mocked 800 px-wide canvas (x=0..800).
    act(() => {
      window.dispatchEvent(
        new MouseEvent("mouseup", {
          clientX: 1200,
          clientY: 400,
          bubbles: true,
        }),
      );
    });

    // The drop must commit so the waypoint follows the rider's pointer
    // and the cursor / drag state is cleared. With only the map-scoped
    // listeners, releasing past the canvas edge would leave the gesture
    // stuck mid-drag forever.
    expect(handleMoveWaypoint).toHaveBeenCalledTimes(1);
    expect(mockCanvas.style.cursor).toBe("");

    // Subsequent unrelated window mouseup must not fire again — there
    // is no `active` drag, so finishDrag bails out via its guard.
    act(() => {
      window.dispatchEvent(
        new MouseEvent("mouseup", {
          clientX: 100,
          clientY: 100,
          bubbles: true,
        }),
      );
    });
    expect(handleMoveWaypoint).toHaveBeenCalledTimes(1);
  });

  it("treats a tap on a waypoint without movement as a no-op", () => {
    const handleAddWaypoint = vi.fn();
    const handleMoveWaypoint = vi.fn();
    const layerHandlers = new Map<string, (event: unknown) => void>();
    const mapHandlers = new Map<string, (event: unknown) => void>();
    mockMap.on.mockImplementation(
      (event: string, layerOrHandler: unknown, maybeHandler?: unknown) => {
        if (typeof layerOrHandler === "string") {
          layerHandlers.set(
            `${event}:${layerOrHandler}`,
            maybeHandler as (event: unknown) => void,
          );
        } else {
          mapHandlers.set(event, layerOrHandler as (event: unknown) => void);
        }
        return mockMap;
      },
    );
    mockMap.off.mockImplementation((event: string, layerOrHandler: unknown) => {
      if (typeof layerOrHandler === "string") {
        layerHandlers.delete(`${event}:${layerOrHandler}`);
      } else {
        mapHandlers.delete(event);
      }
      return mockMap;
    });
    mockMap.queryRenderedFeatures.mockReturnValue([]);

    render(
      <TripPlannerMap
        trip={trip()}
        month={7}
        onAddWaypoint={handleAddWaypoint}
        onMoveWaypoint={handleMoveWaypoint}
      />,
    );

    // Tap inside the waypoint circle but slightly off centre — the
    // mouseup `lngLat` differs from the marker's stored location, so
    // committing it would silently nudge the waypoint by a few pixels.
    act(() => {
      layerHandlers.get("mousedown:trip-planner-waypoint-pin")?.({
        preventDefault: vi.fn(),
        features: [{ properties: { dayNumber: 1, waypointId: "start-1" } }],
        point: { x: 100, y: 100 },
        lngLat: { lng: 14.41, lat: 50.08 },
      });
      mapHandlers.get("mouseup")?.({
        point: { x: 102, y: 101 },
        lngLat: { lng: 14.412, lat: 50.082 },
        preventDefault: vi.fn(),
      });
      mapHandlers.get("click")?.({
        point: { x: 102, y: 101 },
        lngLat: { lng: 14.412, lat: 50.082 },
      });
    });

    expect(handleMoveWaypoint).not.toHaveBeenCalled();
    expect(handleAddWaypoint).not.toHaveBeenCalled();
  });

  it("snaps a dropped waypoint to a nearby road when one is visible", () => {
    const handleMoveWaypoint = vi.fn();
    const layerHandlers = new Map<string, (event: unknown) => void>();
    const mapHandlers = new Map<string, (event: unknown) => void>();
    mockMap.on.mockImplementation(
      (event: string, layerOrHandler: unknown, maybeHandler?: unknown) => {
        if (typeof layerOrHandler === "string") {
          layerHandlers.set(
            `${event}:${layerOrHandler}`,
            maybeHandler as (event: unknown) => void,
          );
        } else {
          mapHandlers.set(event, layerOrHandler as (event: unknown) => void);
        }
        return mockMap;
      },
    );
    mockMap.off.mockImplementation((event: string, layerOrHandler: unknown) => {
      if (typeof layerOrHandler === "string") {
        layerHandlers.delete(`${event}:${layerOrHandler}`);
      } else {
        mapHandlers.delete(event);
      }
      return mockMap;
    });
    mockMap.queryRenderedFeatures.mockReturnValue([
      {
        geometry: {
          type: "LineString",
          coordinates: [
            [14.5, 50.1],
            [14.6, 50.1],
          ],
        },
        properties: { quality_score: 4.6 },
      },
    ]);

    render(
      <TripPlannerMap
        trip={trip()}
        month={7}
        onMoveWaypoint={handleMoveWaypoint}
      />,
    );

    act(() => {
      layerHandlers.get("mousedown:trip-planner-waypoint-pin")?.({
        preventDefault: vi.fn(),
        features: [{ properties: { dayNumber: 1, waypointId: "start-1" } }],
        point: { x: 100, y: 100 },
        lngLat: { lng: 14.41, lat: 50.08 },
      });
      mapHandlers.get("mouseup")?.({
        point: { x: 200, y: 110 },
        lngLat: { lng: 14.55, lat: 50.107 },
        preventDefault: vi.fn(),
      });
    });

    expect(handleMoveWaypoint).toHaveBeenCalledWith(1, "start-1", {
      lng: 14.55,
      lat: 50.1,
    });
  });

  it("reuses parent-loaded conditions without refetching route data", () => {
    render(
      <TripPlannerMap
        trip={trip()}
        month={7}
        closuresData={{
          closures: [],
          routeClosures: [],
          counts: { full: 0, partial: 0, advisory: 0, total: 0 },
          routeCounts: { full: 0, partial: 0, advisory: 0, total: 0 },
          loading: false,
          routeLoading: false,
          error: null,
          routeError: null,
          previewDate: new Date("2026-07-15T12:00:00Z"),
        }}
        passesData={{
          passes: [],
          routePasses: [],
          routeClosedCount: 0,
          routeUnknownCount: 0,
          loading: false,
          routeLoading: false,
          error: null,
          routeError: null,
        }}
      />,
    );

    expect(useClosuresMock).not.toHaveBeenCalled();
    expect(usePassesMock).not.toHaveBeenCalled();
    expect(buildTripClosureRoutesMock).not.toHaveBeenCalled();
  });

  it("hides the condition reroute on read-only maps", () => {
    // The trip-detail page renders this map without edit callbacks: a
    // reroute there would mutate only the store while the immutable
    // trip prop keeps rendering — a silent no-op with a desynced view.
    const demoClosure = {
      id: "cl-1",
      title: "Bridge resurfacing",
      reason: "roadworks" as const,
      severity: "partial" as const,
      geometry: [
        { lat: 50.1, lng: 14.49 },
        { lat: 50.12, lng: 14.52 },
      ],
      detour: null,
      country_code: "CZ",
      region: null,
      starts_at: "2026-07-01T00:00:00Z",
      ends_at: "2026-07-18T00:00:00Z",
      notes: null,
      source: "operator" as const,
      created_by: null,
      created_at: "2026-06-20T00:00:00Z",
      updated_at: "2026-06-20T00:00:00Z",
    };
    const conditionsProps = {
      closuresData: {
        closures: [demoClosure],
        routeClosures: [demoClosure],
        counts: { full: 0, partial: 1, advisory: 0, total: 1 },
        routeCounts: { full: 0, partial: 1, advisory: 0, total: 1 },
        loading: false,
        routeLoading: false,
        error: null,
        routeError: null,
        previewDate: new Date("2026-07-15T12:00:00Z"),
      },
      passesData: {
        passes: [],
        routePasses: [],
        routeClosedCount: 0,
        routeUnknownCount: 0,
        loading: false,
        routeLoading: false,
        error: null,
        routeError: null,
      },
    };

    // Read-only (no waypoint-edit callbacks): popover opens, no reroute.
    const readOnlyRef = createRef<TripPlannerMapHandle>();
    const readOnly = render(
      <TripPlannerMap
        ref={readOnlyRef}
        trip={trip()}
        month={7}
        {...conditionsProps}
      />,
    );
    act(() =>
      readOnlyRef.current?.openConditionPopover({
        kind: "closure",
        id: "cl-1",
      }),
    );
    expect(screen.getByText("Bridge resurfacing")).toBeInTheDocument();
    expect(screen.getByText("Affects your route")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Reroute around it" }),
    ).toBeNull();
    readOnly.unmount();

    // Editable planner map: the reroute action is offered.
    const editableRef = createRef<TripPlannerMapHandle>();
    render(
      <TripPlannerMap
        ref={editableRef}
        trip={trip()}
        month={7}
        onMoveWaypoint={vi.fn()}
        {...conditionsProps}
      />,
    );
    act(() =>
      editableRef.current?.openConditionPopover({
        kind: "closure",
        id: "cl-1",
      }),
    );
    expect(
      screen.getByRole("button", { name: "Reroute around it" }),
    ).toBeInTheDocument();
  });

  it("labels the pass popover with its closed/unknown status", () => {
    // The map draws ONE seasonal-pass badge for closed and unknown alike
    // (design), so the popover must carry the distinction.
    const demoPass = {
      id: "pass-1",
      name: "Stelvio Pass",
      country_code: "IT",
      region: "Lombardy",
      lat: 46.52,
      lng: 10.45,
      elevation_m: 2757,
      typical_open_month: 6,
      typical_close_month: 10,
      status: "closed" as const,
      status_overridden: false,
      notes: null,
      last_updated: "2026-04-01T00:00:00Z",
    };
    const ref = createRef<TripPlannerMapHandle>();
    render(
      <TripPlannerMap
        ref={ref}
        trip={trip()}
        month={7}
        closuresData={{
          closures: [],
          routeClosures: [],
          counts: { full: 0, partial: 0, advisory: 0, total: 0 },
          routeCounts: { full: 0, partial: 0, advisory: 0, total: 0 },
          loading: false,
          routeLoading: false,
          error: null,
          routeError: null,
          previewDate: new Date("2026-07-15T12:00:00Z"),
        }}
        passesData={{
          passes: [demoPass],
          routePasses: [demoPass],
          routeClosedCount: 1,
          routeUnknownCount: 0,
          loading: false,
          routeLoading: false,
          error: null,
          routeError: null,
        }}
      />,
    );

    act(() =>
      ref.current?.openConditionPopover({ kind: "pass", id: "pass-1" }),
    );
    expect(screen.getByText("Stelvio Pass")).toBeInTheDocument();
    expect(screen.getByText("Seasonal pass · Closed")).toBeInTheDocument();
  });

  it("passes per-segment quality features covering every day to the route source", async () => {
    const multiDayTrip: Trip = {
      ...trip(),
      num_days: 2,
      days: [
        {
          ...trip().days[0]!,
          dayNumber: 1,
        },
        {
          dayNumber: 2,
          title: "Day two",
          distanceKm: 98,
          durationMinutes: 150,
          elevationGain: 620,
          avgQuality: 3.8,
          routeGeometry: {
            type: "LineString",
            coordinates: [
              [14.7, 50.25],
              [14.82, 50.3],
              [14.95, 50.36],
            ],
          },
          waypoints: [
            {
              id: "start-2",
              name: "Louny",
              location: { lng: 14.71, lat: 50.24 },
              type: "start",
            },
            {
              id: "end-2",
              name: "Decin",
              location: { lng: 14.98, lat: 50.37 },
              type: "end",
            },
          ],
        },
      ],
    };

    render(
      <TripPlannerMap trip={multiDayTrip} month={7} selectedDayNumber={1} />,
    );

    // Wait for the sync effect (triggered after ready=true) to push the
    // route collection to the mock source — the route source receives 2
    // addSource calls: one empty from ensurePlannerLayers and one with
    // the real data from the syncGeoJsonSource effect.
    await waitFor(() => {
      const routeSourceCalls = mockMap.addSource.mock.calls.filter(
        ([sourceId]) => sourceId === "trip-planner-route",
      );
      const features = routeSourceCalls
        .map(
          (call) =>
            (call[1] as { data: { features: unknown[] } }).data.features,
        )
        .find((f) => f.length > 0) as
        | Array<{ properties: { dayNumber: number; segmentId: string } }>
        | undefined;
      // Per-segment features now — both days must be represented and every
      // feature must carry a clickable segment id.
      expect(features).toBeDefined();
      const dayNumbers = new Set(features!.map((f) => f.properties.dayNumber));
      expect(dayNumbers).toEqual(new Set([1, 2]));
      expect(
        features!.every((f) => /^d\d+-s\d+$/.test(f.properties.segmentId)),
      ).toBe(true);
    });
  });
});
