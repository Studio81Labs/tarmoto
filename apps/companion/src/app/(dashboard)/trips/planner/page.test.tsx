import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import TripPlannerPage from "./page";
import { ToastHost } from "@/components/ToastHost";
import { useToastStore } from "@/stores/toast";
import { useClosures, type ClosuresQueryResult } from "@/hooks/useClosures";
import { usePasses, type PassesQueryResult } from "@/hooks/usePasses";
import { useTripStore, type BackendWaypointType } from "@/stores/trip";
import { useAuthStore } from "@/stores/auth";
import { tripsApi } from "@/lib/api";
import { plannerApi } from "@/lib/planner/api";
import type { Trip, TripParameters, TripSummary, Waypoint } from "@/lib/types";
import { usePlannerRouting } from "@/hooks/usePlannerRouting";

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
  useTripStore: Object.assign(vi.fn(), {
    getState: vi.fn(),
  }),
  MAX_TRIP_DAYS: 14,
  // Mirror the real pure helper: re-type a terminal accommodation to `end`
  // when the day has no explicit end (generated overnight day).
  normalizeDayFinish: (waypoints: { type: string }[]) => {
    if (waypoints.some((w) => w.type === "end")) return waypoints;
    const lastIdx = waypoints.length - 1;
    if (waypoints[lastIdx]?.type === "accommodation") {
      return waypoints.map((w, i) =>
        i === lastIdx ? { ...w, type: "end" } : w,
      );
    }
    return waypoints;
  },
  // Mirror the real helper: the day's finish is its `end`, or a terminal
  // accommodation (generated overnight) when there's no explicit end.
  dayFinishWaypoint: (waypoints: { type: string }[]) => {
    const end = waypoints.find((w) => w.type === "end");
    if (end) return end;
    const last = waypoints[waypoints.length - 1];
    return last?.type === "accommodation" ? last : undefined;
  },
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
    saveRoute: vi.fn(),
  },
}));

// Prevent the live-routing hook from firing real API calls in unit tests.
vi.mock("@/hooks/usePlannerRouting", () => ({
  usePlannerRouting: vi.fn(() => ({ routing: false })),
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
    num_days: 3,
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

type TripStoreSnapshot = {
  trips: TripSummary[];
  tripsOwnerId: string | null;
  activeTrip: Trip | null;
  isGenerating: boolean;
  canUndo: boolean;
  canRedo: boolean;
  routeDirty: boolean;
  stalePreviewDays: number[];
  selectedDayIndex: number;
  focusedSegmentId: string | null;
  hoveredSegmentId: string | null;
  undoStack: Array<{ trip: Trip | null; dirty: boolean; stale: number[] }>;
  redoStack: Array<{ trip: Trip | null; dirty: boolean; stale: number[] }>;
  setTrips: (trips: TripSummary[], ownerId?: string | null) => void;
  setActiveTrip: (trip: Trip | null) => void;
  setGenerating: (isGenerating: boolean) => void;
  setSelectedDay: (index: number) => void;
  addDay: () => void;
  removeDay: (index: number) => void;
  relinkDayStart: (index: number) => void;
  markRouteDirty: () => void;
  draftPlannerParameters: TripParameters | null;
  setDraftPlannerParameters: (parameters: TripParameters) => void;
  focusSegment: (segmentId: string | null) => void;
  hoverSegment: (segmentId: string | null) => void;
  selectedPlannerSegmentId: string | null;
  activePoiCategories: ReadonlySet<import("@/lib/planner/types").PoiCategory>;
  togglePoiCategory: (
    category: import("@/lib/planner/types").PoiCategory,
  ) => void;
  selectPlannerSegment: (segmentId: string | null) => void;
  planningMode: "single" | "multiday";
  setPlanningMode: (mode: "single" | "multiday") => void;
  splitStatus: "none" | "split" | "stale";
  dayPlans: import("@/lib/planner/types").DayPlan[] | null;
  pinnedBreakKms: number[];
  applySplit: (
    dayPlans: import("@/lib/planner/types").DayPlan[],
    pinnedBreakKms?: number[],
  ) => void;
  clearSplit: () => void;
  setPinnedBreaks: (kms: number[]) => void;
  materializeSplit: () => void;
  renameWaypoint: (waypointId: string, name: string) => void;
  renameActiveTrip: (name: string) => void;
  addWaypoint: (dayIndex: number, waypoint: unknown) => void;
  appendPlannerWaypoint: (
    dayIndex: number,
    waypoint: unknown,
    parameters?: Trip["parameters"],
  ) => void;
  insertWaypointBeforeEnd: (dayIndex: number, waypoint: unknown) => void;
  insertWaypointBefore: (
    dayIndex: number,
    beforeWaypointId: string | null,
    waypoint: unknown,
  ) => void;
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
  placeWaypoint: (coords: { lat: number; lng: number }, action: string) => void;
  setWaypointType: (waypointId: string, type: Waypoint["type"]) => void;
  removeWaypointById: (waypointId: string) => void;
  routingWaypoints: () => { lat: number; lng: number }[];
  saveWaypoints: () => {
    lat: number;
    lng: number;
    name?: string;
    type: BackendWaypointType;
  }[];
  saveDays: () => {
    dayNumber: number;
    title: string | null;
    startLinked: boolean;
    waypoints: {
      lat: number;
      lng: number;
      name?: string;
      type: BackendWaypointType;
    }[];
  }[];
  applyRouteResult: (dayNumber: number, result: unknown) => void;
  resetForTest: () => void;
};

describe("TripPlannerPage", () => {
  const useClosuresMock = vi.mocked(useClosures);
  const usePassesMock = vi.mocked(usePasses);
  const useTripStoreMock = vi.mocked(useTripStore);
  const usePlannerRoutingMock = vi.mocked(usePlannerRouting);
  const tripsApiCreateMock = vi.mocked(tripsApi.create);
  const tripsApiDeleteMock = vi.mocked(tripsApi.delete);
  const tripsApiGetMock = vi.mocked(tripsApi.get);
  const tripsApiImportRouteMock = vi.mocked(tripsApi.importRoute);
  const tripsApiReplaceImportedRouteMock = vi.mocked(
    tripsApi.replaceImportedRoute,
  );
  const tripsApiUpdateMock = vi.mocked(tripsApi.update);
  const tripsApiSaveRouteMock = vi.mocked(tripsApi.saveRoute);

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
    useToastStore.getState().dismissAll();
    useAuthStore.setState({
      user: null,
      isAuthenticated: false,
      accessToken: null,
    });
    mockedTripPlannerMap.mockClear();
    mockedPassesPanel.mockClear();
    mockedClosuresPanel.mockClear();
    mockedTripCollaborateModal.mockClear();
    mockPush.mockClear();
    setActiveTrip.mockReset();
    setGenerating.mockReset();
    useClosuresMock.mockReset();
    usePassesMock.mockReset();
    usePlannerRoutingMock.mockReset();
    tripsApiCreateMock.mockReset();
    tripsApiDeleteMock.mockReset();
    tripsApiGetMock.mockReset();
    tripsApiImportRouteMock.mockReset();
    tripsApiReplaceImportedRouteMock.mockReset();
    tripsApiUpdateMock.mockReset();
    tripsApiSaveRouteMock.mockReset();
    tripsApiCreateMock.mockResolvedValue({
      data: { id: "server-trip-1" },
    } as never);
    tripsApiDeleteMock.mockResolvedValue({ data: undefined } as never);
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
    tripsApiSaveRouteMock.mockResolvedValue({
      data: buildTripDetail("Saved route"),
    } as never);
    usePlannerRoutingMock.mockReturnValue({ routing: false });
    setActiveTrip.mockImplementation((trip) => {
      storeState.activeTrip = trip;
    });
    setGenerating.mockImplementation((isGenerating) => {
      storeState.isGenerating = isGenerating;
    });
    storeState = {
      trips: [],
      tripsOwnerId: null,
      activeTrip: null,
      isGenerating: false,
      canUndo: false,
      canRedo: false,
      routeDirty: false,
      stalePreviewDays: [],
      selectedDayIndex: 0,
      draftPlannerParameters: null,
      focusedSegmentId: null,
      hoveredSegmentId: null,
      undoStack: [],
      redoStack: [],
      setTrips: vi.fn(),
      setActiveTrip,
      setGenerating,
      setSelectedDay: vi.fn(),
      addDay: vi.fn(),
      removeDay: vi.fn(),
      relinkDayStart: vi.fn(),
      markRouteDirty: vi.fn(),
      setDraftPlannerParameters: vi.fn(),
      focusSegment: vi.fn(),
      hoverSegment: vi.fn(),
      selectedPlannerSegmentId: null,
      activePoiCategories: new Set<import("@/lib/planner/types").PoiCategory>(),
      togglePoiCategory: vi.fn(),
      selectPlannerSegment: vi.fn(),
      planningMode: "single" as const,
      setPlanningMode: vi.fn(),
      splitStatus: "none" as const,
      dayPlans: null,
      pinnedBreakKms: [],
      applySplit: vi.fn(),
      clearSplit: vi.fn(),
      setPinnedBreaks: vi.fn(),
      materializeSplit: vi.fn(),
      renameWaypoint: vi.fn(),
      renameActiveTrip: vi.fn(),
      addWaypoint: vi.fn(),
      appendPlannerWaypoint: vi.fn(),
      insertWaypointBeforeEnd: vi.fn(),
      insertWaypointBefore: vi.fn(),
      removeWaypoint: vi.fn(),
      moveWaypoint: vi.fn(),
      reorderWaypoints: vi.fn(),
      undo: vi.fn(),
      redo: vi.fn(),
      placeWaypoint: vi.fn(),
      setWaypointType: vi.fn(),
      removeWaypointById: vi.fn(),
      routingWaypoints: vi.fn(() => []),
      saveWaypoints: vi.fn(() => [
        {
          lat: 46.47,
          lng: 10.37,
          name: "Bormio",
          type: "start" as BackendWaypointType,
        },
        {
          lat: 46.61,
          lng: 10.57,
          name: "Prato allo Stelvio",
          type: "end" as BackendWaypointType,
        },
      ]),
      saveDays: vi.fn(() => [
        {
          dayNumber: 1,
          title: null,
          startLinked: false,
          waypoints: [
            {
              lat: 46.47,
              lng: 10.37,
              name: "Bormio",
              type: "start" as BackendWaypointType,
            },
            {
              lat: 46.61,
              lng: 10.57,
              name: "Prato allo Stelvio",
              type: "end" as BackendWaypointType,
            },
          ],
        },
      ]),
      applyRouteResult: vi.fn(),
      resetForTest: vi.fn(),
    };
    useTripStoreMock.mockImplementation((selector) => selector(storeState));
    // Wire getState so handleSaveRoute's useTripStore.getState().saveWaypoints()
    // returns the same storeState that the selector-based hook reads.
    vi.mocked(useTripStore).getState = vi.fn(() => storeState as never);
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

  it("renders no day column (not even placeholders) before a split", () => {
    render(<TripPlannerPage />);

    // Revision 2 §B: the day column is ABSENT pre-split — no empty
    // state, no placeholder chips, no day concept anywhere.
    expect(
      screen.queryByRole("button", { name: /Day 1/i }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/No days yet/)).not.toBeInTheDocument();
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

  it("restores the drawn planner region from the URL", async () => {
    window.history.replaceState(
      {},
      "",
      "/trips/planner?bbox=10.3,46.45,10.6,46.7",
    );

    render(<TripPlannerPage />);

    await waitFor(() =>
      expect(mockedTripPlannerMap).toHaveBeenLastCalledWith(
        expect.objectContaining({
          drawnRegion: [10.3, 46.45, 10.6, 46.7],
        }),
      ),
    );
  });

  it("drops a lingering saved trip and its parameters when opened as create-new (no tripId)", async () => {
    // A persisted (UUID) trip left in the store from a prior edit, carrying
    // non-default parameters. Mounting `/trips/planner` with no `?tripId=`
    // is the create-new entry point, so it must reset to a blank canvas AND
    // default controls — not inherit the dropped trip's settings.
    storeState.activeTrip = {
      ...activeTrip,
      id: "11111111-2222-4333-8444-555555555555",
      parameters: { ...activeTrip.parameters, days: 9, dailyKmTarget: 400 },
    };

    render(<TripPlannerPage />);

    await waitFor(() => expect(setActiveTrip).toHaveBeenCalledWith(null));
    expect(screen.getByLabelText("Number of days")).toHaveValue(3);
    expect(screen.getByLabelText("Daily km target")).toHaveValue(250);
  });

  // "Push to phone" was pulled from the toolbar (rider feedback); its
  // metadata/imported-route save flow stays dormant in _handleSave. The
  // toolbar now offers Reset (start over in place) and Discard (delete
  // the persisted trip and go back to the trips list).
  it("offers Reset and Discard instead of Push to phone when a trip exists", () => {
    storeState.activeTrip = activeTrip;

    render(<TripPlannerPage />);

    expect(
      screen.queryByRole("button", { name: "Push to phone \u2192" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reset" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Discard" })).toBeInTheDocument();
  });

  // Reset/Discard confirm through the app-styled ConfirmDialog — the
  // planner never opens system dialogs (they block the whole tab).
  it("Reset clears the working trip after in-app confirmation", () => {
    storeState.activeTrip = activeTrip;

    render(<TripPlannerPage />);
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    fireEvent.click(screen.getByRole("button", { name: "Reset planner" }));

    expect(setActiveTrip).toHaveBeenCalledWith(null);
  });

  it("Reset does nothing when the confirmation is cancelled", () => {
    storeState.activeTrip = activeTrip;

    render(<TripPlannerPage />);
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(setActiveTrip).not.toHaveBeenCalledWith(null);
    expect(
      screen.queryByRole("button", { name: "Reset planner" }),
    ).not.toBeInTheDocument();
  });

  it("Discard deletes the bound server trip and navigates back to trips", async () => {
    const serverTripId = "11111111-2222-4333-8444-555555555555";
    window.history.replaceState(
      {},
      "",
      `/trips/planner?tripId=${serverTripId}`,
    );
    // Hydration failing is fine — the id stays bound for deletion.
    tripsApiGetMock.mockRejectedValue(new Error("offline"));
    tripsApiDeleteMock.mockResolvedValue({ data: {} } as never);
    storeState.activeTrip = activeTrip;

    render(<TripPlannerPage />);
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard route" }));

    await waitFor(() =>
      expect(tripsApiDeleteMock).toHaveBeenCalledWith(serverTripId),
    );
    expect(mockPush).toHaveBeenCalledWith("/trips");
  });

  it("Discard without a persisted trip just leaves the planner", async () => {
    storeState.activeTrip = activeTrip; // in-memory draft id

    render(<TripPlannerPage />);
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard route" }));

    await waitFor(() => expect(mockPush).toHaveBeenCalledWith("/trips"));
    expect(tripsApiDeleteMock).not.toHaveBeenCalled();
  });

  it("dropped the demo-trip shortcut from the toolbar", () => {
    render(<TripPlannerPage />);
    expect(
      screen.queryByRole("button", { name: "Load demo trip" }),
    ).not.toBeInTheDocument();
  });

  it("keeps a drafted loop in roundtrip mode: Recalculate reopens the dialog", () => {
    // Finish placed back on the start coordinates = loop route.
    storeState.activeTrip = {
      ...activeTrip,
      days: [
        {
          ...activeTrip.days[0]!,
          waypoints: [
            {
              id: "s",
              name: "Start",
              type: "start",
              location: { lng: 10, lat: 46 },
            },
            {
              id: "turn",
              name: "Turnaround",
              type: "via",
              location: { lng: 11, lat: 46.5 },
            },
            {
              id: "e",
              name: "Start",
              type: "end",
              location: { lng: 10, lat: 46 },
            },
          ],
        },
      ],
    };

    render(<TripPlannerPage />);

    fireEvent.click(
      screen.getByRole("button", { name: "Recalculate roundtrip" }),
    );

    // The options dialog opens (in recalculate wording) instead of the
    // A\u2192B draft path, whose direct route would be 0 km.
    expect(
      screen.getByRole("dialog", { name: "Roundtrip options" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Recalculate roundtrip" }),
    ).toBeInTheDocument();
  });

  it("labels the draft action Draft roundtrip when only a start exists", () => {
    storeState.activeTrip = {
      ...activeTrip,
      days: [
        {
          ...activeTrip.days[0]!,
          waypoints: [
            {
              id: "s",
              name: "Start",
              type: "start",
              location: { lng: 10, lat: 46 },
            },
          ],
        },
      ],
    };

    render(<TripPlannerPage />);

    expect(
      screen.getByRole("button", { name: "Draft roundtrip" }),
    ).toBeInTheDocument();
    // The one-line roundtrip helper (rider feedback) replaces the old
    // multi-sentence draft paragraph.
    expect(
      screen.getByText(
        "No finish set — Tarmoto will loop you back to your start.",
      ),
    ).toBeInTheDocument();
  });

  it("drafts a roundtrip from the SELECTED day's start, not day 1's", async () => {
    // Two days with day 2 selected and start-only (roundtrip mode). The
    // draft must read the SELECTED day's start — its via inserts target
    // that day, so day 1's endpoints belong to a different leg.
    storeState.activeTrip = {
      ...activeTrip,
      days: [
        activeTrip.days[0]!,
        {
          ...activeTrip.days[0]!,
          dayNumber: 2,
          waypoints: [
            {
              id: "s2",
              name: "Brno",
              type: "start",
              location: { lng: 16.6, lat: 49.2 },
            },
          ],
        },
      ],
    };
    storeState.selectedDayIndex = 1;
    const draftSpy = vi.spyOn(plannerApi, "draftRoundtrip").mockResolvedValue({
      segments: [],
      summary: {
        distanceKm: 240,
        timeMin: 300,
        score: 4,
        surfaceMix: [],
        flagged: [],
      },
      reachedTargetKm: true,
      vias: [],
    });

    render(<TripPlannerPage />);
    fireEvent.click(screen.getByRole("button", { name: "Draft roundtrip" }));
    const dialog = screen.getByRole("dialog", { name: "Roundtrip options" });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Draft roundtrip" }),
    );

    await waitFor(() => expect(draftSpy).toHaveBeenCalledTimes(1));
    expect(draftSpy.mock.calls[0]![0]).toEqual({ lat: 49.2, lng: 16.6 });
    draftSpy.mockRestore();
  });

  it("keeps a day's custom LEG overrides when the rider switches days", () => {
    // Leg overrides are stored per day: reconciliation may only run a
    // day's legs against that day's own spine, so viewing day 2 must
    // not discard day 1's CUSTOM road-type choices.
    const mkWp = (id: string, type: Waypoint["type"], lng: number) => ({
      id,
      name: id,
      type,
      location: { lng, lat: 46 },
    });
    storeState.activeTrip = {
      ...activeTrip,
      days: [
        {
          ...activeTrip.days[0]!,
          waypoints: [
            mkWp("d1-s", "start", 10),
            mkWp("d1-v", "via", 11),
            mkWp("d1-e", "end", 12),
          ],
        },
        {
          ...activeTrip.days[0]!,
          dayNumber: 2,
          waypoints: [mkWp("d2-s", "start", 12), mkWp("d2-e", "end", 13)],
        },
      ],
    };
    storeState.selectedDayIndex = 0;

    const { rerender } = render(<TripPlannerPage />);

    // Override the first day-1 leg to Maximum twisty.
    fireEvent.click(
      screen.getAllByRole("button", { name: "Road type for this leg" })[0]!,
    );
    fireEvent.click(screen.getByRole("button", { name: "Maximum twisty" }));
    const firstLegButton = () =>
      screen.getAllByRole("button", { name: "Road type for this leg" })[0]!;
    expect(firstLegButton()).toHaveTextContent("Maximum twisty");
    expect(firstLegButton()).toHaveTextContent("CUSTOM");

    // Day 2's single leg has no override…
    storeState.selectedDayIndex = 1;
    rerender(<TripPlannerPage />);
    expect(
      screen.getAllByRole("button", { name: "Road type for this leg" }),
    ).toHaveLength(1);
    expect(firstLegButton()).toHaveTextContent("Trip default");
    expect(firstLegButton()).not.toHaveTextContent("CUSTOM");

    // …and returning to day 1 still shows the override.
    storeState.selectedDayIndex = 0;
    rerender(<TripPlannerPage />);
    expect(firstLegButton()).toHaveTextContent("Maximum twisty");
    expect(firstLegButton()).toHaveTextContent("CUSTOM");
  });

  it("does not persist a loaded trip's parameters as saved defaults", async () => {
    // A rider-made pref edit writes back as the new saved defaults (§F),
    // but a later trip hydration applies the TRIP's parameters — those
    // must never ride the still-set touched flag into a second save.
    useAuthStore.setState({
      user: { id: "u-1", email: "r@example.com", displayName: "R" },
      isAuthenticated: true,
      accessToken: "test-access-token",
    });
    const loadSpy = vi
      .spyOn(plannerApi, "getUserRoutePrefs")
      .mockResolvedValue(null);
    const saveSpy = vi
      .spyOn(plannerApi, "saveUserRoutePrefs")
      .mockResolvedValue(undefined);

    const { rerender } = render(<TripPlannerPage />);
    await waitFor(() => expect(loadSpy).toHaveBeenCalled());

    // Rider edit → debounced write-back fires once.
    fireEvent.click(screen.getByRole("button", { name: "Route preferences" }));
    fireEvent.click(screen.getByLabelText(/avoid highways/i));
    await waitFor(() => expect(saveSpy).toHaveBeenCalledTimes(1), {
      timeout: 3000,
    });

    // A different trip hydrates the controls programmatically…
    storeState.activeTrip = {
      ...activeTrip,
      id: "another-trip",
      parameters: { ...activeTrip.parameters, avoidUnpaved: true },
    };
    rerender(<TripPlannerPage />);

    // …and the debounce window passes without a second save.
    await act(() => new Promise((resolve) => window.setTimeout(resolve, 1100)));
    expect(saveSpy).toHaveBeenCalledTimes(1);
    loadSpy.mockRestore();
    saveSpy.mockRestore();
  });

  it("keeps §03 dormant while no waypoints are placed", () => {
    storeState.activeTrip = {
      ...activeTrip,
      days: [
        { ...activeTrip.days[0]!, waypoints: [], routeGeometry: undefined },
      ],
    };

    render(<TripPlannerPage />);

    // No draft button in any wording, and no helper copy — the map's
    // own "place a start point" hint carries the guidance.
    expect(
      screen.queryByRole("button", { name: /draft|propose|recalculate/i }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/No finish set/)).not.toBeInTheDocument();
  });

  it("hides the draft section entirely once start + finish exist", () => {
    // Distinct start (Bormio) and finish (Prato) — the route is already
    // LIVE, so there is nothing to "draft" and §03 disappears; the
    // "Route ready" chip communicates the state instead.
    storeState.activeTrip = activeTrip;

    render(<TripPlannerPage />);

    expect(
      screen.queryByRole("button", { name: /draft|propose|recalculate/i }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Draft route")).not.toBeInTheDocument();
    expect(
      screen.queryByText(/Already placed your points/),
    ).not.toBeInTheDocument();
    // Approximate ride time rides along with the distance (310 min).
    expect(
      screen.getByText("Route ready — 240 km · ~5h 10m"),
    ).toBeInTheDocument();
    expect(screen.getAllByText(/240 km · ~5h 10m/).length).toBeGreaterThan(0);
  });

  it("renders the Fun-Zone card as a checkbox that reflects the drawn region", () => {
    render(<TripPlannerPage />);

    const checkbox = screen.getByRole("checkbox", {
      name: /Draw region · Fun Zones/,
    });
    expect(checkbox).toHaveAttribute("aria-checked", "false");
    expect(
      screen.getByText("Find dense clusters of great road."),
    ).toBeInTheDocument();

    // Checking with no region starts the map draw via the handle — the
    // map is mocked here, so just assert the click doesn't blow up and
    // the box stays unchecked until the map reports a mode change.
    fireEvent.click(checkbox);
    expect(checkbox).toHaveAttribute("aria-checked", "false");
  });

  it("checks the Fun-Zone card and unchecks-to-remove when a region exists", () => {
    // Region hydrated from the URL — same path a shared planner link uses.
    window.history.replaceState(
      {},
      "",
      "/trips/planner?bbox=14.4,50.08,14.7,50.3",
    );

    render(<TripPlannerPage />);

    const checkbox = screen.getByRole("checkbox", {
      name: /Draw region · Fun Zones/,
    });
    expect(checkbox).toHaveAttribute("aria-checked", "true");
    expect(
      screen.getByText(/Region set — drafting keeps the route inside it\./),
    ).toBeInTheDocument();

    // Unchecking with a drawn region removes it.
    fireEvent.click(checkbox);
    expect(checkbox).toHaveAttribute("aria-checked", "false");
    expect(
      screen.getByText("Find dense clusters of great road."),
    ).toBeInTheDocument();
  });

  it("derives the header name from the endpoints and renames via the dialog", () => {
    // Placeholder name + Bormio -> Prato endpoints = derived title.
    storeState.activeTrip = { ...activeTrip, name: "New Trip" };

    render(<TripPlannerPage />);

    fireEvent.click(
      screen.getByRole("button", { name: /Bormio → Prato allo Stelvio/ }),
    );
    const input = screen.getByLabelText("Trip name") as HTMLInputElement;
    expect(input.value).toBe("Bormio → Prato allo Stelvio");

    fireEvent.change(input, { target: { value: "Stelvio raid" } });
    fireEvent.click(screen.getByRole("button", { name: "Save name" }));

    expect(storeState.renameActiveTrip).toHaveBeenCalledWith("Stelvio raid");
    expect(screen.queryByLabelText("Trip name")).toBeNull();
  });

  it("keeps a rider-set name untouched in the header", () => {
    storeState.activeTrip = { ...activeTrip, name: "Passo weekend" };
    render(<TripPlannerPage />);
    expect(
      screen.getByRole("button", { name: /Passo weekend/ }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Bormio → Prato/)).toBeNull();
  });

  it("renders the parameters panel always-visible in the spec 3-col layout", () => {
    // v2 Trip Planner spec drops the toggle UX — Parameters live in
    // the fixed 340 px right column. Asserting one of the labeled
    // controls is reachable on mount proves the panel is present
    // without re-introducing the obsolete toggle button.
    render(<TripPlannerPage />);

    expect(screen.getByLabelText("Number of days")).toBeInTheDocument();
    expect(screen.getByLabelText("Road preference")).toBeInTheDocument();
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
    // Invalid road value falls back to the revision 3 default: direct.
    expect(screen.getByLabelText("Road preference")).toHaveValue("direct");
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
      // 'direct' is the default road preference (revision 3 §A).
      target: { value: "direct" },
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

  it("passes invite-link permission as false for joined planner members", async () => {
    window.history.replaceState(
      {},
      "",
      "/trips/planner?tripId=11111111-2222-4333-8444-555555555555",
    );
    useAuthStore.setState({
      user: {
        id: "u-member",
        email: "member@example.com",
        displayName: "Member",
      },
      isAuthenticated: true,
      accessToken: "test-access-token",
    });
    tripsApiGetMock.mockResolvedValueOnce({
      data: buildTripDetail("Joined trip", {
        id: "11111111-2222-4333-8444-555555555555",
        members: [
          {
            user_id: "u-owner",
            display_name: "Owner",
            role: "owner",
            joined_at: "2026-04-23T09:00:00Z",
          },
          {
            user_id: "u-member",
            display_name: "Member",
            role: "member",
            joined_at: "2026-04-23T09:15:00Z",
          },
        ],
      }),
    } as never);

    render(<TripPlannerPage />);

    await waitFor(() =>
      expect(tripsApiGetMock).toHaveBeenCalledWith(
        "11111111-2222-4333-8444-555555555555",
      ),
    );
    await waitFor(() => {
      expect(mockedTripCollaborateModal).toHaveBeenLastCalledWith(
        expect.objectContaining({ canCreateInviteLink: false }),
      );
    });
  });

  it("passes invite-link permission as true for planner admins", async () => {
    window.history.replaceState(
      {},
      "",
      "/trips/planner?tripId=11111111-2222-4333-8444-555555555555",
    );
    useAuthStore.setState({
      user: {
        id: "u-admin",
        email: "admin@example.com",
        displayName: "Admin",
      },
      isAuthenticated: true,
      accessToken: "test-access-token",
    });
    tripsApiGetMock.mockResolvedValueOnce({
      data: buildTripDetail("Admin trip", {
        id: "11111111-2222-4333-8444-555555555555",
        members: [
          {
            user_id: "u-owner",
            display_name: "Owner",
            role: "owner",
            joined_at: "2026-04-23T09:00:00Z",
          },
          {
            user_id: "u-admin",
            display_name: "Admin",
            role: "admin",
            joined_at: "2026-04-23T09:15:00Z",
          },
        ],
      }),
    } as never);

    render(<TripPlannerPage />);

    await waitFor(() =>
      expect(tripsApiGetMock).toHaveBeenCalledWith(
        "11111111-2222-4333-8444-555555555555",
      ),
    );
    await waitFor(() => {
      expect(mockedTripCollaborateModal).toHaveBeenLastCalledWith(
        expect.objectContaining({ canCreateInviteLink: true }),
      );
    });
  });

  // ── Save route (Task 11) ─────────────────────────────────────────────

  it("disables Save route when fewer than 2 routing waypoints exist", () => {
    // No activeTrip → activeDayWaypoints is null → routingWaypoints is []
    storeState.activeTrip = null;

    render(<TripPlannerPage />);

    expect(screen.getByRole("button", { name: "Save route" })).toBeDisabled();
  });

  it("enables Save route when waypoints + geometry are present AND the draft is dirty", () => {
    // activeTrip fixture has 2 waypoints + routeGeometry
    storeState.activeTrip = activeTrip;
    storeState.routeDirty = true; // rider has edited the route

    render(<TripPlannerPage />);

    expect(
      screen.getByRole("button", { name: "Save route" }),
    ).not.toBeDisabled();
  });

  it("disables Save route while the preview is stale (mid routing debounce)", () => {
    // Edited (routeDirty) with geometry present, but stalePreviewDays non-empty →
    // the displayed geometry is from the pre-edit waypoints; Save must wait.
    storeState.activeTrip = activeTrip;
    storeState.routeDirty = true;
    storeState.stalePreviewDays = [1];

    render(<TripPlannerPage />);

    expect(screen.getByRole("button", { name: "Save route" })).toBeDisabled();
  });

  it("disables Save route on an unedited loaded trip (routeDirty false) so a no-op save can't reroute", () => {
    // Loaded trip with geometry + waypoints but no edits yet.
    storeState.activeTrip = activeTrip;
    storeState.routeDirty = false;

    render(<TripPlannerPage />);

    expect(screen.getByRole("button", { name: "Save route" })).toBeDisabled();
  });

  it("disables Save route when there is a start + via but no end waypoint", () => {
    storeState.activeTrip = {
      ...activeTrip,
      days: [
        {
          ...activeTrip.days[0]!,
          waypoints: [
            {
              id: "wp-1",
              name: "Start",
              type: "start",
              location: { lng: 10.37, lat: 46.47 },
            },
            {
              id: "wp-2",
              name: "Via",
              type: "via",
              location: { lng: 10.5, lat: 46.55 },
            },
          ],
        },
      ],
    };
    storeState.routeDirty = true;

    render(<TripPlannerPage />);

    expect(screen.getByRole("button", { name: "Save route" })).toBeDisabled();
  });

  it("calls tripsApi.saveRoute with days[], creates trip on first save, and shows success toast", async () => {
    storeState.activeTrip = activeTrip;
    storeState.routeDirty = true;

    render(
      <>
        <TripPlannerPage />
        <ToastHost />
      </>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Save route" }));

    await waitFor(() =>
      expect(tripsApiCreateMock).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Best fit", num_days: 1 }),
      ),
    );
    expect(tripsApiSaveRouteMock).toHaveBeenCalledWith(
      "server-trip-1",
      expect.objectContaining({
        days: expect.arrayContaining([
          expect.objectContaining({
            dayNumber: 1,
            startLinked: false,
            waypoints: expect.arrayContaining([
              expect.objectContaining({
                lat: 46.47,
                lng: 10.37,
                type: "start",
              }),
              expect.objectContaining({ lat: 46.61, lng: 10.57, type: "end" }),
            ]),
          }),
        ]),
        options: expect.objectContaining({
          avoid_highways: true,
          avoid_tolls: false,
          avoid_unpaved: true,
        }),
      }),
    );
    expect(setActiveTrip).toHaveBeenCalledWith(
      expect.objectContaining({ id: "server-trip-1" }),
    );
    expect(await screen.findByText("Route saved")).toBeInTheDocument();
  });

  it("saves a multi-day payload with days[] and num_days from day count", async () => {
    // Two non-empty days — saveDays() returns 2 entries.
    storeState.activeTrip = {
      ...activeTrip,
      days: [
        activeTrip.days[0]!,
        {
          ...activeTrip.days[0]!,
          dayNumber: 2,
          title: "Day 2",
          startLinked: true,
          waypoints: [
            {
              id: "wp-d2-start",
              name: "Prato allo Stelvio",
              type: "start",
              location: { lng: 10.57, lat: 46.61 },
            },
            {
              id: "wp-d2-end",
              name: "Innsbruck",
              type: "end",
              location: { lng: 11.39, lat: 47.27 },
            },
          ],
        },
      ],
    };
    storeState.routeDirty = true;
    storeState.stalePreviewDays = [];
    // Override saveDays to return a 2-day payload.
    (storeState.saveDays as ReturnType<typeof vi.fn>).mockReturnValue([
      {
        dayNumber: 1,
        title: null,
        startLinked: false,
        waypoints: [
          {
            lat: 46.47,
            lng: 10.37,
            name: "Bormio",
            type: "start" as BackendWaypointType,
          },
          {
            lat: 46.61,
            lng: 10.57,
            name: "Prato allo Stelvio",
            type: "end" as BackendWaypointType,
          },
        ],
      },
      {
        dayNumber: 2,
        title: null,
        startLinked: true,
        waypoints: [
          {
            lat: 46.61,
            lng: 10.57,
            name: "Prato allo Stelvio",
            type: "start" as BackendWaypointType,
          },
          {
            lat: 47.27,
            lng: 11.39,
            name: "Innsbruck",
            type: "end" as BackendWaypointType,
          },
        ],
      },
    ]);

    render(
      <>
        <TripPlannerPage />
        <ToastHost />
      </>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Save route" }));

    await waitFor(() =>
      expect(tripsApiCreateMock).toHaveBeenCalledWith(
        expect.objectContaining({ num_days: 2 }),
      ),
    );
    expect(tripsApiSaveRouteMock).toHaveBeenCalledWith(
      "server-trip-1",
      expect.objectContaining({
        days: expect.arrayContaining([
          expect.objectContaining({ dayNumber: 1 }),
          expect.objectContaining({ dayNumber: 2 }),
        ]),
      }),
    );
  });

  it("uses the existing server trip id on subsequent Save route calls without creating a duplicate", async () => {
    const serverTripId = "11111111-2222-4333-8444-555555555555";
    window.history.replaceState(
      {},
      "",
      `/trips/planner?tripId=${serverTripId}`,
    );
    storeState.activeTrip = { ...activeTrip, id: serverTripId };
    storeState.routeDirty = true;

    render(<TripPlannerPage />);

    fireEvent.click(screen.getByRole("button", { name: "Save route" }));

    await waitFor(() =>
      expect(tripsApiSaveRouteMock).toHaveBeenCalledWith(
        serverTripId,
        expect.any(Object),
      ),
    );
    expect(tripsApiCreateMock).not.toHaveBeenCalled();
  });

  it("shows an error toast when saveRoute fails", async () => {
    storeState.activeTrip = activeTrip;
    storeState.routeDirty = true;
    tripsApiSaveRouteMock.mockRejectedValueOnce(new Error("network error"));

    render(
      <>
        <TripPlannerPage />
        <ToastHost />
      </>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Save route" }));

    expect(
      await screen.findByText("Could not save the route. Please try again."),
    ).toBeInTheDocument();
  });

  // ── Live routing gate (per-day stale gate) ──────────────────────────

  it("does NOT call usePlannerRouting with enabled=true when routeDirty is false", () => {
    // Simulate opening an existing saved trip that already has geometry.
    // routeDirty is false (default) — liveRouteEnabled = false && ... = false.
    storeState.activeTrip = activeTrip; // has routeGeometry
    storeState.routeDirty = false;
    storeState.stalePreviewDays = [1];

    render(<TripPlannerPage />);

    const lastCall = usePlannerRoutingMock.mock.calls.at(-1);
    expect(lastCall).toBeDefined();
    // The 5th argument is `enabled`
    expect(lastCall?.[3]).toBe(false);
  });

  it("does NOT call usePlannerRouting with enabled=true when the day is not stale", () => {
    // routeDirty=true but stalePreviewDays is empty — no day needs routing.
    storeState.activeTrip = activeTrip;
    storeState.routeDirty = true;
    storeState.stalePreviewDays = []; // day 1 is fresh

    render(<TripPlannerPage />);

    const lastCall = usePlannerRoutingMock.mock.calls.at(-1);
    expect(lastCall).toBeDefined();
    expect(lastCall?.[3]).toBe(false);
  });

  it("calls usePlannerRouting with enabled=true when routeDirty and selected day is stale", () => {
    storeState.activeTrip = activeTrip; // day 1 present
    storeState.routeDirty = true;
    storeState.stalePreviewDays = [1]; // day 1 is stale

    render(<TripPlannerPage />);

    const lastCall = usePlannerRoutingMock.mock.calls.at(-1);
    expect(lastCall).toBeDefined();
    expect(lastCall?.[3]).toBe(true);
  });

  it("routes start→overnight for an accommodation-terminated day (live inputs match Save)", () => {
    storeState.activeTrip = {
      ...activeTrip,
      days: [
        {
          ...activeTrip.days[0]!,
          waypoints: [
            {
              id: "s",
              name: "Start",
              type: "start",
              location: { lng: 10, lat: 46 },
            },
            {
              id: "h",
              name: "Hotel",
              type: "accommodation",
              location: { lng: 11, lat: 46.5 },
            },
          ],
        },
      ],
    };
    storeState.routeDirty = true;
    storeState.stalePreviewDays = [1];

    render(<TripPlannerPage />);

    // The terminal accommodation is normalized to the day's finish, so the
    // live-routing legs (arg 0) span BOTH points — the preview routes to the
    // overnight, matching the route saveDays/the backend will persist.
    const lastCall = usePlannerRoutingMock.mock.calls.at(-1);
    expect(lastCall?.[0]).toEqual([
      expect.objectContaining({
        legId: "s->h",
        from: { lat: 46, lng: 10 },
        to: { lat: 46.5, lng: 11 },
        // The loaded trip's own "mixed" parameter maps to 'balanced'.
        options: expect.objectContaining({ preference: "balanced" }),
      }),
    ]);
  });

  it("does NOT route the selected day when a different day is stale", () => {
    // selectedDayIndex=0 (day 1) but only day 2 is stale — day 1 is fresh.
    storeState.activeTrip = {
      ...activeTrip,
      days: [
        activeTrip.days[0]!,
        {
          ...activeTrip.days[0]!,
          dayNumber: 2,
          waypoints: [],
          routeGeometry: undefined,
        },
      ],
    };
    storeState.selectedDayIndex = 0; // viewing day 1
    storeState.routeDirty = true;
    storeState.stalePreviewDays = [2]; // only day 2 stale

    render(<TripPlannerPage />);

    const lastCall = usePlannerRoutingMock.mock.calls.at(-1);
    expect(lastCall).toBeDefined();
    // day 1 is not in stalePreviewDays so enabled=false
    expect(lastCall?.[3]).toBe(false);
  });

  it("calls markRouteDirty when the user clicks an avoid-options checkbox", () => {
    storeState.activeTrip = activeTrip;
    storeState.routeDirty = false;

    render(<TripPlannerPage />);

    fireEvent.click(screen.getByLabelText("Avoid highways"));
    expect(storeState.markRouteDirty).toHaveBeenCalledTimes(1);
  });

  // ── Task 9: Dynamic day tabs + multi-day save gate ───────────────────

  it("renders one tab per trip day and switches the selected day via store", () => {
    storeState.activeTrip = {
      ...activeTrip,
      days: [
        activeTrip.days[0]!,
        {
          ...activeTrip.days[0]!,
          dayNumber: 2,
          title: "Day 2",
          waypoints: [],
          routeGeometry: undefined,
        },
      ],
    };
    storeState.selectedDayIndex = 0;
    // A loaded multi-day trip presents as an existing split (the day
    // column renders DayPlans; the floating footer is gone).
    storeState.planningMode = "multiday";
    storeState.splitStatus = "split";
    storeState.dayPlans = [1, 2].map((n) => ({
      dayNumber: n,
      segmentIds: [],
      distanceKm: 80,
      timeMin: 90,
      quality: {
        distanceKm: 80,
        timeMin: 90,
        score: 4,
        surfaceMix: [],
        flagged: [],
      },
      startTown: "Start",
      endTown: "Finish",
      suggestedStays: [],
      endKm: 80 * n,
    }));

    render(<TripPlannerPage />);

    const day1Buttons = screen.getAllByRole("button", { name: /Day 1/i });
    const day2Buttons = screen.getAllByRole("button", { name: /Day 2/i });
    expect(day1Buttons.length).toBeGreaterThanOrEqual(1);
    expect(day2Buttons.length).toBeGreaterThanOrEqual(1);

    // Clicking the Day 2 card selects the real day for per-day routing.
    fireEvent.click(day2Buttons[0]!);
    expect(storeState.setSelectedDay).toHaveBeenCalledWith(1);
  });

  it("disables Save route when any day is incomplete (has waypoints but missing end)", () => {
    // Day 1 complete, Day 2 has only a start — incomplete blocks save
    storeState.activeTrip = {
      ...activeTrip,
      days: [
        activeTrip.days[0]!, // complete: start + end
        {
          ...activeTrip.days[0]!,
          dayNumber: 2,
          routeGeometry: {
            type: "LineString",
            coordinates: [
              [10.37, 46.47],
              [10.57, 46.61],
            ],
          },
          waypoints: [
            {
              id: "wp-d2-start",
              name: "Start only",
              type: "start",
              location: { lng: 10.37, lat: 46.47 },
            },
          ],
        },
      ],
    };
    storeState.routeDirty = true;
    storeState.stalePreviewDays = [];

    render(<TripPlannerPage />);

    expect(screen.getByRole("button", { name: "Save route" })).toBeDisabled();
  });

  it("disables Save route while a day preview is stale", () => {
    storeState.activeTrip = {
      ...activeTrip,
      days: [
        activeTrip.days[0]!, // complete
      ],
    };
    storeState.routeDirty = true;
    storeState.stalePreviewDays = [1]; // day 1 is stale

    render(<TripPlannerPage />);

    expect(screen.getByRole("button", { name: "Save route" })).toBeDisabled();
  });

  it("enables Save route when all non-empty days are complete and no day is stale", () => {
    storeState.activeTrip = {
      ...activeTrip,
      days: [
        activeTrip.days[0]!, // complete: start + end + routeGeometry
        {
          ...activeTrip.days[0]!,
          dayNumber: 2,
          waypoints: [],
          distanceKm: 0,
          routeGeometry: undefined,
        }, // empty day — does not block save
      ],
    };
    storeState.routeDirty = true;
    storeState.stalePreviewDays = []; // all fresh

    render(<TripPlannerPage />);

    expect(
      screen.getByRole("button", { name: "Save route" }),
    ).not.toBeDisabled();
  });

  it("disables Save route when a complete-by-waypoints day has no previewed geometry", () => {
    storeState.activeTrip = {
      ...activeTrip,
      days: [
        {
          ...activeTrip.days[0]!, // valid start/end waypoints…
          routeGeometry: undefined, // …but never previewed (e.g. a loaded share)
        },
      ],
    };
    storeState.routeDirty = true;
    storeState.stalePreviewDays = []; // not stale → would otherwise pass

    render(<TripPlannerPage />);

    // Geometry-less day must NOT pass the gate — otherwise Save would submit a
    // leg the backend routes without the rider ever previewing it.
    expect(screen.getByRole("button", { name: "Save route" })).toBeDisabled();
  });

  it("treats a terminal accommodation (generated overnight) as a day finish for the Save gate", () => {
    storeState.activeTrip = {
      ...activeTrip,
      days: [
        {
          ...activeTrip.days[0]!, // keeps routeGeometry so the geometry gate passes
          waypoints: [
            {
              id: "s",
              name: "Start",
              type: "start",
              location: { lng: 10, lat: 46 },
            },
            {
              id: "h",
              name: "Hotel",
              type: "accommodation",
              location: { lng: 11, lat: 46.5 },
            },
          ],
        },
      ],
    };
    storeState.routeDirty = true;
    storeState.stalePreviewDays = [];

    render(<TripPlannerPage />);

    // The day ends in an accommodation (no explicit `end`) — it must count as
    // complete so an edited generated trip can still be saved.
    expect(
      screen.getByRole("button", { name: "Save route" }),
    ).not.toBeDisabled();
  });

  it("hides the day column and header day count while the trip is unsplit", () => {
    storeState.activeTrip = activeTrip;
    storeState.splitStatus = "none";
    storeState.dayPlans = null;

    render(<TripPlannerPage />);

    // No day concept anywhere in 'single' mode (revision 2 §A/§B/§C).
    expect(screen.queryByText(/No days yet/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Day 1")).not.toBeInTheDocument();
    expect(screen.queryByText(/\d+ days ·/)).not.toBeInTheDocument();
  });

  const samplePlans = [
    {
      dayNumber: 1,
      segmentIds: ["d1-s0"],
      distanceKm: 240,
      timeMin: 250,
      quality: {
        distanceKm: 240,
        timeMin: 250,
        score: 4.1,
        surfaceMix: [],
        flagged: [],
      },
      startTown: "Start",
      endTown: "Brno",
      suggestedStays: [],
      endKm: 240,
    },
    {
      dayNumber: 2,
      segmentIds: ["d1-s1"],
      distanceKm: 210,
      timeMin: 220,
      quality: {
        distanceKm: 210,
        timeMin: 220,
        score: 3.6,
        surfaceMix: [],
        flagged: [],
      },
      startTown: "Brno",
      endTown: "Finish",
      suggestedStays: [],
      noTownNearby: true,
      endKm: 450,
    },
  ];

  it("renders DayPlans in the day column once split", () => {
    storeState.activeTrip = activeTrip;
    storeState.planningMode = "multiday";
    storeState.splitStatus = "split";
    storeState.dayPlans = samplePlans;

    render(<TripPlannerPage />);

    expect(screen.getByLabelText("Day 1")).toBeInTheDocument();
    expect(screen.getByLabelText("Day 2")).toBeInTheDocument();
    expect(screen.getByText("START → BRNO")).toBeInTheDocument();
    expect(
      screen.getByText(/No overnight town near this break/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Route changed/)).not.toBeInTheDocument();
    // Split button reads Re-split while split.
    expect(
      screen.getByRole("button", { name: /Re-split/i }),
    ).toBeInTheDocument();
  });

  it("dims stale days and offers a RE-SPLIT shortcut after a route edit", () => {
    storeState.activeTrip = activeTrip;
    storeState.planningMode = "multiday";
    storeState.splitStatus = "stale";
    storeState.dayPlans = samplePlans;

    render(<TripPlannerPage />);

    // Both the day-column banner and the BUILD-tab hint surface the change.
    expect(screen.getAllByText(/Route changed/).length).toBeGreaterThanOrEqual(
      1,
    );
    expect(
      screen.getByRole("button", { name: "RE-SPLIT" }),
    ).toBeInTheDocument();
    // Days remain visible (dimmed) for orientation.
    expect(screen.getByLabelText("Day 1")).toBeInTheDocument();
  });

  it("shows the day count in the header only after a split", () => {
    storeState.activeTrip = activeTrip;
    storeState.planningMode = "multiday";
    storeState.splitStatus = "split";
    storeState.dayPlans = samplePlans;

    render(<TripPlannerPage />);

    // Post-split header: "N days · <total> km" (revision 2 §C).
    expect(screen.getByText(/2 days · 240 km/)).toBeInTheDocument();
  });

  it("expanding Plan as multi-day trip is the day-planning opt-in", () => {
    storeState.activeTrip = activeTrip;
    const { container } = render(<TripPlannerPage />);

    const details = container.querySelector("details")!;
    // Collapsed by default — the optional layer stays out of the way.
    expect(details.open).toBe(false);

    details.open = true;
    fireEvent(details, new Event("toggle", { bubbles: false }));
    expect(storeState.setPlanningMode).toHaveBeenCalledWith("multiday");

    // Collapsing before ever splitting backs out of the day concept.
    details.open = false;
    fireEvent(details, new Event("toggle", { bubbles: false }));
    expect(storeState.setPlanningMode).toHaveBeenLastCalledWith("single");
  });
});
