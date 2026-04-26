import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import TripDetailPage from "./page";
import { ApiError, tripsApi } from "@/lib/api";
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

vi.mock("next/navigation", () => ({
  useParams: () => ({ tripId: useParamsTripId }),
  useRouter: () => ({ replace: mockReplace, push: vi.fn(), back: vi.fn() }),
}));

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
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

vi.mock("@/stores/auth", () => ({
  useAuthStore: vi.fn(),
}));

vi.mock("@/stores/trip", () => ({
  useTripStore: vi.fn(),
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

vi.mock("@/components/TripExportMenu", () => ({
  TripExportMenu: () => <button>Export</button>,
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
    created_at: "2026-04-24T10:00:00.000Z",
    daily_km_min: 200,
    daily_km_max: 300,
    min_quality: 4,
    road_preference: "scenic",
    invite_code: "ABCDEFGH",
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
        role: "member",
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

function primeStores(callerId: string | null = "owner-1") {
  // Mirror the per-selector pattern used by Zustand: each call to
  // `useStore(selector)` invokes the selector against the current
  // snapshot. Tests don't need full reactivity — a fixed snapshot is
  // enough since `useTripStore.getState()` isn't called from this page.
  const authSnapshot = { user: callerId ? { id: callerId } : null };
  useAuthStoreMock.mockImplementation(((selector: (s: unknown) => unknown) =>
    selector(authSnapshot)) as unknown as typeof useAuthStore);
  const setActiveTrip = vi.fn();
  const tripSnapshot = { setActiveTrip };
  useTripStoreMock.mockImplementation(((selector: (s: unknown) => unknown) =>
    selector(tripSnapshot)) as unknown as typeof useTripStore);
  useClosuresMock.mockReturnValue(closuresResult);
  usePassesMock.mockReturnValue(passesResult);
  useTripCollabSessionMock.mockReturnValue({
    cursors: new Map(),
    presence: new Map(),
    suggestions: [],
    setSuggestions: vi.fn(),
    suggestionsError: null,
    emitCursor: vi.fn(),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  useParamsTripId = "trip-1";
  primeStores();
  // Stub global confirm so the delete-confirmation tests can drive it.
  vi.spyOn(window, "confirm").mockReturnValue(true);
});

// ── Tests ──────────────────────────────────────────────────────────────

describe("TripDetailPage — data fetching", () => {
  it("renders the loading state while the request is in flight", () => {
    tripsApiGetMock.mockReturnValue(new Promise(() => {}));
    render(<TripDetailPage />);
    expect(screen.getByText(/loading trip/i)).toBeInTheDocument();
  });

  it("fetches the trip via tripsApi.get and renders header + day stats", async () => {
    tripsApiGetMock.mockResolvedValue({ data: buildDetail() } as never);
    render(<TripDetailPage />);

    await waitFor(() => {
      expect(tripsApiGetMock).toHaveBeenCalledWith("trip-1");
    });
    expect(await screen.findByText("Italian Loop")).toBeInTheDocument();
    // Header total + per-day card both render the same distance for a
    // single-day trip; getAllByText sidesteps the duplicate without
    // weakening the assertion (we still want to see at least one).
    expect(screen.getAllByText(/220\.5 km/).length).toBeGreaterThan(0);
    // Day-by-day surfaces the day title and its waypoint count.
    expect(screen.getByText(/Climb to Sella/)).toBeInTheDocument();
    expect(screen.getByText(/2 waypoints/)).toBeInTheDocument();
  });

  it("renders the not-found state when the backend 404s", async () => {
    tripsApiGetMock.mockRejectedValue(
      new ApiError("Trip not found", 404, null),
    );
    render(<TripDetailPage />);
    expect(await screen.findByText(/trip not found/i)).toBeInTheDocument();
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it("redirects to /trips when the backend returns 403", async () => {
    tripsApiGetMock.mockRejectedValue(new ApiError("Forbidden", 403, null));
    render(<TripDetailPage />);
    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith("/trips");
    });
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

  it("renders the owner badge with the Crown icon for the owner row", async () => {
    tripsApiGetMock.mockResolvedValue({ data: buildDetail() } as never);
    render(<TripDetailPage />);
    fireEvent.click(await screen.findByRole("tab", { name: /members/i }));
    // Roles render as uppercase pills next to each name; verifying
    // both surface lets the test detect a regression that swaps the
    // icon/label without changing visual state.
    expect(await screen.findByText("Adam")).toBeInTheDocument();
    expect(screen.getByText(/^owner$/i)).toBeInTheDocument();
    expect(screen.getByText("Eve")).toBeInTheDocument();
    expect(screen.getByText(/^member$/i)).toBeInTheDocument();
  });
});

describe("TripDetailPage — delete confirmation", () => {
  it("calls confirm() before issuing DELETE", async () => {
    tripsApiGetMock.mockResolvedValue({ data: buildDetail() } as never);
    tripsApiDeleteMock.mockResolvedValue({ data: undefined } as never);
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<TripDetailPage />);

    fireEvent.click(
      await screen.findByRole("button", { name: /delete trip/i }),
    );
    expect(confirmSpy).toHaveBeenCalledWith(
      expect.stringContaining('Delete "Italian Loop"?'),
    );
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

    expect(
      await screen.findByText(/this trip no longer exists/i),
    ).toBeInTheDocument();
    expect(mockReplace).not.toHaveBeenCalled();
  });
});
