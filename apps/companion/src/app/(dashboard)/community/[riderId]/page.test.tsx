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

// Mutable so a test can drive a client-side navigation between profiles.
const riderIdParam = vi.hoisted(() => ({ current: "u-2" }));
vi.mock("next/navigation", () => ({
  useParams: () => ({ riderId: riderIdParam.current }),
}));

vi.mock("@/lib/rider-profile", async (orig) => ({
  ...(await orig<typeof import("@/lib/rider-profile")>()),
  fetchPublicProfile: vi.fn(),
  fetchPublicBadges: vi.fn(async () => ({ status: "ok", badges: [] })),
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
    fetchPublicBadgesMock.mockResolvedValue({ status: "ok", badges: [] });
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
    // Reset: the navigation test below leaves a different rider on the param.
    riderIdParam.current = "u-2";
    // Cleared, not just re-stubbed: counts here are absolute, and this file's
    // earlier describes leave their own calls on the mock.
    fetchPublicProfileMock.mockClear();
    fetchPublicProfileMock.mockResolvedValue(profile());
    fetchPublicBadgesMock.mockClear();
    fetchPublicBadgesMock.mockResolvedValue({ status: "ok", badges: [] });
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

  it("keeps the shelf's spacing when the notice replaces it", async () => {
    // `BadgesSection` owns its own `mb-4`, so a replacement without it leaves
    // the notice touching the shared-rides section below — reported in the
    // #1166 operator pass.
    systemSwitches.sys_gamification = false;
    render(<RiderProfilePage />);

    const notice = await screen.findByText(/temporarily unavailable/i);
    expect(notice.closest(".mb-4")).not.toBeNull();
  });

  it("keeps that spacing for the FAILED state too", async () => {
    // The fix covers both replacement states, so both need pinning: a broken
    // wrapper on the error path would leave "Could not load badges" touching
    // the shared-rides section with the suite still green.
    systemSwitches.sys_gamification = true;
    fetchPublicBadgesMock.mockResolvedValue({ status: "failed" });
    render(<RiderProfilePage />);

    const notice = await screen.findByText("Could not load badges");
    expect(notice.closest(".mb-4")).not.toBeNull();
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

  it("leaves the LOADED profile alone when the switch flips", async () => {
    // Badges live in their own effect for this reason. Sharing the profile's
    // effect made a flip re-issue `fetchPublicProfile` too, so the page went
    // back to a skeleton — and on a transient failure to "Could not load
    // profile" — for a change that only affects the badge shelf.
    const { rerender } = render(<RiderProfilePage />);
    expect(await screen.findByText("Matteo Ferri")).toBeInTheDocument();
    expect(fetchPublicProfileMock).toHaveBeenCalledTimes(1);

    // Any later profile fetch fails, so a re-issued one is unmistakable: the
    // page would fall to its error state.
    fetchPublicProfileMock.mockRejectedValue(new Error("boom"));
    systemSwitches.sys_gamification = false;
    rerender(<RiderProfilePage />);

    expect(
      await screen.findByText(/temporarily unavailable/i),
    ).toBeInTheDocument();
    expect(fetchPublicProfileMock).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Matteo Ferri")).toBeInTheDocument();
    expect(
      screen.queryByText("Could not load profile"),
    ).not.toBeInTheDocument();
  });

  it("shows NEITHER badge surface while the request is still out", async () => {
    // The two requests are independent, so the profile lands first on any
    // normal load. Until the badge request settles the page must show no shelf
    // and no count — an empty shelf would read as "this rider has earned
    // nothing" and the tile would put a number on it.
    let resolveBadges: ((v: { status: "ok"; badges: [] }) => void) | undefined;
    fetchPublicBadgesMock.mockReturnValue(
      new Promise((resolve) => {
        resolveBadges = resolve;
      }),
    );
    render(<RiderProfilePage />);

    expect(await screen.findByText("Matteo Ferri")).toBeInTheDocument();
    expect(screen.queryByText(/No badges/)).not.toBeInTheDocument();
    expect(screen.queryByText("Badges")).not.toBeInTheDocument();

    resolveBadges?.({ status: "ok", badges: [] });
    expect(
      await screen.findByText("No badges available yet."),
    ).toBeInTheDocument();
  });

  it("does not attribute the PREVIOUS rider's badges to a new profile", async () => {
    // Client-side navigation between profiles: the badge request for the new
    // rider is still out while their profile renders. Carrying the old list
    // across credits one rider with another's badges.
    fetchPublicBadgesMock.mockResolvedValue({
      status: "ok",
      badges: [
        {
          key: "roads_discovered",
          name: "Explorer",
          description: "Unique road segments ridden",
          category: "exploration",
          tier: "bronze",
          earned_at: "2026-01-01T00:00:00Z",
          progress: { current: 100, bronze: 100, silver: 250, gold: 500 },
        },
      ],
    } as never);
    const { rerender } = render(<RiderProfilePage />);
    // The card renders CATALOG copy for the key, not the DTO's `name`.
    expect(await screen.findByText("Explorer")).toBeInTheDocument();

    // The next rider's badges hang; only the profile resolves.
    fetchPublicBadgesMock.mockReturnValue(new Promise(() => {}));
    fetchPublicProfileMock.mockResolvedValue(
      profile({ id: "u-3", display_name: "Nadia Roux" }),
    );
    riderIdParam.current = "u-3";
    rerender(<RiderProfilePage />);

    expect(await screen.findByText("Nadia Roux")).toBeInTheDocument();
    expect(screen.queryByText("Explorer")).not.toBeInTheDocument();
    expect(screen.queryByText("Badges")).not.toBeInTheDocument();
  });

  it("SAYS the badge fetch failed instead of showing an empty shelf", async () => {
    // An empty shelf is a claim about the rider ("no badges earned yet"), and
    // the count tile beside it would report 0 on the strength of a network
    // error. Both have to drop out.
    // Through the helper's CONTRACT: it resolves `{status:"failed"}` for HTTP
    // errors, missing bodies and network exceptions — it does not reject. A
    // test that mocked a rejection here would pass while production silently
    // rendered an empty shelf.
    fetchPublicBadgesMock.mockResolvedValue({ status: "failed" });
    render(<RiderProfilePage />);

    expect(
      await screen.findByText("Could not load badges"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/No badges/)).not.toBeInTheDocument();
    expect(screen.queryByText("Badges")).not.toBeInTheDocument();
    // The profile is untouched by a badge failure.
    expect(screen.getByText("Matteo Ferri")).toBeInTheDocument();
  });
});
