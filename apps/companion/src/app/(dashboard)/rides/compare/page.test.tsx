import { render, screen, waitFor } from "@testing-library/react";
import CompareRidesPage from "./page";
import { api } from "@/lib/api";

const mockPush = vi.fn();
const mockReplace = vi.fn();
const mockSearchParams = vi.hoisted(() => ({
  value: new URLSearchParams("a=ride-a&b=ride-b"),
}));

const mockedRideRouteMap = vi.fn(({ label }: { label?: string }) => (
  <div data-testid="ride-route-map">{label}</div>
));

vi.mock("next/navigation", () => ({
  usePathname: () => "/rides/compare",
  useRouter: () => ({ push: mockPush, replace: mockReplace }),
  useSearchParams: () => mockSearchParams.value,
}));

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    api: {
      ...actual.api,
      GET: vi.fn(),
    },
  };
});

vi.mock("../_components/RideRouteMap", () => ({
  RideRouteMap: (props: { label?: string; fitBounds?: unknown }) =>
    mockedRideRouteMap(props),
}));

function comparableRide(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    status: "completed",
    ride_type: "solo",
    started_at:
      id === "ride-a" ? "2026-05-01T08:00:00.000Z" : "2026-05-02T08:00:00.000Z",
    ended_at: "2026-05-01T10:00:00.000Z",
    distance_km: id === "ride-a" ? 100 : 118,
    duration_min: 120,
    avg_speed: id === "ride-a" ? 50 : 59,
    max_speed: id === "ride-a" ? 90 : 104,
    avg_road_quality: id === "ride-a" ? 3.6 : 4.2,
    elevation_gain: id === "ride-a" ? 500 : 640,
    elevation_loss: 470,
    curve_count: 100,
    max_lean_angle: 30,
    fuel_estimate_l: 4.2,
    route_geometry: [
      { lat: 49.1, lng: 16.6 },
      { lat: 49.2, lng: 16.8 },
    ],
    segments: [
      {
        road_segment_id: `${id}-seg-1`,
        road_name: "Ridge Road",
        quality_reading: 4,
        speed_avg: id === "ride-a" ? 50 : 60,
        speed_max: id === "ride-a" ? 80 : 95,
        lean_angle_max: 22,
      },
    ],
    ...overrides,
  };
}

function mockCompareApi(
  rideA = comparableRide("ride-a"),
  rideB = comparableRide("ride-b"),
) {
  vi.mocked(api.GET).mockImplementation((path, options) => {
    if (path === "/api/v1/rides") {
      return Promise.resolve({
        data: { rides: [rideA, rideB] },
      } as unknown as Awaited<ReturnType<typeof api.GET>>);
    }
    const rideId = (
      options as { params?: { path?: { rideId?: string } } } | undefined
    )?.params?.path?.rideId;
    return Promise.resolve({
      data: rideId === "ride-a" ? rideA : rideB,
    } as unknown as Awaited<ReturnType<typeof api.GET>>);
  });
}

describe("CompareRidesPage analytics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSearchParams.value = new URLSearchParams("a=ride-a&b=ride-b");
    vi.mocked(api.GET).mockReset();
  });

  it("renders T34 side-by-side maps and stats diff for the selected rides", async () => {
    mockCompareApi(
      comparableRide("ride-a", {
        route_geometry: [
          { lat: 49.1, lng: 16.6 },
          { lat: 49.2, lng: 16.8 },
        ],
      }),
      comparableRide("ride-b", {
        route_geometry: [
          { lat: 48.9, lng: 16.2 },
          { lat: 49.6, lng: 17.1 },
        ],
      }),
    );

    render(<CompareRidesPage />);

    await waitFor(() => {
      expect(screen.getAllByTestId("ride-route-map")).toHaveLength(2);
    });
    expect(screen.getAllByText("Ride A").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Ride B").length).toBeGreaterThan(0);
    expect(screen.getByText("Stats diff")).toBeInTheDocument();
    expect(screen.getByText("+18.0")).toBeInTheDocument();
    expect(mockedRideRouteMap).toHaveBeenCalledWith(
      expect.objectContaining({
        label: "Ride A interactive route map",
        fitBounds: {
          minLng: 16.2,
          minLat: 48.9,
          maxLng: 17.1,
          maxLat: 49.6,
        },
      }),
    );
    expect(mockedRideRouteMap).toHaveBeenCalledWith(
      expect.objectContaining({
        label: "Ride B interactive route map",
        fitBounds: {
          minLng: 16.2,
          minLat: 48.9,
          maxLng: 17.1,
          maxLat: 49.6,
        },
      }),
    );
  });

  it("shows missing-GPS states per side without hiding the comparison", async () => {
    mockCompareApi(
      comparableRide("ride-a"),
      comparableRide("ride-b", { route_geometry: null }),
    );

    render(<CompareRidesPage />);

    await waitFor(() => {
      expect(screen.getAllByTestId("ride-route-map")).toHaveLength(1);
    });
    expect(mockedRideRouteMap).toHaveBeenCalledWith(
      expect.objectContaining({
        label: "Ride A interactive route map",
        fitBounds: null,
      }),
    );
    expect(screen.getByText("Ride B has no GPS track.")).toBeInTheDocument();
  });
});
