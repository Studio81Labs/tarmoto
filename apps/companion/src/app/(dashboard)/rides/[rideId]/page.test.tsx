import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import RideDetailPage from "./page";
import { api } from "@/lib/api";
import { useAuthStore } from "@/stores/auth";

let routeRideId = "ride-1";

const mockedRideRouteMap = vi.fn((props: { label?: string }) => (
  <div data-testid="ride-route-map">{props.label ?? "Ride route map"}</div>
));

vi.mock("next/navigation", () => ({
  useParams: () => ({ rideId: routeRideId }),
}));

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    api: {
      ...actual.api,
      GET: vi.fn(),
      PATCH: vi.fn(),
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
    ...overrides,
  };
}

describe("RideDetailPage", () => {
  beforeEach(() => {
    routeRideId = "ride-1";
    mockedRideRouteMap.mockClear();
    vi.mocked(api.GET).mockReset();
    vi.mocked(api.PATCH).mockReset();
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
    expect(
      screen.getByRole("button", { name: /Export GPX/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Export CSV/i }),
    ).toBeInTheDocument();
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
