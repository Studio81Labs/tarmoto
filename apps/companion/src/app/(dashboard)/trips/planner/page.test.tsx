import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import TripPlannerPage from "./page";
import { useClosures, type ClosuresQueryResult } from "@/hooks/useClosures";
import { usePasses, type PassesQueryResult } from "@/hooks/usePasses";
import { useTripStore } from "@/stores/trip";
import { tripsApi } from "@/lib/api";
import type { Trip } from "@/lib/types";

const { mockPush } = vi.hoisted(() => ({
  mockPush: vi.fn(),
}));

const mockedTripPlannerMap = vi.fn((_props?: unknown) => (
  <div data-testid="trip-planner-map" />
));
const mockedPassesPanel = vi.fn((_props?: unknown) => (
  <div data-testid="passes-panel" />
));
const mockedClosuresPanel = vi.fn((_props?: unknown) => (
  <div data-testid="closures-panel" />
));
const mockedTripCollaborateModal = vi.fn((_props?: unknown) => null);

vi.mock("@/hooks/useClosures", () => ({
  useClosures: vi.fn(),
}));

vi.mock("@/hooks/usePasses", () => ({
  usePasses: vi.fn(),
}));

vi.mock("@/stores/trip", () => ({
  useTripStore: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
}));

vi.mock("@/lib/api", () => ({
  tripsApi: {
    get: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    importRoute: vi.fn(),
    replaceImportedRoute: vi.fn(),
    generate: vi.fn(),
  },
}));

vi.mock("@/lib/closures-summary", async () => {
  const actual = await vi.importActual<typeof import("@/lib/closures-summary")>(
    "@/lib/closures-summary",
  );
  return {
    ...actual,
    buildTripClosureRoutes: vi.fn(() => [
      {
        id: "day-1",
        label: "Day 1 · Demo",
        points: [
          { lat: 50.08, lng: 14.41 },
          { lat: 50.19, lng: 14.61 },
        ],
      },
    ]),
  };
});

vi.mock("@/components/TripPlannerMap", () => ({
  TripPlannerMap: (props: unknown) => mockedTripPlannerMap(props),
}));

vi.mock("@/components/PassesPanel", () => ({
  PassesPanel: (props: unknown) => mockedPassesPanel(props),
}));

vi.mock("@/components/ClosuresPanel", () => ({
  ClosuresPanel: (props: unknown) => mockedClosuresPanel(props),
}));

vi.mock("@/components/SegmentSidebar", () => ({
  SegmentSidebar: () => <div data-testid="segment-sidebar" />,
}));

vi.mock("@/components/TripStopsPanel", () => ({
  TripStopsPanel: () => <div data-testid="trip-stops-panel" />,
}));

vi.mock("@/components/TripExportMenu", () => ({
  TripExportMenu: () => <div data-testid="trip-export-menu" />,
}));

vi.mock("@/components/TripImportDialog", () => ({
  TripImportDialog: () => null,
}));

vi.mock("@/components/TripCollaborateModal", () => ({
  TripCollaborateModal: (props: unknown) => mockedTripCollaborateModal(props),
}));

function buildTrip(name: string): Trip {
  return {
    id: name.toLowerCase().replace(/\s+/g, "-"),
    name,
    status: "draft",
    createdAt: "2026-04-23T09:00:00Z",
    updatedAt: "2026-04-23T09:00:00Z",
    collaborators: [],
    parameters: {
      days: 3,
      dailyKmTarget: 250,
      roadPreference: "mixed",
      surfacePreference: ["asphalt"],
      avoidHighways: true,
      avoidTolls: false,
      avoidUnpaved: true,
      minQuality: 3,
    },
    days: [
      {
        dayNumber: 1,
        title: "Day 1",
        distanceKm: 240,
        durationMinutes: 310,
        elevationGain: 1800,
        avgQuality: 4,
        overnightStop: {
          id: "stay-1",
          name: "Bormio",
          type: "accommodation",
          location: { lng: 10.37, lat: 46.47 },
        },
        routeGeometry: {
          type: "LineString",
          coordinates: [
            [10.37, 46.47],
            [10.57, 46.61],
          ],
        },
        waypoints: [
          {
            id: "wp-1",
            name: "Bormio",
            type: "start",
            location: { lng: 10.37, lat: 46.47 },
          },
          {
            id: "wp-2",
            name: "Prato allo Stelvio",
            type: "end",
            location: { lng: 10.57, lat: 46.61 },
          },
        ],
        segments: [],
      },
    ],
  };
}

function buildTripDetail(
  name: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    id: "server-trip-1",
    title: name,
    region: null,
    num_days: 3,
    status: "planned",
    member_count: 1,
    created_at: "2026-04-23T09:00:00Z",
    daily_km_min: 250,
    daily_km_max: 250,
    min_quality: 3,
    road_preference: "mixed",
    invite_code: "ABCDEFGH",
    members: [
      {
        user_id: "u-owner",
        display_name: "Owner",
        role: "owner",
        joined_at: "2026-04-23T09:00:00Z",
      },
    ],
    days: [
      {
        id: "day-1",
        day_number: 1,
        title: "Backend day",
        distance_km: 251,
        avg_quality: 4.4,
        elevation_gain: 1200,
        elevation_loss: 900,
        curviness_score: 74,
        scenic_score: 81,
        estimated_time_min: 288,
        route_geometry: [
          { lat: 46.47, lng: 10.37 },
          { lat: 46.52, lng: 10.45 },
          { lat: 46.61, lng: 10.57 },
        ],
        waypoints: [
          {
            id: "wp-start",
            sequence: 0,
            lat: 46.47,
            lng: 10.37,
            name: "Bormio",
            waypoint_type: "start",
            road_segment_id: null,
            notes: null,
            duration_min: null,
          },
          {
            id: "wp-end",
            sequence: 1,
            lat: 46.61,
            lng: 10.57,
            name: "Prato allo Stelvio",
            waypoint_type: "end",
            road_segment_id: null,
            notes: null,
            duration_min: null,
          },
        ],
      },
    ],
    ...overrides,
  };
}

function buildGenerationResponse(selected = "best-fit") {
  const option = (id: string, label: string, title: string) => ({
    id,
    label,
    summary: `${label} from backend`,
    total_distance_km: id === "fastest" ? 220 : id === "scenic" ? 284 : 251,
    total_duration_min: id === "fastest" ? 240 : id === "scenic" ? 330 : 288,
    avg_quality: id === "fastest" ? 3.9 : id === "scenic" ? 4.7 : 4.4,
    avg_curviness: id === "fastest" ? 62 : id === "scenic" ? 88 : 74,
    avg_scenic: id === "fastest" ? 64 : id === "scenic" ? 92 : 81,
    selected: id === selected,
    days: buildTripDetail(title).days,
  });

  const selectedLabel =
    selected === "fastest"
      ? "Fastest backend"
      : selected === "scenic"
        ? "Scenic backend"
        : "Best backend";

  return {
    trip: buildTripDetail(selectedLabel),
    selected_option: selected,
    options: [
      option("best-fit", "Best backend", "Best backend"),
      option("scenic", "Scenic backend", "Scenic backend"),
      option("fastest", "Fastest backend", "Fastest backend"),
    ],
  };
}

type TripStoreSnapshot = {
  trips: Trip[];
  activeTrip: Trip | null;
  isGenerating: boolean;
  canUndo: boolean;
  canRedo: boolean;
  focusedSegmentId: string | null;
  hoveredSegmentId: string | null;
  undoStack: Array<Trip | null>;
  redoStack: Array<Trip | null>;
  setTrips: (trips: Trip[]) => void;
  setActiveTrip: (trip: Trip | null) => void;
  setGenerating: (isGenerating: boolean) => void;
  focusSegment: (segmentId: string | null) => void;
  hoverSegment: (segmentId: string | null) => void;
  addWaypoint: (dayIndex: number, waypoint: unknown) => void;
  appendPlannerWaypoint: (
    dayIndex: number,
    waypoint: unknown,
    parameters?: Trip["parameters"],
  ) => void;
  insertWaypointBeforeEnd: (dayIndex: number, waypoint: unknown) => void;
  removeWaypoint: (dayIndex: number, waypointId: string) => void;
  moveWaypoint: (
    dayIndex: number,
    waypointId: string,
    location: { lng: number; lat: number },
    parameters?: Trip["parameters"],
  ) => void;
  reorderWaypoints: (
    dayIndex: number,
    fromIndex: number,
    toIndex: number,
  ) => void;
  undo: () => void;
  redo: () => void;
};

describe("TripPlannerPage", () => {
  const useClosuresMock = vi.mocked(useClosures);
  const usePassesMock = vi.mocked(usePasses);
  const useTripStoreMock = vi.mocked(useTripStore);
  const tripsApiCreateMock = vi.mocked(tripsApi.create);
  const tripsApiDeleteMock = vi.mocked(tripsApi.delete);
  const tripsApiGenerateMock = vi.mocked(tripsApi.generate);
  const tripsApiGetMock = vi.mocked(tripsApi.get);
  const tripsApiImportRouteMock = vi.mocked(tripsApi.importRoute);
  const tripsApiReplaceImportedRouteMock = vi.mocked(
    tripsApi.replaceImportedRoute,
  );
  const tripsApiUpdateMock = vi.mocked(tripsApi.update);

  const closuresData: ClosuresQueryResult = {
    closures: [],
    routeClosures: [],
    counts: { full: 0, partial: 0, advisory: 0, total: 0 },
    routeCounts: { full: 0, partial: 0, advisory: 0, total: 0 },
    loading: false,
    routeLoading: false,
    error: null,
    routeError: null,
    previewDate: new Date("2026-07-15T12:00:00Z"),
  };

  const passesData: PassesQueryResult = {
    passes: [],
    routePasses: [],
    routeClosedCount: 0,
    routeUnknownCount: 0,
    loading: false,
    routeLoading: false,
    error: null,
    routeError: null,
  };

  const setActiveTrip = vi.fn<(trip: Trip | null) => void>();
  const setGenerating = vi.fn<(isGenerating: boolean) => void>();
  const activeTrip = buildTrip("Best fit");
  let storeState: TripStoreSnapshot;

  beforeEach(() => {
    // Each test starts on the bare planner URL so URL hydration can't bleed
    // between cases.
    window.history.replaceState({}, "", "/trips/planner");
    mockedTripPlannerMap.mockClear();
    mockedPassesPanel.mockClear();
    mockedClosuresPanel.mockClear();
    mockedTripCollaborateModal.mockClear();
    mockPush.mockClear();
    setActiveTrip.mockReset();
    setGenerating.mockReset();
    useClosuresMock.mockReset();
    usePassesMock.mockReset();
    tripsApiCreateMock.mockReset();
    tripsApiDeleteMock.mockReset();
    tripsApiGenerateMock.mockReset();
    tripsApiGetMock.mockReset();
    tripsApiImportRouteMock.mockReset();
    tripsApiReplaceImportedRouteMock.mockReset();
    tripsApiUpdateMock.mockReset();
    tripsApiCreateMock.mockResolvedValue({
      data: { id: "server-trip-1" },
    } as never);
    tripsApiDeleteMock.mockResolvedValue({ data: undefined } as never);
    tripsApiGenerateMock.mockResolvedValue({
      data: buildGenerationResponse(),
    } as never);
    tripsApiGetMock.mockResolvedValue({ data: {} } as never);
    tripsApiImportRouteMock.mockResolvedValue({
      data: { id: "imported-server-trip-1" },
    } as never);
    tripsApiReplaceImportedRouteMock.mockResolvedValue({
      data: { id: "promoted-imported-trip-1" },
    } as never);
    tripsApiUpdateMock.mockResolvedValue({
      data: { id: "server-trip-1" },
    } as never);
    setActiveTrip.mockImplementation((trip) => {
      storeState.activeTrip = trip;
    });
    setGenerating.mockImplementation((isGenerating) => {
      storeState.isGenerating = isGenerating;
    });
    storeState = {
      trips: [],
      activeTrip: null,
      isGenerating: false,
      canUndo: false,
      canRedo: false,
      focusedSegmentId: null,
      hoveredSegmentId: null,
      undoStack: [],
      redoStack: [],
      setTrips: vi.fn(),
      setActiveTrip,
      setGenerating,
      focusSegment: vi.fn(),
      hoverSegment: vi.fn(),
      addWaypoint: vi.fn(),
      appendPlannerWaypoint: vi.fn(),
      insertWaypointBeforeEnd: vi.fn(),
      removeWaypoint: vi.fn(),
      moveWaypoint: vi.fn(),
      reorderWaypoints: vi.fn(),
      undo: vi.fn(),
      redo: vi.fn(),
    };
    useTripStoreMock.mockImplementation((selector) => selector(storeState));
    useClosuresMock.mockReturnValue(closuresData);
    usePassesMock.mockReturnValue(passesData);
  });

  it("fetches planner conditions once and shares the results with the map and sidebar panels", () => {
    render(<TripPlannerPage />);

    expect(screen.getByTestId("trip-planner-map")).toBeInTheDocument();
    expect(useClosuresMock).toHaveBeenCalledTimes(1);
    expect(usePassesMock).toHaveBeenCalledTimes(1);

    expect(mockedTripPlannerMap).toHaveBeenCalledWith(
      expect.objectContaining({
        month: expect.any(Number),
        closuresData,
        passesData,
      }),
    );
    expect(mockedClosuresPanel).toHaveBeenCalledWith(
      expect.objectContaining({
        data: closuresData,
      }),
    );
    expect(mockedPassesPanel).toHaveBeenCalledWith(
      expect.objectContaining({
        data: passesData,
      }),
    );
    expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Redo" })).toBeDisabled();
  });

  it("keeps placeholder timeline tabs non-interactive until a trip exists", () => {
    render(<TripPlannerPage />);

    expect(screen.getByRole("button", { name: /Day 1/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Day 2/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Day 3/i })).toBeDisabled();
    expect(mockedTripPlannerMap).toHaveBeenCalledWith(
      expect.objectContaining({
        selectedDayNumber: 1,
      }),
    );
  });

  it("passes the live planner parameters into map-click waypoint creation", () => {
    render(<TripPlannerPage />);

    fireEvent.change(screen.getByLabelText("Number of days"), {
      target: { value: "5" },
    });
    fireEvent.change(screen.getByLabelText("Daily km target"), {
      target: { value: "180" },
    });
    fireEvent.change(screen.getByLabelText("Road preference"), {
      target: { value: "direct" },
    });
    fireEvent.click(screen.getByLabelText("Gravel"));
    fireEvent.click(screen.getByLabelText("Avoid highways"));
    fireEvent.click(screen.getByLabelText("Avoid tolls"));

    const latestMapProps = mockedTripPlannerMap.mock.calls.at(-1)?.[0] as
      | { onAddWaypoint?: (location: { lng: number; lat: number }) => void }
      | undefined;
    const onAddWaypoint = latestMapProps?.onAddWaypoint;

    expect(onAddWaypoint).toBeDefined();

    onAddWaypoint?.({ lng: 14.41, lat: 50.08 });

    expect(storeState.appendPlannerWaypoint).toHaveBeenCalledWith(
      0,
      {
        lng: 14.41,
        lat: 50.08,
      },
      {
        days: 5,
        dailyKmTarget: 180,
        roadPreference: "direct",
        surfacePreference: ["asphalt", "gravel"],
        avoidHighways: false,
        avoidTolls: true,
        avoidUnpaved: true,
        minQuality: 3,
      },
    );
  });

  it("dispatches moveWaypoint with the matching day index and live planner params when a marker is dropped on the map", () => {
    render(<TripPlannerPage />);

    // Change controls so the test can assert the *live* sidebar values
    // are forwarded — not the trip's persisted parameters. Without
    // threading these through, drag-rebuilds would silently use the
    // last saved parameters and ignore the rider's current settings.
    fireEvent.change(screen.getByLabelText("Number of days"), {
      target: { value: "5" },
    });
    fireEvent.change(screen.getByLabelText("Road preference"), {
      target: { value: "scenic" },
    });
    fireEvent.change(screen.getByLabelText("Minimum road quality"), {
      target: { value: "4" },
    });

    const latestMapProps = mockedTripPlannerMap.mock.calls.at(-1)?.[0] as
      | {
          onMoveWaypoint?: (
            dayNumber: number,
            waypointId: string,
            location: { lng: number; lat: number },
          ) => void;
        }
      | undefined;
    const onMoveWaypoint = latestMapProps?.onMoveWaypoint;

    expect(onMoveWaypoint).toBeDefined();

    onMoveWaypoint?.(2, "wp-via-1", { lng: 14.55, lat: 50.12 });

    expect(storeState.moveWaypoint).toHaveBeenCalledWith(
      1,
      "wp-via-1",
      { lng: 14.55, lat: 50.12 },
      {
        days: 5,
        dailyKmTarget: 250,
        roadPreference: "scenic",
        surfacePreference: ["asphalt"],
        avoidHighways: true,
        avoidTolls: false,
        avoidUnpaved: true,
        minQuality: 4,
      },
    );
  });

  it("generates itinerary options from the planner parameters and selects the best-fit trip", async () => {
    tripsApiGenerateMock.mockResolvedValueOnce({
      data: buildGenerationResponse(),
    } as never);
    storeState.activeTrip = activeTrip;

    render(<TripPlannerPage />);

    fireEvent.change(screen.getByLabelText("Number of days"), {
      target: { value: "4" },
    });
    fireEvent.change(screen.getByLabelText("Daily km target"), {
      target: { value: "320" },
    });
    fireEvent.click(screen.getByLabelText("Gravel"));
    fireEvent.click(screen.getByRole("button", { name: "Generate itinerary" }));

    await waitFor(() =>
      expect(tripsApiCreateMock).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Best fit",
          num_days: 4,
          daily_km_min: 320,
          daily_km_max: 320,
        }),
      ),
    );
    expect(tripsApiGenerateMock).toHaveBeenCalledWith(
      "server-trip-1",
      expect.objectContaining({
        start_location: { lat: 46.47, lng: 10.37 },
        avoid_highways: true,
        avoid_tolls: false,
        avoid_unpaved: true,
        surfaces: ["asphalt"],
      }),
    );
    expect(setGenerating).toHaveBeenNthCalledWith(1, true);
    expect(setActiveTrip).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "server-trip-1",
        name: "Best backend",
        days: [
          expect.objectContaining({
            routeGeometry: {
              type: "LineString",
              coordinates: [
                [10.37, 46.47],
                [10.45, 46.52],
                [10.57, 46.61],
              ],
            },
          }),
        ],
      }),
    );
    expect(setGenerating).toHaveBeenLastCalledWith(false);
    expect(screen.getByText("Scenic backend")).toBeInTheDocument();
    expect(screen.getByText("Fastest backend")).toBeInTheDocument();
  });

  it("persists a newly selected backend option before showing it as active", async () => {
    tripsApiGenerateMock
      .mockResolvedValueOnce({ data: buildGenerationResponse() } as never)
      .mockResolvedValueOnce({
        data: buildGenerationResponse("fastest"),
      } as never);
    storeState.activeTrip = activeTrip;

    render(<TripPlannerPage />);

    fireEvent.click(screen.getByRole("button", { name: "Generate itinerary" }));

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Fastest backend/i })),
    );

    fireEvent.click(screen.getByRole("button", { name: /Fastest backend/i }));

    await waitFor(() =>
      expect(tripsApiGenerateMock).toHaveBeenLastCalledWith(
        "server-trip-1",
        expect.objectContaining({
          option: "fastest",
        }),
      ),
    );
    expect(setActiveTrip).toHaveBeenLastCalledWith(
      expect.objectContaining({
        name: "Fastest backend",
      }),
    );
  });

  it("shows a backend generation error without falling back to demo options", async () => {
    tripsApiGenerateMock.mockRejectedValueOnce(new Error("route failed"));
    storeState.activeTrip = activeTrip;

    render(<TripPlannerPage />);

    fireEvent.click(screen.getByRole("button", { name: "Generate itinerary" }));

    expect(
      await screen.findByText(
        "Could not generate itinerary options right now.",
      ),
    ).toBeInTheDocument();
    expect(setActiveTrip).not.toHaveBeenCalledWith(activeTrip);
  });

  it("shows a stable average-quality value for empty generated options", async () => {
    tripsApiGenerateMock.mockResolvedValueOnce({
      data: {
        ...buildGenerationResponse(),
        trip: buildTripDetail("Empty option", { days: [] }),
        options: [
          {
            id: "best-fit",
            label: "Empty option",
            summary: "No generated days",
            total_distance_km: 0,
            total_duration_min: 0,
            avg_quality: 0,
            avg_curviness: 0,
            avg_scenic: 0,
            selected: true,
            days: [],
          },
        ],
      },
    } as never);
    storeState.activeTrip = activeTrip;

    render(<TripPlannerPage />);

    fireEvent.click(screen.getByRole("button", { name: "Generate itinerary" }));

    await waitFor(() =>
      expect(
        screen.getByRole("heading", { level: 1, name: "Empty option" }),
      ).toBeInTheDocument(),
    );
    expect(screen.getByText("0.0/5")).toBeInTheDocument();
    expect(screen.queryByText("NaN")).not.toBeInTheDocument();
  });

  it("saves the selected generated option to the backend", async () => {
    storeState.activeTrip = activeTrip;
    render(<TripPlannerPage />);

    fireEvent.click(screen.getByRole("button", { name: "Generate itinerary" }));

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Fastest backend/i })),
    );

    tripsApiGenerateMock.mockResolvedValueOnce({
      data: buildGenerationResponse("fastest"),
    } as never);
    fireEvent.click(screen.getByRole("button", { name: /Fastest backend/i }));

    await waitFor(() =>
      expect(tripsApiGenerateMock).toHaveBeenCalledWith(
        "server-trip-1",
        expect.objectContaining({
          option: "fastest",
        }),
      ),
    );

    tripsApiGenerateMock.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(mockPush).toHaveBeenCalledWith("/trips/server-trip-1"),
    );
    expect(tripsApiGenerateMock).not.toHaveBeenCalled();
  });

  it("keeps request-only generation filters live after installing the generated backend trip", async () => {
    storeState.activeTrip = activeTrip;
    render(<TripPlannerPage />);

    fireEvent.click(screen.getByLabelText("Avoid highways"));
    fireEvent.click(screen.getByLabelText("Gravel"));
    fireEvent.click(screen.getByRole("button", { name: "Generate itinerary" }));

    await waitFor(() =>
      expect(setActiveTrip).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "Best backend",
          parameters: expect.objectContaining({
            surfacePreference: ["asphalt", "gravel"],
            avoidHighways: false,
            avoidUnpaved: true,
          }),
        }),
      ),
    );
    expect(screen.getByLabelText("Avoid highways")).not.toBeChecked();
    expect(screen.getByLabelText("Gravel")).toBeChecked();

    tripsApiGenerateMock.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(mockPush).toHaveBeenCalledWith("/trips/server-trip-1"),
    );
    expect(tripsApiGenerateMock).not.toHaveBeenCalled();
  });

  it("regenerates the selected backend option when planner controls change before saving", async () => {
    storeState.activeTrip = activeTrip;
    render(<TripPlannerPage />);

    fireEvent.click(screen.getByRole("button", { name: "Generate itinerary" }));

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Best backend/i })),
    );

    tripsApiGenerateMock.mockClear();
    fireEvent.change(screen.getByLabelText("Number of days"), {
      target: { value: "4" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(tripsApiUpdateMock).toHaveBeenCalledWith(
        "server-trip-1",
        expect.objectContaining({
          num_days: 4,
        }),
      ),
    );
    expect(tripsApiGenerateMock).toHaveBeenCalledWith(
      "server-trip-1",
      expect.objectContaining({
        option: "best-fit",
      }),
    );
    expect(mockPush).toHaveBeenCalledWith("/trips/server-trip-1");
  });

  it("does not expose day-scoped regeneration for backend-generated options", async () => {
    storeState.activeTrip = activeTrip;
    render(<TripPlannerPage />);

    fireEvent.click(screen.getByRole("button", { name: "Generate itinerary" }));

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Best backend/i })),
    );

    expect(
      screen.queryByRole("button", { name: /Regenerate day 1/i }),
    ).not.toBeInTheDocument();
  });

  it("deletes a newly created metadata-only trip when route generation fails", async () => {
    tripsApiGenerateMock.mockRejectedValueOnce(new Error("route failed"));
    storeState.activeTrip = activeTrip;

    render(<TripPlannerPage />);

    fireEvent.click(screen.getByRole("button", { name: "Generate itinerary" }));

    await waitFor(() =>
      expect(tripsApiDeleteMock).toHaveBeenCalledWith("server-trip-1"),
    );
    expect(mockPush).not.toHaveBeenCalled();
  });

  it("sends a valid daily-km band when saving a short daily target", async () => {
    storeState.activeTrip = {
      ...activeTrip,
      parameters: {
        ...activeTrip.parameters,
        dailyKmTarget: 100,
      },
    };

    render(<TripPlannerPage />);

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(tripsApiCreateMock).toHaveBeenCalledWith(
        expect.objectContaining({
          daily_km_min: 100,
          daily_km_max: 100,
        }),
      ),
    );
  });

  it("normalizes zero daily-km targets to the backend minimum instead of dropping them", async () => {
    storeState.activeTrip = {
      ...activeTrip,
      parameters: {
        ...activeTrip.parameters,
        dailyKmTarget: 0,
      },
    };

    render(<TripPlannerPage />);

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(tripsApiCreateMock).toHaveBeenCalledWith(
        expect.objectContaining({
          daily_km_min: 1,
          daily_km_max: 1,
        }),
      ),
    );
  });

  it("blocks contradictory unpaved surface filters before creating a trip", async () => {
    storeState.activeTrip = {
      ...activeTrip,
      parameters: {
        ...activeTrip.parameters,
        surfacePreference: ["gravel"],
        avoidUnpaved: true,
      },
    };

    render(<TripPlannerPage />);

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(
      await screen.findByText(
        "Select at least one paved surface or turn off Avoid unpaved roads before saving.",
      ),
    ).toBeInTheDocument();
    expect(tripsApiCreateMock).not.toHaveBeenCalled();
    expect(tripsApiGenerateMock).not.toHaveBeenCalled();
  });

  it("does not save or redirect when the trip has no start waypoint", async () => {
    storeState.activeTrip = {
      ...activeTrip,
      days: [
        {
          ...activeTrip.days[0]!,
          waypoints: [],
        },
      ],
    };

    render(<TripPlannerPage />);

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(
      await screen.findByText("Add a start waypoint before saving this trip."),
    ).toBeInTheDocument();
    expect(tripsApiCreateMock).not.toHaveBeenCalled();
    expect(tripsApiGenerateMock).not.toHaveBeenCalled();
    expect(mockPush).not.toHaveBeenCalled();
  });

  it("preserves imported route geometry when saving an imported draft", async () => {
    storeState.activeTrip = {
      ...activeTrip,
      id: "imported-123",
      name: "Passo loop import",
      importSourceFormat: "kml",
      days: [
        {
          ...activeTrip.days[0]!,
          routeGeometry: {
            type: "LineString",
            coordinates: [
              [10.37, 46.47],
              [10.45, 46.55],
              [10.57, 46.61],
            ],
          },
          waypoints: [
            {
              id: "wp-start",
              name: "Bormio",
              type: "start",
              location: { lng: 10.37, lat: 46.47 },
            },
            {
              id: "wp-via",
              name: "Umbrail",
              type: "photo",
              location: { lng: 10.45, lat: 46.55 },
            },
            {
              id: "wp-end",
              name: "Prato allo Stelvio",
              type: "end",
              location: { lng: 10.57, lat: 46.61 },
            },
          ],
        },
      ],
    };

    render(<TripPlannerPage />);

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(tripsApiImportRouteMock).toHaveBeenCalledWith({
        title: "Passo loop import",
        source_format: "kml",
        geometry: [
          { lng: 10.37, lat: 46.47 },
          { lng: 10.45, lat: 46.55 },
          { lng: 10.57, lat: 46.61 },
        ],
        waypoints: [
          { lng: 10.37, lat: 46.47, name: "Bormio" },
          { lng: 10.45, lat: 46.55, name: "Umbrail", type: "photo" },
          { lng: 10.57, lat: 46.61, name: "Prato allo Stelvio" },
        ],
      }),
    );
    expect(tripsApiCreateMock).not.toHaveBeenCalled();
    expect(tripsApiGenerateMock).not.toHaveBeenCalled();
    expect(mockPush).toHaveBeenCalledWith("/trips/imported-server-trip-1");
  });

  it("writes an imported draft into the promoted server trip instead of creating a duplicate", async () => {
    const promotedTripId = "11111111-2222-4333-8444-555555555555";
    storeState.activeTrip = {
      ...activeTrip,
      id: "imported-456",
      name: "Promoted import",
      importSourceFormat: "gpx",
      days: [
        {
          ...activeTrip.days[0]!,
          routeGeometry: {
            type: "LineString",
            coordinates: [
              [10.37, 46.47],
              [10.57, 46.61],
            ],
          },
        },
      ],
    };

    render(<TripPlannerPage />);

    const latestModalProps = mockedTripCollaborateModal.mock.calls.at(
      -1,
    )?.[0] as { onPromoted?: (tripId: string) => void } | undefined;

    await act(async () => {
      latestModalProps?.onPromoted?.(promotedTripId);
    });

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(tripsApiReplaceImportedRouteMock).toHaveBeenCalledWith(
        promotedTripId,
        expect.objectContaining({
          title: "Promoted import",
          source_format: "gpx",
          geometry: [
            { lng: 10.37, lat: 46.47 },
            { lng: 10.57, lat: 46.61 },
          ],
        }),
      ),
    );
    expect(tripsApiImportRouteMock).not.toHaveBeenCalled();
    expect(tripsApiCreateMock).not.toHaveBeenCalled();
    expect(tripsApiGenerateMock).not.toHaveBeenCalled();
    expect(mockPush).toHaveBeenCalledWith(`/trips/${promotedTripId}`);
  });

  it("updates server-loaded trips from the current controls without regenerating existing route geometry", async () => {
    const serverTripId = "11111111-2222-4333-8444-555555555555";
    tripsApiUpdateMock.mockResolvedValueOnce({
      data: { id: serverTripId },
    } as never);
    storeState.activeTrip = {
      ...activeTrip,
      id: serverTripId,
      name: "Server loaded route",
    };

    render(<TripPlannerPage />);

    fireEvent.change(screen.getByLabelText("Number of days"), {
      target: { value: "5" },
    });
    fireEvent.change(screen.getByLabelText("Daily km target"), {
      target: { value: "180" },
    });
    fireEvent.change(screen.getByLabelText("Road preference"), {
      target: { value: "direct" },
    });
    fireEvent.change(screen.getByLabelText("Minimum road quality"), {
      target: { value: "4" },
    });
    fireEvent.click(screen.getByLabelText("Avoid highways"));

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(tripsApiUpdateMock).toHaveBeenCalledWith(
        serverTripId,
        expect.objectContaining({
          title: "Server loaded route",
          num_days: 5,
          daily_km_min: 180,
          daily_km_max: 180,
          min_quality: 4,
          road_preference: "fast",
        }),
      ),
    );
    expect(tripsApiGenerateMock).not.toHaveBeenCalled();
    expect(mockPush).toHaveBeenCalledWith(`/trips/${serverTripId}`);
  });

  it("keeps the save button disabled after successful save while navigation is pending", async () => {
    storeState.activeTrip = activeTrip;
    render(<TripPlannerPage />);

    fireEvent.click(screen.getByRole("button", { name: "Generate itinerary" }));

    await waitFor(() =>
      expect(setActiveTrip).toHaveBeenCalledWith(
        expect.objectContaining({ name: "Best backend" }),
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(mockPush).toHaveBeenCalledWith("/trips/server-trip-1"),
    );
    expect(screen.getByRole("button", { name: "Saving…" })).toBeDisabled();
  });

  it("toggles aria-pressed on the parameters button when the panel is shown or hidden", () => {
    render(<TripPlannerPage />);

    const button = screen.getByRole("button", { name: /Parameters/i });
    expect(button).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(button);
    expect(button).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(button);
    expect(button).toHaveAttribute("aria-pressed", "true");
  });

  it("hydrates planner controls from the URL on mount", () => {
    window.history.replaceState(
      {},
      "",
      "/trips/planner?days=7&dailyKm=320&road=scenic&surfaces=asphalt,gravel&minQuality=4&avoidHighways=0&avoidTolls=1&avoidUnpaved=0",
    );

    render(<TripPlannerPage />);

    expect(screen.getByLabelText("Number of days")).toHaveValue(7);
    expect(screen.getByLabelText("Daily km target")).toHaveValue(320);
    expect(screen.getByLabelText("Road preference")).toHaveValue("scenic");
    expect(screen.getByLabelText("Minimum road quality")).toHaveValue("4");
    expect(screen.getByLabelText("Asphalt")).toBeChecked();
    expect(screen.getByLabelText("Gravel")).toBeChecked();
    expect(screen.getByLabelText("Concrete")).not.toBeChecked();
    expect(screen.getByLabelText("Avoid highways")).not.toBeChecked();
    expect(screen.getByLabelText("Avoid tolls")).toBeChecked();
    expect(screen.getByLabelText("Avoid unpaved roads")).not.toBeChecked();
  });

  it("clamps and ignores invalid URL planner values without crashing", () => {
    window.history.replaceState(
      {},
      "",
      "/trips/planner?days=99&dailyKm=nope&road=teleport&surfaces=lava,asphalt&minQuality=0",
    );

    render(<TripPlannerPage />);

    expect(screen.getByLabelText("Number of days")).toHaveValue(14);
    expect(screen.getByLabelText("Daily km target")).toHaveValue(250);
    expect(screen.getByLabelText("Road preference")).toHaveValue("mixed");
    expect(screen.getByLabelText("Minimum road quality")).toHaveValue("1");
    expect(screen.getByLabelText("Asphalt")).toBeChecked();
    expect(screen.getByLabelText("Gravel")).not.toBeChecked();
  });

  it("writes planner control changes to the URL via history.replaceState", () => {
    render(<TripPlannerPage />);

    fireEvent.change(screen.getByLabelText("Number of days"), {
      target: { value: "7" },
    });
    expect(window.location.search).toContain("days=7");

    fireEvent.change(screen.getByLabelText("Daily km target"), {
      target: { value: "320" },
    });
    expect(window.location.search).toContain("dailyKm=320");

    fireEvent.change(screen.getByLabelText("Road preference"), {
      target: { value: "scenic" },
    });
    expect(window.location.search).toContain("road=scenic");

    fireEvent.click(screen.getByLabelText("Gravel"));
    expect(window.location.search).toContain("surfaces=asphalt%2Cgravel");

    fireEvent.click(screen.getByLabelText("Avoid highways"));
    expect(window.location.search).toContain("avoidHighways=0");
  });

  it("removes planner parameters from the URL when controls return to defaults", () => {
    window.history.replaceState({}, "", "/trips/planner?days=7&road=scenic");

    render(<TripPlannerPage />);

    fireEvent.change(screen.getByLabelText("Number of days"), {
      target: { value: "3" },
    });
    expect(window.location.search).not.toMatch(/[?&]days=/);
    expect(window.location.search).toContain("road=scenic");

    fireEvent.change(screen.getByLabelText("Road preference"), {
      target: { value: "mixed" },
    });
    expect(window.location.search).not.toMatch(/[?&]road=/);
  });

  it("preserves the tripId search param when syncing planner controls", () => {
    window.history.replaceState(
      {},
      "",
      "/trips/planner?tripId=11111111-2222-4333-8444-555555555555",
    );

    render(<TripPlannerPage />);

    fireEvent.change(screen.getByLabelText("Number of days"), {
      target: { value: "5" },
    });

    expect(window.location.search).toContain(
      "tripId=11111111-2222-4333-8444-555555555555",
    );
    expect(window.location.search).toContain("days=5");
  });

  it("updates the promoted server trip instead of creating a duplicate draft", async () => {
    const promotedTripId = "11111111-2222-4333-8444-555555555555";
    tripsApiUpdateMock.mockResolvedValueOnce({
      data: { id: promotedTripId },
    } as never);
    storeState.activeTrip = activeTrip;

    render(<TripPlannerPage />);

    const latestModalProps = mockedTripCollaborateModal.mock.calls.at(
      -1,
    )?.[0] as { onPromoted?: (tripId: string) => void } | undefined;

    await act(async () => {
      latestModalProps?.onPromoted?.(promotedTripId);
    });

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(tripsApiUpdateMock).toHaveBeenCalledWith(
        promotedTripId,
        expect.any(Object),
      ),
    );
    expect(tripsApiCreateMock).not.toHaveBeenCalled();
    expect(tripsApiGenerateMock).toHaveBeenCalledWith(
      promotedTripId,
      expect.objectContaining({ option: undefined }),
    );
    expect(mockPush).toHaveBeenCalledWith(`/trips/${promotedTripId}`);
  });
});
