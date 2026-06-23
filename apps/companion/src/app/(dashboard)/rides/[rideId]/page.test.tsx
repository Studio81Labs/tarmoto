import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import RideDetailPage from "./page";
import { api } from "@/lib/api";
import { useAuthStore } from "@/stores/auth";

let routeRideId = "ride-1";
let routePathname = "/rides/ride-1";

const mockedRideRouteMap = vi.fn((props: { label?: string }) => (
  <div data-testid="ride-route-map">{props.label ?? "Ride route map"}</div>
));

vi.mock("next/navigation", () => ({
  useParams: () => ({ rideId: routeRideId }),
  usePathname: () => routePathname,
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
});
