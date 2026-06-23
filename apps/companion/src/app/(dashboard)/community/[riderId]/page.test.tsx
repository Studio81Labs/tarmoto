import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import RiderProfilePage from "./page";
import { useAuthStore } from "@/stores/auth";
import {
  fetchPublicProfile,
  fetchPublicBadges,
  type PublicProfile,
} from "@/lib/rider-profile";

vi.mock("next/navigation", () => ({ useParams: () => ({ riderId: "u-2" }) }));

vi.mock("@/lib/rider-profile", async (orig) => ({
  ...(await orig<typeof import("@/lib/rider-profile")>()),
  fetchPublicProfile: vi.fn(),
  fetchPublicBadges: vi.fn(async () => []),
}));

vi.mock("@/components/community/SharedRidesSection", () => ({
  SharedRidesSection: () => null,
}));

const fetchPublicProfileMock = vi.mocked(fetchPublicProfile);
const fetchPublicBadgesMock = vi.mocked(fetchPublicBadges);

function profile(over: Partial<PublicProfile> = {}): PublicProfile {
  return {
    id: "u-2",
    display_name: "Matteo Ferri",
    avatar_url: null,
    bio: null,
    home_region: "Bergamo, IT",
    created_at: "2022-04-01T10:00:00Z",
    follower_count: 221,
    following_count: 30,
    total_distance_km: 8776,
    shared_ride_count: 150,
    is_following: false,
    follows_you: false,
    is_self: false,
    ...over,
  };
}

describe("RiderProfilePage · Follows you badge", () => {
  beforeEach(() => {
    useAuthStore.setState({
      user: { id: "me-1" } as never,
      isAuthenticated: true,
      accessToken: "tok",
    });
    fetchPublicBadgesMock.mockResolvedValue([]);
  });

  it("shows the 'Follows you' badge when the rider follows the viewer", async () => {
    fetchPublicProfileMock.mockResolvedValue(profile({ follows_you: true }));
    render(<RiderProfilePage />);
    expect(await screen.findByText("Matteo Ferri")).toBeInTheDocument();
    expect(screen.getByText("Follows you")).toBeInTheDocument();
  });

  it("hides the badge when the rider does not follow the viewer", async () => {
    fetchPublicProfileMock.mockResolvedValue(profile({ follows_you: false }));
    render(<RiderProfilePage />);
    expect(await screen.findByText("Matteo Ferri")).toBeInTheDocument();
    expect(screen.queryByText("Follows you")).not.toBeInTheDocument();
  });
});
