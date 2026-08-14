import { render, screen, waitFor, within } from "@testing-library/react";
import CompareRidesPage from "./page";
import { api } from "@/lib/api";
import { useAuthStore } from "@/stores/auth";

// `road_quality_overlay` gates the A/B quality glyph and the quality-diff
// section; the real hook needs a QueryClientProvider this suite does not
// render. Keyed so a case that kills one switch cannot silently flip another.
const killSwitches = vi.hoisted(
  () => ({ road_quality_overlay: true }) as Record<string, boolean>,
);
vi.mock("@/hooks/useEntitlements", () => ({
  useFeatureKillSwitch: (key: string) => ({
    enabled: killSwitches[key] ?? true,
    isResolved: true,
  }),
}));

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
  RideRouteMap: (props: { label?: string; containerClassName?: string }) =>
    mockedRideRouteMap(props),
}));

function comparableRide(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name: id === "ride-a" ? "Morning loop" : "Sunset ridge",
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
    max_lean_angle: id === "ride-a" ? 32 : 41,
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
    // Compare page gates fetches on `useAuthStore.accessToken` (the
    // AuthSync race fix). Seed a session so the options + detail
    // effects actually run under test.
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

  it("renders the two A/B route thumbnails and the metric comparison table", async () => {
    mockCompareApi();

    render(<CompareRidesPage />);

    await waitFor(() => {
      expect(screen.getAllByTestId("ride-route-map")).toHaveLength(2);
    });
    // A/B card stamps render the TRANSLATED slot label (the Stamp component
    // uppercases via CSS, so "Ride A" shows as "RIDE A"; jsdom keeps the
    // untransformed text). Scope within each card so this fails if the stamp
    // reverts to a raw "RIDE A"/"RIDE B" literal or stops rendering — other
    // "Ride A"/"Ride B" nodes (e.g. the elevation legend) live outside.
    expect(
      within(screen.getByTestId("compare-slot-a")).getByText("Ride A"),
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId("compare-slot-b")).getByText("Ride B"),
    ).toBeInTheDocument();
    // Thumbnails use the compact label + a 120px container.
    expect(mockedRideRouteMap).toHaveBeenCalledWith(
      expect.objectContaining({
        label: "Ride A route map",
        containerClassName: "h-[120px]",
      }),
    );

    // The single metric table: header carries each ride's name, and the
    // design rows render (Max lean values prove the per-ride mapping).
    const table = screen.getByText("Metric").closest("div")!.parentElement!;
    expect(
      within(table).getByText(/Ride A · Morning loop/),
    ).toBeInTheDocument();
    expect(
      within(table).getByText(/Ride B · Sunset ridge/),
    ).toBeInTheDocument();
    expect(screen.getByText("Max lean")).toBeInTheDocument();
    expect(screen.getByText("32°")).toBeInTheDocument();
    expect(screen.getByText("41°")).toBeInTheDocument();
    // Honest gaps: hazards + region degrade to em-dashes (not fabricated).
    expect(screen.getByText("Hazards")).toBeInTheDocument();
    expect(screen.getByText("Region")).toBeInTheDocument();
    // Preserved richer data still present.
    expect(screen.getByText("Curve count")).toBeInTheDocument();
    expect(screen.getByText("Elevation gain")).toBeInTheDocument();
  });

  it("shows a missing-GPS state for a ride without a route track", async () => {
    mockCompareApi(
      comparableRide("ride-a"),
      comparableRide("ride-b", { route_geometry: null }),
    );

    render(<CompareRidesPage />);

    await waitFor(() => {
      expect(screen.getAllByTestId("ride-route-map")).toHaveLength(1);
    });
    expect(mockedRideRouteMap).toHaveBeenCalledWith(
      expect.objectContaining({ label: "Ride A route map" }),
    );
    expect(screen.getByText("Ride B has no GPS track.")).toBeInTheDocument();
  });
});

describe("CompareRidesPage — road_quality_overlay", () => {
  beforeEach(() => {
    killSwitches.road_quality_overlay = true;
  });

  it("hides the A/B quality glyph and the quality-diff section under the kill", async () => {
    killSwitches.road_quality_overlay = false;
    mockCompareApi();
    render(<CompareRidesPage />);
    // Wait for both rides to LOAD, not just for the slots to mount. Asserting
    // on the empty state made the glyph check vacuous — a mutant that ungated
    // it survived, because with no ride there is no glyph either way.
    await waitFor(() =>
      expect(screen.getAllByTestId("ride-route-map")).toHaveLength(2),
    );

    // The section compares nothing but the killed dimension, so an empty
    // shell would be worse than its absence.
    expect(screen.queryByText("Road quality")).not.toBeInTheDocument();
    // The A/B glyph too — it reads its own derivation, which the section
    // assertion above does not touch.
    expect(screen.queryAllByLabelText(/^Quality \d of 5$/)).toHaveLength(0);
    // The rest of the comparison is untouched.
    expect(screen.getByTestId("compare-slot-a")).toBeInTheDocument();
  });

  it("shows both while the flag is live", async () => {
    mockCompareApi();
    render(<CompareRidesPage />);
    await waitFor(() =>
      expect(screen.getAllByTestId("ride-route-map")).toHaveLength(2),
    );
    expect(screen.getByText("Road quality")).toBeInTheDocument();
    expect(
      screen.queryAllByLabelText(/^Quality \d of 5$/).length,
    ).toBeGreaterThan(0);
  });
});
