import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import TripDetailPage from "./page";
import { ApiError, roadsApi, tripsApi } from "@/lib/api";
import { tripCollabApi } from "@/lib/api/trip-collab";
import { useAuthStore } from "@/stores/auth";
import { useTripStore } from "@/stores/trip";
import { useClosures, type ClosuresQueryResult } from "@/hooks/useClosures";
import { usePasses, type PassesQueryResult } from "@/hooks/usePasses";
import { useTripCollabSession } from "@/hooks/useTripCollabSession";
import type { TripDetailResponse } from "@/lib/trip-from-detail";

// ── Module mocks ────────────────────────────────────────────────────────

const mockReplace = vi.fn();
const mockedTripPlannerMap = vi.fn((_props?: unknown) => (
  <div data-testid="trip-planner-map" />
));
const mockedTripCollabModal = vi.fn((_props?: unknown) => null);
let useParamsTripId: string | null = "trip-1";

// The router object must be REFERENTIALLY STABLE like the real
// next/navigation hook — the page's load effect lists `router` in its
// deps, and a fresh object per render would re-fire the fetch (and flip
// the page back to loading) on every unrelated state update.
const mockRouter = { replace: mockReplace, push: vi.fn(), back: vi.fn() };
// Unlike Next's real notFound() this records the call WITHOUT throwing:
// jsdom has no not-found boundary, so the real sentinel would escape React
// as an unhandled error and fail the run. Both pages fall through to their
// error branch after a no-op notFound(), so rendering stays safe.
const mockNotFound = vi.fn();
vi.mock("next/navigation", () => ({
  useParams: () => ({ tripId: useParamsTripId }),
  useRouter: () => mockRouter,
  notFound: () => mockNotFound(),
}));

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    roadsApi: { ...actual.roadsApi, getSegmentDetail: vi.fn() },
    tripsApi: {
      get: vi.fn(),
      delete: vi.fn(),
      list: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      generate: vi.fn(),
      invite: vi.fn(),
    },
  };
});

vi.mock("@/lib/api/trip-collab", () => ({
  tripCollabApi: { leaveTrip: vi.fn() },
}));

vi.mock("@/stores/auth", () => ({
  useAuthStore: vi.fn(),
}));

vi.mock("@/stores/trip", () => ({
  useTripStore: vi.fn(),
}));

// The route-quality hydration this page runs now reads an operator kill
// switch, which is backed by a react-query request; this test renders without
// a QueryClientProvider. Fails SAFE (enabled) to match production.
const killSwitches: Record<string, boolean> = vi.hoisted(() => ({}));
vi.mock("@/hooks/useEntitlements", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/useEntitlements")>()),
  useFeatureKillSwitch: (key: string) => ({
    enabled: killSwitches[key] ?? true,
    isResolved: true,
  }),
}));
vi.mock("@/hooks/useClosures", () => ({
  useClosures: vi.fn(),
}));

vi.mock("@/hooks/usePasses", () => ({
  usePasses: vi.fn(),
}));

vi.mock("@/hooks/useTripCollabSession", () => ({
  useTripCollabSession: vi.fn(),
}));

// Pass-through: the real hook debounces the loading skeleton by 250ms,
// which would force timer juggling in every loading-state assertion.
vi.mock("@/hooks/useDelayedLoading", () => ({
  useDelayedLoading: (loading: boolean) => loading,
}));

vi.mock("@/lib/closures-summary", async () => {
  const actual = await vi.importActual<typeof import("@/lib/closures-summary")>(
    "@/lib/closures-summary",
  );
  return {
    ...actual,
    buildTripClosureRoutes: vi.fn(() => []),
  };
});

vi.mock("@/components/TripPlannerMap", () => ({
  TripPlannerMap: (props: unknown) => mockedTripPlannerMap(props),
}));

vi.mock("@/components/SegmentSidebar", () => ({
  SegmentSidebar: () => <div data-testid="segment-sidebar" />,
}));

vi.mock("@/components/TripExportButton", () => ({
  TripExportButton: () => <button>Export</button>,
}));

vi.mock("@/components/TripCollaborateModal", () => ({
  TripCollaborateModal: (props: unknown) => mockedTripCollabModal(props),
}));

// ── Fixtures ────────────────────────────────────────────────────────────

function buildDetail(
  overrides: Partial<TripDetailResponse> = {},
): TripDetailResponse {
  return {
    id: "trip-1",
    title: "Italian Loop",
    region: "Dolomites",
    num_days: 2,
    status: "planned",
    member_count: 2,
    owner_id: "owner-1",
    folder_id: null,
    distance_km: null,
    quality_avg: null,
    passes_count: null,
    overview_geometry: null,
    created_at: "2026-04-24T10:00:00.000Z",
    daily_km_min: 200,
    daily_km_max: 300,
    min_quality: 4,
    road_preference: "scenic",
    members: [
      {
        user_id: "owner-1",
        display_name: "Adam",
        role: "owner",
        joined_at: "2026-04-24T10:00:00.000Z",
      },
      {
        user_id: "member-1",
        display_name: "Eve",
        role: "viewer",
        joined_at: "2026-04-24T11:00:00.000Z",
      },
    ],
    days: [
      {
        id: "d-1",
        day_number: 1,
        title: "Climb to Sella",
        distance_km: 220.5,
        avg_quality: 4.2,
        elevation_gain: 1500,
        elevation_loss: 1500,
        curviness_score: 75,
        scenic_score: 80,
        estimated_time_min: 270,
        start_linked: false,
        route_geometry: [
          { lat: 46.5, lng: 11.2 },
          { lat: 46.6, lng: 11.3 },
        ],
        waypoints: [
          {
            id: "w-1",
            sequence: 0,
            lat: 46.5,
            lng: 11.2,
            name: "Bolzano",
            waypoint_type: "start",
            road_segment_id: null,
            notes: null,
            duration_min: null,
          },
          {
            id: "w-2",
            sequence: 1,
            lat: 46.6,
            lng: 11.3,
            name: "Hotel Sella",
            waypoint_type: "hotel",
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

const closuresResult: ClosuresQueryResult = {
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

const passesResult: PassesQueryResult = {
  passes: [],
  routePasses: [],
  routeClosedCount: 0,
  routeUnknownCount: 0,
  loading: false,
  routeLoading: false,
  error: null,
  routeError: null,
};

// ── Test setup helpers ─────────────────────────────────────────────────

const useAuthStoreMock = vi.mocked(useAuthStore);
const useTripStoreMock = vi.mocked(useTripStore);
const useClosuresMock = vi.mocked(useClosures);
const usePassesMock = vi.mocked(usePasses);
const useTripCollabSessionMock = vi.mocked(useTripCollabSession);
const tripsApiGetMock = vi.mocked(tripsApi.get);
const tripsApiDeleteMock = vi.mocked(tripsApi.delete);

function primeStores(
  callerId: string | null = "owner-1",
  activeTrip: unknown = null,
) {
  // Mirror the per-selector pattern used by Zustand: each call to
  // `useStore(selector)` invokes the selector against the current
  // snapshot. Tests don't need full reactivity — a fixed snapshot is
  // enough since `useTripStore.getState()` isn't called from this page.
  const authSnapshot = {
    user: callerId ? { id: callerId } : null,
    // The page gates its data fetch on a non-null access token to avoid
    // a hard-navigation AuthSync race. Tests assert the loaded states,
    // so the token always needs to be seeded — even the "unauthenticated
    // caller" case sets it so the trip still loads and we can confirm
    // the role-gated UI hides correctly.
    accessToken: "test-access-token",
  };
  useAuthStoreMock.mockImplementation(((selector: (s: unknown) => unknown) =>
    selector(authSnapshot)) as unknown as typeof useAuthStore);
  const setActiveTrip = vi.fn();
  const tripSnapshot = {
    setActiveTrip,
    applyRouteQuality: vi.fn(),
    activeTrip,
    selectedPlannerSegmentId: null,
    selectPlannerSegment: vi.fn(),
  };
  useTripStoreMock.mockImplementation(((selector: (s: unknown) => unknown) =>
    selector(tripSnapshot)) as unknown as typeof useTripStore);
  useClosuresMock.mockReturnValue(closuresResult);
  usePassesMock.mockReturnValue(passesResult);
  useTripCollabSessionMock.mockReturnValue({
    cursors: new Map(),
    presence: new Map(),
    members: new Map(),
    suggestions: [],
    setSuggestions: vi.fn(),
    suggestionsError: null,
    emitCursor: vi.fn(),
  });
  return { setActiveTrip };
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of Object.keys(killSwitches)) delete killSwitches[key];
  useParamsTripId = "trip-1";
  primeStores();
  // Stub global confirm so the delete-confirmation tests can drive it.
  vi.spyOn(window, "confirm").mockReturnValue(true);
});

// ── Tests ──────────────────────────────────────────────────────────────

describe("TripDetailPage — planner draft preservation", () => {
  it("restores an unsaved planner draft after viewing a saved trip", () => {
    // The rider has an in-memory draft in the shared store; viewing this saved
    // trip must not destroy it.
    const draft = { id: "planner-20260707120000", days: [] };
    const { setActiveTrip } = primeStores("owner-1", draft);
    tripsApiGetMock.mockReturnValue(new Promise(() => {}));

    const { unmount } = render(<TripDetailPage />);
    unmount();

    expect(setActiveTrip).toHaveBeenLastCalledWith(draft);
  });

  it("clears a lingering persisted (UUID) trip on leave", () => {
    const persisted = { id: "123e4567-e89b-12d3-a456-426614174000", days: [] };
    const { setActiveTrip } = primeStores("owner-1", persisted);
    tripsApiGetMock.mockReturnValue(new Promise(() => {}));

    const { unmount } = render(<TripDetailPage />);
    unmount();

    expect(setActiveTrip).toHaveBeenLastCalledWith(null);
  });
});

describe("TripDetailPage — data fetching", () => {
  it("renders the loading state while the request is in flight", () => {
    tripsApiGetMock.mockReturnValue(new Promise(() => {}));
    render(<TripDetailPage />);
    expect(screen.getByText(/loading trip/i)).toBeInTheDocument();
  });

  it("fetches the trip via tripsApi.get and renders header + day stats", async () => {
    const detail = buildDetail();
    // Day-by-day cards render only for multi-day routes — mirror the
    // fixture day as Day 2 so the section shows.
    detail.days = [
      detail.days[0]!,
      {
        ...detail.days[0]!,
        id: "d-2",
        day_number: 2,
        title: "Descent to Canazei",
      },
    ];
    tripsApiGetMock.mockResolvedValue({ data: detail } as never);
    render(<TripDetailPage />);

    await waitFor(() => {
      expect(tripsApiGetMock).toHaveBeenCalledWith("trip-1");
    });
    expect(await screen.findByText("Italian Loop")).toBeInTheDocument();
    // Header meta + trip-summary tile + per-day cards all show distances;
    // getAllByText sidesteps the duplicates without weakening the check.
    expect(screen.getAllByText(/220\.5 km/).length).toBeGreaterThan(0);
    // Day-by-day surfaces the day titles and their waypoint counts.
    expect(screen.getByText(/Climb to Sella/)).toBeInTheDocument();
    expect(screen.getByText(/Descent to Canazei/)).toBeInTheDocument();
    expect(screen.getAllByText(/2 waypoints/).length).toBe(2);
  });

  it("routes a backend 404 to the app-level not-found screen", async () => {
    tripsApiGetMock.mockRejectedValue(
      new ApiError("Trip not found", 404, null),
    );
    render(<TripDetailPage />);
    await waitFor(() => {
      expect(mockNotFound).toHaveBeenCalled();
    });
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it("redirects to /trips when the backend returns 403", async () => {
    tripsApiGetMock.mockRejectedValue(new ApiError("Forbidden", 403, null));
    render(<TripDetailPage />);
    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith("/trips");
    });
  });

  it("does not flash the generic error UI while the 403 redirect lands", async () => {
    // Without the in-flight cancellation guard, the .finally() below the
    // catch ran setLoading(false) and the page rendered "Unknown error
    // loading trip." for one frame before the router-driven unmount
    // landed. Hold the visible state at "loading" until the unmount
    // actually swaps the route.
    tripsApiGetMock.mockRejectedValue(new ApiError("Forbidden", 403, null));
    render(<TripDetailPage />);
    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith("/trips");
    });
    expect(
      screen.queryByText(/unknown error loading trip/i),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/couldn't load this trip/i),
    ).not.toBeInTheDocument();
  });

  it("renders a generic error when the request fails for an unknown reason", async () => {
    tripsApiGetMock.mockRejectedValue(new Error("network down"));
    render(<TripDetailPage />);
    expect(
      await screen.findByText(/couldn't load this trip/i),
    ).toBeInTheDocument();
  });
});

describe("TripDetailPage — member-role gating", () => {
  it("shows a Delete button when the caller is the owner", async () => {
    tripsApiGetMock.mockResolvedValue({ data: buildDetail() } as never);
    render(<TripDetailPage />);
    expect(
      await screen.findByRole("button", { name: /delete trip/i }),
    ).toBeInTheDocument();
  });

  it("hides the Delete button for plain members", async () => {
    primeStores("member-1");
    tripsApiGetMock.mockResolvedValue({ data: buildDetail() } as never);
    render(<TripDetailPage />);
    // Wait for the trip to render so the absence is meaningful.
    expect(await screen.findByText("Italian Loop")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /delete trip/i }),
    ).not.toBeInTheDocument();
  });

  it("hides the Delete button for unauthenticated callers", async () => {
    primeStores(null);
    tripsApiGetMock.mockResolvedValue({ data: buildDetail() } as never);
    render(<TripDetailPage />);
    expect(await screen.findByText("Italian Loop")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /delete trip/i }),
    ).not.toBeInTheDocument();
  });

  it("gives viewers Suggestions + Leave, no Collaborate/Edit/Delete", async () => {
    // Default fixture: member-1 (Eve) is a viewer.
    primeStores("member-1");
    tripsApiGetMock.mockResolvedValue({ data: buildDetail() } as never);
    render(<TripDetailPage />);

    expect(await screen.findByText("Italian Loop")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /suggestions/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /leave/i })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /collaborate/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: /edit/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /delete trip/i }),
    ).not.toBeInTheDocument();
  });

  it("gives editors Suggestions + Leave + Edit, no Collaborate/Delete", async () => {
    primeStores("member-1");
    tripsApiGetMock.mockResolvedValue({
      data: buildDetail({
        members: [
          {
            user_id: "owner-1",
            display_name: "Adam",
            role: "owner",
            joined_at: "2026-04-24T10:00:00.000Z",
          },
          {
            user_id: "member-1",
            display_name: "Eve",
            role: "editor",
            joined_at: "2026-04-24T11:00:00.000Z",
          },
        ],
      }),
    } as never);
    render(<TripDetailPage />);

    expect(await screen.findByText("Italian Loop")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /suggestions/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /leave/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /edit/i })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /collaborate/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /delete trip/i }),
    ).not.toBeInTheDocument();
  });

  it("leaves the trip and returns to the list on confirm", async () => {
    const leaveMock = vi.mocked(tripCollabApi.leaveTrip);
    leaveMock.mockResolvedValue(undefined as never);
    primeStores("member-1"); // viewer
    tripsApiGetMock.mockResolvedValue({ data: buildDetail() } as never);
    render(<TripDetailPage />);

    fireEvent.click(await screen.findByRole("button", { name: /leave/i }));
    // Confirm dialog → confirm.
    fireEvent.click(screen.getByRole("button", { name: /leave trip/i }));

    await waitFor(() => expect(leaveMock).toHaveBeenCalledWith("trip-1"));
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith("/trips"));
  });

  it("gives the owner Collaborate + Edit + Delete, no Leave", async () => {
    primeStores("owner-1");
    tripsApiGetMock.mockResolvedValue({ data: buildDetail() } as never);
    render(<TripDetailPage />);

    expect(await screen.findByText("Italian Loop")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /collaborate/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /edit/i })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /delete trip/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /^leave/i }),
    ).not.toBeInTheDocument();
  });
});

describe("TripDetailPage — delete confirmation", () => {
  // Deleting confirms through the app-styled ConfirmDialog — the app
  // never opens system dialogs.
  it("opens the app confirm dialog and does nothing on cancel", async () => {
    tripsApiGetMock.mockResolvedValue({ data: buildDetail() } as never);
    tripsApiDeleteMock.mockResolvedValue({ data: undefined } as never);
    render(<TripDetailPage />);

    fireEvent.click(
      await screen.findByRole("button", { name: /delete trip/i }),
    );
    expect(
      screen.getByRole("dialog", { name: "Delete this trip?" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(tripsApiDeleteMock).not.toHaveBeenCalled();
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it("issues DELETE and replaces the URL with /trips on confirm", async () => {
    tripsApiGetMock.mockResolvedValue({ data: buildDetail() } as never);
    tripsApiDeleteMock.mockResolvedValue({ data: undefined } as never);
    render(<TripDetailPage />);

    fireEvent.click(
      await screen.findByRole("button", { name: /delete trip/i }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Delete permanently" }));

    await waitFor(() => {
      expect(tripsApiDeleteMock).toHaveBeenCalledWith("trip-1");
    });
    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith("/trips");
    });
  });

  it("surfaces an inline error and stays on the page when DELETE fails", async () => {
    tripsApiGetMock.mockResolvedValue({ data: buildDetail() } as never);
    // 5xx is the realistic transient failure to model. Non-owner deletes
    // 404 by design (no role enumeration), so the 404 path lives in
    // its own assertion below.
    tripsApiDeleteMock.mockRejectedValue(new ApiError("boom", 500, null));
    render(<TripDetailPage />);

    fireEvent.click(
      await screen.findByRole("button", { name: /delete trip/i }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Delete permanently" }));

    expect(
      await screen.findByText(/couldn't delete the trip/i),
    ).toBeInTheDocument();
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it("renders the 404-specific message when the trip no longer exists", async () => {
    tripsApiGetMock.mockResolvedValue({ data: buildDetail() } as never);
    tripsApiDeleteMock.mockRejectedValue(
      new ApiError("Trip not found", 404, null),
    );
    render(<TripDetailPage />);

    fireEvent.click(
      await screen.findByRole("button", { name: /delete trip/i }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Delete permanently" }));

    expect(
      await screen.findByText(/this trip no longer exists/i),
    ).toBeInTheDocument();
    expect(mockReplace).not.toHaveBeenCalled();
  });
});
describe("TripDetailPage — road_quality_overlay kill switch", () => {
  it("closes the segment drawer and stops its fetch on a live kill", async () => {
    // The map gates its own layers, but the DRAWER is owned here: the parent
    // keys both the `getSegmentDetail` effect and the sidebar off its own
    // selection, so gating the map alone left the score/history panel open and
    // an in-flight response free to land behind it.
    primeStores();
    tripsApiGetMock.mockResolvedValue({ data: buildDetail() } as never);
    vi.mocked(roadsApi.getSegmentDetail).mockReturnValue(
      new Promise(() => {}) as never,
    );

    const { rerender } = render(<TripDetailPage />);
    await waitFor(() => expect(mockedTripPlannerMap).toHaveBeenCalled());

    // Open the drawer the way the map does.
    const props = mockedTripPlannerMap.mock.calls.at(-1)?.[0] as {
      onOpenSegmentDetail?: (id: string) => void;
    };
    act(() => props?.onOpenSegmentDetail?.("seg-1"));
    await waitFor(() =>
      expect(vi.mocked(roadsApi.getSegmentDetail)).toHaveBeenCalledWith(
        "seg-1",
        expect.anything(),
      ),
    );

    // Spy on the ABORT, not on "was it re-requested": without the gate the
    // effect's deps simply do not change, so nothing is re-requested either and
    // a call-count assertion would pass against broken code.
    const abortSpy = vi.spyOn(AbortController.prototype, "abort");
    killSwitches.road_quality_overlay = false;
    vi.mocked(roadsApi.getSegmentDetail).mockClear();
    rerender(<TripDetailPage />);

    // Collapsing the effective id re-runs the effect, whose teardown aborts the
    // in-flight request and returns the panel to idle.
    await waitFor(() => expect(abortSpy).toHaveBeenCalled());
    expect(vi.mocked(roadsApi.getSegmentDetail)).not.toHaveBeenCalled();
    abortSpy.mockRestore();
  });
});

describe("TripDetailPage — trip_planning kill switch", () => {
  it("hides Edit, which only redirects into the killed planner", async () => {
    // `/trips/:id/edit` has no UI of its own — its effect redirects straight to
    // the planner, so with planning killed the button is a one-way trip to the
    // unavailable card.
    primeStores("owner-1");
    tripsApiGetMock.mockResolvedValue({ data: buildDetail() } as never);

    const view = () => <TripDetailPage />;
    const { rerender } = render(view());
    expect(
      await screen.findByRole("link", { name: /edit/i }),
    ).toBeInTheDocument();

    killSwitches.trip_planning = false;
    // A fresh element: React bails out of a re-render given the identical one.
    rerender(view());
    await waitFor(() =>
      expect(screen.queryByRole("link", { name: /edit/i })).toBeNull(),
    );
  });
});
