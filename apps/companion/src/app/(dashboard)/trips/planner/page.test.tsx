import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import TripPlannerPage from "./page";
import { ToastHost } from "@/components/ToastHost";
import { useToastStore } from "@/stores/toast";
import { useClosures, type ClosuresQueryResult } from "@/hooks/useClosures";
import { usePasses, type PassesQueryResult } from "@/hooks/usePasses";
import { useTripStore, type BackendWaypointType } from "@/stores/trip";
import { useAuthStore } from "@/stores/auth";
import { ApiError, tripsApi } from "@/lib/api";
import { plannerApi } from "@/lib/planner/api";
import type { Trip, TripParameters, TripSummary, Waypoint } from "@/lib/types";
import { usePlannerRouting } from "@/hooks/usePlannerRouting";
import { FEATURE_LIMIT_EXCEEDED } from "@tarmoto/shared";
import { insertDraftedVias } from "./page.helpers";

// Entitlements: a fixed free tier is enough for the upgrade-modal safety-net
// test below — the tier/limit resolution itself is covered by useEntitlements'
// own tests and the /trips list suite (Task 6). useLimit + useUserTrips are
// controllable so the proactive-cap-gate test can drive an at-limit state;
// their defaults (unlimited + no trips) leave every other test ungated.
const { useLimitMock, useUserTripsMock, useFeatureMock } = vi.hoisted(() => ({
  // Default enabled+resolved so the Collaborate entry (C2 gate) isn't gated in
  // the other tests; the collaborative_trips gate test overrides this.
  useFeatureMock: vi.fn((_key: string) => ({
    enabled: true,
    isLoading: false,
    isError: false,
    isSuccess: true,
  })),
  useLimitMock: vi.fn(() => ({
    limit: null as number | null,
    isLoading: false,
    isSuccess: true,
  })),
  useUserTripsMock: vi.fn((_opts?: { enabled?: boolean }) => ({
    trips: [] as unknown[],
    loading: false,
    error: false,
    tripById: new Map(),
  })),
}));
vi.mock("@/hooks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks")>()),
  useEntitlements: () => ({
    tier: "free",
    features: null,
    limits: null,
    isLoading: false,
  }),
  useFeature: (key: string) => useFeatureMock(key),
  useLimit: () => useLimitMock(),
}));
vi.mock("@/hooks/useUserTrips", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/useUserTrips")>()),
  useUserTrips: (opts?: { enabled?: boolean }) => useUserTripsMock(opts),
}));

const { mockPush } = vi.hoisted(() => ({
  mockPush: vi.fn(),
}));

const collabHarness = vi.hoisted(() => ({
  callbacks: undefined as
    | {
        onTripUpdated?: (detail: unknown) => void;
        onTripDeleted?: (detail: unknown) => void;
      }
    | undefined,
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

vi.mock("@/lib/api", async () => {
  // Spread the real module so ApiError, roadsApi, and any other exports the
  // page imports resolve (the segment-detail drawer uses roadsApi + ApiError);
  // only tripsApi is stubbed for the trip CRUD the tests drive.
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    tripsApi: {
      get: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      importRoute: vi.fn(),
      replaceImportedRoute: vi.fn(),
      generate: vi.fn(),
      saveRoute: vi.fn(),
      updateWaypointNames: vi.fn(),
    },
  };
});

// Prevent the live-routing hook from firing real API calls in unit tests.
vi.mock("@/hooks/usePlannerRouting", () => ({
  usePlannerRouting: vi.fn(() => ({ routing: false })),
}));

vi.mock("@/hooks/useTripCollabSession", () => ({
  useTripCollabSession: vi.fn(
    (_tripId: string | null, callbacks: typeof collabHarness.callbacks) => {
      collabHarness.callbacks = callbacks;
      return {
        cursors: new Map(),
        presence: new Map(),
        members: new Map(),
        suggestions: [],
        setSuggestions: vi.fn(),
        suggestionsError: null,
        emitCursor: vi.fn(),
      };
    },
  ),
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

vi.mock("@/components/TripExportButton", () => ({
  TripExportButton: () => <div data-testid="trip-export-menu" />,
}));

vi.mock("@/components/TripImportDialog", () => ({
  // Renders a marker while open so tests can assert the ?import=1 entry
  // point without pulling in the real parse/preview machinery.
  TripImportDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="import-dialog-open" /> : null,
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
  namesDirty: boolean;
  renamedWaypointIds: string[];
  savedWaypointNames: Record<string, string | null>;
  stalePreviewDays: number[];
  selectedDayIndex: number;
  focusedSegmentId: string | null;
  hoveredSegmentId: string | null;
  undoStack: Array<{
    trip: Trip | null;
    dirty: boolean;
    stale: number[];
  }>;
  redoStack: Array<{
    trip: Trip | null;
    dirty: boolean;
    stale: number[];
  }>;
  setTrips: (trips: TripSummary[], ownerId?: string | null) => void;
  setActiveTrip: (trip: Trip | null) => void;
  setGenerating: (isGenerating: boolean) => void;
  setSelectedDay: (index: number) => void;
  addDay: () => void;
  removeDay: (index: number) => void;
  relinkDayStart: (index: number) => void;
  markRouteDirty: () => void;
  markDayRouteDirty: (dayIndex: number) => void;
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
  applyRouteQuality: (
    dayNumber: number,
    forGeometry: unknown,
    segments: unknown,
  ) => void;
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
  const tripsApiUpdateNamesMock = vi.mocked(tripsApi.updateWaypointNames);

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
    collabHarness.callbacks = undefined;
    useFeatureMock.mockReset().mockImplementation(() => ({
      enabled: true,
      isLoading: false,
      isError: false,
      isSuccess: true,
    }));
    mockPush.mockClear();
    // The selected-day route-quality effect (#862) fires for any committed
    // day; stub the fetch so these tests don't reach the real client.
    vi.spyOn(plannerApi, "getRouteQuality").mockResolvedValue([]);
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
    // Reset the entitlement/trips gate mocks (call history AND return) to their
    // ungated defaults (resolved-unlimited cap, no trips) so only the
    // proactive-gate tests opt in and per-test call assertions start clean.
    useLimitMock.mockReset();
    useLimitMock.mockReturnValue({
      limit: null,
      isLoading: false,
      isSuccess: true,
    });
    useUserTripsMock.mockReset();
    useUserTripsMock.mockReturnValue({
      trips: [],
      loading: false,
      error: false,
      tripById: new Map(),
    });
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
      namesDirty: false,
      renamedWaypointIds: [],
      savedWaypointNames: {},
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
      markDayRouteDirty: vi.fn(),
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
      applyRouteQuality: vi.fn(),
      resetForTest: vi.fn(),
    };
    useTripStoreMock.mockImplementation((selector) => selector(storeState));
    // Wire getState so handleSaveRoute's useTripStore.getState().saveWaypoints()
    // returns the same storeState that the selector-based hook reads.
    vi.mocked(useTripStore).getState = vi.fn(() => storeState as never);
    useClosuresMock.mockReturnValue(closuresData);
    usePassesMock.mockReturnValue(passesData);
  });

  it("opens the import dialog for the /trips ?import=1 entry point and strips the param", () => {
    window.history.replaceState({}, "", "/trips/planner?import=1");
    render(<TripPlannerPage />);

    expect(screen.getByTestId("import-dialog-open")).toBeInTheDocument();
    // Param stripped so a reload (or the planner's URL sync) can't re-open it.
    expect(window.location.search).not.toContain("import=1");
  });

  it("does not open the import dialog on the bare planner URL", () => {
    render(<TripPlannerPage />);
    expect(screen.queryByTestId("import-dialog-open")).not.toBeInTheDocument();
  });

  it("keeps unnamed POI category fallbacks instead of reverse-geocoding them", async () => {
    const reverseGeocode = vi
      .spyOn(plannerApi, "reverseGeocode")
      .mockResolvedValue("Generated address");
    storeState.activeTrip = {
      ...activeTrip,
      days: [
        {
          ...activeTrip.days[0]!,
          waypoints: [
            activeTrip.days[0]!.waypoints[0]!,
            {
              id: "generic-via",
              type: "via",
              location: { lng: 10.45, lat: 46.52 },
            },
            {
              id: "poi-via",
              type: "via",
              poiCategory: "cafe",
              location: { lng: 10.5, lat: 46.56 },
            },
            activeTrip.days[0]!.waypoints[1]!,
          ],
        },
      ],
    };

    render(<TripPlannerPage />);

    await waitFor(() => expect(reverseGeocode).toHaveBeenCalledTimes(1));
    expect(reverseGeocode).toHaveBeenCalledWith(46.52, 10.45, {
      format: expect.any(Object),
    });
    await waitFor(() =>
      expect(storeState.renameWaypoint).toHaveBeenCalledWith(
        "generic-via",
        "Generated address",
      ),
    );
    expect(storeState.renameWaypoint).not.toHaveBeenCalledWith(
      "poi-via",
      expect.any(String),
    );
  });

  it("marks typed-search via names as source data", async () => {
    vi.spyOn(plannerApi, "geocode").mockResolvedValue([
      { name: "Via 1", lat: 46.52, lng: 10.45 },
    ]);
    storeState.activeTrip = activeTrip;

    render(<TripPlannerPage />);

    fireEvent.click(screen.getByRole("button", { name: "Add via point" }));
    fireEvent.change(
      screen.getByLabelText("Search location for a new via point"),
      { target: { value: "Via 1" } },
    );
    fireEvent.click(await screen.findByRole("option", { name: "Via 1" }));

    expect(storeState.insertWaypointBeforeEnd).toHaveBeenCalledWith(
      0,
      expect.objectContaining({
        name: "Via 1",
        nameIsSource: true,
        location: { lng: 10.45, lat: 46.52 },
        type: "via",
      }),
    );
  });

  it.each(["draft", "loop"] as const)(
    "preserves source provenance and omits generated names at the %s insertion boundary",
    (idPrefix) => {
      const insertWaypoint = vi.fn();

      insertDraftedVias(
        [
          { lat: 46.52, lng: 10.45, name: "Via 1" },
          { lat: 46.56, lng: 10.5 },
        ],
        1,
        idPrefix,
        insertWaypoint,
        1_722_000_000_000,
      );

      expect(insertWaypoint).toHaveBeenNthCalledWith(1, 1, {
        id: `${idPrefix}-1722000000000-0`,
        name: "Via 1",
        nameIsSource: true,
        location: { lat: 46.52, lng: 10.45 },
        type: "via",
      });
      expect(insertWaypoint).toHaveBeenNthCalledWith(
        2,
        1,
        expect.objectContaining({
          id: `${idPrefix}-1722000000000-1`,
          location: { lat: 46.56, lng: 10.5 },
          type: "via",
        }),
      );
      const unnamedWaypoint = insertWaypoint.mock.calls[1]![1];
      expect(unnamedWaypoint).not.toHaveProperty("name");
      expect(unnamedWaypoint).not.toHaveProperty("nameIsSource");
    },
  );

  it("shares whole-route conditions with the map and a day-scoped copy with the sidebar", () => {
    render(<TripPlannerPage />);

    expect(screen.getByTestId("trip-planner-map")).toBeInTheDocument();
    // Two hook instances: whole-route for the map, day-scoped for the sidebar.
    // With no day selected both request the same routes, so react-query serves
    // them from a single cache entry (no double fetch). Two instances across the
    // initial render + the post-mount session-kind reconcile render = 4 calls.
    expect(useClosuresMock).toHaveBeenCalledTimes(4);
    expect(usePassesMock).toHaveBeenCalledTimes(4);

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
    // No day is selected before a split, so the map gets no selected day.
    const mapProps = mockedTripPlannerMap.mock.calls.at(-1)?.[0] as
      | { selectedDayNumber?: number }
      | undefined;
    expect(mapProps?.selectedDayNumber).toBeUndefined();
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
    fireEvent.click(screen.getByLabelText("Avoid motorways"));
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

  it("dispatches moveWaypoint with the matching day index and live planner params when a marker is dropped on the map", async () => {
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
    // Minimum road quality is a react-aria Select — its label points to the
    // trigger button directly; click to open, then pick the option.
    await userEvent.click(screen.getByLabelText("Minimum road quality"));
    await userEvent.click(
      screen.getByRole("option", { name: "Excellent only" }),
    );

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

  // The exits are visible from the moment the planner opens \u2014 a rider
  // shouldn't need to draw a route first to find the way out.
  it("offers Reset and Discard on a fresh planner before any route exists", () => {
    render(<TripPlannerPage />);

    expect(screen.getByRole("button", { name: "Reset" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Discard" })).toBeInTheDocument();
  });

  // Reset means "start from empty" — it only applies to a not-yet-saved
  // draft. Once the trip is persisted (server binding) the toolbar
  // offers Discard only.
  it("hides Reset once the trip is persisted", async () => {
    const serverTripId = "11111111-2222-4333-8444-555555555555";
    window.history.replaceState(
      {},
      "",
      `/trips/planner?tripId=${serverTripId}`,
    );
    // Reset/Discard are owner-only now — hydrate the caller as the owner.
    useAuthStore.setState({
      user: { id: "u-owner", email: "o@example.com", displayName: "O" },
      isAuthenticated: true,
      accessToken: "test-access-token",
    });
    tripsApiGetMock.mockResolvedValue({
      data: buildTripDetail("Persisted", { id: serverTripId }),
    } as never);
    storeState.activeTrip = activeTrip;

    render(<TripPlannerPage />);

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Discard" }),
      ).toBeInTheDocument(),
    );
    expect(
      screen.queryByRole("button", { name: "Reset" }),
    ).not.toBeInTheDocument();
  });

  // C2 — the Collaborate ENTRY is gated for a persisted trip when
  // collaborative_trips is off: the owner gets the upsell, never the modal
  // (which would fire a raw persisted-trip 403 on share/invite).
  it("gates the Collaborate entry with an upsell (not the modal) for a persisted trip when collaborative_trips is off", async () => {
    const serverTripId = "11111111-2222-4333-8444-555555555555";
    window.history.replaceState(
      {},
      "",
      `/trips/planner?tripId=${serverTripId}`,
    );
    useAuthStore.setState({
      user: { id: "u-owner", email: "o@example.com", displayName: "O" },
      isAuthenticated: true,
      accessToken: "test-access-token",
    });
    tripsApiGetMock.mockResolvedValue({
      data: buildTripDetail("Persisted", { id: serverTripId }),
    } as never);
    storeState.activeTrip = activeTrip;
    useFeatureMock.mockImplementation((key: string) =>
      key === "collaborative_trips"
        ? { enabled: false, isLoading: false, isError: false, isSuccess: true }
        : { enabled: true, isLoading: false, isError: false, isSuccess: true },
    );

    render(<TripPlannerPage />);

    const collaborate = await screen.findByRole("button", {
      name: /collaborate/i,
    });
    fireEvent.click(collaborate);

    // The upsell shows; the collaboration modal is never opened.
    expect(
      await screen.findByText("Collaborating on a saved trip needs Pro."),
    ).toBeInTheDocument();
    expect(
      mockedTripCollaborateModal.mock.calls.every(
        ([p]) => !(p as { open?: boolean }).open,
      ),
    ).toBe(true);
  });

  // Carve-out: an UNSAVED draft has nothing persisted to share, so the entry is
  // NOT gated even with collaborative_trips off — the modal opens as usual.
  it("does not gate the Collaborate entry for an unsaved draft (carve-out) when collaborative_trips is off", async () => {
    storeState.activeTrip = activeTrip;
    useFeatureMock.mockImplementation((key: string) =>
      key === "collaborative_trips"
        ? { enabled: false, isLoading: false, isError: false, isSuccess: true }
        : { enabled: true, isLoading: false, isError: false, isSuccess: true },
    );

    render(<TripPlannerPage />);

    fireEvent.click(screen.getByRole("button", { name: /collaborate/i }));

    // No upsell; the modal is opened.
    expect(
      screen.queryByText("Collaborating on a saved trip needs Pro."),
    ).not.toBeInTheDocument();
    expect(
      mockedTripCollaborateModal.mock.calls.some(
        ([p]) => (p as { open?: boolean }).open,
      ),
    ).toBe(true);
  });

  // Recovery: the entry upsell must not linger once collaborative_trips is
  // granted (an upgrade in another tab / operator re-enable).
  it("dismisses the Collaborate entry upsell when collaborative_trips is later granted", async () => {
    const serverTripId = "11111111-2222-4333-8444-555555555555";
    window.history.replaceState(
      {},
      "",
      `/trips/planner?tripId=${serverTripId}`,
    );
    useAuthStore.setState({
      user: { id: "u-owner", email: "o@example.com", displayName: "O" },
      isAuthenticated: true,
      accessToken: "test-access-token",
    });
    tripsApiGetMock.mockResolvedValue({
      data: buildTripDetail("Persisted", { id: serverTripId }),
    } as never);
    storeState.activeTrip = activeTrip;
    useFeatureMock.mockImplementation((key: string) =>
      key === "collaborative_trips"
        ? { enabled: false, isLoading: false, isError: false, isSuccess: true }
        : { enabled: true, isLoading: false, isError: false, isSuccess: true },
    );

    const { rerender } = render(<TripPlannerPage />);
    fireEvent.click(
      await screen.findByRole("button", { name: /collaborate/i }),
    );
    expect(
      await screen.findByText("Collaborating on a saved trip needs Pro."),
    ).toBeInTheDocument();

    // A later /users/me refresh grants collaborative_trips.
    useFeatureMock.mockImplementation(() => ({
      enabled: true,
      isLoading: false,
      isError: false,
      isSuccess: true,
    }));
    rerender(<TripPlannerPage />);

    await waitFor(() =>
      expect(
        screen.queryByText("Collaborating on a saved trip needs Pro."),
      ).not.toBeInTheDocument(),
    );
  });

  // Fail closed: while the snapshot is UNRESOLVED, the entry is DISABLED — not
  // opening the modal, and not opening an upsell that can't render (tier still
  // null on cold hydration) which would silently swallow the click.
  it("disables the Collaborate entry while collaborative_trips is unresolved for a persisted trip", async () => {
    const serverTripId = "11111111-2222-4333-8444-555555555555";
    window.history.replaceState(
      {},
      "",
      `/trips/planner?tripId=${serverTripId}`,
    );
    useAuthStore.setState({
      user: { id: "u-owner", email: "o@example.com", displayName: "O" },
      isAuthenticated: true,
      accessToken: "test-access-token",
    });
    tripsApiGetMock.mockResolvedValue({
      data: buildTripDetail("Persisted", { id: serverTripId }),
    } as never);
    storeState.activeTrip = activeTrip;
    // Unresolved: isLoading, not success, not error.
    useFeatureMock.mockImplementation((key: string) =>
      key === "collaborative_trips"
        ? { enabled: false, isLoading: true, isError: false, isSuccess: false }
        : { enabled: true, isLoading: false, isError: false, isSuccess: true },
    );

    render(<TripPlannerPage />);

    const collaborate = await screen.findByRole("button", {
      name: /collaborate/i,
    });
    expect(collaborate).toBeDisabled();
    // A click on the disabled button is a no-op: neither the upsell nor the
    // modal opens (no silently-swallowed click).
    fireEvent.click(collaborate);
    expect(
      screen.queryByText("Collaborating on a saved trip needs Pro."),
    ).not.toBeInTheDocument();
    expect(
      mockedTripCollaborateModal.mock.calls.every(
        ([p]) => !(p as { open?: boolean }).open,
      ),
    ).toBe(true);
  });

  // Once the snapshot resolves DISABLED, the entry is enabled again and the
  // click opens the upsell (tier is known by then, so it renders).
  it("re-enables the Collaborate entry to an upsell once collaborative_trips resolves disabled", async () => {
    const serverTripId = "11111111-2222-4333-8444-555555555555";
    window.history.replaceState(
      {},
      "",
      `/trips/planner?tripId=${serverTripId}`,
    );
    useAuthStore.setState({
      user: { id: "u-owner", email: "o@example.com", displayName: "O" },
      isAuthenticated: true,
      accessToken: "test-access-token",
    });
    tripsApiGetMock.mockResolvedValue({
      data: buildTripDetail("Persisted", { id: serverTripId }),
    } as never);
    storeState.activeTrip = activeTrip;
    useFeatureMock.mockImplementation((key: string) =>
      key === "collaborative_trips"
        ? { enabled: false, isLoading: true, isError: false, isSuccess: false }
        : { enabled: true, isLoading: false, isError: false, isSuccess: true },
    );

    const { rerender } = render(<TripPlannerPage />);
    expect(
      await screen.findByRole("button", { name: /collaborate/i }),
    ).toBeDisabled();

    // The snapshot resolves DISABLED.
    useFeatureMock.mockImplementation((key: string) =>
      key === "collaborative_trips"
        ? { enabled: false, isLoading: false, isError: false, isSuccess: true }
        : { enabled: true, isLoading: false, isError: false, isSuccess: true },
    );
    rerender(<TripPlannerPage />);

    const collaborate = screen.getByRole("button", { name: /collaborate/i });
    expect(collaborate).not.toBeDisabled();
    fireEvent.click(collaborate);
    expect(
      await screen.findByText("Collaborating on a saved trip needs Pro."),
    ).toBeInTheDocument();
  });

  // The recovery effect must NOT dismiss the upsell just because the query
  // went unresolved (e.g. a useRoadQualityZoomCap reset) — only a resolved
  // ENABLED snapshot clears it.
  it("keeps the Collaborate entry upsell open when the snapshot goes unresolved (still disabled)", async () => {
    const serverTripId = "11111111-2222-4333-8444-555555555555";
    window.history.replaceState(
      {},
      "",
      `/trips/planner?tripId=${serverTripId}`,
    );
    useAuthStore.setState({
      user: { id: "u-owner", email: "o@example.com", displayName: "O" },
      isAuthenticated: true,
      accessToken: "test-access-token",
    });
    tripsApiGetMock.mockResolvedValue({
      data: buildTripDetail("Persisted", { id: serverTripId }),
    } as never);
    storeState.activeTrip = activeTrip;
    useFeatureMock.mockImplementation((key: string) =>
      key === "collaborative_trips"
        ? { enabled: false, isLoading: false, isError: false, isSuccess: true }
        : { enabled: true, isLoading: false, isError: false, isSuccess: true },
    );

    const { rerender } = render(<TripPlannerPage />);
    fireEvent.click(
      await screen.findByRole("button", { name: /collaborate/i }),
    );
    expect(
      await screen.findByText("Collaborating on a saved trip needs Pro."),
    ).toBeInTheDocument();

    // The snapshot goes UNRESOLVED (a reset refetch) — the feature is NOT known
    // to be granted, so the upsell must stay put.
    useFeatureMock.mockImplementation((key: string) =>
      key === "collaborative_trips"
        ? { enabled: false, isLoading: true, isError: false, isSuccess: false }
        : { enabled: true, isLoading: false, isError: false, isSuccess: true },
    );
    rerender(<TripPlannerPage />);

    expect(
      screen.getByText("Collaborating on a saved trip needs Pro."),
    ).toBeInTheDocument();
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
    // Discard is owner-only — hydrate the caller as the owner.
    useAuthStore.setState({
      user: { id: "u-owner", email: "o@example.com", displayName: "O" },
      isAuthenticated: true,
      accessToken: "test-access-token",
    });
    tripsApiGetMock.mockResolvedValue({
      data: buildTripDetail("Persisted", { id: serverTripId }),
    } as never);
    tripsApiDeleteMock.mockResolvedValue({ data: {} } as never);
    storeState.activeTrip = activeTrip;

    render(<TripPlannerPage />);
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Discard" }),
      ).toBeInTheDocument(),
    );
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

  it("applies the confirmed roundtrip preference to the live route inputs", async () => {
    // The dialog's road preference is the loop's character — after the
    // draft, live routing recomputes through the vias, so the page must
    // adopt it or the loop silently falls back to the old trip-wide value.
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
    // Road preference is a react-aria Select — its label points to the trigger
    // button directly; click to open, then pick the option.
    await userEvent.click(within(dialog).getByLabelText("Road preference"));
    await userEvent.click(
      screen.getByRole("option", { name: "Maximum twisty" }),
    );
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Draft roundtrip" }),
    );

    await waitFor(() => expect(draftSpy).toHaveBeenCalledTimes(1));
    expect(draftSpy.mock.calls[0]![1]).toEqual(
      expect.objectContaining({ preference: "maximum_twisty" }),
    );
    // Dialog closed; the §02 summary now reads the confirmed character.
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Roundtrip options" }),
      ).not.toBeInTheDocument(),
    );
    expect(screen.getByText(/^Maximum twisty · /)).toBeInTheDocument();
    draftSpy.mockRestore();
  });

  it("a confirmed roundtrip preference never writes the saved defaults, even after a real touch", async () => {
    // The programmatic setRoadPreference from the dialog must clear the
    // touched flag: an earlier rider edit in the same session would
    // otherwise smuggle the per-loop choice into users route_prefs.
    useAuthStore.setState({
      user: { id: "u-1", email: "r@example.com", displayName: "R" },
      isAuthenticated: true,
      accessToken: "test-access-token",
    });
    const loadSpy = vi
      .spyOn(plannerApi, "getUserRoutePrefs")
      .mockResolvedValue(null);
    const savePrefsSpy = vi
      .spyOn(plannerApi, "saveUserRoutePrefs")
      .mockResolvedValue(undefined);
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
    await waitFor(() => expect(loadSpy).toHaveBeenCalled());

    // A REAL rider edit → one defaults write.
    fireEvent.click(screen.getByRole("button", { name: "Route preferences" }));
    fireEvent.click(screen.getByLabelText(/avoid motorways/i));
    await waitFor(() => expect(savePrefsSpy).toHaveBeenCalledTimes(1), {
      timeout: 3000,
    });

    // Confirm a roundtrip with a DIFFERENT preference…
    fireEvent.click(screen.getByRole("button", { name: "Draft roundtrip" }));
    const dialog = screen.getByRole("dialog", { name: "Roundtrip options" });
    // Road preference is a react-aria Select — its label points to the trigger
    // button directly; click to open, then pick the option.
    await userEvent.click(within(dialog).getByLabelText("Road preference"));
    await userEvent.click(
      screen.getByRole("option", { name: "Maximum twisty" }),
    );
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Draft roundtrip" }),
    );
    await waitFor(() => expect(draftSpy).toHaveBeenCalledTimes(1));

    // …and the debounce window passes without a second defaults write.
    await act(() => new Promise((resolve) => window.setTimeout(resolve, 1100)));
    expect(savePrefsSpy).toHaveBeenCalledTimes(1);
    loadSpy.mockRestore();
    savePrefsSpy.mockRestore();
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
    // A leg edit stales its OWN day only — the global dirty would wedge
    // the Save gate on days live routing never revisits.
    expect(storeState.markDayRouteDirty).toHaveBeenCalledWith(0);
    expect(storeState.markRouteDirty).not.toHaveBeenCalled();
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
    fireEvent.click(screen.getByLabelText(/avoid motorways/i));
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
    // Minimum road quality is a react-aria Select — assert the selected label.
    expect(screen.getByLabelText("Minimum road quality")).toHaveTextContent(
      "Excellent only",
    );
    expect(screen.getByLabelText("Asphalt")).toBeChecked();
    expect(screen.getByLabelText("Gravel")).toBeChecked();
    expect(screen.getByLabelText("Concrete")).not.toBeChecked();
    expect(screen.getByLabelText("Avoid motorways")).not.toBeChecked();
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
    // Minimum road quality is a react-aria Select — assert the selected label.
    expect(screen.getByLabelText("Minimum road quality")).toHaveTextContent(
      "Any condition",
    );
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

    fireEvent.click(screen.getByLabelText("Avoid motorways"));
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

  it("shows an access-denied screen to a viewer opening the editor", async () => {
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
            role: "viewer",
            joined_at: "2026-04-23T09:15:00Z",
          },
        ],
      }),
    } as never);

    render(<TripPlannerPage />);

    // Once the role resolves as viewer, the editor is replaced by an
    // access screen pointing back to the read-only preview.
    expect(await screen.findByText(/view-only access/i)).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /open preview/i }),
    ).toBeInTheDocument();
    // No editor chrome — the Save button isn't in the tree at all.
    expect(
      screen.queryByRole("button", { name: "Save route" }),
    ).not.toBeInTheDocument();
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
            role: "editor",
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
      expect(mockedTripCollaborateModal).toHaveBeenCalledWith(
        expect.objectContaining({ canCreateInviteLink: true }),
      );
    });
  });

  // ── Save route (Task 11) ─────────────────────────────────────────────

  it("keeps request-only surface and avoid choices after the save collaboration echo", async () => {
    const tripId = "11111111-2222-4333-8444-777777777777";
    window.history.replaceState({}, "", `/trips/planner?tripId=${tripId}`);
    storeState.activeTrip = {
      ...activeTrip,
      id: tripId,
      parameters: {
        ...activeTrip.parameters,
        surfacePreference: ["asphalt", "concrete"],
        avoidTolls: true,
      },
    };
    tripsApiGetMock.mockResolvedValue({
      data: buildTripDetail("Best fit", { id: tripId }),
    } as never);

    render(<TripPlannerPage />);

    const concrete = screen.getByRole("checkbox", { name: "Concrete" });
    const tolls = screen.getByRole("checkbox", { name: "Avoid tolls" });
    await waitFor(() => {
      expect(concrete).toBeChecked();
      expect(tolls).toBeChecked();
      expect(collabHarness.callbacks?.onTripUpdated).toBeTypeOf("function");
    });

    act(() => {
      collabHarness.callbacks?.onTripUpdated?.(
        buildTripDetail("Best fit", { id: tripId }),
      );
    });

    expect(concrete).toBeChecked();
    expect(tolls).toBeChecked();
    expect(setActiveTrip).toHaveBeenLastCalledWith(
      expect.objectContaining({
        parameters: expect.objectContaining({
          surfacePreference: ["asphalt", "concrete"],
          avoidTolls: true,
        }),
      }),
    );
  });

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

  it("persists a name-only edit via updateWaypointNames (only renamed ids, no re-route), not saveRoute (#911)", async () => {
    // A late reverse-geocoded pin name on a loaded/imported trip: names are
    // dirty but the route is not. Save must hit PATCH /waypoints (geometry
    // preserved) — NOT the re-routing saveRoute — and send only the waypoint
    // that was actually renamed so a collaborator's other rename isn't reverted.
    const tripId = "11111111-2222-4333-8444-777777777777";
    const WP1 = "aaaaaaaa-1111-4111-8111-111111111111";
    const WP2 = "bbbbbbbb-2222-4222-8222-222222222222";
    // ?tripId keeps the persisted trip mounted (the bare URL drops lingering
    // UUID trips); owner role unlocks Save.
    window.history.replaceState({}, "", `/trips/planner?tripId=${tripId}`);
    useAuthStore.setState({
      user: { id: "u-owner", email: "o@example.com", displayName: "O" },
      isAuthenticated: true,
      accessToken: "test-access-token",
    });
    tripsApiGetMock.mockResolvedValue({
      data: buildTripDetail("Loaded", { id: tripId }),
    } as never);
    // Loaded trip carrying server (UUID) waypoints; only WP1 was renamed.
    storeState.activeTrip = {
      ...activeTrip,
      id: tripId,
      days: [
        {
          ...activeTrip.days[0]!,
          waypoints: [
            {
              ...activeTrip.days[0]!.waypoints[0]!,
              id: WP1,
              name: "Bormio (town)",
            },
            { ...activeTrip.days[0]!.waypoints[1]!, id: WP2 },
          ],
        },
      ],
    };
    storeState.routeDirty = false;
    storeState.namesDirty = true;
    storeState.renamedWaypointIds = [WP1]; // WP2 left untouched
    tripsApiUpdateNamesMock.mockResolvedValue({
      data: buildTripDetail("Loaded", { id: tripId }),
    } as never);

    render(
      <>
        <TripPlannerPage />
        <ToastHost />
      </>,
    );

    // Wait for the owner role to land — Save unlocks (canWriteRoute + namesDirty).
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Save route" })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save route" }));

    await waitFor(() =>
      expect(tripsApiUpdateNamesMock).toHaveBeenCalledWith(tripId, {
        waypoints: [{ id: WP1, name: "Bormio (town)" }],
      }),
    );
    // Exactly one waypoint sent (the renamed one) — WP2 is not included.
    expect(tripsApiUpdateNamesMock).toHaveBeenCalledTimes(1);
    // The re-routing route save is never taken.
    expect(tripsApiSaveRouteMock).not.toHaveBeenCalled();
    expect(await screen.findByText("Names saved")).toBeInTheDocument();
  });

  it("persists a name-only edit on an unsaved GPX import via the import endpoint, not saveRoute (#911)", async () => {
    // Unsaved import: `imported-*` id + `imp-wp-*` waypoints, geometry = the
    // imported track. A label edit has no server trip / UUID waypoint to PATCH,
    // so it must re-send the track (names + geometry) through the import
    // endpoint — saveRoute would re-route and reshape the imported line.
    const imported: Trip = {
      ...activeTrip,
      id: "imported-123",
      importSourceFormat: "gpx",
      days: [
        {
          ...activeTrip.days[0]!,
          waypoints: [
            {
              ...activeTrip.days[0]!.waypoints[0]!,
              id: "imp-wp-start",
              name: "Start",
            },
            {
              ...activeTrip.days[0]!.waypoints[1]!,
              id: "imp-wp-end",
              name: "End",
            },
          ],
        },
      ],
    };
    storeState.activeTrip = imported;
    storeState.routeDirty = false;
    storeState.namesDirty = true;
    storeState.renamedWaypointIds = ["imp-wp-start"];
    tripsApiImportRouteMock.mockResolvedValue({
      data: buildTripDetail("Imported", {
        id: "11111111-2222-4333-8444-999999999999",
      }),
    } as never);

    render(
      <>
        <TripPlannerPage />
        <ToastHost />
      </>,
    );

    const saveBtn = await screen.findByRole("button", { name: "Save route" });
    expect(saveBtn).toBeEnabled();
    fireEvent.click(saveBtn);

    await waitFor(() =>
      expect(tripsApiImportRouteMock).toHaveBeenCalledWith(
        expect.objectContaining({
          source_format: "gpx",
          // Imported track geometry is preserved (not re-routed).
          geometry: expect.arrayContaining([
            expect.objectContaining({
              lng: expect.any(Number),
              lat: expect.any(Number),
            }),
          ]),
          // Edited labels ride along.
          waypoints: expect.arrayContaining([
            expect.objectContaining({ name: "Start" }),
            expect.objectContaining({ name: "End" }),
          ]),
        }),
      ),
    );
    expect(tripsApiSaveRouteMock).not.toHaveBeenCalled();
    expect(await screen.findByText("Names saved")).toBeInTheDocument();
    // importRoute created the backend trip → promoted: ?tripId is written so a
    // refresh reloads it (and role/collab state binds), like the full save.
    await waitFor(() =>
      expect(window.location.search).toContain(
        "tripId=11111111-2222-4333-8444-999999999999",
      ),
    );
  });

  it("PATCHes the trip metadata AFTER a successful route save and hydrates from it", async () => {
    // PUT /route replaces days but never the metadata — the PATCH keeps
    // title and planner parameters from reverting, and it runs after the
    // route commit so a failed re-route can't persist new parameters
    // against old geometry.
    // ?tripId keeps the persisted trip mounted (the bare planner URL
    // drops lingering UUID trips as the new-trip entry point).
    window.history.replaceState(
      {},
      "",
      "/trips/planner?tripId=11111111-2222-4333-8444-666666666666",
    );
    useAuthStore.setState({
      user: { id: "u-owner", email: "o@example.com", displayName: "O" },
      isAuthenticated: true,
      accessToken: "test-access-token",
    });
    tripsApiGetMock.mockResolvedValue({
      data: buildTripDetail("Renamed ride", {
        id: "11111111-2222-4333-8444-666666666666",
      }),
    } as never);
    storeState.activeTrip = {
      ...activeTrip,
      id: "11111111-2222-4333-8444-666666666666",
      name: "Renamed ride",
    };
    storeState.routeDirty = true;
    tripsApiUpdateMock.mockResolvedValue({
      data: buildTripDetail("Renamed ride", {
        id: "11111111-2222-4333-8444-666666666666",
      }),
    } as never);

    render(<TripPlannerPage />);
    // Metadata stays locked until the owner role lands (rename enabled).
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /Renamed ride/ }),
      ).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save route" }));

    await waitFor(() => expect(tripsApiUpdateMock).toHaveBeenCalled());
    expect(tripsApiUpdateMock).toHaveBeenCalledWith(
      "11111111-2222-4333-8444-666666666666",
      expect.objectContaining({
        title: "Renamed ride",
        num_days: 1,
        road_preference: expect.any(String),
        min_quality: expect.any(Number),
      }),
    );
    // Route first, metadata second.
    expect(tripsApiSaveRouteMock.mock.invocationCallOrder[0]!).toBeLessThan(
      tripsApiUpdateMock.mock.invocationCallOrder[0]!,
    );
    // The PATCH response (fresh metadata + days) is what hydrates.
    expect(setActiveTrip).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Renamed ride" }),
    );
    expect(tripsApiCreateMock).not.toHaveBeenCalled();
  });

  it("does not touch metadata when the route save fails", async () => {
    // A Valhalla failure on one edited day must not leave the new
    // parameters persisted against the old geometry.
    window.history.replaceState(
      {},
      "",
      "/trips/planner?tripId=11111111-2222-4333-8444-666666666666",
    );
    // Route saves are role-gated now — resolve the caller as the owner.
    useAuthStore.setState({
      user: { id: "u-owner", email: "o@example.com", displayName: "O" },
      isAuthenticated: true,
      accessToken: "test-access-token",
    });
    tripsApiGetMock.mockResolvedValue({
      data: buildTripDetail("Failing trip", {
        id: "11111111-2222-4333-8444-666666666666",
      }),
    } as never);
    storeState.activeTrip = {
      ...activeTrip,
      id: "11111111-2222-4333-8444-666666666666",
    };
    storeState.routeDirty = true;
    tripsApiSaveRouteMock.mockRejectedValue(new Error("502"));

    render(
      <>
        <TripPlannerPage />
        <ToastHost />
      </>,
    );
    // The role-gated Save arms once the caller resolves as the owner.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Save route" })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save route" }));

    expect(
      await screen.findByText(/Could not save the route/),
    ).toBeInTheDocument();
    expect(tripsApiUpdateMock).not.toHaveBeenCalled();
  });

  it("a rename saves the title immediately and never arms a route save", async () => {
    // A rename is a metadata edit: routing the whole trip again (with
    // whatever sits in the sidebar) just to carry a title would change
    // saved geometry unpreviewed — or block the title when routing is
    // down.
    window.history.replaceState(
      {},
      "",
      "/trips/planner?tripId=11111111-2222-4333-8444-888888888888",
    );
    useAuthStore.setState({
      user: { id: "u-owner", email: "o@example.com", displayName: "O" },
      isAuthenticated: true,
      accessToken: "test-access-token",
    });
    tripsApiGetMock.mockResolvedValue({
      data: buildTripDetail("Best fit", {
        id: "11111111-2222-4333-8444-888888888888",
      }),
    } as never);
    storeState.activeTrip = {
      ...activeTrip,
      id: "11111111-2222-4333-8444-888888888888",
    };
    tripsApiUpdateMock.mockResolvedValue({ data: {} } as never);

    render(
      <>
        <TripPlannerPage />
        <ToastHost />
      </>,
    );
    // Rename stays locked until the owner role lands.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Best fit/ })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: /Best fit/ }));
    fireEvent.change(screen.getByLabelText("Trip name"), {
      target: { value: "Renamed only" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save name" }));

    await waitFor(() =>
      expect(tripsApiUpdateMock).toHaveBeenCalledWith(
        "11111111-2222-4333-8444-888888888888",
        { title: "Renamed only" },
      ),
    );
    expect(await screen.findByText("Trip renamed")).toBeInTheDocument();
    // The rename armed no route save and dirtied nothing.
    expect(tripsApiSaveRouteMock).not.toHaveBeenCalled();
    expect(storeState.renameActiveTrip).toHaveBeenCalledWith("Renamed only");
  });

  it("keeps metadata locked while a persisted trip's role is still loading", () => {
    // Treating the role-fetch window as editable would let a member
    // queue a metadata PATCH that fails after the route already
    // committed — locked until the role lands.
    window.history.replaceState(
      {},
      "",
      "/trips/planner?tripId=11111111-2222-4333-8444-999999999999",
    );
    storeState.activeTrip = {
      ...activeTrip,
      id: "11111111-2222-4333-8444-999999999999",
    };
    // No auth: the role fetch never resolves in this render.
    render(<TripPlannerPage />);
    expect(screen.getByRole("button", { name: /Best fit/ })).toBeDisabled();
  });

  it("keeps the editor out of reach for viewers on a saved trip", async () => {
    // Viewers are read-and-comment only — the planner replaces its whole
    // body with an access screen rather than a functional-looking editor
    // whose writes would 403.
    window.history.replaceState(
      {},
      "",
      "/trips/planner?tripId=11111111-2222-4333-8444-777777777777",
    );
    useAuthStore.setState({
      user: { id: "u-member", email: "m@example.com", displayName: "M" },
      isAuthenticated: true,
      accessToken: "test-access-token",
    });
    tripsApiGetMock.mockResolvedValue({
      data: buildTripDetail("Viewer trip", {
        id: "11111111-2222-4333-8444-777777777777",
        members: [
          {
            user_id: "u-owner",
            display_name: "Owner",
            role: "owner",
            joined_at: "2026-04-23T09:00:00Z",
          },
          {
            user_id: "u-member",
            display_name: "M",
            role: "viewer",
            joined_at: "2026-04-23T09:15:00Z",
          },
        ],
      }),
    } as never);

    render(<TripPlannerPage />);

    expect(await screen.findByText(/view-only access/i)).toBeInTheDocument();
    // No route writes are even reachable.
    expect(
      screen.queryByRole("button", { name: "Save route" }),
    ).not.toBeInTheDocument();
    expect(tripsApiSaveRouteMock).not.toHaveBeenCalled();
  });

  it("sends per-leg preferences with the save when a LEG override exists", async () => {
    // The save re-routes server-side: without the leg breakdown a custom
    // leg would persist a different line than the approved preview.
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
            mkWp("s", "start", 10),
            mkWp("v", "via", 11),
            mkWp("e", "end", 12),
          ],
        },
      ],
    };
    storeState.routeDirty = true;
    (storeState.saveDays as ReturnType<typeof vi.fn>).mockReturnValue([
      {
        dayNumber: 1,
        title: null,
        startLinked: false,
        waypoints: [
          { lat: 46, lng: 10, name: "s", type: "start" as BackendWaypointType },
          { lat: 46, lng: 11, name: "v", type: "via" as BackendWaypointType },
          { lat: 46, lng: 12, name: "e", type: "end" as BackendWaypointType },
        ],
      },
    ]);

    render(<TripPlannerPage />);
    // Override the FIRST leg (trip-wide is Maximum twisty via "curvy").
    fireEvent.click(
      screen.getAllByRole("button", { name: "Road type for this leg" })[0]!,
    );
    fireEvent.click(screen.getByRole("button", { name: "Scenic balance" }));
    fireEvent.click(screen.getByRole("button", { name: "Save route" }));

    await waitFor(() => expect(tripsApiSaveRouteMock).toHaveBeenCalled());
    const body = tripsApiSaveRouteMock.mock.calls[0]![1] as {
      days: Array<{ leg_preferences?: string[] }>;
    };
    // Leg 1 carries the override; leg 2 inherits the trip-wide character.
    expect(body.days[0]!.leg_preferences).toEqual([
      "scenic_balance",
      "balanced",
    ]);
  });

  it("remaps day-0 leg overrides onto just-materialized split days", async () => {
    // materializeSplit rewrites the single working day into N days right
    // before the payload is built — the overrides still live under day 0
    // and must be reconciled against each NEW day's spine, or Day 1+
    // legs silently fall back to the trip-wide preference on save.
    const mkWp = (id: string, type: Waypoint["type"], lng: number) => ({
      id,
      name: id,
      type,
      location: { lng, lat: 46 },
    });
    const workingDay = {
      ...activeTrip.days[0]!,
      waypoints: [
        mkWp("s", "start", 10),
        mkWp("v", "via", 11),
        mkWp("e", "end", 12),
      ],
    };
    storeState.activeTrip = { ...activeTrip, days: [workingDay] };
    storeState.routeDirty = true;
    storeState.splitStatus = "split";
    // The split boundary lands between the via and the finish: day 1
    // keeps s→v (override survives), day 2 is the new SS→e leg.
    (
      storeState.materializeSplit as ReturnType<typeof vi.fn>
    ).mockImplementation(() => {
      storeState.activeTrip = {
        ...activeTrip,
        days: [
          {
            ...workingDay,
            waypoints: [
              mkWp("s", "start", 10),
              mkWp("v", "via", 11),
              mkWp("split-end-1", "end", 11.5),
            ],
          },
          {
            ...workingDay,
            dayNumber: 2,
            waypoints: [
              mkWp("split-start-2", "start", 11.5),
              mkWp("e", "end", 12),
            ],
          },
        ],
      };
    });
    (storeState.saveDays as ReturnType<typeof vi.fn>).mockReturnValue([
      {
        dayNumber: 1,
        title: null,
        startLinked: false,
        waypoints: [
          { lat: 46, lng: 10, name: "s", type: "start" as BackendWaypointType },
          { lat: 46, lng: 11, name: "v", type: "via" as BackendWaypointType },
          {
            lat: 46,
            lng: 11.5,
            name: "split-end-1",
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
            lat: 46,
            lng: 11.5,
            name: "split-start-2",
            type: "start" as BackendWaypointType,
          },
          { lat: 46, lng: 12, name: "e", type: "end" as BackendWaypointType },
        ],
      },
    ]);

    render(<TripPlannerPage />);
    // Override the first leg (s→v) of the working day.
    fireEvent.click(
      screen.getAllByRole("button", { name: "Road type for this leg" })[0]!,
    );
    fireEvent.click(screen.getByRole("button", { name: "Scenic balance" }));
    fireEvent.click(screen.getByRole("button", { name: "Save route" }));

    await waitFor(() => expect(tripsApiSaveRouteMock).toHaveBeenCalled());
    const body = tripsApiSaveRouteMock.mock.calls[0]![1] as {
      days: Array<{ leg_preferences?: string[] }>;
    };
    // Day 1 keeps the surviving s→v override; the boundary pair (v→SE)
    // re-inherits. Day 2's spine has no surviving override at all.
    expect(body.days[0]!.leg_preferences).toEqual([
      "scenic_balance",
      "balanced",
    ]);
    expect(body.days[1]!.leg_preferences).toBeUndefined();
  });

  it("re-seeds leg overrides from a loaded trip's persisted leg_preferences", () => {
    // Saved leg_preferences map positionally onto the day's routing
    // pairs; values equal to the trip-wide preference collapse back to
    // inherit so only genuine overrides read CUSTOM.
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
            mkWp("s", "start", 10),
            mkWp("v", "via", 11),
            mkWp("e", "end", 12),
          ],
          // Trip-wide maps to Balanced (fixture "mixed"): leg 1 is a
          // real override, leg 2 collapses to inherit.
          legPreferences: ["scenic_balance", "balanced"],
        },
      ],
    };

    render(<TripPlannerPage />);

    const legButtons = screen.getAllByRole("button", {
      name: "Road type for this leg",
    });
    expect(legButtons[0]).toHaveTextContent("Scenic balance");
    expect(legButtons[0]).toHaveTextContent("CUSTOM");
    expect(legButtons[1]).toHaveTextContent("Trip default");
    expect(legButtons[1]).not.toHaveTextContent("CUSTOM");
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
    // Route saves are role-gated: resolve the caller as an editor.
    useAuthStore.setState({
      user: { id: "u-member", email: "m@example.com", displayName: "M" },
      isAuthenticated: true,
      accessToken: "test-access-token",
    });
    tripsApiGetMock.mockResolvedValue({
      data: buildTripDetail("Joined trip", {
        id: serverTripId,
        members: [
          {
            user_id: "u-owner",
            display_name: "Owner",
            role: "owner",
            joined_at: "2026-04-23T09:00:00Z",
          },
          {
            user_id: "u-member",
            display_name: "M",
            role: "editor",
            joined_at: "2026-04-23T09:15:00Z",
          },
        ],
      }),
    } as never);
    storeState.activeTrip = { ...activeTrip, id: serverTripId };
    storeState.routeDirty = true;

    render(<TripPlannerPage />);

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Save route" })).toBeEnabled(),
    );
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

  // Task 7: the planner's Save route button is the primary mint path — a
  // brand-new trip is created (tripsApi.create) as part of the same save.
  // The client-side gate (Task 6) can be stale, so the backend's real
  // featureLimitExceeded 403 must still surface as the upgrade modal
  // instead of the generic error toast.
  it("shows the upgrade modal when the create call hits the server's feature-limit 403", async () => {
    storeState.activeTrip = activeTrip;
    storeState.routeDirty = true;
    tripsApiCreateMock.mockRejectedValueOnce(
      new ApiError("Feature limit exceeded", 403, {
        code: FEATURE_LIMIT_EXCEEDED,
        feature: "max_active_trips",
        limit: 1,
        current: 1,
      }),
    );

    render(
      <>
        <TripPlannerPage />
        <ToastHost />
      </>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Save route" }));

    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(
      screen.getByText("You've reached your trip limit on the Free plan."),
    ).toBeInTheDocument();
    // The generic failure toast must NOT also fire for this rejection.
    expect(
      screen.queryByText("Could not save the route. Please try again."),
    ).not.toBeInTheDocument();
  });

  it("proactively opens the upgrade modal when a capped rider opens a fresh planner directly", async () => {
    // Direct /trips/planner load (bookmark/address bar) bypasses the /trips
    // header block. A new trip WOULD mint against the rider's own cap, which is
    // already met — surface the prompt before they build/import a route.
    useAuthStore.setState({
      user: { id: "u-owner", email: "o@example.com", displayName: "O" },
      isAuthenticated: true,
      accessToken: "test-access-token",
    });
    useLimitMock.mockReturnValue({
      limit: 1,
      isLoading: false,
      isSuccess: true,
    });
    useUserTripsMock.mockReturnValue({
      trips: [{ id: "t1", owner_id: "u-owner", status: "draft" }],
      loading: false,
      error: false,
      tripById: new Map(),
    });

    render(<TripPlannerPage />);

    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(
      screen.getByText("You've reached your trip limit on the Free plan."),
    ).toBeInTheDocument();
    // Owner in a new-trip context → a real Upgrade CTA (not the suppressed one).
    expect(
      screen.getByRole("button", { name: /Upgrade to Pro/i }),
    ).toBeInTheDocument();
  });

  it("fails closed on a fresh planner while the trip count is still loading (finite cap)", async () => {
    // Count unknown (trips query pending) under a finite cap → must not wave a
    // possibly-capped rider through on an empty count. Fail closed by DISABLING
    // the mint controls (neutral — we don't claim a limit we can't verify, so
    // no "limit reached" modal here).
    useAuthStore.setState({
      user: { id: "u-owner", email: "o@example.com", displayName: "O" },
      isAuthenticated: true,
      accessToken: "test-access-token",
    });
    useLimitMock.mockReturnValue({
      limit: 1,
      isLoading: false,
      isSuccess: true,
    });
    useUserTripsMock.mockReturnValue({
      trips: [],
      loading: true,
      error: false,
      tripById: new Map(),
    });

    render(<TripPlannerPage />);

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Import GPX" })).toBeDisabled(),
    );
    expect(screen.getByRole("button", { name: /Save route/i })).toBeDisabled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("fails closed (disabled mint controls) on a fresh planner when the trip count query errors (finite cap)", async () => {
    useAuthStore.setState({
      user: { id: "u-owner", email: "o@example.com", displayName: "O" },
      isAuthenticated: true,
      accessToken: "test-access-token",
    });
    useLimitMock.mockReturnValue({
      limit: 1,
      isLoading: false,
      isSuccess: true,
    });
    useUserTripsMock.mockReturnValue({
      trips: [],
      loading: false,
      error: true,
      tripById: new Map(),
    });

    render(<TripPlannerPage />);

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Import GPX" })).toBeDisabled(),
    );
    expect(screen.getByRole("button", { name: /Save route/i })).toBeDisabled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("fails closed (disabled mint controls) on a cold planner load before the cap resolves", async () => {
    // Auth-hydration delay / entitlement error → capResolved false. No tier to
    // render a modal, so we must DISABLE the mint controls, not wave through.
    useAuthStore.setState({
      user: { id: "u-owner", email: "o@example.com", displayName: "O" },
      isAuthenticated: true,
      accessToken: "test-access-token",
    });
    useLimitMock.mockReturnValue({
      limit: null,
      isLoading: false,
      isSuccess: false,
    });

    render(<TripPlannerPage />);

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Import GPX" })).toBeDisabled(),
    );
    expect(screen.getByRole("button", { name: /Save route/i })).toBeDisabled();
  });

  it("does NOT proactively gate when EDITING an existing trip at the cap (editing doesn't mint)", async () => {
    const serverTripId = "11111111-2222-4333-8444-555555555555";
    window.history.replaceState(
      {},
      "",
      `/trips/planner?tripId=${serverTripId}`,
    );
    useAuthStore.setState({
      user: { id: "u-owner", email: "o@example.com", displayName: "O" },
      isAuthenticated: true,
      accessToken: "test-access-token",
    });
    tripsApiGetMock.mockResolvedValue({
      data: buildTripDetail("Persisted", { id: serverTripId }),
    } as never);
    useLimitMock.mockReturnValue({
      limit: 1,
      isLoading: false,
      isSuccess: true,
    });
    useUserTripsMock.mockReturnValue({
      trips: [{ id: "t1", owner_id: "u-owner", status: "draft" }],
      loading: false,
      error: false,
      tripById: new Map(),
    });
    storeState.activeTrip = activeTrip;

    render(<TripPlannerPage />);

    // Give the trip-detail fetch a tick to bind serverTripId, then confirm the
    // proactive modal never appeared — an existing trip mints nothing on save.
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Discard" }),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    // Import (gated ONLY by the mint gate) stays enabled — an open-trip edit is
    // not a mint context.
    expect(
      screen.getByRole("button", { name: "Import GPX" }),
    ).not.toBeDisabled();
  });

  it("gates an owner reopening their COMPLETED trip at the cap (save promotes it → mints)", async () => {
    const serverTripId = "11111111-2222-4333-8444-555555555555";
    window.history.replaceState(
      {},
      "",
      `/trips/planner?tripId=${serverTripId}`,
    );
    useAuthStore.setState({
      user: { id: "u-owner", email: "o@example.com", displayName: "O" },
      isAuthenticated: true,
      accessToken: "test-access-token",
    });
    tripsApiGetMock.mockResolvedValue({
      data: buildTripDetail("Done", { id: serverTripId, status: "completed" }),
    } as never);
    useLimitMock.mockReturnValue({
      limit: 1,
      isLoading: false,
      isSuccess: true,
    });
    useUserTripsMock.mockReturnValue({
      trips: [{ id: "t1", owner_id: "u-owner", status: "draft" }],
      loading: false,
      error: false,
      tripById: new Map(),
    });
    // Saving a completed trip promotes it (completed→planned) → mints against
    // the owner's cap, so it IS gated even though it's a saved trip.
    storeState.activeTrip = { ...activeTrip, status: "completed" };

    render(<TripPlannerPage />);

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /Save route/i }),
      ).toBeDisabled(),
    );
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });

  it("keeps mint controls blocked while a saved trip's role/status are still loading (capped owner)", async () => {
    // A completed-trip reopen by the owner mints (completed→planned). Until the
    // caller role/status load we can't tell completed from open, so a saved trip
    // must fail closed rather than briefly enabling the import/drop paths.
    const serverTripId = "11111111-2222-4333-8444-555555555555";
    window.history.replaceState(
      {},
      "",
      `/trips/planner?tripId=${serverTripId}`,
    );
    useAuthStore.setState({
      user: { id: "u-owner", email: "o@example.com", displayName: "O" },
      isAuthenticated: true,
      accessToken: "test-access-token",
    });
    // Never resolves → serverTripCallerRole stays null (role/status unknown).
    tripsApiGetMock.mockReturnValue(new Promise<never>(() => {}) as never);
    useLimitMock.mockReturnValue({
      limit: 1,
      isLoading: false,
      isSuccess: true,
    });
    useUserTripsMock.mockReturnValue({
      trips: [{ id: "t1", owner_id: "u-owner", status: "draft" }],
      loading: false,
      error: false,
      tripById: new Map(),
    });

    render(<TripPlannerPage />);

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Import GPX" })).toBeDisabled(),
    );
  });

  it("does not open the import dialog from ?import=1 when the rider is at their cap", async () => {
    // A direct import URL must not bypass the disabled toolbar button.
    window.history.replaceState({}, "", "/trips/planner?import=1");
    useAuthStore.setState({
      user: { id: "u-owner", email: "o@example.com", displayName: "O" },
      isAuthenticated: true,
      accessToken: "test-access-token",
    });
    useLimitMock.mockReturnValue({
      limit: 1,
      isLoading: false,
      isSuccess: true,
    });
    useUserTripsMock.mockReturnValue({
      trips: [{ id: "t1", owner_id: "u-owner", status: "draft" }],
      loading: false,
      error: false,
      tripById: new Map(),
    });

    render(<TripPlannerPage />);

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Import GPX" })).toBeDisabled(),
    );
    expect(screen.queryByTestId("import-dialog-open")).not.toBeInTheDocument();
  });

  it("does not fetch the (unpaginated) trips list when the cap is unlimited", () => {
    // Unlimited cap in a fresh mint session → the count is irrelevant, so the
    // geospatial /trips list query stays disabled.
    useLimitMock.mockReturnValue({
      limit: null,
      isLoading: false,
      isSuccess: true,
    });

    render(<TripPlannerPage />);

    expect(useUserTripsMock).toHaveBeenCalledWith({ enabled: false });
    expect(useUserTripsMock).not.toHaveBeenCalledWith({ enabled: true });
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

    fireEvent.click(screen.getByLabelText("Avoid motorways"));
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
    expect(
      screen.queryByLabelText("Highlight day 1 on the map"),
    ).not.toBeInTheDocument();
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

  it("renders the shared day cards once split", () => {
    storeState.activeTrip = activeTrip;
    storeState.planningMode = "multiday";
    storeState.splitStatus = "split";
    storeState.dayPlans = samplePlans;

    render(<TripPlannerPage />);

    // One card per split day, using the same preview-style "Day-by-day" card.
    expect(
      screen.getByLabelText("Highlight day 1 on the map"),
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText("Highlight day 2 on the map"),
    ).toBeInTheDocument();
    // Unmaterialized split (activeTrip still has one whole-route day): every
    // card projects from its own DayPlan, so day 1 shows its slice's towns
    // rather than the shared whole-route day's data.
    expect(
      within(screen.getByLabelText("Highlight day 1 on the map")).getByText(
        /Start → Brno/,
      ),
    ).toBeInTheDocument();
    expect(
      within(screen.getByLabelText("Highlight day 2 on the map")).getByText(
        /Brno → Finish/,
      ),
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
    expect(
      screen.getByLabelText("Highlight day 1 on the map"),
    ).toBeInTheDocument();
  });

  it("shows the day count in the header only after a split", () => {
    storeState.activeTrip = activeTrip;
    storeState.planningMode = "multiday";
    storeState.splitStatus = "split";
    storeState.dayPlans = samplePlans;

    render(<TripPlannerPage />);

    // Post-split header meta: day count + total distance segments
    // (revision 2 §C; icon-per-segment layout). Distance formats via
    // format.distanceKm for parity with the trip-preview header — the seam
    // only shows a decimal when the value actually has one (240 -> "240 km",
    // not the old toFixed(1)-forced "240.0 km").
    expect(screen.getAllByText("2 days").length).toBeGreaterThan(0);
    expect(screen.getAllByText("240 km").length).toBeGreaterThan(0);
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

  it("gates re-splitting off for loaded multi-day trips", async () => {
    // A saved multi-day trip already carries materialized days; splitting
    // only day 1 would show a wrong itinerary that materializeSplit()
    // refuses to persist — every re-split entry point must be gated.
    const mkPlan = (dayNumber: number, endKm: number) => ({
      dayNumber,
      segmentIds: [],
      distanceKm: 200,
      timeMin: 240,
      quality: {
        distanceKm: 200,
        timeMin: 240,
        score: 4,
        surfaceMix: [],
        flagged: [],
      },
      startTown: "A",
      endTown: "B",
      suggestedStays: [],
      endKm,
    });
    storeState.activeTrip = {
      ...activeTrip,
      days: [
        activeTrip.days[0]!,
        { ...activeTrip.days[0]!, dayNumber: 2, startLinked: true },
      ],
    };
    storeState.planningMode = "multiday";
    storeState.splitStatus = "split";
    storeState.dayPlans = [mkPlan(1, 200), mkPlan(2, 400)];

    const { container, rerender } = render(<TripPlannerPage />);
    const details = container.querySelector("details")!;
    details.open = true;
    fireEvent(details, new Event("toggle", { bubbles: false }));

    // The BUILD split button is disabled and explains why.
    expect(screen.getByRole("button", { name: /Re-split/ })).toBeDisabled();
    expect(screen.getByText(/This trip's days are saved/)).toBeInTheDocument();

    // Changing the day controls must not recompute a bogus split.
    fireEvent.change(screen.getByLabelText("Daily km target"), {
      target: { value: "300" },
    });
    await act(async () => {});
    expect(storeState.applySplit).not.toHaveBeenCalled();

    // A stale split on a multi-day trip offers no day-column shortcut.
    storeState.splitStatus = "stale";
    rerender(<TripPlannerPage />);
    expect(screen.queryByRole("button", { name: "RE-SPLIT" })).toBeNull();
  });
});
