import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { forwardRef, useEffect, useImperativeHandle } from "react";
import { TripPlannerMap } from "./TripPlannerMap";
import type { Trip } from "@/lib/types";
import { createRegionDrawControl } from "@/components/map/RegionDrawControl";
import { useClosures } from "@/hooks/useClosures";
import { usePasses } from "@/hooks/usePasses";
import { buildTripClosureRoutes } from "@/lib/closures-summary";

const mockMap = {
  addSource: vi.fn(),
  getSource: vi.fn(),
  addLayer: vi.fn(),
  getLayer: vi.fn(),
  on: vi.fn(),
  off: vi.fn(),
  queryRenderedFeatures: vi.fn(),
  setPaintProperty: vi.fn(),
  fitBounds: vi.fn(),
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

function trip(): Trip {
  return {
    id: "trip-1",
    name: "Planner test trip",
    status: "draft",
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
    mockMap.on.mockReset();
    mockMap.off.mockReset();
    mockMap.queryRenderedFeatures.mockReset();
    mockMap.setPaintProperty.mockReset();
    mockMap.fitBounds.mockReset();
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
  });

  it("toggles the shared MapCanvas quality and surface overlays", () => {
    render(<TripPlannerMap trip={trip()} month={7} />);

    const canvas = screen.getByTestId("planner-map-canvas");
    expect(canvas).toHaveAttribute("data-show-quality", "true");
    expect(canvas).toHaveAttribute("data-show-surface", "false");

    fireEvent.click(
      screen.getByRole("button", { name: "Surface overlay off" }),
    );
    expect(canvas).toHaveAttribute("data-show-surface", "true");

    fireEvent.click(
      screen.getByRole("button", { name: "Road quality overlay on" }),
    );
    expect(canvas).toHaveAttribute("data-show-quality", "false");
  });

  it("snaps map clicks onto nearby road geometry before adding a waypoint", () => {
    const handleAddWaypoint = vi.fn();
    const eventHandlers = new Map<string, (event: unknown) => void>();
    mockMap.on.mockImplementation((event, handler) => {
      eventHandlers.set(event, handler);
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

    render(
      <TripPlannerMap
        trip={trip()}
        month={7}
        onAddWaypoint={handleAddWaypoint}
      />,
    );

    act(() => {
      eventHandlers.get("click")?.({
        point: { x: 180, y: 140 },
        lngLat: { lng: 14.435, lat: 50.106 },
      });
    });

    expect(handleAddWaypoint).toHaveBeenCalledWith({
      lng: 14.435,
      lat: 50.1,
    });
  });

  it("surfaces rectangle drawing controls and lets riders clear a drawn region", () => {
    render(<TripPlannerMap trip={trip()} month={7} />);

    fireEvent.click(screen.getByRole("button", { name: "Draw region" }));
    expect(drawControl.start).toHaveBeenCalledTimes(1);

    act(() => {
      lastDrawOptions?.onModeChange?.("drawing");
    });
    expect(
      screen.getByRole("button", { name: "Cancel drawing" }),
    ).toBeInTheDocument();

    act(() => {
      lastDrawOptions?.onRegionDrawn([14.4, 50.08, 14.7, 50.3]);
      lastDrawOptions?.onModeChange?.("idle");
    });
    expect(
      screen.getByRole("button", { name: "Clear region" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Redraw region" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /Drag the region to move it, drag a handle to resize, or press Delete to remove\./,
      ),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Clear region" }));
    expect(drawControl.clearDrawn).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByRole("button", { name: "Clear region" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Draw region" }),
    ).toBeInTheDocument();
  });

  it("clears the drawn region when the rider presses Delete or Backspace", () => {
    render(<TripPlannerMap trip={trip()} month={7} />);

    act(() => {
      lastDrawOptions?.onRegionDrawn([14.4, 50.08, 14.7, 50.3]);
      lastDrawOptions?.onModeChange?.("idle");
    });
    expect(
      screen.getByRole("button", { name: "Clear region" }),
    ).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "Delete" });
    expect(drawControl.clearDrawn).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByRole("button", { name: "Clear region" }),
    ).not.toBeInTheDocument();

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

  it("hides the Cancel drawing button while editing the drawn region", () => {
    render(<TripPlannerMap trip={trip()} month={7} />);

    act(() => {
      lastDrawOptions?.onRegionDrawn([14.4, 50.08, 14.7, 50.3]);
      lastDrawOptions?.onModeChange?.("idle");
    });
    act(() => {
      lastDrawOptions?.onModeChange?.("editing");
    });

    expect(
      screen.queryByRole("button", { name: "Cancel drawing" }),
    ).not.toBeInTheDocument();
    // The "Redraw region" entry-point should still be reachable so the
    // rider can outline a fresh rectangle even while a drag is active.
    expect(
      screen.getByRole("button", { name: "Redraw region" }),
    ).toBeInTheDocument();
  });

  it("does not add a waypoint when the click lands on the drawn region", () => {
    const handleAddWaypoint = vi.fn();
    const eventHandlers = new Map<string, (event: unknown) => void>();
    mockMap.on.mockImplementation((event, handler) => {
      eventHandlers.set(event, handler);
      return mockMap;
    });
    mockMap.off.mockImplementation((event) => {
      eventHandlers.delete(event);
      return mockMap;
    });
    drawControl.hitTest.mockReturnValue(true);

    render(
      <TripPlannerMap
        trip={trip()}
        month={7}
        onAddWaypoint={handleAddWaypoint}
      />,
    );

    act(() => {
      lastDrawOptions?.onRegionDrawn([14.4, 50.08, 14.7, 50.3]);
      lastDrawOptions?.onModeChange?.("idle");
    });

    act(() => {
      eventHandlers.get("click")?.({
        point: { x: 200, y: 200 },
        lngLat: { lng: 14.55, lat: 50.2 },
      });
    });

    expect(drawControl.hitTest).toHaveBeenCalledWith({ x: 200, y: 200 });
    expect(handleAddWaypoint).not.toHaveBeenCalled();
  });

  it("re-fits the map when trip bounds change on the same trip id", () => {
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

      return waitFor(() => {
        expect(mockMap.fitBounds).toHaveBeenCalledTimes(1);
        expect(mockMap.fitBounds).toHaveBeenCalledWith(
          [
            [15.11, 50.58],
            [15.61, 50.79],
          ],
          expect.objectContaining({
            padding: 72,
            duration: 0,
            maxZoom: 11,
          }),
        );
      });
    });
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

  it("shows in-map seasonal condition details and registers closure/pass overlay sources", () => {
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

    expect(screen.getByText("Conditions for July")).toBeInTheDocument();
    expect(screen.getByText("Stelvio summit roadworks")).toBeInTheDocument();
    expect(screen.getByText("Roadworks")).toBeInTheDocument();
    expect(screen.getByText("Jul 1 - Jul 21")).toBeInTheDocument();
    expect(screen.getByText("Stelvio Pass")).toBeInTheDocument();
    expect(screen.getByText("Open · 2,757 m")).toBeInTheDocument();

    expect(mockMap.addSource).toHaveBeenCalledWith(
      "trip-planner-closure-lines",
      expect.objectContaining({ type: "geojson" }),
    );
    expect(mockMap.addSource).toHaveBeenCalledWith(
      "trip-planner-pass-markers",
      expect.objectContaining({ type: "geojson" }),
    );
  });

  it("shows route-check failures instead of a false safe-route message", () => {
    useClosuresMock.mockReturnValue({
      closures: [],
      routeClosures: [],
      counts: { full: 0, partial: 0, advisory: 0, total: 0 },
      routeCounts: { full: 0, partial: 0, advisory: 0, total: 0 },
      loading: false,
      routeLoading: false,
      error: null,
      routeError: "Failed to check route closures",
      previewDate: new Date("2026-07-15T12:00:00Z"),
    });
    usePassesMock.mockReturnValue({
      passes: [],
      routePasses: [],
      routeClosedCount: 0,
      routeUnknownCount: 0,
      loading: false,
      routeLoading: false,
      error: null,
      routeError: "Failed to check route passes",
    });

    render(<TripPlannerMap trip={trip()} month={7} />);

    expect(
      screen.getByText("Failed to check route closures"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("No route closures or pass warnings for this month."),
    ).not.toBeInTheDocument();
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
    expect(
      screen.getByText("No route closures or pass warnings for this month."),
    ).toBeInTheDocument();
  });
});
