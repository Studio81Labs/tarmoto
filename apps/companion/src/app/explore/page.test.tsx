import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { forwardRef, useImperativeHandle } from "react";
import ExplorerPage from "./page";
import { roadsApi } from "@/lib/api";
import type { RoadSegmentDetailResponse } from "@/lib/api";
import { useMapStore } from "@/stores/map";
import { useAuthStore } from "@/stores/auth";
import { DEFAULT_MAP_FILTERS, cloneFilters } from "@/lib/map-filters";
import { usePreferencesStore } from "@/stores/preferences";
import { FormatProvider } from "@/format/FormatProvider";

const mockReplace = vi.fn();
const mockSearchParams = vi.hoisted(() => ({
  value: new URLSearchParams(),
}));

type MockQualityMapProps = {
  showFunZones?: boolean;
  selectedFunZoneId?: string | null;
  onSegmentSelect?: (segmentId: string) => void;
  onRideSelect?: (rideId: string) => void;
  onViewChange?: (view: {
    lng: number;
    lat: number;
    zoom: number;
    bbox: [number, number, number, number];
  }) => void;
  onDrawnRegionChange?: (bbox: [number, number, number, number] | null) => void;
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
    <button type="button" onClick={() => props.onRideSelect?.("ride-9")}>
      Select mock ride
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
    <button
      type="button"
      onClick={() => props.onDrawnRegionChange?.([1.1, 2.2, 3.3, 4.4])}
    >
      Report mock draw region
    </button>
    <button type="button" onClick={() => props.onDrawnRegionChange?.(null)}>
      Clear mock draw region
    </button>
  </>
));

// Mock the public Fun Zones fetchers so the draw-region flow can assert the
// bbox the list is scoped to without a live backend.
const fetchFunZonesInBboxMock = vi.fn(
  async (
    _bbox: [number, number, number, number],
    _init?: { signal?: AbortSignal },
  ) => [] as never[],
);
vi.mock("@/lib/discover", () => ({
  fetchFunZonesInBbox: (
    bbox: [number, number, number, number],
    init?: { signal?: AbortSignal },
  ) => fetchFunZonesInBboxMock(bbox, init),
  fetchFunZoneDetail: vi.fn(async () => null),
}));

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
    {
      flyTo: (t: { lng: number; lat: number; zoom: number }) => void;
      startDrawRegion: () => void;
      cancelDrawRegion: () => void;
      clearDrawnRegion: () => void;
    },
    MockQualityMapProps
  >(function MockQualityMap(props, ref) {
    useImperativeHandle(
      ref,
      () => ({
        flyTo: flyToMock,
        startDrawRegion: () => {},
        cancelDrawRegion: () => {},
        clearDrawnRegion: () => {},
      }),
      [],
    );
    return mockQualityMap(props);
  }),
}));

// The "My trips" overlay hook needs a QueryClient; stub it (no trips) so the
// page renders without one, like the closures/passes panels are stubbed.
vi.mock("@/hooks/useUserTrips", () => ({
  useUserTrips: () => ({
    trips: [],
    loading: false,
    error: false,
    tripById: new Map(),
  }),
}));
vi.mock("@/hooks/useUserRideTracks", () => ({
  useUserRideTracks: () => ({
    tracks: [],
    truncated: false,
    loading: false,
    error: false,
  }),
}));
// `useFeatureGrantNonce` (called at the page top to refetch an open ride when
// advanced_ride_stats unlocks) reaches react-query via useEntitlements, which
// needs a QueryClient this test deliberately doesn't provide. Stub just that
// export — the mutable `grantNonce.value` lets a test drive a grant transition
// — and keep the rest real.
const grantNonce = vi.hoisted(() => ({ value: 0 }));
// `useSystemSwitch` (aerial-basemap kill switch) also reaches react-query; stub
// it with a mutable enabled flag so the aerial gate tests can drive it.
const aerialSwitch = vi.hoisted(() => ({ enabled: true }));
vi.mock("@/hooks", async (importActual) => ({
  ...(await importActual<typeof import("@/hooks")>()),
  useFeatureGrantNonce: () => grantNonce.value,
  useSystemSwitch: () => ({
    enabled: aerialSwitch.enabled,
    isResolved: true,
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
    showConditionsLayer: false,
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
    quality_source: null,
    osm_quality_seed: null,
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
    grantNonce.value = 0;
    aerialSwitch.enabled = true;
    flyToMock.mockReset();
    fetchFunZonesInBboxMock.mockClear();
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

  it("honours legacy /discover deep-link params: camera + zone open the Fun Zones overlay, then the params are stripped", () => {
    window.history.replaceState(
      {},
      "",
      "/explore?lng=18.26&lat=49.82&z=10&zone=zone-42",
    );
    render(<ExplorerPage />);

    expect(flyToMock).toHaveBeenCalledWith({
      lng: 18.26,
      lat: 49.82,
      zoom: 10,
    });
    const props = mockQualityMap.mock.lastCall?.[0] as MockQualityMapProps;
    expect(props.showFunZones).toBe(true);
    expect(props.selectedFunZoneId).toBe("zone-42");
    // One-shot params are stripped so refresh/share doesn't replay them.
    expect(window.location.search).not.toContain("zone");
    expect(window.location.search).not.toContain("lng");
    window.history.replaceState({}, "", "/explore");
  });

  it("leaves the Fun Zones overlay off on a bare /explore visit", () => {
    window.history.replaceState({}, "", "/explore");
    render(<ExplorerPage />);
    const props = mockQualityMap.mock.lastCall?.[0] as MockQualityMapProps;
    expect(props.showFunZones).toBe(false);
    expect(flyToMock).not.toHaveBeenCalled();
  });

  it("shows the aerial basemap toggle and switches the map to aerial when sys_aerial_basemap is on", () => {
    render(<ExplorerPage />);
    expect(screen.getByRole("group", { name: "Basemap" })).toBeInTheDocument();
    expect(
      (mockQualityMap.mock.lastCall?.[0] as { basemap?: string }).basemap,
    ).toBe("map");
    fireEvent.click(screen.getByRole("button", { name: "Aerial" }));
    expect(
      (mockQualityMap.mock.lastCall?.[0] as { basemap?: string }).basemap,
    ).toBe("aerial");
  });

  it("hides the aerial toggle and forces the base map to 'map' when sys_aerial_basemap is killed mid-session", () => {
    const { rerender } = render(<ExplorerPage />);
    // Rider had selected aerial…
    fireEvent.click(screen.getByRole("button", { name: "Aerial" }));
    expect(
      (mockQualityMap.mock.lastCall?.[0] as { basemap?: string }).basemap,
    ).toBe("aerial");

    // …then the operator kills sys_aerial_basemap (WMTS outage).
    aerialSwitch.enabled = false;
    rerender(<ExplorerPage />);

    // Toggle gone; base map reverts to "map" despite the stale "aerial" state.
    expect(
      screen.queryByRole("group", { name: "Basemap" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Aerial" }),
    ).not.toBeInTheDocument();
    expect(
      (mockQualityMap.mock.lastCall?.[0] as { basemap?: string }).basemap,
    ).toBe("map");
  });

  it("scopes the Fun Zones fetch to a drawn region, then reverts on clear", async () => {
    // ?zones=1 opens the overlay on mount (legacy /discover deep link).
    window.history.replaceState({}, "", "/explore?zones=1");
    render(<ExplorerPage />);

    // A reported viewport scopes the initial fetch.
    fireEvent.click(
      screen.getByRole("button", { name: "Report mock viewport" }),
    );
    await waitFor(() =>
      expect(fetchFunZonesInBboxMock).toHaveBeenLastCalledWith(
        [13.1, 48.2, 14.9, 49.8],
        expect.anything(),
      ),
    );

    // Drawing a region re-scopes the fetch to that box.
    fireEvent.click(
      screen.getByRole("button", { name: "Report mock draw region" }),
    );
    await waitFor(() =>
      expect(fetchFunZonesInBboxMock).toHaveBeenLastCalledWith(
        [1.1, 2.2, 3.3, 4.4],
        expect.anything(),
      ),
    );

    // Clearing the region reverts to the viewport bbox.
    fireEvent.click(
      screen.getByRole("button", { name: "Clear mock draw region" }),
    );
    await waitFor(() =>
      expect(fetchFunZonesInBboxMock).toHaveBeenLastCalledWith(
        [13.1, 48.2, 14.9, 49.8],
        expect.anything(),
      ),
    );
  });

  it("narrow viewport: arming Draw region steps the overlay aside for a cancellable draw", async () => {
    // Stub matchMedia to report a narrow viewport *with* a fine pointer
    // (a small desktop window / mouse) — the case where the overlay variant
    // renders and the drag-based draw control is still offered.
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({
        matches: query.includes("any-pointer: fine"),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    );
    try {
      window.history.replaceState({}, "", "/explore?zones=1");
      render(<ExplorerPage />);

      // The overlay renders its Draw region control.
      const drawBtn = await screen.findByRole("button", {
        name: /^draw region$/i,
      });

      // Arming the draw hides the map-covering overlay (so the rider can drag)
      // and surfaces a floating cancel affordance instead.
      fireEvent.click(drawBtn);
      expect(
        screen.getByText(/drag on the map to draw a region/i),
      ).toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: /^draw region$/i }),
      ).toBeNull();

      // Cancel restores the overlay without committing a box.
      fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));
      expect(
        await screen.findByRole("button", { name: /^draw region$/i }),
      ).toBeInTheDocument();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("touch-only device: hides the drag-based Draw region control", async () => {
    // No fine pointer: the drag-only control can't complete a box, so the
    // sidebar offers the zone list without a Draw region button.
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    );
    try {
      window.history.replaceState({}, "", "/explore?zones=1");
      render(<ExplorerPage />);
      // The Fun Zones block still renders (its empty state is present)…
      expect(
        await screen.findByText(/no fun zones in view/i),
      ).toBeInTheDocument();
      // …but no draw affordance.
      expect(
        screen.queryByRole("button", { name: /^draw region$/i }),
      ).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
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
    expect(screen.getByText(/3 confirmations$/i)).toBeInTheDocument();
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

  it("consumes the grant nonce while no ride is open so the next selection isn't silently misclassified", async () => {
    // advanced_ride_stats unlocks while NO ride drawer is open. The nonce bumps,
    // but with nothing selected the fetch effect must still consume it — else
    // the next ride click is misread as a silent grant-refetch (no loading,
    // errors swallowed), leaving the click with no drawer or feedback.
    const { rerender } = render(<ExplorerPage />);

    // The grant lands with no drawer open; re-render so the page reads it.
    grantNonce.value = 1;
    rerender(<ExplorerPage />);

    // Now open a ride whose fetch FAILS. With the nonce correctly consumed this
    // is a normal (non-silent) open, so the error surfaces in the drawer rather
    // than being swallowed.
    apiGetMock.mockRejectedValueOnce(new Error("offline"));
    fireEvent.click(screen.getByRole("button", { name: /select mock ride/i }));

    expect(
      await screen.findByText("Could not load this ride"),
    ).toBeInTheDocument();
  });

  it("does not strand the ride drawer on loading when the flag unlocks mid-load", async () => {
    // The first ride request is still pending when advanced_ride_stats unlocks.
    // The nonce bump must NOT be silenced as an enrichment (no ready ride yet) —
    // otherwise the follow-up load, if it fails, would swallow the error and
    // leave the drawer stuck on its loading snapshot.
    apiGetMock
      .mockReturnValueOnce(new Promise(() => {})) // first load: never resolves
      .mockRejectedValueOnce(new Error("offline")); // grant reload: fails

    const { rerender } = render(<ExplorerPage />);
    fireEvent.click(screen.getByRole("button", { name: /select mock ride/i }));

    // Drawer is loading while the first request is pending.
    expect(
      await screen.findByText("Fetching the route and ride stats."),
    ).toBeInTheDocument();

    // The flag unlocks mid-load: the nonce bumps and the effect re-fetches.
    grantNonce.value = 1;
    rerender(<ExplorerPage />);

    // The follow-up runs as a NORMAL load (no ready ride to enrich), so its
    // failure surfaces an error rather than stranding the loading state.
    expect(
      await screen.findByText("Could not load this ride"),
    ).toBeInTheDocument();
  });

  it("uses singular confirmation copy for one hazard confirmation", async () => {
    const detail = segmentDetail();
    vi.mocked(roadsApi.getSegmentDetail).mockResolvedValueOnce({
      data: {
        ...detail,
        active_hazards: detail.active_hazards.map((hazard) => ({
          ...hazard,
          confirmations: 1,
        })),
      },
    });

    render(<ExplorerPage />);
    fireEvent.click(
      screen.getByRole("button", { name: /select mock segment/i }),
    );

    expect(await screen.findByText(/1 confirmation$/i)).toBeInTheDocument();
    expect(screen.queryByText(/1 confirmations$/i)).toBeNull();
  });

  it("T27/T28: exposes regional closures and passes panels scoped to the explorer viewport", () => {
    render(<ExplorerPage />);

    fireEvent.click(
      screen.getByRole("button", { name: /report mock viewport/i }),
    );

    // Closures + Passes were previously always-rendered inside the filter
    // column; #570 moved them behind toggles in the top action row, and the
    // map-points unification collapsed the two pills into one "Conditions"
    // toggle that opens both panels together.
    fireEvent.click(screen.getByRole("button", { name: /^conditions\s*$/i }));

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
    // `useFormat()` only reflects the store's `unitSystem` inside a
    // `FormatProvider` — SegmentDetailSidebar's own `hydratePreferences()`
    // mount effect still reads localStorage into the (global) preferences
    // store, and the provider here relays that into the format seam,
    // mirroring the real app shell.
    window.localStorage.setItem("tarmoto:preferences:unit-system", "imperial");
    usePreferencesStore.setState({ unitSystem: "imperial" });
    vi.mocked(roadsApi.getSegmentDetail).mockResolvedValueOnce({
      data: segmentDetail(),
    });

    render(
      <FormatProvider formatLocale="en" timeZone="UTC" units="metric">
        <ExplorerPage />
      </FormatProvider>,
    );

    fireEvent.click(
      screen.getByRole("button", { name: /select mock segment/i }),
    );

    await waitFor(() => {
      expect(screen.getAllByText(/MR-12 · 0.8 mi/i).length).toBeGreaterThan(0);
    });
  });
});
