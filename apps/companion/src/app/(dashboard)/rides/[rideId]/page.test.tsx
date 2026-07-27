import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import RideDetailPage from "./page";
import { api } from "@/lib/api";
import { useAuthStore } from "@/stores/auth";

let routeRideId = "ride-1";
let routePathname = "/rides/ride-1";

const mockedRideRouteMap = vi.fn((props: { label?: string }) => (
  <div data-testid="ride-route-map">{props.label ?? "Ride route map"}</div>
));

// Unlike Next's real notFound() this records the call WITHOUT throwing:
// jsdom has no not-found boundary, so the real sentinel would escape React
// as an unhandled error and fail the run. Both pages fall through to their
// error branch after a no-op notFound(), so rendering stays safe.
const mockNotFound = vi.fn();
// `useRouter` is needed by `UpgradePrompt` (rendered inside the locked
// advanced-ride-stats teasers) — its CTA pushes to /settings/subscription.
vi.mock("next/navigation", () => ({
  useParams: () => ({ rideId: routeRideId }),
  usePathname: () => routePathname,
  useRouter: () => ({ push: vi.fn() }),
  notFound: () => mockNotFound(),
}));

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    api: {
      ...actual.api,
      GET: vi.fn(),
      PATCH: vi.fn(),
      POST: vi.fn(),
    },
  };
});

vi.mock("../_components/RideRouteMap", () => ({
  RideRouteMap: (props: { label?: string }) => mockedRideRouteMap(props),
}));

// RideExportMenu (rendered in this page's header) and the advanced-ride-stats
// gate (Max lean / Ascent tiles, elevation profile card, ride-dynamics card,
// per-segment LEAN column) all call useFeature/useEntitlements, which hit
// react-query — mock the barrel so it doesn't need a QueryClient. Default:
// entitled for every key, so the pre-gate assertions (export menu + real
// lean/elevation values) are unchanged unless a test overrides per-key below.
// `dataUpdatedAt > 0` marks "a snapshot has resolved at least once" — the
// signal `advancedStatsLocked` trusts through a later refetch error. The
// wrapper defaults it to 1 (resolved); the never-resolved gating tests set it
// to 0 explicitly.
const useFeatureMock = vi.fn(
  (
    _key: string,
  ): {
    enabled: boolean;
    isLoading: boolean;
    isSuccess: boolean;
    isError?: boolean;
    dataUpdatedAt?: number;
  } => ({
    enabled: true,
    isLoading: false,
    isSuccess: true,
  }),
);
const useEntitlementsMock = vi.fn<() => { tier: string | null }>(() => ({
  tier: "free",
}));
// A counter the grant-refetch test bumps to simulate advanced_ride_stats
// unlocking while the page stays mounted (see useFeatureGrantNonce).
const useFeatureGrantNonceMock = vi.fn<() => number>(() => 0);
vi.mock("@/hooks", () => ({
  useFeature: (key: string) => {
    const r = useFeatureMock(key);
    return {
      isError: false,
      ...r,
      // Default to a resolved snapshot (dataUpdatedAt > 0) unless a test opts
      // into the never-resolved case with an explicit 0.
      dataUpdatedAt: r.dataUpdatedAt ?? 1,
    };
  },
  useEntitlements: () => useEntitlementsMock(),
  useFeatureGrantNonce: () => useFeatureGrantNonceMock(),
}));

function ride(overrides: Record<string, unknown> = {}) {
  return {
    id: "ride-1",
    name: null,
    status: "completed",
    ride_type: "trip",
    started_at: "2026-05-01T08:00:00.000Z",
    ended_at: "2026-05-01T10:00:00.000Z",
    distance_km: 120,
    duration_min: 120,
    avg_speed: 60,
    max_speed: 95,
    avg_road_quality: 4.1,
    elevation_gain: 700,
    elevation_loss: 650,
    curve_count: 140,
    max_lean_angle: 34,
    fuel_estimate_l: 5.2,
    lean_distribution: { "0_10": 10, "10_20": 20, "20_30": 40, "30_plus": 30 },
    route_geometry: [
      { lat: 49.1, lng: 16.6 },
      { lat: 49.2, lng: 16.8 },
    ],
    segments: [
      {
        road_segment_id: "seg-1",
        road_name: "Ridge Road",
        quality_reading: 4.4,
        speed_avg: 58,
        speed_max: 86,
        lean_angle_max: 22,
      },
      {
        road_segment_id: "seg-2",
        road_name: "Forest Run",
        quality_reading: 3.6,
        speed_avg: 72,
        speed_max: 98,
        lean_angle_max: 31,
      },
    ],
    viewer_is_owner: true,
    rider_id: "rider-1",
    rider_name: "John Rider",
    rider_avatar_url: null,
    share_token: "tok-public",
    ...overrides,
  };
}

describe("RideDetailPage", () => {
  beforeEach(() => {
    routeRideId = "ride-1";
    routePathname = "/rides/ride-1";
    mockedRideRouteMap.mockClear();
    vi.mocked(api.GET).mockReset();
    vi.mocked(api.PATCH).mockReset();
    vi.mocked(api.POST).mockReset();
    useFeatureMock.mockReset();
    useFeatureMock.mockImplementation(() => ({
      enabled: true,
      isLoading: false,
      isSuccess: true,
    }));
    useEntitlementsMock.mockReset();
    useEntitlementsMock.mockReturnValue({ tier: "free" });
    useFeatureGrantNonceMock.mockReset();
    useFeatureGrantNonceMock.mockReturnValue(0);
    useAuthStore.setState({
      accessToken: "test-token",
      isAuthenticated: true,
      user: {
        id: "user-1",
        email: "rider@example.com",
        displayName: "Test Rider",
      },
    });
  });

  it("renders the v2 detail: breadcrumb, map, stat tiles, elevation, dynamics, segments", async () => {
    vi.mocked(api.GET).mockResolvedValueOnce({
      data: ride(),
      response: { status: 200 },
    } as unknown as Awaited<ReturnType<typeof api.GET>>);

    render(<RideDetailPage />);

    // Breadcrumb back to the list.
    expect(
      await screen.findByRole("link", { name: /Ride History · All rides/i }),
    ).toHaveAttribute("href", "/rides");

    // The byline shows for every ride, including your own, and links to the
    // rider's community profile.
    expect(
      screen.getByRole("link", { name: /by John Rider/i }),
    ).toHaveAttribute("href", "/community/rider-1");

    // Route map gets the geometry.
    expect(screen.getByTestId("ride-route-map")).toBeInTheDocument();
    expect(mockedRideRouteMap).toHaveBeenCalledWith(
      expect.objectContaining({
        geometry: [
          { lat: 49.1, lng: 16.6 },
          { lat: 49.2, lng: 16.8 },
        ],
      }),
    );

    // Stat tiles (distance/avg speed/max lean/ascent).
    expect(screen.getByText("120")).toBeInTheDocument();
    expect(screen.getByText("60")).toBeInTheDocument();
    expect(screen.getByText("34°")).toBeInTheDocument();

    // Elevation summary uses the totals (per-sample profile not recorded).
    expect(screen.getByText("Climb & descent")).toBeInTheDocument();
    expect(screen.getByText("+700 m")).toBeInTheDocument();
    expect(screen.getByText("−650 m")).toBeInTheDocument();
    // Net change: 700 - 650 = +50, formatted once via `format.splitElevation`
    // rather than subtracting two already-formatted display strings.
    expect(screen.getByText("+50 m")).toBeInTheDocument();

    // Speed profile (US-48): the per-segment speed graph renders for rides
    // with segment telemetry.
    expect(
      screen.getByRole("img", { name: /ride speed graph/i }),
    ).toBeInTheDocument();

    // Lean dynamics: avg lean derived from the histogram (weighted 24°).
    expect(screen.getByText("Time spent leaning")).toBeInTheDocument();
    expect(screen.getByText("24°")).toBeInTheDocument();

    // Road segments table.
    expect(screen.getByText("2 roads ridden")).toBeInTheDocument();
    expect(screen.getByText("Ridge Road")).toBeInTheDocument();
    expect(screen.getByText("Forest Run")).toBeInTheDocument();
  });

  it("keeps one decimal for a positive integer fuel estimate", async () => {
    vi.mocked(api.GET).mockResolvedValueOnce({
      data: ride({ fuel_estimate_l: 4 }),
      response: { status: 200 },
    } as unknown as Awaited<ReturnType<typeof api.GET>>);

    render(<RideDetailPage />);

    expect(await screen.findByText("4.0L")).toBeInTheDocument();
  });

  it("renames the ride via PATCH and reflects the new name", async () => {
    vi.mocked(api.GET).mockResolvedValueOnce({
      data: ride({ name: null }),
      response: { status: 200 },
    } as unknown as Awaited<ReturnType<typeof api.GET>>);
    vi.mocked(api.PATCH).mockResolvedValueOnce({
      data: { ...ride(), name: "Sunday loop" },
      error: undefined,
    } as unknown as Awaited<ReturnType<typeof api.PATCH>>);

    render(<RideDetailPage />);

    // Unnamed ride falls back to the date label; the rename control exists.
    await screen.findByText(/Ride on/);
    fireEvent.click(screen.getByRole("button", { name: "Rename ride" }));
    const input = screen.getByRole("textbox", { name: "Ride name" });
    fireEvent.change(input, { target: { value: "Sunday loop" } });
    fireEvent.click(screen.getByRole("button", { name: "Save name" }));

    await waitFor(() =>
      expect(vi.mocked(api.PATCH)).toHaveBeenCalledWith(
        "/api/v1/rides/{rideId}",
        expect.objectContaining({
          params: { path: { rideId: "ride-1" } },
          body: { name: "Sunday loop" },
        }),
      ),
    );
    expect(
      await screen.findByRole("heading", { name: "Sunday loop" }),
    ).toBeInTheDocument();
  });

  it("offers Compare / Share / Export actions in the header", async () => {
    vi.mocked(api.GET).mockResolvedValueOnce({
      data: ride(),
      response: { status: 200 },
    } as unknown as Awaited<ReturnType<typeof api.GET>>);

    render(<RideDetailPage />);

    expect(
      await screen.findByRole("link", { name: /Compare/i }),
    ).toHaveAttribute("href", "/rides/compare?a=ride-1");
    expect(screen.getByRole("button", { name: /Share/i })).toBeInTheDocument();
    // Export is a single trigger that opens a CSV / GPX menu.
    const exportTrigger = screen.getByRole("button", { name: "Export" });
    expect(exportTrigger).toBeInTheDocument();
    fireEvent.click(exportTrigger);
    expect(screen.getByRole("menuitem", { name: /CSV/i })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /GPX/i })).toBeInTheDocument();
  });

  it("Share copies the public no-auth share link, not the dashboard URL", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    vi.mocked(api.GET).mockResolvedValueOnce({
      data: ride(),
      response: { status: 200 },
    } as unknown as Awaited<ReturnType<typeof api.GET>>);

    render(<RideDetailPage />);

    fireEvent.click(await screen.findByRole("button", { name: /Share/i }));

    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(
        expect.stringContaining("/rides/shared/tok-public"),
      ),
    );
    // It must not copy the auth-gated dashboard URL.
    expect(writeText).not.toHaveBeenCalledWith(
      expect.stringContaining("/rides/ride-1"),
    );
  });

  it("Share creates a link-only share when the owner's ride isn't shared yet", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    vi.mocked(api.GET).mockResolvedValueOnce({
      data: ride({ share_token: null }),
      response: { status: 200 },
    } as unknown as Awaited<ReturnType<typeof api.GET>>);
    vi.mocked(api.POST).mockResolvedValueOnce({
      data: { share_token: "tok-new" },
      error: undefined,
    } as unknown as Awaited<ReturnType<typeof api.POST>>);

    render(<RideDetailPage />);

    fireEvent.click(await screen.findByRole("button", { name: /Share/i }));

    await waitFor(() =>
      expect(vi.mocked(api.POST)).toHaveBeenCalledWith(
        "/api/v1/rides/{rideId}/share",
        expect.objectContaining({
          params: { path: { rideId: "ride-1" } },
          body: { is_public: false },
        }),
      ),
    );
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(
        expect.stringContaining("/rides/shared/tok-new"),
      ),
    );
  });

  it.each([[404], [400]])(
    "routes a backend %i to the app-level not-found screen",
    async (status) => {
      routePathname = "/community/rides/ride-1";
      vi.mocked(api.GET).mockResolvedValueOnce({
        data: null,
        error: undefined,
        response: { status },
      } as unknown as Awaited<ReturnType<typeof api.GET>>);

      render(<RideDetailPage />);
      await waitFor(() => {
        expect(mockNotFound).toHaveBeenCalled();
      });
    },
  );

  it("renders read-only for a community ride viewed by a non-owner", async () => {
    // Opened under the community route, so the back link returns to the feed.
    routePathname = "/community/rides/ride-1";
    vi.mocked(api.GET).mockResolvedValueOnce({
      data: ride({
        name: "Stelvio loop",
        viewer_is_owner: false,
        rider_id: "owner-7",
        rider_name: "Matteo Ferri",
      }),
      response: { status: 200 },
    } as unknown as Awaited<ReturnType<typeof api.GET>>);

    render(<RideDetailPage />);

    expect(await screen.findByText("Stelvio loop")).toBeInTheDocument();
    // Owner-only actions are hidden; sharing the link stays available.
    expect(
      screen.queryByRole("button", { name: "Rename ride" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Compare/i })).toBeNull();
    expect(screen.queryByRole("button", { name: "Export" })).toBeNull();
    expect(screen.getByRole("button", { name: /Share/i })).toBeInTheDocument();
    // Attribution links to the owner's profile; back link goes to the feed.
    expect(screen.getByRole("link", { name: /Matteo Ferri/i })).toHaveAttribute(
      "href",
      "/community/owner-7",
    );
    expect(
      screen.getByRole("link", { name: /Community · Feed/i }),
    ).toHaveAttribute("href", "/community/feed");
  });

  it("degrades unbacked sections without GPS or lean samples", async () => {
    vi.mocked(api.GET).mockResolvedValueOnce({
      data: ride({
        route_geometry: null,
        lean_distribution: null,
        segments: [],
      }),
      response: { status: 200 },
    } as unknown as Awaited<ReturnType<typeof api.GET>>);

    render(<RideDetailPage />);

    await waitFor(() => {
      expect(screen.queryByText(/loading ride/i)).not.toBeInTheDocument();
    });
    expect(screen.queryByTestId("ride-route-map")).not.toBeInTheDocument();
    expect(
      screen.getByText("No GPS track was recorded for this ride."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("No lean samples were recorded for this ride."),
    ).toBeInTheDocument();
    // No segments → no segments table.
    expect(screen.queryByText(/roads ridden/i)).not.toBeInTheDocument();
  });

  it("renders quality bars for the average road quality", async () => {
    vi.mocked(api.GET).mockResolvedValueOnce({
      data: ride(),
      response: { status: 200 },
    } as unknown as Awaited<ReturnType<typeof api.GET>>);

    render(<RideDetailPage />);

    // avg_road_quality 4.1 → tier 4 (also rendered per quality segment).
    const heading = await screen.findByRole("heading", { level: 1 });
    expect(heading).toBeInTheDocument();
    expect(screen.getAllByLabelText("Quality 4 of 5").length).toBeGreaterThan(
      0,
    );
  });

  // advanced_ride_stats (Pro): lean angle / elevation gain-loss / lean
  // distribution are display-gated — locked teaser tiles + upsell instead of
  // the (backend-nulled) real values, never a blank gap.
  describe("advanced_ride_stats gating", () => {
    it("renders the real lean/elevation/lean-distribution values when entitled", async () => {
      // Default beforeEach mock is already entitled — this pins the contract
      // explicitly rather than relying only on the general detail test above.
      vi.mocked(api.GET).mockResolvedValueOnce({
        data: ride(),
        response: { status: 200 },
      } as unknown as Awaited<ReturnType<typeof api.GET>>);

      render(<RideDetailPage />);

      expect(await screen.findByText("34°")).toBeInTheDocument(); // Max lean tile
      expect(screen.getByText("+700 m")).toBeInTheDocument(); // Elevation profile
      expect(screen.getByText("−650 m")).toBeInTheDocument();
      // Unsigned descent in the "Conditions & setup" card — a SECOND render of
      // elevation_loss that must also be gated.
      expect(screen.getByText("650 m")).toBeInTheDocument();
      expect(screen.getByText("24°")).toBeInTheDocument(); // Avg lean (dynamics card)
      expect(screen.getByText("22°")).toBeInTheDocument(); // Per-segment LEAN column
      expect(screen.getByText("31°")).toBeInTheDocument();
      expect(screen.queryByText("Upgrade to Pro")).not.toBeInTheDocument();
    });

    it("locks lean/elevation/lean-distribution behind a Pro teaser when not entitled", async () => {
      useFeatureMock.mockImplementation((key: string) =>
        key === "advanced_ride_stats"
          ? { enabled: false, isLoading: false, isSuccess: true }
          : { enabled: true, isLoading: false, isSuccess: true },
      );
      vi.mocked(api.GET).mockResolvedValueOnce({
        data: ride(),
        response: { status: 200 },
      } as unknown as Awaited<ReturnType<typeof api.GET>>);

      render(<RideDetailPage />);

      await screen.findByText("Climb & descent");

      // Real paid values are gone everywhere they'd otherwise render.
      expect(screen.queryByText("34°")).not.toBeInTheDocument(); // Max lean tile
      expect(screen.queryByText("+700 m")).not.toBeInTheDocument(); // Elevation card
      expect(screen.queryByText("−650 m")).not.toBeInTheDocument();
      // The duplicate unsigned descent in "Conditions & setup" is gated too.
      expect(screen.queryByText("650 m")).not.toBeInTheDocument();
      expect(screen.queryByText("24°")).not.toBeInTheDocument(); // Avg lean
      expect(screen.queryByText("22°")).not.toBeInTheDocument(); // Segment LEAN col
      expect(screen.queryByText("31°")).not.toBeInTheDocument();

      // Locked teasers + a single-CTA upsell are present instead.
      expect(screen.getAllByText("Pro").length).toBeGreaterThan(0);
      expect(
        screen.getAllByRole("button", { name: /Upgrade to Pro/i }).length,
      ).toBeGreaterThan(0);

      // Non-paid stats are unaffected.
      expect(screen.getByText("120")).toBeInTheDocument(); // Distance
    });

    it("fails closed to the same locked teaser while advanced_ride_stats is still resolving", async () => {
      useFeatureMock.mockImplementation((key: string) =>
        key === "advanced_ride_stats"
          ? {
              enabled: false,
              isLoading: true,
              isSuccess: false,
              dataUpdatedAt: 0, // never resolved
            }
          : { enabled: true, isLoading: false, isSuccess: true },
      );
      // Unresolved entitlements: the snapshot hasn't succeeded yet, so tier
      // is also unknown — the locked card must not offer a dead-end CTA
      // without a known upgrade target.
      useEntitlementsMock.mockReturnValue({ tier: null });
      vi.mocked(api.GET).mockResolvedValueOnce({
        data: ride(),
        response: { status: 200 },
      } as unknown as Awaited<ReturnType<typeof api.GET>>);

      render(<RideDetailPage />);

      await screen.findByText("Climb & descent");

      expect(screen.queryByText("34°")).not.toBeInTheDocument();
      expect(screen.queryByText("+700 m")).not.toBeInTheDocument();
      expect(screen.queryByText("24°")).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: /Upgrade to Pro/i }),
      ).not.toBeInTheDocument();
    });

    it("defers to the backend payload when the entitlement query errored", async () => {
      // /users/me failed → isError. The ride endpoint already gated the fields
      // server-side, so an entitled rider whose refetch failed must keep seeing
      // the REAL values, not be flipped to a paywall teaser.
      useFeatureMock.mockImplementation((key: string) =>
        key === "advanced_ride_stats"
          ? {
              enabled: false,
              isLoading: false,
              isSuccess: false,
              isError: true,
              dataUpdatedAt: 0, // never resolved → defer to the backend payload
            }
          : { enabled: true, isLoading: false, isSuccess: true },
      );
      vi.mocked(api.GET).mockResolvedValueOnce({
        data: ride(),
        response: { status: 200 },
      } as unknown as Awaited<ReturnType<typeof api.GET>>);

      render(<RideDetailPage />);

      expect(await screen.findByText("+700 m")).toBeInTheDocument();
      expect(screen.getByText("−650 m")).toBeInTheDocument();
      expect(screen.getByText("34°")).toBeInTheDocument();
      // No paywall teaser CTA when the entitlement query merely errored.
      expect(
        screen.queryByRole("button", { name: /Upgrade to Pro/i }),
      ).not.toBeInTheDocument();
    });

    it("keeps a cached DENIAL locked when a later refetch errors (retained disabled snapshot)", async () => {
      // A prior snapshot resolved DISABLED (dataUpdatedAt > 0), then a later
      // /users/me refetch failed (isError) while React Query retained that
      // disabled snapshot. The retained payload still holds real advanced
      // values (fetched while entitled earlier), but the last KNOWN entitlement
      // is denial — the tiles must stay LOCKED, not re-expose the paid values.
      useFeatureMock.mockImplementation((key: string) =>
        key === "advanced_ride_stats"
          ? {
              enabled: false,
              isLoading: false,
              isSuccess: false,
              isError: true,
              dataUpdatedAt: 5, // a snapshot resolved before the error
            }
          : { enabled: true, isLoading: false, isSuccess: true },
      );
      vi.mocked(api.GET).mockResolvedValueOnce({
        data: ride(), // payload still carries the real advanced values
        response: { status: 200 },
      } as unknown as Awaited<ReturnType<typeof api.GET>>);

      render(<RideDetailPage />);

      await screen.findByText("Climb & descent");
      // The retained denial keeps the paid values hidden despite the error.
      expect(screen.queryByText("34°")).not.toBeInTheDocument();
      expect(screen.queryByText("+700 m")).not.toBeInTheDocument();
      expect(screen.queryByText("24°")).not.toBeInTheDocument();
      // Non-paid stats still render.
      expect(screen.getByText("120")).toBeInTheDocument();
    });

    it("silently refetches the ride when advanced_ride_stats unlocks mid-view", async () => {
      // Locked first: the backend nulls the paid fields for this request, so the
      // initial payload has no lean/elevation values.
      const nulled = ride({
        max_lean_angle: null,
        elevation_gain: null,
        elevation_loss: null,
        lean_distribution: null,
        segments: [],
      });
      useFeatureMock.mockImplementation((key: string) =>
        key === "advanced_ride_stats"
          ? { enabled: false, isLoading: false, isSuccess: true }
          : { enabled: true, isLoading: false, isSuccess: true },
      );
      vi.mocked(api.GET)
        .mockResolvedValueOnce({
          data: nulled,
          response: { status: 200 },
        } as unknown as Awaited<ReturnType<typeof api.GET>>)
        .mockResolvedValueOnce({
          data: ride(),
          response: { status: 200 },
        } as unknown as Awaited<ReturnType<typeof api.GET>>);

      const { rerender } = render(<RideDetailPage />);

      // Locked teaser — the backend-nulled payload has no real values.
      await screen.findByText("Climb & descent");
      expect(screen.queryByText("34°")).not.toBeInTheDocument();
      expect(vi.mocked(api.GET)).toHaveBeenCalledTimes(1);

      // Access is granted while the page stays mounted: the flag flips enabled
      // and the grant nonce bumps, re-arming the fetch.
      useFeatureMock.mockImplementation(() => ({
        enabled: true,
        isLoading: false,
        isSuccess: true,
      }));
      useFeatureGrantNonceMock.mockReturnValue(1);
      rerender(<RideDetailPage />);

      // The silent refetch pulls the now-populated payload — real values fill in
      // without the rider reloading, and it took a second GET to do it.
      expect(await screen.findByText("34°")).toBeInTheDocument();
      expect(screen.getByText("+700 m")).toBeInTheDocument();
      expect(vi.mocked(api.GET)).toHaveBeenCalledTimes(2);
    });

    it("does not get stuck on the skeleton when the flag unlocks during the initial load", async () => {
      // The first request is still pending when the flag unlocks. The nonce
      // bump must NOT be treated as a silent enrichment (there's no ride on
      // screen yet) — otherwise the follow-up load, though it setRide()s, would
      // never clear `loading` and the page would sit on the skeleton forever.
      let resolveFirst: (v: unknown) => void = () => {};
      const firstPending = new Promise((resolve) => {
        resolveFirst = resolve;
      });
      vi.mocked(api.GET)
        .mockReturnValueOnce(
          firstPending as unknown as ReturnType<typeof api.GET>,
        )
        .mockResolvedValueOnce({
          data: ride(),
          response: { status: 200 },
        } as unknown as Awaited<ReturnType<typeof api.GET>>);

      const { rerender } = render(<RideDetailPage />);
      // No ride content yet — the first load is pending.
      expect(screen.queryByText("Climb & descent")).not.toBeInTheDocument();

      // The flag unlocks mid-load: the nonce bumps and the effect re-fetches.
      useFeatureGrantNonceMock.mockReturnValue(1);
      rerender(<RideDetailPage />);

      // The follow-up load resolves as a NORMAL load: content renders and the
      // skeleton clears (it isn't silenced into a permanent loading state).
      expect(await screen.findByText("Climb & descent")).toBeInTheDocument();
      expect(screen.getByText("34°")).toBeInTheDocument();
      // Release the abandoned first request — it's cancelled, so it's a no-op.
      resolveFirst({ data: ride(), response: { status: 200 } });
    });
  });
});
