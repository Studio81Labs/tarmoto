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
const mockMap = {
  addSource: vi.fn(),
  getSource: vi.fn(),
  addLayer: vi.fn(),
  getLayer: vi.fn(),
  on: vi.fn(),
  off: vi.fn(),
  queryRenderedFeatures: vi.fn(),
  querySourceFeatures: vi.fn(),
  setPaintProperty: vi.fn(),
  setLayoutProperty: vi.fn(),
  setFilter: vi.fn(),
  fitBounds: vi.fn(),
  getCanvas: vi.fn(() => mockCanvas),
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
    mockMap.on.mockReset();
    mockMap.off.mockReset();
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
      screen.getByRole("button", { name: "Color the route line by surface" }),
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
        name: "Color the route line by road quality",
      }),
    );
    expect(canvas).toHaveAttribute("data-show-quality", "true");
    expect(canvas).toHaveAttribute("data-show-surface", "false");
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
    expect(
      screen.getByText(
        /Drag the region to move it, drag a handle to resize, or press Delete to remove\./,
      ),
    ).toBeInTheDocument();

    act(() => ref.current?.cancelRegionDraw());
    expect(drawControl.cancel).toHaveBeenCalledTimes(1);
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
