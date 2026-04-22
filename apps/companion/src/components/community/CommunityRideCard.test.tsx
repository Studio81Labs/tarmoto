import { render, screen } from "@testing-library/react";
import { CommunityRideCard } from "./CommunityRideCard";
import type { CommunityRide } from "@/lib/api";

function ride(overrides: Partial<CommunityRide> = {}): CommunityRide {
  return {
    id: overrides.id ?? "ride-1",
    share_token: overrides.share_token ?? "token-1",
    rider_id: overrides.rider_id ?? "rider-1",
    rider_name: overrides.rider_name ?? "John Rider",
    rider_avatar_url: overrides.rider_avatar_url ?? null,
    ride_type: overrides.ride_type ?? "trip",
    started_at: overrides.started_at ?? "2026-04-22T10:00:00.000Z",
    distance_km: overrides.distance_km ?? 242.6,
    avg_speed: overrides.avg_speed ?? 63.2,
    avg_road_quality: overrides.avg_road_quality ?? 4.4,
    avg_curviness: overrides.avg_curviness ?? 6.1,
    duration_min: overrides.duration_min ?? 215,
    view_count: overrides.view_count ?? 123,
    route_geometry:
      overrides.route_geometry !== undefined
        ? overrides.route_geometry
        : [
            { lat: 49.2, lng: 16.6 },
            { lat: 49.15, lng: 16.7 },
            { lat: 49.1, lng: 16.75 },
          ],
  };
}

describe("CommunityRideCard", () => {
  it("renders rider info, stats, and a route mini-preview when geometry is present", () => {
    render(<CommunityRideCard ride={ride()} />);

    expect(screen.getByText("John Rider")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /john rider/i })).toHaveAttribute(
      "href",
      "/community/rider-1",
    );
    expect(
      screen.getByLabelText("John Rider route preview"),
    ).toBeInTheDocument();
    expect(screen.getByText("123 views")).toBeInTheDocument();
    expect(screen.getByText("4.4/5")).toBeInTheDocument();
  });

  it("falls back gracefully when the ride has no route geometry", () => {
    render(
      <CommunityRideCard
        ride={ride({ route_geometry: null, rider_name: "No Track Rider" })}
      />,
    );

    expect(screen.getByText("Preview unavailable")).toBeInTheDocument();
  });

  it("URL-encodes rider ids in profile links", () => {
    render(
      <CommunityRideCard
        ride={ride({ rider_id: "rider/with spaces?and#hash" })}
      />,
    );

    expect(screen.getByRole("link", { name: /john rider/i })).toHaveAttribute(
      "href",
      "/community/rider%2Fwith%20spaces%3Fand%23hash",
    );
  });

  it("prefers the quality accent color over the default white text class", () => {
    render(<CommunityRideCard ride={ride()} />);

    const qualityValue = screen.getByText("4.4/5");
    expect(qualityValue.className).toMatch(/\btext-quality-/);
    expect(qualityValue).not.toHaveClass("text-white");
  });
});
