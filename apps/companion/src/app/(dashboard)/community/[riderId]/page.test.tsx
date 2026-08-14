import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import RiderProfilePage from "./page";
import { useAuthStore } from "@/stores/auth";
import {
  fetchPublicProfile,
  fetchPublicBadges,
  type PublicProfile,
} from "@/lib/rider-profile";

// KEYED: this page reads the `sys_gamification` system switch (the badge
// shelf and the adjacent Badges metric). Keyed from the start so a later
// second switch cannot pass a gate written against the wrong one (#1204).
const systemSwitches = vi.hoisted(
  () => ({ sys_gamification: true }) as Record<string, boolean>,
);
vi.mock("@/hooks/useEntitlements", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/useEntitlements")>()),
  useSystemSwitch: (key: string) => ({
    enabled: systemSwitches[key] ?? true,
    isResolved: true,
  }),
}));

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

describe("RiderProfilePage — sys_gamification", () => {
  beforeEach(() => {
    systemSwitches.sys_gamification = true;
    useAuthStore.setState({
      user: { id: "me-1" } as never,
      isAuthenticated: true,
      accessToken: "tok",
    });
    fetchPublicProfileMock.mockResolvedValue(profile());
    fetchPublicBadgesMock.mockClear();
    fetchPublicBadgesMock.mockResolvedValue([]);
  });

  it("drops the badge shelf AND its adjacent count, keeping the profile", async () => {
    // `earnedBadgeCount` is derived from the same array as the shelf, so
    // gating only the shelf leaves a "Badges: 0" metric reporting the shutdown
    // as the rider having earned nothing. The profile itself is not
    // gamification and stays up.
    systemSwitches.sys_gamification = false;
    render(<RiderProfilePage />);

    expect(
      await screen.findByText(/temporarily unavailable/i),
    ).toBeInTheDocument();
    expect(screen.queryByText("Badges")).not.toBeInTheDocument();
    expect(fetchPublicBadgesMock).not.toHaveBeenCalled();
    // The rider's own page is still there.
    expect(fetchPublicProfileMock).toHaveBeenCalled();
  });

  it("REFETCHES badges when the subsystem is restored", async () => {
    // Gating the off direction is only half of it: the effect skipped the
    // badge fetch and stored an empty array, so restoring the switch brought
    // the shelf back reading "zero badges" until the rider navigated away.
    systemSwitches.sys_gamification = false;
    const { rerender } = render(<RiderProfilePage />);
    await waitFor(() => expect(fetchPublicProfileMock).toHaveBeenCalled());
    expect(fetchPublicBadgesMock).not.toHaveBeenCalled();

    systemSwitches.sys_gamification = true;
    rerender(<RiderProfilePage />);

    await waitFor(() => expect(fetchPublicBadgesMock).toHaveBeenCalled());
  });
});
