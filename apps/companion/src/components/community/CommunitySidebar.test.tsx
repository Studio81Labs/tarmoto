import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { CommunitySidebar } from "./CommunitySidebar";
import { useAuthStore } from "@/stores/auth";
import {
  fetchActiveChallengeCard,
  fetchSuggestedRiders,
} from "@/lib/community-sidebar";
import { fetchRegionalLeaderboards } from "@/lib/gamification-fetch";

// KEYED: this sidebar reads the `sys_gamification` system switch (the active
// challenge card). Keyed from the start so adding a second switch later cannot
// silently pass a gate on the wrong one (#1204).
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

vi.mock("@/lib/community-sidebar", () => ({
  fetchActiveChallengeCard: vi.fn(async () => null),
  fetchSuggestedRiders: vi.fn(),
}));
vi.mock("@/lib/gamification-fetch", () => ({
  fetchRegionalLeaderboards: vi.fn(),
}));
vi.mock("@/lib/rider-profile", () => ({
  followRider: vi.fn(async () => undefined),
}));

const fetchSuggestedRidersMock = vi.mocked(fetchSuggestedRiders);
const fetchActiveChallengeCardMock = vi.mocked(fetchActiveChallengeCard);
const fetchRegionalLeaderboardsMock = vi.mocked(fetchRegionalLeaderboards);

const entry = (over: Record<string, unknown>) => ({
  rank: 1,
  userId: "u-1",
  displayName: "Speedy",
  homeRegion: "Tirol",
  value: 1234,
  isMe: false,
  ...over,
});

describe("CommunitySidebar", () => {
  beforeEach(() => {
    systemSwitches.sys_gamification = true;
    useAuthStore.setState({
      user: { id: "me-1" } as never,
      isAuthenticated: true,
      accessToken: "tok",
    });
    fetchSuggestedRidersMock.mockResolvedValue([
      {
        id: "rider-9",
        display_name: "Jane Rider",
        avatar_url: null,
        home_region: "Bormio",
        ride_count: 12,
      },
    ]);
    fetchActiveChallengeCardMock.mockResolvedValue(null);
    fetchRegionalLeaderboardsMock.mockResolvedValue({
      region: "Global",
      generatedAt: "2026-04-23T09:00:00Z",
      total_distance_km: {
        dimension: "total_distance_km",
        unit: "km",
        entries: [
          entry({ rank: 1, userId: "u-1", displayName: "Speedy" }),
          entry({ rank: 2, userId: "me-1", displayName: "Me", isMe: true }),
        ],
        me: null,
      },
      roads_discovered: {
        dimension: "roads_discovered",
        unit: "count",
        entries: [],
        me: null,
      },
      hazards_reported: {
        dimension: "hazards_reported",
        unit: "count",
        entries: [],
        me: null,
      },
    } as never);
  });

  it("links a suggested rider's name to their profile, separate from Follow", async () => {
    render(<CommunitySidebar />);

    const profileLink = await screen.findByRole("link", {
      name: /Jane Rider/,
    });
    expect(profileLink).toHaveAttribute("href", "/community/rider-9");
    // The Follow button is a separate control, not part of the profile link.
    expect(profileLink).not.toContainElement(
      screen.getByRole("button", { name: "Follow" }),
    );
  });

  it("links leaderboard rivals to their profile but not the rider's own row", async () => {
    render(<CommunitySidebar />);

    const rivalLink = await screen.findByRole("link", { name: "Speedy" });
    expect(rivalLink).toHaveAttribute("href", "/community/u-1");
    // The signed-in rider's own row stays plain text.
    expect(screen.getByText("You")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "You" })).not.toBeInTheDocument();
  });

  it("uses ICU singular copy and cataloged units for a legacy metric", async () => {
    fetchActiveChallengeCardMock.mockResolvedValue({
      id: "challenge-1",
      contentKey: "roads_discovered",
      metric: "unique_segments",
      current: 1,
      target: 1,
      daysLeft: 1,
    });

    render(<CommunitySidebar />);

    expect(await screen.findByText("1 day left")).toBeInTheDocument();
    expect(screen.getByText("Discover 1 road")).toBeInTheDocument();
    expect(screen.queryByText("1 days left")).not.toBeInTheDocument();
    expect(screen.getByText("1 / 1 road")).toBeInTheDocument();
  });
});

describe("CommunitySidebar — sys_gamification", () => {
  beforeEach(() => {
    systemSwitches.sys_gamification = true;
    // The suite's own beforeEach does not clear these, so a cumulative count
    // from earlier tests would make the assertion below meaningless.
    vi.mocked(fetchActiveChallengeCard).mockClear();
    vi.mocked(fetchSuggestedRiders).mockClear();
    vi.mocked(fetchRegionalLeaderboards).mockClear();
    useAuthStore.setState({
      user: { id: "me-1" } as never,
      isAuthenticated: true,
      accessToken: "tok",
    });
  });

  it("says UNAVAILABLE instead of quietly dropping the challenge card", async () => {
    // An absent card reads as "no challenge is running", which is exactly the
    // silent empty state this epic forbids — and the backend returns no active
    // challenges while the switch is off, so the card would simply vanish.
    systemSwitches.sys_gamification = false;
    render(<CommunitySidebar />);

    expect(
      await screen.findByText(/temporarily unavailable/i),
    ).toBeInTheDocument();
    expect(vi.mocked(fetchActiveChallengeCard)).not.toHaveBeenCalled();
    // The standings are gamification too, and the same notice covers them.
    expect(vi.mocked(fetchRegionalLeaderboards)).not.toHaveBeenCalled();
  });

  it("keeps the rest of the sidebar", async () => {
    systemSwitches.sys_gamification = false;
    render(<CommunitySidebar />);
    // Suggested riders are community, not gamification.
    await waitFor(() =>
      expect(vi.mocked(fetchSuggestedRiders)).toHaveBeenCalled(),
    );
  });
});
