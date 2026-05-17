import { afterEach, describe, expect, it, vi } from "vitest";
import { _resetRefreshDedupForTests, dedupedRefresh } from "@/lib/auth-refresh";
import type { BackendAuthResponse } from "@/lib/social-auth-bridge";

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
    },
    ...overrides,
  } as BackendAuthResponse;
}

afterEach(() => {
  _resetRefreshDedupForTests();
  vi.useRealTimers();
});

describe("dedupedRefresh", () => {
  it("collapses concurrent refreshes for the same user into one backend call", async () => {
    const refresh = vi.fn(async () => mockResponse());

    const results = await Promise.all([
      dedupedRefresh("user-1", "RT-old", { refresh, graceMs: 0 }),
      dedupedRefresh("user-1", "RT-old", { refresh, graceMs: 0 }),
      dedupedRefresh("user-1", "RT-old", { refresh, graceMs: 0 }),
    ]);

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(results).toHaveLength(3);
    expect(results.every((r) => r.access_token === "AT-new")).toBe(true);
  });

  it("different users don't share the in-flight promise", async () => {
    const refresh = vi.fn(async (rt: string) =>
      mockResponse({ refresh_token: `new-${rt}` }),
    );

    const [a, b] = await Promise.all([
      dedupedRefresh("user-1", "RT-1", { refresh, graceMs: 0 }),
      dedupedRefresh("user-2", "RT-2", { refresh, graceMs: 0 }),
    ]);

    expect(refresh).toHaveBeenCalledTimes(2);
    expect(a.refresh_token).toBe("new-RT-1");
    expect(b.refresh_token).toBe("new-RT-2");
  });

  it("starts a fresh refresh after a previous one settles (no grace)", async () => {
    const refresh = vi.fn(async () => mockResponse());

    await dedupedRefresh("user-1", "RT-old", { refresh, graceMs: 0 });
    await dedupedRefresh("user-1", "RT-new", { refresh, graceMs: 0 });

    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("reuses the cached entry within the grace window after a settled refresh", async () => {
    vi.useFakeTimers();
    const refresh = vi.fn(async () => mockResponse());

    // First refresh, settles immediately
    await dedupedRefresh("user-1", "RT-old", { refresh, graceMs: 1_000 });
    expect(refresh).toHaveBeenCalledTimes(1);

    // Within grace — should share the cached promise instead of
    // hitting the backend with a stale RT-old.
    await dedupedRefresh("user-1", "RT-old", { refresh, graceMs: 1_000 });
    expect(refresh).toHaveBeenCalledTimes(1);

    // Advance past the grace window
    await vi.advanceTimersByTimeAsync(1_100);

    // Now a fresh refresh should fire
    await dedupedRefresh("user-1", "RT-newer", {
      refresh,
      graceMs: 1_000,
    });
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("propagates errors to all concurrent callers and clears the entry", async () => {
    const refresh = vi.fn(async () => {
      throw new Error("backend 429");
    });

    const results = await Promise.allSettled([
      dedupedRefresh("user-1", "RT-old", { refresh, graceMs: 0 }),
      dedupedRefresh("user-1", "RT-old", { refresh, graceMs: 0 }),
    ]);

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(results.every((r) => r.status === "rejected")).toBe(true);

    // Subsequent call should start a fresh refresh because the
    // previous one failed (and graceMs=0 evicted synchronously).
    refresh.mockImplementationOnce(async () => mockResponse());
    const recovered = await dedupedRefresh("user-1", "RT-old", {
      refresh,
      graceMs: 0,
    });
    expect(recovered.access_token).toBe("AT-new");
    expect(refresh).toHaveBeenCalledTimes(2);
  });
});
