import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchGamificationSnapshot as fetchGamificationSnapshotWithTranslate,
  fetchMeProfile as fetchMeProfileWithTranslate,
  fetchProgression as fetchProgressionWithTranslate,
  fetchRegionalLeaderboards as fetchRegionalLeaderboardsWithTranslate,
  GamificationFetchError,
  joinChallenge as joinChallengeWithTranslate,
} from "../gamification-fetch";
import { api } from "@/lib/api";
import { createFormatters } from "@tarmoto/shared";
import { t } from "@/i18n";

const format = createFormatters({ locale: "en", units: "metric" });
const joinChallenge = (challengeId: string) =>
  joinChallengeWithTranslate(challengeId, { translate: t });
const fetchMeProfile = () => fetchMeProfileWithTranslate({ translate: t });
const fetchProgression = () => fetchProgressionWithTranslate({ translate: t });
const fetchGamificationSnapshot = (
  userId: string,
  options: Omit<
    Parameters<typeof fetchGamificationSnapshotWithTranslate>[1],
    "translate"
  >,
) =>
  fetchGamificationSnapshotWithTranslate(userId, { ...options, translate: t });
const fetchRegionalLeaderboards = (
  options: Omit<
    Parameters<typeof fetchRegionalLeaderboardsWithTranslate>[0],
    "translate"
  > = {},
) => fetchRegionalLeaderboardsWithTranslate({ ...options, translate: t });

const ME_PROFILE_RESPONSE = {
  joined_at: "2024-04-13T10:00:00.000Z",
  total_hours: 87.4,
  total_rides: 18,
  total_distance_km: 1_234.5,
  roads_discovered: 73,
  hazards_reported: 6,
  follower_count: 11,
  following_count: 7,
  badges_earned: 5,
};

vi.mock("@/lib/api", () => ({
  api: {
    GET: vi.fn(),
    POST: vi.fn(),
  },
}));

const mockGet = vi.mocked(api.GET);
const mockPost = vi.mocked(api.POST);

function ok<T>(data: T) {
  return {
    data,
    response: new Response(null, { status: 200 }),
  } as unknown as Awaited<ReturnType<typeof api.GET>>;
}

function fail(status: number, body: unknown = { message: "boom" }) {
  return {
    error: body,
    response: new Response(null, { status }),
  } as unknown as Awaited<ReturnType<typeof api.GET>>;
}

beforeEach(() => {
  mockGet.mockReset();
  mockPost.mockReset();
});

describe("joinChallenge", () => {
  it("calls POST /challenges/{id}/join with the given id", async () => {
    mockPost.mockResolvedValueOnce(ok({ challenge_id: "ch-1" }));

    await joinChallenge("ch-1");

    expect(mockPost).toHaveBeenCalledWith(
      "/api/v1/challenges/{challengeId}/join",
      { params: { path: { challengeId: "ch-1" } } },
    );
  });

  it("treats 409 (already joined) as success", async () => {
    mockPost.mockResolvedValueOnce(fail(409, { message: "Already joined" }));

    await expect(joinChallenge("ch-1")).resolves.toBeUndefined();
  });

  it("propagates non-409 errors", async () => {
    mockPost.mockResolvedValueOnce(fail(404, { message: "Not found" }));

    await expect(joinChallenge("ch-1")).rejects.toBeInstanceOf(
      GamificationFetchError,
    );
  });

  it("uses cataloged rider copy while preserving the response status", async () => {
    mockPost.mockResolvedValueOnce(fail(500, { message: "Server died" }));

    try {
      await joinChallenge("ch-1");
      throw new Error("expected join to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(GamificationFetchError);
      const ge = err as GamificationFetchError;
      expect(ge.message).toBe("Could not join challenge");
      expect(ge.status).toBe(500);
    }
  });
});

describe("fetchMeProfile", () => {
  it("returns the rider summary on success", async () => {
    mockGet.mockResolvedValueOnce(ok(ME_PROFILE_RESPONSE));

    const me = await fetchMeProfile();

    expect(mockGet).toHaveBeenCalledWith("/api/v1/users/me/profile", {
      signal: undefined,
    });
    expect(me.total_hours).toBe(87.4);
    expect(me.joined_at).toBe("2024-04-13T10:00:00.000Z");
  });

  it("wraps backend errors in GamificationFetchError with the status", async () => {
    mockGet.mockResolvedValueOnce(fail(500, { message: "boom" }));

    try {
      await fetchMeProfile();
      throw new Error("expected fetchMeProfile to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(GamificationFetchError);
      const ge = err as GamificationFetchError;
      expect(ge.message).toBe("Could not load your profile summary");
      expect(ge.status).toBe(500);
    }
  });
});

describe("fetchProgression", () => {
  it("returns the rider's XP / level / tier on success", async () => {
    mockGet.mockResolvedValueOnce(
      ok({
        xp: 23750,
        level: 14,
        tier: "Curve Hunter",
        next_tier: "Mountain Goat",
        current_tier_xp: 11250,
        next_tier_xp: 26250,
        xp_to_next_tier: 2500,
      }),
    );

    const progression = await fetchProgression();

    expect(mockGet).toHaveBeenCalledWith("/api/v1/users/me/progression", {
      signal: undefined,
    });
    expect(progression.tier).toBe("Curve Hunter");
    expect(progression.next_tier).toBe("Mountain Goat");
    expect(progression.xp_to_next_tier).toBe(2500);
  });

  it("wraps backend errors in GamificationFetchError with the status", async () => {
    mockGet.mockResolvedValueOnce(fail(503, { message: "down" }));

    await expect(fetchProgression()).rejects.toMatchObject({
      name: "GamificationFetchError",
      status: 503,
    });
  });
});

describe("fetchGamificationSnapshot", () => {
  function setupHappyPath() {
    // Order: badges, challenges (parallel), then per-challenge details.
    // We respond in URL-pattern order via implementation rather than relying
    // on call order.
    mockGet.mockImplementation((url: string, options?: unknown) => {
      const opts = options as
        { params?: { path?: Record<string, string> } } | undefined;
      if (url === "/api/v1/users/me/profile") {
        return Promise.resolve(ok(ME_PROFILE_RESPONSE));
      }
      if (url === "/api/v1/users/{userId}/badges") {
        return Promise.resolve(
          ok([
            {
              key: "total_distance",
              category: "distance",
              tier: "bronze",
              earned_at: "2026-04-01T00:00:00Z",
              progress: {
                current: 200,
                bronze: 100,
                silver: 1000,
                gold: 10000,
              },
            },
          ]),
        );
      }
      if (url === "/api/v1/challenges") {
        return Promise.resolve(
          ok([
            {
              id: "ch-1",
              content_key: "roads_discovered",
              metric: "roads_discovered",
              target: 10,
              starts_at: "2026-04-01T00:00:00Z",
              ends_at: "2026-05-01T00:00:00Z",
              reward_badge_key: null,
              participant_count: 12,
            },
          ]),
        );
      }
      if (url === "/api/v1/challenges/{challengeId}") {
        const id = opts?.params?.path?.challengeId;
        return Promise.resolve(
          ok({
            id,
            content_key: "roads_discovered",
            metric: "roads_discovered",
            target: 10,
            starts_at: "2026-04-01T00:00:00Z",
            ends_at: "2026-05-01T00:00:00Z",
            reward_badge_key: null,
            participant_count: 12,
            my_progress: 4,
            my_completed: false,
            leaderboard: [
              {
                rank: 1,
                user_id: "user-1",
                display_name: "Me",
                progress: 4,
                completed: false,
              },
            ],
          }),
        );
      }
      return Promise.resolve(fail(404));
    });
  }

  it("composes badges + challenges + details + me-profile into a snapshot", async () => {
    setupHappyPath();

    const snap = await fetchGamificationSnapshot("user-1", { format });

    expect(snap.badges).toHaveLength(1);
    expect(snap.badges[0]?.id).toBe("total_distance");
    expect(snap.challenges).toHaveLength(1);
    expect(snap.challenges[0]?.current).toBe(4);
    expect(snap.challengeMeta["ch-1"]).toEqual({
      joined: true,
      participantCount: 12,
    });
    // The me-profile fields backfill `totalHours` / `joinedAt` that the
    // badges endpoint can't provide (issue #334).
    expect(snap.stats.totalHours).toBe(87.4);
    expect(snap.stats.joinedAt).toBe("2024-04-13T10:00:00.000Z");
  });

  it("propagates errors from the badges call", async () => {
    mockGet.mockImplementation((url: string) => {
      if (url === "/api/v1/users/{userId}/badges") {
        return Promise.resolve(fail(500, { message: "DB down" }));
      }
      return Promise.resolve(ok([]));
    });

    await expect(
      fetchGamificationSnapshot("user-1", { format }),
    ).rejects.toThrow("Could not load badges");
  });

  it("propagates errors from the challenges list call", async () => {
    mockGet.mockImplementation((url: string) => {
      if (url === "/api/v1/users/{userId}/badges") {
        return Promise.resolve(ok([]));
      }
      if (url === "/api/v1/users/me/profile") {
        return Promise.resolve(ok(ME_PROFILE_RESPONSE));
      }
      if (url === "/api/v1/challenges") {
        return Promise.resolve(fail(503, { message: "Unavailable" }));
      }
      return Promise.resolve(ok([]));
    });

    await expect(
      fetchGamificationSnapshot("user-1", { format }),
    ).rejects.toThrow("Could not load challenges");
  });

  it("propagates errors from the me-profile call", async () => {
    mockGet.mockImplementation((url: string) => {
      if (url === "/api/v1/users/me/profile") {
        return Promise.resolve(fail(500, { message: "Profile lookup failed" }));
      }
      return Promise.resolve(ok([]));
    });

    await expect(
      fetchGamificationSnapshot("user-1", { format }),
    ).rejects.toThrow("Could not load your profile summary");
  });

  it("returns an empty-but-valid snapshot when there are no challenges", async () => {
    mockGet.mockImplementation((url: string) => {
      if (url === "/api/v1/users/{userId}/badges")
        return Promise.resolve(ok([]));
      if (url === "/api/v1/challenges") return Promise.resolve(ok([]));
      if (url === "/api/v1/users/me/profile")
        return Promise.resolve(ok(ME_PROFILE_RESPONSE));
      return Promise.resolve(fail(404));
    });

    const snap = await fetchGamificationSnapshot("user-1", { format });
    expect(snap.challenges).toEqual([]);
    expect(snap.milestones.length).toBeGreaterThan(0);
  });

  it("threads the AbortSignal through every backend call", async () => {
    setupHappyPath();
    const controller = new AbortController();

    await fetchGamificationSnapshot("user-1", {
      format,
      signal: controller.signal,
    });

    // Every api.GET invocation should have received the same signal so
    // that aborting the controller cancels the whole fan-out.
    for (const call of mockGet.mock.calls) {
      const init = call[1] as { signal?: AbortSignal } | undefined;
      expect(init?.signal).toBe(controller.signal);
    }
  });
});

describe("fetchRegionalLeaderboards", () => {
  function regionalDto(overrides: Partial<{ region: string | null }> = {}) {
    return {
      region: null,
      generated_at: "2026-05-01T00:00:00Z",
      total_distance_km: {
        dimension: "total_distance_km" as const,
        unit: "km",
        entries: [
          {
            rank: 1,
            user_id: "u1",
            display_name: "Alice",
            home_region: "Beskydy",
            value: 1500,
          },
        ],
        me: null,
      },
      roads_discovered: {
        dimension: "roads_discovered" as const,
        unit: "roads",
        entries: [],
        me: null,
      },
      hazards_reported: {
        dimension: "hazards_reported" as const,
        unit: "reports",
        entries: [],
        me: null,
      },
      ...overrides,
    };
  }

  it("calls GET /leaderboards/regional and maps to UI shape", async () => {
    mockGet.mockResolvedValueOnce(ok(regionalDto({ region: "Beskydy" })));

    const result = await fetchRegionalLeaderboards({
      region: "Beskydy",
      currentUserId: "u1",
    });

    expect(mockGet).toHaveBeenCalledWith("/api/v1/leaderboards/regional", {
      params: { query: { region: "Beskydy" } },
      signal: undefined,
    });
    expect(result.region).toBe("Beskydy");
    expect(result.total_distance_km.entries[0]?.isMe).toBe(true);
  });

  it("omits the region query when empty / whitespace", async () => {
    mockGet.mockResolvedValueOnce(ok(regionalDto()));

    await fetchRegionalLeaderboards({ region: "   " });

    expect(mockGet).toHaveBeenCalledWith("/api/v1/leaderboards/regional", {
      params: { query: {} },
      signal: undefined,
    });
  });

  it("forwards limit through to the query", async () => {
    mockGet.mockResolvedValueOnce(ok(regionalDto()));

    await fetchRegionalLeaderboards({ limit: 5 });

    const call = mockGet.mock.calls[0];
    const opts = call?.[1] as
      { params?: { query?: Record<string, unknown> } } | undefined;
    expect(opts?.params?.query?.limit).toBe(5);
  });

  it("throws GamificationFetchError on HTTP error", async () => {
    mockGet.mockResolvedValueOnce(fail(503, { message: "Down" }));

    await expect(fetchRegionalLeaderboards()).rejects.toBeInstanceOf(
      GamificationFetchError,
    );
  });
});
