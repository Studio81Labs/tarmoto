import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import RideDetailPage from "./page";
import { api } from "@/lib/api";
import { useAuthStore } from "@/stores/auth";

let routeRideId = "ride-1";

const mockedRideRouteMap = vi.fn(({ label }: { label?: string }) => (
  <div data-testid="ride-route-map">{label ?? "Ride route map"}</div>
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
    ride_type: "solo",
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

describe("RideDetailPage analytics", () => {
  beforeEach(() => {
    routeRideId = "ride-1";
    mockedRideRouteMap.mockClear();
    vi.mocked(api.GET).mockReset();
    vi.mocked(api.PATCH).mockReset();
    // The detail page now gates its fetch on `useAuthStore.accessToken`
    // (matches the AuthSync race fix). Seed a session so the effect
    // actually fires under test.
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

  it("renders T31 route map, elevation profile, speed graph, and stats", async () => {
    vi.mocked(api.GET).mockResolvedValueOnce({
      data: ride(),
      response: { status: 200 },
    } as unknown as Awaited<ReturnType<typeof api.GET>>);

    render(<RideDetailPage />);

    expect(await screen.findByTestId("ride-route-map")).toBeInTheDocument();
    expect(mockedRideRouteMap).toHaveBeenCalledWith(
      expect.objectContaining({
        geometry: [
          { lat: 49.1, lng: 16.6 },
          { lat: 49.2, lng: 16.8 },
        ],
      }),
    );
    expect(screen.getByText("Elevation profile")).toBeInTheDocument();
    expect(screen.getByText("Speed graph")).toBeInTheDocument();
    expect(
      screen.getByText("No elevation profile was recorded for this ride."),
    ).toBeInTheDocument();
    expect(screen.getByText(/98 km\/h peak/i)).toBeInTheDocument();
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

  it("renders a visible speed marker for one-segment rides", async () => {
    vi.mocked(api.GET).mockResolvedValueOnce({
      data: ride({
        segments: [
          {
            road_segment_id: "seg-1",
            road_name: "Ridge Road",
            quality_reading: 4.4,
            speed_avg: 58,
            speed_max: 86,
            lean_angle_max: 22,
          },
        ],
      }),
      response: { status: 200 },
    } as unknown as Awaited<ReturnType<typeof api.GET>>);

    const { container } = render(<RideDetailPage />);

    expect(await screen.findByText(/86 km\/h peak/i)).toBeInTheDocument();
    const speedGraph = container.querySelector(
      'svg[aria-label="Ride speed graph"]',
    );
    expect(speedGraph?.querySelector("circle")).toBeInTheDocument();
  });

  it("distinguishes missing GPS and missing elevation from API failures", async () => {
    vi.mocked(api.GET).mockResolvedValueOnce({
      data: ride({ route_geometry: null, segments: [] }),
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
      screen.getByText("No elevation profile was recorded for this ride."),
    ).toBeInTheDocument();
  });
});
