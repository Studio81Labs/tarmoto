import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchPublicBadges,
  fetchPublicProfile as fetchPublicProfileWithTranslate,
  followRider as followRiderWithTranslate,
  formatCount,
  formatJoinedLabel,
  initialsFromName,
  RiderProfileNotFoundError,
  unfollowRider as unfollowRiderWithTranslate,
} from "../rider-profile";
import { api, ApiError } from "../api";
import { t } from "@/i18n";

const FIXED_NOW = new Date("2026-04-18T00:00:00Z");
const fetchPublicProfile = (
  riderId: string,
  options: Omit<
    Parameters<typeof fetchPublicProfileWithTranslate>[1],
    "translate"
  > = {},
) => fetchPublicProfileWithTranslate(riderId, { ...options, translate: t });
const followRider = (riderId: string) => followRiderWithTranslate(riderId, t);
const unfollowRider = (riderId: string) =>
  unfollowRiderWithTranslate(riderId, t);

vi.mock("../api", async () => {
  const actual = await vi.importActual<typeof import("../api")>("../api");
  return {
    ...actual,
    api: {
      GET: vi.fn(),
      POST: vi.fn(),
      DELETE: vi.fn(),
    },
  };
});

const apiGet = vi.mocked(api.GET);
const apiPost = vi.mocked(api.POST);
const apiDelete = vi.mocked(api.DELETE);

// openapi-fetch's typed result is heavily generic; cast through `unknown` so
// tests can construct minimal `{ data, response }` / `{ error, response }`
// objects without re-deriving the full union for every endpoint.
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
  apiGet.mockReset();
  apiPost.mockReset();
  apiDelete.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("formatCount", () => {
  it("locale-formats small counts", () => {
    expect(formatCount(5, "en")).toBe("5");
    expect(formatCount(999, "en")).toBe("999");
  });

  it("switches to k for larger counts", () => {
    expect(formatCount(1_500, "en")).toBe("1.5k");
    expect(formatCount(25_000, "en")).toBe("25k");
  });
});

describe("formatJoinedLabel", () => {
  it("uses 'this month' for the same calendar month", () => {
    expect(formatJoinedLabel("2026-04-03T00:00:00Z", FIXED_NOW)).toBe(
      "Joined this month",
    );
  });

  it("shows month counts under a year", () => {
    expect(formatJoinedLabel("2026-01-01T00:00:00Z", FIXED_NOW)).toBe(
      "Joined 3 months ago",
    );
  });

  it("switches to years once over twelve months", () => {
    expect(formatJoinedLabel("2024-04-01T00:00:00Z", FIXED_NOW)).toBe(
      "Joined 2 years ago",
    );
  });

  it("degrades gracefully for bad dates", () => {
    expect(formatJoinedLabel("not-a-date", FIXED_NOW)).toBe("Joined recently");
  });
});

describe("initialsFromName", () => {
  it("takes the first letter of the first two words", () => {
    expect(initialsFromName("Alice Doe")).toBe("AD");
  });

  it("falls back to '?' for empty or nullish names", () => {
    expect(initialsFromName("")).toBe("?");
    expect(initialsFromName(null)).toBe("?");
  });
});

describe("fetchPublicProfile", () => {
  function profilePayload() {
    return {
      id: "rider-1",
      display_name: "Alice",
      avatar_url: null,
      bio: "Hi",
      home_region: "Prague",
      created_at: "2024-04-18T00:00:00Z",
      follower_count: 12,
      following_count: 7,
      is_following: false,
      follows_you: false,
      is_self: false,
    };
  }

  it("returns the profile from the typed client when the endpoint succeeds", async () => {
    apiGet.mockResolvedValueOnce(ok(profilePayload()));
    const profile = await fetchPublicProfile("rider-1");
    expect(profile.display_name).toBe("Alice");
    expect(profile.follower_count).toBe(12);
  });

  it("calls the typed client with the rider path param", async () => {
    apiGet.mockResolvedValueOnce(ok(profilePayload()));
    await fetchPublicProfile("rider-with/odd id");
    expect(apiGet).toHaveBeenCalledWith(
      "/api/v1/users/{userId}/profile",
      expect.objectContaining({
        params: { path: { userId: "rider-with/odd id" } },
      }),
    );
  });

  it("throws RiderProfileNotFoundError on 404", async () => {
    apiGet.mockResolvedValueOnce(fail(404));
    await expect(fetchPublicProfile("missing")).rejects.toBeInstanceOf(
      RiderProfileNotFoundError,
    );
  });

  it("throws RiderProfileFetchError on other non-OK statuses", async () => {
    apiGet.mockResolvedValueOnce(fail(500));
    await expect(fetchPublicProfile("rider-2")).rejects.toMatchObject({
      name: "RiderProfileFetchError",
      status: 500,
    });
  });

  it("throws RiderProfileFetchError on 403 rather than masking it", async () => {
    apiGet.mockResolvedValueOnce(fail(403));
    await expect(fetchPublicProfile("rider-3")).rejects.toMatchObject({
      name: "RiderProfileFetchError",
      status: 403,
    });
  });

  it("forwards the abort signal to the typed client", async () => {
    apiGet.mockResolvedValueOnce(ok(profilePayload()));
    const controller = new AbortController();
    await fetchPublicProfile("rider-1", { signal: controller.signal });
    expect(apiGet).toHaveBeenCalledWith(
      "/api/v1/users/{userId}/profile",
      expect.objectContaining({ signal: controller.signal }),
    );
  });
});

describe("fetchPublicBadges", () => {
  it("returns badges from the typed client", async () => {
    const badges = [
      {
        key: "pioneer",
        name: "Pioneer",
        description: "First 100 roads",
        category: "exploration",
        tier: "bronze",
        earned_at: "2026-01-01T00:00:00Z",
        progress: { current: 100, bronze: 100, silver: 250, gold: 500 },
      },
    ];
    apiGet.mockResolvedValueOnce(ok(badges));
    const result = await fetchPublicBadges("rider-1");
    expect(result).toEqual({ status: "ok", badges });
  });

  it("REPORTS an errored badges endpoint instead of an empty list", async () => {
    // Resolving to `[]` made the caller render "No badges earned yet" — a
    // claim about the rider — off a 500, and left every caller's error
    // handling unreachable because nothing but an abort ever rejected.
    apiGet.mockResolvedValueOnce(fail(500));
    expect(await fetchPublicBadges("rider-1")).toEqual({ status: "failed" });
  });

  it("REPORTS a network exception the same way", async () => {
    apiGet.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    expect(await fetchPublicBadges("rider-1")).toEqual({ status: "failed" });
  });

  it("REPORTS a 200 with no body", async () => {
    apiGet.mockResolvedValueOnce({ data: undefined, error: undefined });
    expect(await fetchPublicBadges("rider-1")).toEqual({ status: "failed" });
  });

  it("re-throws AbortError so cancelled effects don't poison state", async () => {
    apiGet.mockRejectedValueOnce(
      Object.assign(new Error("aborted"), { name: "AbortError" }),
    );
    await expect(fetchPublicBadges("rider-1")).rejects.toMatchObject({
      name: "AbortError",
    });
  });
});

describe("follow / unfollow", () => {
  it("POSTs follow requests through the typed client", async () => {
    apiPost.mockResolvedValueOnce(ok(undefined));
    await expect(followRider("rider-1")).resolves.toBeUndefined();
    expect(apiPost).toHaveBeenCalledWith(
      "/api/v1/users/{userId}/follow",
      expect.objectContaining({
        params: { path: { userId: "rider-1" } },
      }),
    );
  });

  it("treats 409 already-following as success", async () => {
    apiPost.mockResolvedValueOnce(fail(409));
    await expect(followRider("rider-1")).resolves.toBeUndefined();
  });

  it("treats 404 not-following as success on unfollow", async () => {
    apiDelete.mockResolvedValueOnce(fail(404));
    await expect(unfollowRider("rider-1")).resolves.toBeUndefined();
  });

  it("rejects on other non-OK statuses", async () => {
    apiPost.mockResolvedValueOnce(fail(500));
    await expect(followRider("rider-1")).rejects.toBeInstanceOf(ApiError);
  });
});
