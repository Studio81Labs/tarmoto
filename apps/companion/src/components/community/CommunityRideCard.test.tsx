import { render, screen } from "@testing-library/react";
import { CommunityRideCard } from "./CommunityRideCard";
import type { CommunityRide } from "@/lib/api";

// Kill switches fail SAFE (enabled until a confirmed `force_off`); the real
// hook needs a QueryClientProvider this suite does not set up.
const killSwitch = vi.hoisted(() => ({ enabled: true }));
vi.mock("@/hooks/useEntitlements", () => ({
  useFeatureKillSwitch: () => ({
    enabled: killSwitch.enabled,
    isResolved: true,
  }),
}));

vi.mock("next/navigation", async () => {
  const actual =
    await vi.importActual<typeof import("next/navigation")>("next/navigation");
  return { ...actual, useRouter: () => ({ push: vi.fn() }) };
});

function ride(overrides: Partial<CommunityRide> = {}): CommunityRide {
  return {
    id: "ride-1",
    share_token: "token-1",
    rider_id: "rider-1",
    rider_name: "John Rider",
    rider_avatar_url: null,
    name: "Three Passes Sunday",
    ride_type: "trip",
    started_at: "2026-04-22T10:00:00.000Z",
    distance_km: 242.6,
    avg_speed: 63.2,
    avg_road_quality: 4.4,
    avg_curviness: 6.1,
    duration_min: 215,
    view_count: 123,
    description: "Stelvio + Umbrail + Bernina. All resurfaced in May.",
    like_count: 142,
    viewer_has_liked: false,
    clone_count: 12,
    route_geometry: [
      { lat: 49.2, lng: 16.6 },
      { lat: 49.15, lng: 16.7 },
      { lat: 49.1, lng: 16.75 },
    ],
    ...overrides,
  };
}

describe("CommunityRideCard", () => {
  it("links the ride to the full ride detail page, and the author to their profile", () => {
    render(<CommunityRideCard ride={ride()} />);

    // Both the title and the route-preview thumbnail open the ride detail
    // under the community route — publicly-shared rides are viewable there.
    expect(
      screen.getByRole("link", { name: "Three Passes Sunday" }),
    ).toHaveAttribute("href", "/community/rides/ride-1");
    expect(
      screen.getByRole("link", { name: "Three Passes Sunday route preview" }),
    ).toHaveAttribute("href", "/community/rides/ride-1");
    expect(screen.getByRole("link", { name: /john rider/i })).toHaveAttribute(
      "href",
      "/community/rider-1",
    );
    expect(screen.getByText(/resurfaced in May/i)).toBeInTheDocument();
    // QualityBars maps 4.4 → tier 4.
    expect(screen.getByLabelText("Quality 4 of 5")).toBeInTheDocument();
    expect(screen.getByText("142")).toBeInTheDocument();
    expect(screen.getByText("12")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /add to trips/i }),
    ).toBeInTheDocument();
  });

  it("falls back to the ride date when there is no name, and shows no-preview", () => {
    render(
      <CommunityRideCard ride={ride({ name: null, route_geometry: null })} />,
    );

    expect(screen.getByText("No preview")).toBeInTheDocument();
    // No name → the title link is the formatted date, not the literal name.
    expect(
      screen.queryByRole("link", { name: "Three Passes Sunday" }),
    ).not.toBeInTheDocument();
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

  it("reflects an already-liked ride in the heart button state", () => {
    render(<CommunityRideCard ride={ride({ viewer_has_liked: true })} />);

    expect(screen.getByRole("button", { name: /unlike/i })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("removes Add to trips when trip planning is killed — cloning mints a trip", async () => {
    // A THIRD trip-creation path, reached from the community feed rather than
    // from /trips, which is why the planner and Duplicate gates missed it.
    killSwitch.enabled = false;
    render(<CommunityRideCard ride={ride()} />);
    expect(screen.queryByRole("button", { name: /add to trips/i })).toBeNull();
    // The rest of the card is community content and stays.
    expect(screen.getByRole("button", { name: /like/i })).toBeInTheDocument();
  });
});
