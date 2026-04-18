import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Badge, Bike, RiderStats } from "../types";
import {
  buildDemoProfile,
  buildStatTiles,
  countEarnedBadges,
  fetchRiderProfile,
  followRider,
  formatCount,
  formatHours,
  formatJoinedLabel,
  formatKm,
  initialsFromName,
  pickShowcaseBike,
  RiderProfileFetchError,
  RiderProfileNotFoundError,
  sortBadges,
  unfollowRider,
} from "../rider-profile";

const FIXED_NOW = new Date("2026-04-18T00:00:00Z");

function bike(overrides: Partial<Bike> & { id: string }): Bike {
  return {
    make: "Yamaha",
    model: "MT-07",
    year: 2022,
    isActive: false,
    totalKm: 1000,
    ...overrides,
  };
}

function stats(overrides: Partial<RiderStats> = {}): RiderStats {
  return {
    totalKm: 1234,
    totalRides: 56,
    totalHours: 90,
    roadsDiscovered: 42,
    hazardsReported: 7,
    joinedAt: "2024-04-18T00:00:00Z",
    ...overrides,
  };
}

describe("formatKm", () => {
  it("rounds small distances to whole kilometres", () => {
    expect(formatKm(4)).toBe("4 km");
    expect(formatKm(12.7)).toBe("13 km");
  });

  it("uses k notation with one decimal between 1000 and 10000", () => {
    expect(formatKm(1234)).toBe("1.2k km");
    expect(formatKm(9499)).toBe("9.5k km");
  });

  it("drops the decimal past ten thousand", () => {
    expect(formatKm(12_340)).toBe("12k km");
    expect(formatKm(100_000)).toBe("100k km");
  });

  it("promotes values that would round up to 10.0 into the integer branch", () => {
    // Without the guard 9,950 would render "10.0k km" immediately before
    // 10,000 renders "10k km" — visually inconsistent for neighbours.
    expect(formatKm(9_950)).toBe("10k km");
    expect(formatKm(9_999)).toBe("10k km");
  });
});

describe("formatCount", () => {
  it("locale-formats small counts", () => {
    expect(formatCount(5)).toBe("5");
    expect(formatCount(999)).toBe("999");
  });

  it("switches to k for larger counts", () => {
    expect(formatCount(1_500)).toBe("1.5k");
    expect(formatCount(25_000)).toBe("25k");
  });

  it("avoids the 9,950 → '10.0k' vs 10,000 → '10k' discontinuity", () => {
    expect(formatCount(9_950)).toBe("10k");
  });
});

describe("formatHours", () => {
  it("shows minutes under one hour", () => {
    expect(formatHours(0.5)).toBe("30 min");
  });

  it("shows one-decimal hours up to 100", () => {
    expect(formatHours(12.5)).toBe("12.5 h");
  });

  it("rounds large hour counts", () => {
    expect(formatHours(412.7)).toBe("413 h");
  });

  it("promotes values that would render as '100.0' into the integer branch", () => {
    expect(formatHours(99.97)).toBe("100 h");
    expect(formatHours(100)).toBe("100 h");
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
    expect(formatJoinedLabel("2026-03-01T00:00:00Z", FIXED_NOW)).toBe(
      "Joined 1 month ago",
    );
  });

  it("switches to years once over twelve months", () => {
    expect(formatJoinedLabel("2024-04-01T00:00:00Z", FIXED_NOW)).toBe(
      "Joined 2 years ago",
    );
    expect(formatJoinedLabel("2025-03-01T00:00:00Z", FIXED_NOW)).toBe(
      "Joined 1 year ago",
    );
  });

  it("degrades gracefully for bad dates", () => {
    expect(formatJoinedLabel("not-a-date", FIXED_NOW)).toBe("Joined recently");
  });

  it("does not count a partial month as a full month", () => {
    // Joined Mar 20, now Apr 18 — 29 days, not a full calendar month.
    expect(formatJoinedLabel("2026-03-20T00:00:00Z", FIXED_NOW)).toBe(
      "Joined this month",
    );
  });

  it("clamps future join dates so we never display negative ages", () => {
    expect(formatJoinedLabel("2026-06-01T00:00:00Z", FIXED_NOW)).toBe(
      "Joined this month",
    );
  });
});

describe("buildStatTiles", () => {
  it("produces tiles in the documented order with formatted values", () => {
    const tiles = buildStatTiles(
      stats({ totalRides: 121, totalKm: 16_550, roadsDiscovered: 284 }),
    );
    expect(tiles.map((t) => t.key)).toEqual([
      "totalRides",
      "totalKm",
      "roadsDiscovered",
      "hazardsReported",
    ]);
    expect(tiles[0].value).toBe("121");
    expect(tiles[1].value).toBe("17k km");
    expect(tiles[2].value).toBe("284");
  });
});

describe("initialsFromName", () => {
  it("takes the first letter of the first two words", () => {
    expect(initialsFromName("Alice Doe")).toBe("AD");
    expect(initialsFromName("Alice Bob Carol")).toBe("AB");
  });

  it("handles single-word names", () => {
    expect(initialsFromName("Alice")).toBe("A");
  });

  it("does not leak 'UN' from 'undefined' when the name has leading whitespace", () => {
    expect(initialsFromName("  Alice")).toBe("A");
    expect(initialsFromName("\t\n Alice Doe")).toBe("AD");
  });

  it("falls back to '?' for empty, whitespace-only, or nullish names", () => {
    expect(initialsFromName("")).toBe("?");
    expect(initialsFromName("   ")).toBe("?");
    expect(initialsFromName(null)).toBe("?");
    expect(initialsFromName(undefined)).toBe("?");
  });
});

describe("pickShowcaseBike", () => {
  it("returns null for an empty garage", () => {
    expect(pickShowcaseBike([])).toBeNull();
  });

  it("prefers the active bike regardless of distance", () => {
    const garage = [
      bike({ id: "a", isActive: false, totalKm: 50_000 }),
      bike({ id: "b", isActive: true, totalKm: 1_000 }),
    ];
    expect(pickShowcaseBike(garage)?.id).toBe("b");
  });

  it("falls back to the highest-km bike when no active bike exists", () => {
    const garage = [
      bike({ id: "a", isActive: false, totalKm: 2_000 }),
      bike({ id: "b", isActive: false, totalKm: 9_000 }),
      bike({ id: "c", isActive: false, totalKm: 4_000 }),
    ];
    expect(pickShowcaseBike(garage)?.id).toBe("b");
  });
});

describe("sortBadges", () => {
  it("places earned badges before locked ones", () => {
    const badges: Badge[] = [
      { id: "a", name: "Alpha", description: "", icon: "compass" },
      {
        id: "b",
        name: "Bravo",
        description: "",
        icon: "mountain",
        earnedAt: "2026-01-01T00:00:00Z",
      },
    ];
    const entries = sortBadges(badges);
    expect(entries[0].badge.id).toBe("b");
    expect(entries[0].earned).toBe(true);
    expect(entries[1].earned).toBe(false);
  });

  it("orders earned badges by most-recent earn date", () => {
    const badges: Badge[] = [
      {
        id: "old",
        name: "Old",
        description: "",
        icon: "trophy",
        earnedAt: "2024-01-01T00:00:00Z",
      },
      {
        id: "new",
        name: "New",
        description: "",
        icon: "trophy",
        earnedAt: "2026-03-01T00:00:00Z",
      },
    ];
    expect(sortBadges(badges).map((e) => e.badge.id)).toEqual(["new", "old"]);
  });

  it("sorts locked badges alphabetically", () => {
    const badges: Badge[] = [
      { id: "z", name: "Zulu", description: "", icon: "trophy" },
      { id: "a", name: "Alpha", description: "", icon: "trophy" },
    ];
    expect(sortBadges(badges).map((e) => e.badge.id)).toEqual(["a", "z"]);
  });

  it("keeps ordering stable when an earned badge has an invalid date", () => {
    // A NaN getTime() used to leak into the comparator and scramble the
    // order of every earned badge. With the guard, the invalid entry
    // sorts last among earned and the rest keep their recency order.
    const badges: Badge[] = [
      {
        id: "valid-new",
        name: "New",
        description: "",
        icon: "trophy",
        earnedAt: "2026-03-01T00:00:00Z",
      },
      {
        id: "invalid",
        name: "Bad",
        description: "",
        icon: "trophy",
        earnedAt: "not-a-real-date",
      },
      {
        id: "valid-old",
        name: "Old",
        description: "",
        icon: "trophy",
        earnedAt: "2024-01-01T00:00:00Z",
      },
    ];
    expect(sortBadges(badges).map((e) => e.badge.id)).toEqual([
      "valid-new",
      "valid-old",
      "invalid",
    ]);
  });
});

describe("countEarnedBadges", () => {
  it("counts only the earned entries", () => {
    const entries = sortBadges([
      {
        id: "a",
        name: "A",
        description: "",
        icon: "c",
        earnedAt: "2026-01-01T00:00:00Z",
      },
      { id: "b", name: "B", description: "", icon: "c" },
      {
        id: "c",
        name: "C",
        description: "",
        icon: "c",
        earnedAt: "2026-02-01T00:00:00Z",
      },
    ]);
    expect(countEarnedBadges(entries)).toBe(2);
  });
});

describe("buildDemoProfile", () => {
  it("is deterministic per rider id", () => {
    const a = buildDemoProfile("rider-1");
    const b = buildDemoProfile("rider-1");
    expect(a).toEqual(b);
  });

  it("produces different display names for different ids", () => {
    const ids = ["a", "b", "c", "d", "e"];
    const names = new Set(ids.map((id) => buildDemoProfile(id).displayName));
    // Not all five need to be distinct (modulo the demo name pool), but at
    // least two variants must appear so the profile page looks different for
    // different visitors.
    expect(names.size).toBeGreaterThan(1);
  });

  it("always populates bikes, badges, collections, and recent rides", () => {
    const profile = buildDemoProfile("rider-x");
    expect(profile.bikes.length).toBeGreaterThan(0);
    expect(profile.badges.length).toBeGreaterThan(0);
    expect(profile.collections.length).toBeGreaterThan(0);
    expect(profile.recentRides.length).toBeGreaterThan(0);
    expect(profile.stats.totalRides).toBeGreaterThan(0);
  });
});

describe("fetchRiderProfile", () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("returns the normalised profile when the endpoint succeeds", async () => {
    const payload = {
      id: "rider-1",
      displayName: "Alice",
      avatarUrl: null,
      bio: "Hi",
      homeRegion: "Prague",
      bikes: [],
      stats: stats(),
      badges: [],
      isFollowing: true,
      recentRides: [],
      collections: [],
    };
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => payload,
    });
    const result = await fetchRiderProfile("rider-1");
    expect(result.fromFallback).toBe(false);
    expect(result.profile.displayName).toBe("Alice");
    expect(result.profile.isFollowing).toBe(true);
  });

  it("throws RiderProfileNotFoundError on 404", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 404, json: async () => ({}) });
    await expect(fetchRiderProfile("missing")).rejects.toBeInstanceOf(
      RiderProfileNotFoundError,
    );
  });

  it("falls back to a demo profile on network failure", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("network"));
    const result = await fetchRiderProfile("rider-2");
    expect(result.fromFallback).toBe(true);
    expect(result.profile.id).toBe("rider-2");
    expect(result.profile.bikes.length).toBeGreaterThan(0);
  });

  it("throws RiderProfileFetchError on 500-class responses", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    await expect(fetchRiderProfile("rider-3")).rejects.toBeInstanceOf(
      RiderProfileFetchError,
    );
  });

  it("re-throws AbortError rather than falling back to demo", async () => {
    const abortError = Object.assign(new Error("aborted"), {
      name: "AbortError",
    });
    global.fetch = vi.fn().mockRejectedValue(abortError);
    await expect(fetchRiderProfile("rider-abort")).rejects.toMatchObject({
      name: "AbortError",
    });
  });

  it("throws RiderProfileFetchError on 403 rather than faking a profile", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 403, json: async () => ({}) });
    await expect(fetchRiderProfile("rider-4")).rejects.toMatchObject({
      name: "RiderProfileFetchError",
      status: 403,
    });
  });

  it("forwards the access token as a bearer header when provided", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: "r", displayName: "R" }),
    });
    global.fetch = fetchMock;
    await fetchRiderProfile("r", { accessToken: "token-123" });
    const [, init] = fetchMock.mock.calls[0];
    expect(
      (init as RequestInit).headers as Record<string, string>,
    ).toMatchObject({ Authorization: "Bearer token-123" });
  });

  it("URL-encodes riderId so ids containing slashes or spaces stay on the right endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: "rider", displayName: "R" }),
    });
    global.fetch = fetchMock;
    await fetchRiderProfile("rider/with space");
    const [url] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/community/riders/rider%2Fwith%20space");
  });

  it("does not fall back when a 200 body is malformed JSON", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError("Unexpected token");
      },
    });
    await expect(fetchRiderProfile("rider-bad-json")).rejects.toMatchObject({
      name: "RiderProfileFetchError",
    });
  });

  it("sanitises non-finite numbers in the stats payload", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        id: "r",
        displayName: "R",
        stats: {
          totalKm: Number.NaN,
          totalRides: 5,
          totalHours: Number.POSITIVE_INFINITY,
          roadsDiscovered: 10,
          hazardsReported: -3,
          joinedAt: "not-a-date",
        },
      }),
    });
    const { profile } = await fetchRiderProfile("r");
    expect(Number.isFinite(profile.stats.totalKm)).toBe(true);
    expect(Number.isFinite(profile.stats.totalHours)).toBe(true);
    expect(profile.stats.totalRides).toBe(5);
    expect(profile.stats.hazardsReported).toBe(-3);
    // Invalid ISO strings are replaced with the fallback date, not the raw.
    expect(profile.stats.joinedAt).not.toBe("not-a-date");
  });
});

describe("follow / unfollow", () => {
  const originalFetch = global.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof global.fetch;
  });
  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("POSTs follow requests and resolves on 201", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 201 });
    await expect(followRider("rider-1", "tok")).resolves.toBeUndefined();
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/users\/rider-1\/follow$/);
    expect((init as RequestInit).method).toBe("POST");
  });

  it("treats 409 already-following as success", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 409 });
    await expect(followRider("rider-1", null)).resolves.toBeUndefined();
  });

  it("treats 404 not-following as success on unfollow", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 404 });
    await expect(unfollowRider("rider-1", null)).resolves.toBeUndefined();
    const [, init] = fetchMock.mock.calls[0];
    expect((init as RequestInit).method).toBe("DELETE");
  });

  it("URL-encodes riderId in the follow path", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 201 });
    await followRider("rider/with space", null);
    const [url] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/users/rider%2Fwith%20space/follow");
  });

  it("rejects on other non-ok statuses", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500 });
    await expect(followRider("rider-1", null)).rejects.toThrow(
      /Follow request failed/,
    );
  });
});
