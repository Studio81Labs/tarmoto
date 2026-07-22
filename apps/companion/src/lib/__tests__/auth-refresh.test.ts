import { afterEach, describe, expect, it, vi } from "vitest";
import {
  _resetRefreshDedupForTests,
  applyRefreshResult,
  dedupedRefresh,
} from "@/lib/auth-refresh";
import type { BackendAuthResponse } from "@/lib/social-auth-bridge";
import type { JWT } from "next-auth/jwt";

function mockResponse(
  overrides: Partial<BackendAuthResponse> = {},
): BackendAuthResponse {
  return {
    access_token: "AT-new",
    refresh_token: "RT-new",
    expires_in: 3600,
    user: {
      id: "user-1",
      email: "rider@example.com",
      display_name: "Rider",
      phone: null,
      language: "en",
    },
    ...overrides,
    // Dedup tests only read the token fields; a minimal user stands in for
    // the full `UserResponseDto` the generated `AuthResponseDto` now carries.
  } as unknown as BackendAuthResponse;
}

afterEach(() => {
  _resetRefreshDedupForTests();
  vi.useRealTimers();
});

describe("dedupedRefresh", () => {
  it("collapses concurrent refreshes for the same refresh token into one backend call", async () => {
    const refresh = vi.fn(async () => mockResponse());

    const results = await Promise.all([
      dedupedRefresh("RT-old", { refresh, graceMs: 0 }),
      dedupedRefresh("RT-old", { refresh, graceMs: 0 }),
      dedupedRefresh("RT-old", { refresh, graceMs: 0 }),
    ]);

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(results).toHaveLength(3);
    expect(results.every((r) => r.access_token === "AT-new")).toBe(true);
  });

  it("two independent sessions (different refresh tokens) don't share the in-flight promise", async () => {
    // Same rider signed in twice (laptop + phone) → two distinct
    // refresh-token chains. If we keyed by user id, the second
    // session would inherit the first session's rotated tokens,
    // including the backend's `orig_iat` max-lifetime anchor.
    const refresh = vi.fn(async (rt: string) =>
      mockResponse({ refresh_token: `new-${rt}` }),
    );

    const [a, b] = await Promise.all([
      dedupedRefresh("RT-laptop", { refresh, graceMs: 0 }),
      dedupedRefresh("RT-phone", { refresh, graceMs: 0 }),
    ]);

    expect(refresh).toHaveBeenCalledTimes(2);
    expect(a.refresh_token).toBe("new-RT-laptop");
    expect(b.refresh_token).toBe("new-RT-phone");
  });

  it("starts a fresh refresh after a previous one settles (no grace)", async () => {
    const refresh = vi.fn(async () => mockResponse());

    await dedupedRefresh("RT-old", { refresh, graceMs: 0 });
    await dedupedRefresh("RT-new", { refresh, graceMs: 0 });

    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("reuses the cached entry within the grace window after a settled refresh", async () => {
    vi.useFakeTimers();
    const refresh = vi.fn(async () => mockResponse());

    // First refresh, settles immediately
    await dedupedRefresh("RT-old", { refresh, graceMs: 1_000 });
    expect(refresh).toHaveBeenCalledTimes(1);

    // Within grace — a second tab that read the *old* cookie (same
    // RT-old) joins the cached promise instead of hitting the
    // backend with a consumed refresh token.
    await dedupedRefresh("RT-old", { refresh, graceMs: 1_000 });
    expect(refresh).toHaveBeenCalledTimes(1);

    // Advance past the grace window
    await vi.advanceTimersByTimeAsync(1_100);

    // Now a fresh refresh should fire (different RT)
    await dedupedRefresh("RT-newer", {
      refresh,
      graceMs: 1_000,
    });
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("propagates errors to all concurrent callers and clears the entry", async () => {
    // Annotate the mock signature explicitly — `vi.fn(async () => { throw … })`
    // alone infers the return type as `Promise<never>`, which then narrows
    // `mockImplementationOnce` and rejects the recovery branch below.
    const refresh = vi.fn<(rt: string) => Promise<BackendAuthResponse>>(
      async () => {
        throw new Error("backend 429");
      },
    );

    const results = await Promise.allSettled([
      dedupedRefresh("RT-old", { refresh, graceMs: 0 }),
      dedupedRefresh("RT-old", { refresh, graceMs: 0 }),
    ]);

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(results.every((r) => r.status === "rejected")).toBe(true);

    // Subsequent call should start a fresh refresh because the
    // previous one failed (and graceMs=0 evicted synchronously).
    refresh.mockImplementationOnce(async () => mockResponse());
    const recovered = await dedupedRefresh("RT-old", {
      refresh,
      graceMs: 0,
    });
    expect(recovered.access_token).toBe("AT-new");
    expect(refresh).toHaveBeenCalledTimes(2);
  });
});

describe("applyRefreshResult", () => {
  it("repairs a legacy JWT with the current account language", () => {
    const token = {
      id: "user-1",
      email: "rider@example.com",
      displayName: "Rider",
      accessToken: "AT-old",
      refreshToken: "RT-old",
      expiresAt: 1,
    } as JWT;
    const data = mockResponse({ expires_in: 3600 });

    expect(applyRefreshResult(token, data, 10_000)).toMatchObject({
      accessToken: "AT-new",
      refreshToken: "RT-new",
      expiresAt: 3610,
      language: "en",
      error: undefined,
    });
  });
});
