import { render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import AchievementsPage from "./page";
import { useAuthStore } from "@/stores/auth";
import {
  fetchGamificationSnapshot,
  fetchProgression,
  fetchRegionalLeaderboards,
} from "@/lib/gamification-fetch";
import { usersApi } from "@/lib/api";
import type { GamificationSnapshot } from "@/lib/gamification";

// Both switch families fail SAFE (enabled until a confirmed `force_off`).
//
// KEYED, and keyed separately per registry: this page reads the
// `community_access` kill switch (leaderboard profile links) AND the
// `sys_gamification` system switch (the whole module). They live in different
// registry kinds with very different blast radii, so one boolean for both
// would let a gate on the wrong key pass (#1204).
const killSwitches = vi.hoisted(
  () => ({ community_access: true }) as Record<string, boolean>,
);
const systemSwitches = vi.hoisted(
  () => ({ sys_gamification: true }) as Record<string, boolean>,
);
vi.mock("@/hooks/useEntitlements", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/useEntitlements")>()),
  useFeatureKillSwitch: (key: string) => ({
    enabled: killSwitches[key] ?? true,
    isResolved: true,
  }),
  useSystemSwitch: (key: string) => ({
    enabled: systemSwitches[key] ?? true,
    isResolved: true,
  }),
}));

vi.mock("@/lib/gamification-fetch", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/gamification-fetch")
  >("@/lib/gamification-fetch");
  return {
    ...actual,
    fetchGamificationSnapshot: vi.fn(),
    fetchProgression: vi.fn(),
    fetchRegionalLeaderboards: vi.fn(),
    joinChallenge: vi.fn(),
  };
});

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return { ...actual, usersApi: { ...actual.usersApi, getMe: vi.fn() } };
});

const snapshotMock = vi.mocked(fetchGamificationSnapshot);
const progressionMock = vi.mocked(fetchProgression);
const leaderboardsMock = vi.mocked(fetchRegionalLeaderboards);
const getMeMock = vi.mocked(usersApi.getMe);

function snapshot(): GamificationSnapshot {
  return {
    badges: [],
    challenges: [],
    challengeMeta: {},
    milestones: [],
    seasonal: null,
    stats: {
      totalKm: 12000,
      totalRides: 40,
      totalHours: 320,
      roadsDiscovered: 80,
      hazardsReported: 6,
      joinedAt: "2024-04-01T10:00:00.000Z",
    },
  };
}

function emptyDimension(rank: number | null) {
  return {
    dimension: "total_distance_km" as const,
    unit: "km" as const,
    entries: [],
    me:
      rank != null
        ? {
            rank,
            userId: "user-1",
            displayName: "Test Rider",
            homeRegion: "Lombardy",
            value: 12000,
            isMe: true,
          }
        : null,
  };
}

function dimensionWithEntry() {
  return {
    dimension: "total_distance_km" as const,
    unit: "km" as const,
    entries: [
      {
        rank: 1,
        userId: "rider-9",
        displayName: "Jane Rider",
        homeRegion: "Lombardy",
        value: 9000,
        isMe: false,
      },
    ],
    me: null,
  };
}

function leaderboards(rank: number | null) {
  return {
    region: "Lombardy",
    generatedAt: "2026-04-01T10:00:00.000Z",
    total_distance_km: emptyDimension(rank),
    roads_discovered: emptyDimension(null),
    hazards_reported: emptyDimension(null),
  };
}

describe("AchievementsPage — current-tier hero", () => {
  beforeEach(() => {
    snapshotMock.mockReset();
    progressionMock.mockReset();
    leaderboardsMock.mockReset();
    killSwitches.community_access = true;
    systemSwitches.sys_gamification = true;
    getMeMock.mockReset();
    useAuthStore.setState({
      accessToken: "test-token",
      isAuthenticated: true,
      user: { id: "user-1", email: "rider@example.com", displayName: "Rider" },
    });
    snapshotMock.mockResolvedValue(snapshot());
    // The leaderboards widget resolves home_region from /users/me.
    getMeMock.mockResolvedValue({
      data: { home_region: "Lombardy" },
    } as Awaited<ReturnType<typeof usersApi.getMe>>);
    leaderboardsMock.mockResolvedValue(leaderboards(7));
  });

  it("renders the dark progression hero from the rider's progression + rank", async () => {
    progressionMock.mockResolvedValue({
      xp: 23750,
      level: 14,
      tier: "Curve Hunter",
      next_tier: "Mountain Goat",
      current_tier_xp: 11250,
      next_tier_xp: 26250,
      xp_to_next_tier: 2500,
    });

    render(<AchievementsPage />);

    expect(
      await screen.findByText("Curve Hunter", undefined, { timeout: 3000 }),
    ).toBeInTheDocument();
    expect(screen.getByText("Current tier")).toBeInTheDocument();
    expect(screen.getByText("Level 14 · 23,750 XP")).toBeInTheDocument();
    expect(screen.getByText("Next tier · Mountain Goat")).toBeInTheDocument();
    expect(screen.getByText("2,500 XP to go")).toBeInTheDocument();
    // Regional rank pulled from the distance-dimension `me` row, scoped to the
    // rider's home region so it agrees with the leaderboard below.
    await waitFor(() => expect(screen.getByText("#7")).toBeInTheDocument());
    expect(leaderboardsMock).toHaveBeenCalledWith(
      expect.objectContaining({ region: "Lombardy" }),
    );

    // Leaderboard filters render as segmented controls (stats-page style):
    // a dimension group plus a region group once home_region resolves.
    expect(
      screen.getByRole("radiogroup", { name: /leaderboard dimension/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Distance" })).toBeInTheDocument();
    expect(
      await screen.findByRole("radio", { name: "Global" }),
    ).toBeInTheDocument();
  });

  it("hides the hero for a rider with no XP (empty-state design)", async () => {
    progressionMock.mockResolvedValue({
      xp: 0,
      level: 1,
      tier: "Rookie Rider",
      next_tier: "Road Tripper",
      current_tier_xp: 0,
      next_tier_xp: 2500,
      xp_to_next_tier: 2500,
    });

    render(<AchievementsPage />);

    // Let the snapshot load so the dashboard (and its PageHeader) mounts.
    await waitFor(() => expect(snapshotMock).toHaveBeenCalled());
    expect(
      await screen.findByRole("heading", { level: 1, name: /achievements/i }),
    ).toBeInTheDocument();
    // The tier hero is absent for a zero-XP rider.
    expect(screen.queryByText("Current tier")).not.toBeInTheDocument();
    expect(screen.queryByText("Rookie Rider")).not.toBeInTheDocument();
  });
});
describe("AchievementsPage — community_access kill switch", () => {
  beforeEach(() => {
    leaderboardsMock.mockResolvedValue({
      ...leaderboards(null),
      total_distance_km: dimensionWithEntry(),
    });
  });

  it("links a leaderboard row to the rider's profile normally", async () => {
    render(<AchievementsPage />);
    const row = await screen.findByRole("row", { name: "Jane Rider" });
    expect(row.tagName).toBe("A");
    expect(row).toHaveAttribute("href", "/community/rider-9");
  });

  it("keeps the standings but stops them navigating when community is killed", async () => {
    // The standings are earned HERE, not in the community area, so blanking
    // the row would remove a rider's own achievement data over an unrelated
    // switch. Only the navigation goes.
    killSwitches.community_access = false;
    render(<AchievementsPage />);
    const row = await screen.findByRole("row", { name: "Jane Rider" });
    expect(row.tagName).not.toBe("A");
    expect(screen.getByText("Jane Rider")).toBeInTheDocument();
    for (const link of screen.queryAllByRole("link")) {
      expect(link.getAttribute("href")).not.toMatch(/^\/community\//);
    }
  });
});

describe("AchievementsPage — sys_gamification", () => {
  beforeEach(() => {
    killSwitches.community_access = true;
    systemSwitches.sys_gamification = true;
    snapshotMock.mockClear();
    snapshotMock.mockResolvedValue(snapshot());
    useAuthStore.setState({
      accessToken: "test-token",
      isAuthenticated: true,
      user: { id: "user-1", email: "rider@example.com", displayName: "Rider" },
    });
  });

  it("says UNAVAILABLE and never fetches when the subsystem is off", async () => {
    // The backend answers every gamification list empty while this switch is
    // off, so fetching would render a page telling the rider they have earned
    // nothing — indistinguishable from the truth.
    systemSwitches.sys_gamification = false;
    render(<AchievementsPage />);

    expect(
      await screen.findByText(/temporarily unavailable/i),
    ).toBeInTheDocument();
    expect(snapshotMock).not.toHaveBeenCalled();
  });

  it("KEEPS the standings, which this switch does not cover", async () => {
    // The design puts leaderboards out of scope — "stays live per decision 2"
    // — and the backend keeps serving them. A page-level early return took
    // this section down with the rest, turning a partial shutdown into the
    // loss of a working feature.
    leaderboardsMock.mockResolvedValue({
      ...leaderboards(null),
      total_distance_km: dimensionWithEntry(),
    });
    systemSwitches.sys_gamification = false;
    render(<AchievementsPage />);

    expect(
      await screen.findByText(/temporarily unavailable/i),
    ).toBeInTheDocument();
    expect(await screen.findByText("Jane Rider")).toBeInTheDocument();
    // The gamification half is still gone.
    expect(snapshotMock).not.toHaveBeenCalled();
  });

  it("is independent of community_access", async () => {
    // Different registries, different blast radii: killing community access
    // must not take the module down.
    killSwitches.community_access = false;
    render(<AchievementsPage />);
    await waitFor(() => expect(snapshotMock).toHaveBeenCalled());
    expect(screen.queryByText(/temporarily unavailable/i)).toBeNull();
  });
});
