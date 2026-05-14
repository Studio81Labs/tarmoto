import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import ExplorerPage from "./page";
import { roadsApi } from "@/lib/api";
import { useMapStore } from "@/stores/map";
import { DEFAULT_MAP_FILTERS, cloneFilters } from "@/lib/map-filters";
import { usePreferencesStore } from "@/stores/preferences";

const mockReplace = vi.fn();
const mockSearchParams = vi.hoisted(() => ({
  value: new URLSearchParams(),
}));

const mockQualityMap = vi.fn(
  (props: { onSegmentSelect?: (segmentId: string) => void }) => (
    <button
      type="button"
      onClick={() =>
        props.onSegmentSelect?.("11111111-2222-4333-8444-555555555111")
      }
    >
      Select mock segment
    </button>
  ),
);

vi.mock("next/navigation", () => ({
  usePathname: () => "/explore",
  useRouter: () => ({ replace: mockReplace }),
  useSearchParams: () => mockSearchParams.value,
}));

vi.mock("./_components/QualityMap", () => ({
  QualityMap: (props: { onSegmentSelect?: (segmentId: string) => void }) =>
    mockQualityMap(props),
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

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    roadsApi: {
      ...actual.roadsApi,
      getSegmentDetail: vi.fn(),
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
    filters: cloneFilters(DEFAULT_MAP_FILTERS),
  });
}

function segmentDetail(overrides: Record<string, unknown> = {}) {
  return {
    id: "11111111-2222-4333-8444-555555555111",
    road_name: "Mock Ridge Road",
    road_number: "MR-12",
    quality_score: 4.6,
    curviness_score: 82,
    surface_type: "asphalt",
    length_m: 1240,
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

    expect(
      screen.getByText(/closures panel bbox=17\.557,49\.644,18\.963,49\.996/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/passes panel bbox=17\.557,49\.644,18\.963,49\.996/i),
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
