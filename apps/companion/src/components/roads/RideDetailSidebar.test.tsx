import { render, screen } from "@testing-library/react";
import { RideDetailSidebar } from "./RideDetailSidebar";
import type { components } from "@tarmoto/openapi-client";

type RideDetail = components["schemas"]["RideDetailDto"];

// Max lean / ascent tiles now gate on `advanced_ride_stats` via useFeature —
// mock the hooks barrel (no QueryClient in these tests) and default to
// entitled so the pre-gate assertions below are unchanged.
const useFeatureMock = vi.fn((_key: string) => ({
  enabled: true,
  isLoading: false,
  isSuccess: true,
}));
vi.mock("@/hooks", () => ({
  useFeature: (key: string) => useFeatureMock(key),
}));

function ride(): RideDetail {
  return {
    id: "r1",
    name: "Sunday blast",
    ride_type: "free",
    started_at: "2026-07-01T08:00:00Z",
    ended_at: "2026-07-01T10:00:00Z",
    distance_km: 120,
    duration_min: 120,
    avg_speed: 60,
    max_speed: 140,
    max_lean_angle: 42,
    elevation_gain: 1800,
    avg_road_quality: 4.1,
    avg_curviness: 3.2,
  } as unknown as RideDetail;
}

describe("RideDetailSidebar", () => {
  beforeEach(() => {
    useFeatureMock.mockReset();
    useFeatureMock.mockImplementation(() => ({
      enabled: true,
      isLoading: false,
      isSuccess: true,
    }));
  });

  it("renders nothing when idle", () => {
    const { container } = render(
      <RideDetailSidebar state={{ status: "idle" }} onClose={() => {}} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the ride stats when ready", () => {
    render(
      <RideDetailSidebar
        state={{ status: "ready", ride: ride() }}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText("Sunday blast")).toBeInTheDocument();
    expect(screen.getByText("Distance")).toBeInTheDocument();
    expect(screen.getByText("Max lean")).toBeInTheDocument();
    expect(screen.getByText("42°")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /open ride/i })).toHaveAttribute(
      "href",
      "/rides/r1",
    );
  });

  it("shows a not-found message", () => {
    render(
      <RideDetailSidebar
        state={{ status: "not-found", rideId: "r1" }}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText(/ride not found/i)).toBeInTheDocument();
  });

  it("locks Max lean / Ascent behind a Pro teaser when advanced_ride_stats isn't entitled", () => {
    useFeatureMock.mockImplementation(() => ({
      enabled: false,
      isLoading: false,
      isSuccess: true,
    }));
    render(
      <RideDetailSidebar
        state={{ status: "ready", ride: ride() }}
        onClose={() => {}}
      />,
    );
    // Non-paid stats still render.
    expect(screen.getByText("Distance")).toBeInTheDocument();
    expect(screen.getByText("120")).toBeInTheDocument();
    // Real paid values are gone; the labels stay (locked tiles), with a
    // visible "Pro" affordance instead of the number.
    expect(screen.getByText("Max lean")).toBeInTheDocument();
    expect(screen.getByText("Ascent")).toBeInTheDocument();
    expect(screen.queryByText("42°")).not.toBeInTheDocument();
    expect(screen.getAllByText("Pro").length).toBeGreaterThan(0);
  });

  it("fails closed (locked, no real values) while advanced_ride_stats is still resolving", () => {
    useFeatureMock.mockImplementation(() => ({
      enabled: false,
      isLoading: true,
      isSuccess: false,
    }));
    render(
      <RideDetailSidebar
        state={{ status: "ready", ride: ride() }}
        onClose={() => {}}
      />,
    );
    expect(screen.queryByText("42°")).not.toBeInTheDocument();
    expect(screen.getAllByText("Pro").length).toBeGreaterThan(0);
  });
});
