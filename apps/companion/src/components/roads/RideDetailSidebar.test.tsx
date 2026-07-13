import { render, screen } from "@testing-library/react";
import { RideDetailSidebar } from "./RideDetailSidebar";
import type { components } from "@tarmoto/openapi-client";

type RideDetail = components["schemas"]["RideDetailDto"];

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
});
