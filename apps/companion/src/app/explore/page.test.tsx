import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { forwardRef, useImperativeHandle } from "react";
import ExplorerPage from "./page";
import { roadsApi } from "@/lib/api";
import type { RoadSegmentDetailResponse } from "@/lib/api";
import { useMapStore } from "@/stores/map";
import { useAuthStore } from "@/stores/auth";
import { DEFAULT_MAP_FILTERS, cloneFilters } from "@/lib/map-filters";
import { usePreferencesStore } from "@/stores/preferences";

const mockReplace = vi.fn();
const mockSearchParams = vi.hoisted(() => ({
  value: new URLSearchParams(),
}));

type MockQualityMapProps = {
  onSegmentSelect?: (segmentId: string) => void;
  onViewChange?: (view: {
    lng: number;
    lat: number;
    zoom: number;
    bbox: [number, number, number, number];
  }) => void;
};

const flyToMock = vi.fn();
const mockQualityMap = vi.fn((props: MockQualityMapProps) => (
  <>
    <button
      type="button"
      onClick={() =>
        props.onSegmentSelect?.("11111111-2222-4333-8444-555555555111")
      }
    >
      Select mock segment
    </button>
    <button
      type="button"
      onClick={() =>
        props.onViewChange?.({
          lng: 14,
          lat: 49,
          zoom: 8,
          bbox: [13.1, 48.2, 14.9, 49.8],
        })
      }
    >
      Report mock viewport
    </button>
  </>
));

vi.mock("next/navigation", () => ({
  usePathname: () => "/explore",
  useRouter: () => ({ replace: mockReplace }),
  useSearchParams: () => mockSearchParams.value,
}));

vi.mock("./_components/QualityMap", () => ({
  // forwardRef so the page can call `mapRef.current.flyTo(...)` —
  // /explore wires the search-pick path through that imperative
  // handle (T29 asserts the call here).
  QualityMap: forwardRef<
    { flyTo: (t: { lng: number; lat: number; zoom: number }) => void },
    MockQualityMapProps
  >(function MockQualityMap(props, ref) {
    useImperativeHandle(ref, () => ({ flyTo: flyToMock }), []);
    return mockQualityMap(props);
  }),
}));

vi.mock("@/components/SegmentTrendChart", () => ({
  SegmentTrendChart: ({ segmentId }: { segmentId: string }) => (
    <div data-testid={`segment-trend-chart-${segmentId}`}>Trend chart</div>
  ),
}));

vi.mock("@/components/RoadReviewsPanel", () => ({
  RoadReviewsPanel: ({ segmentId }: { segmentId: string }) => (
    <div>Reviews panel for {segmentId}</div>
  ),
}));

vi.mock("@/components/ClosuresPanel", () => ({
  ClosuresPanel: ({
    bbox,
    showRouteWarnings,
  }: {
    bbox?: string;
    showRouteWarnings?: boolean;
  }) => (
    <div>
      Closures panel bbox={bbox} routes=
      {showRouteWarnings === false ? "hidden" : "shown"}
    </div>
  ),
}));

vi.mock("@/components/PassesPanel", () => ({
  PassesPanel: ({
    bbox,
    showRouteWarnings,
  }: {
    bbox?: string;
    showRouteWarnings?: boolean;
  }) => (
    <div>
      Passes panel bbox={bbox} routes=
      {showRouteWarnings === false ? "hidden" : "shown"}
    </div>
  ),
}));

// The shared address-search field (tested on its own in the planner suite) is
// stubbed to a button that fires `onSelect` with a fixed place, so this suite
// asserts only the /explore integration: picking flies the map + mirrors the
// store.
vi.mock("@/components/planner/GeocodeSearchField", () => ({
  GeocodeSearchField: ({
    ariaLabel,
    onSelect,
  }: {
    ariaLabel: string;
    onSelect: (r: { name: string; lat: number; lng: number }) => void;
  }) => (
    <button
      type="button"
      aria-label={ariaLabel}
      onClick={() =>
        onSelect({
          name: "Tatra Mountains, Slovakia",
          lat: 49.165,
          lng: 19.973,
        })
      }
    >
      {ariaLabel}
    </button>
  ),
}));

const apiGetMock = vi.fn();
vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    roadsApi: {
      ...actual.roadsApi,
      getSegmentDetail: vi.fn(),
    },
    api: {
      ...actual.api,
      GET: (path: string, init: unknown) => apiGetMock(path, init),
    },
  };
});

function resetMapStore() {
  useMapStore.setState({
    center: { lng: 18.26, lat: 49.82 },
    zoom: 10,
    showQualityOverlay: true,
    showHazardOverlay: true,
    showSurfaceOverlay: false,
    showClosuresLayer: false,
    showPassesLayer: false,
    filters: cloneFilters(DEFAULT_MAP_FILTERS),
  });
}

function segmentDetail(
  overrides: Partial<RoadSegmentDetailResponse> = {},
): RoadSegmentDetailResponse {
  return {
    id: "11111111-2222-4333-8444-555555555111",
    road_name: "Mock Ridge Road",
    road_number: "MR-12",
    quality_score: 4.6,
    curviness_score: 82,
    surface_type: "asphalt",
    length_m: 1240,
    segment_length_m: 1240,
    confidence: 91,
    reading_count: 37,
    last_updated: "2026-05-10T12:00:00.000Z",
    geometry: [
      { lat: 46.45, lng: 10.3 },
      { lat: 46.58, lng: 10.48 },
    ],
    elevation_min: 840,
    elevation_max: 1260,
    elevation_profile: [840, 1020, 1260],
    quality_breakdown: {
      excellent: 60,
      good: 30,
      fair: 10,
      poor: 0,
      very_poor: 0,
    },
    active_hazards: [
      {
        id: "haz-1",
        hazard_type: "gravel",
        severity: "medium",
        note: "Loose gravel after the bend",
        photo_url: null,
        confirmations: 3,
        reporter: "Jane Rider",
        road_name: "Mock Ridge Road",
        lat: 46.5,
        lng: 10.4,
        created_at: "2026-05-10T10:00:00.000Z",
        expires_at: "2026-05-13T10:00:00.000Z",
      },
    ],
    active_hazard_count: 1,
    recent_reviews: [],
    review_count: 2,
    avg_review_rating: 4.5,
    riders_per_month: 12,
    quality_history: [
      { month: "2026-03", score: 4.1 },
      { month: "2026-04", score: 4.6 },
    ],
    regional_quality_history: [{ month: "2026-04", score: 3.8 }],
    ...overrides,
  };
}

describe("ExplorerPage", () => {
  beforeEach(() => {
    mockReplace.mockReset();
    mockQualityMap.mockClear();
    mockSearchParams.value = new URLSearchParams();
    window.localStorage.clear();
    resetMapStore();
    usePreferencesStore.setState({ unitSystem: "metric" });
    vi.mocked(roadsApi.getSegmentDetail).mockReset();
    apiGetMock.mockReset();
    flyToMock.mockReset();
    // Tests run against the authenticated explore path by default —
    // the search input only renders for signed-in riders (the public
    // geocode endpoint is AuthGuard-protected so we hide rather than
    // 401 on every keystroke).
    useAuthStore.setState({
      user: {
        id: "user-1",
        email: "rider@example.com",
        displayName: "Rider",
      },
      isAuthenticated: true,
      accessToken: "test-token",
    });
  });

  it("T29: picking an address-search result flies the map to the place (#573)", () => {
    render(<ExplorerPage />);

    // Pick a place from the (stubbed) address search field.
    fireEvent.click(screen.getByRole("button", { name: /address search/i }));

    // Camera fly: MapCanvas reads center/zoom only at init, so
    // a store-only update wouldn't move the visible map. Assert
    // the imperative `flyTo` fires on pick.
    expect(flyToMock).toHaveBeenCalledWith({
      lng: 19.973,
      lat: 49.165,
      zoom: 12,
    });

    // Store mirror still updates so a subsequent remount lands
    // at the picked place.
    const state = useMapStore.getState();
    expect(state.center).toEqual({ lng: 19.973, lat: 49.165 });
    expect(state.zoom).toBe(12);
  });

  it("hides the place search on the public explorer path (geocode is AuthGuard-protected)", () => {
    useAuthStore.setState({
      user: null,
      isAuthenticated: false,
      accessToken: null,
    });

    render(<ExplorerPage />);

    expect(
      screen.queryByRole("button", { name: /address search/i }),
    ).toBeNull();
  });

  it("fetches canonical detail and opens the segment sidebar when a map segment is selected", async () => {
    vi.mocked(roadsApi.getSegmentDetail).mockResolvedValueOnce({
      data: segmentDetail(),
    });

    render(<ExplorerPage />);

    fireEvent.click(
      screen.getByRole("button", { name: /select mock segment/i }),
    );

    await waitFor(() => {
      expect(roadsApi.getSegmentDetail).toHaveBeenCalledWith(
        "11111111-2222-4333-8444-555555555111",
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });

    await waitFor(() => {
      expect(screen.getAllByText("Mock Ridge Road").length).toBeGreaterThan(0);
    });
    expect(screen.getByText("4.6")).toBeInTheDocument();
    expect(screen.getAllByText(/asphalt/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/37 passes/i)).toBeInTheDocument();
    expect(
      screen.getByText(/loose gravel after the bend/i),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId(
        "segment-trend-chart-11111111-2222-4333-8444-555555555111",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Reviews panel for 11111111-2222-4333-8444-555555555111",
      ),
    ).toBeInTheDocument();
  });

  it("T27/T28: exposes regional closures and passes panels scoped to the explorer viewport", () => {
    render(<ExplorerPage />);

    fireEvent.click(
      screen.getByRole("button", { name: /report mock viewport/i }),
    );

    // Closures + Passes were previously always-rendered inside the
    // filter column; #570 moved them behind explicit toggles in the
    // top action row so the rider opts in when they want the data.
    fireEvent.click(screen.getByRole("button", { name: /^closures\s*$/i }));
    fireEvent.click(screen.getByRole("button", { name: /^passes\s*$/i }));

    expect(
      screen.getByText(/closures panel bbox=13\.1,48\.2,14\.9,49\.8/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/passes panel bbox=13\.1,48\.2,14\.9,49\.8/i),
    ).toBeInTheDocument();
    expect(screen.getAllByText(/routes=hidden/i)).toHaveLength(2);
  });

  it("keeps unrelated filter params stable while segment detail is open", async () => {
    mockSearchParams.value = new URLSearchParams("c=40");
    vi.mocked(roadsApi.getSegmentDetail).mockResolvedValueOnce({
      data: segmentDetail(),
    });

    render(<ExplorerPage />);

    fireEvent.click(
      screen.getByRole("button", { name: /select mock segment/i }),
    );

    await waitFor(() => {
      expect(screen.getAllByText("Mock Ridge Road").length).toBeGreaterThan(0);
    });

    expect(mockReplace).not.toHaveBeenCalledWith(
      expect.stringContaining("segment"),
      expect.anything(),
    );
  });

  it("formats segment length with the rider display unit preference", async () => {
    window.localStorage.setItem("tarmoto:preferences:unit-system", "imperial");
    usePreferencesStore.setState({ unitSystem: "imperial" });
    vi.mocked(roadsApi.getSegmentDetail).mockResolvedValueOnce({
      data: segmentDetail(),
    });

    render(<ExplorerPage />);

    fireEvent.click(
      screen.getByRole("button", { name: /select mock segment/i }),
    );

    await waitFor(() => {
      expect(screen.getAllByText(/MR-12 · 0.8 mi/i).length).toBeGreaterThan(0);
    });
  });
});
