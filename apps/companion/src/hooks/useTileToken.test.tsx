import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { TILE_TOKEN_MINT_RETRY_MS, tileTokenRotationMs } from "@tarmoto/shared";
import { QueryClient } from "@tanstack/react-query";
import { withQueryClient } from "./test-utils";

const postMock = vi.fn();
vi.mock("@/lib/api", () => ({
  api: { POST: (...a: unknown[]) => postMock(...a) },
}));

const session = {
  accessToken: null as string | null,
  userId: null as string | null,
};
vi.mock("@/stores/auth", () => ({
  useAuthStore: (
    sel: (s: {
      accessToken: string | null;
      user: { id: string } | null;
    }) => unknown,
  ) =>
    sel({
      accessToken: session.accessToken,
      user: session.userId === null ? null : { id: session.userId },
    }),
}));

import {
  __resetTileTokenForTest,
  getTileToken,
  useTileTokenSync,
} from "./useTileToken";

const minted = (token: string, expiresIn = 900) => ({
  data: { token, expires_in: expiresIn },
  error: undefined,
});

describe("useTileTokenSync (#1279)", () => {
  beforeEach(() => {
    postMock.mockReset();
    __resetTileTokenForTest();
    session.accessToken = "access-token";
    session.userId = "rider-1";
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("mints a credential for a signed-in rider and publishes it", async () => {
    postMock.mockResolvedValue(minted("tok-1"));

    const { result } = renderHook(() => useTileTokenSync(), {
      wrapper: withQueryClient(),
    });

    await waitFor(() => expect(result.current).toBe("rider-1"));
    expect(postMock).toHaveBeenCalledWith("/api/v1/roads/tiles/token", {
      signal: expect.anything(),
    });
    expect(getTileToken()).toBe("tok-1");
  });

  it("never mints for a signed-out visitor", async () => {
    session.accessToken = null;
    session.userId = null;

    const { result } = renderHook(() => useTileTokenSync(), {
      wrapper: withQueryClient(),
    });

    await waitFor(() => expect(result.current).toBeNull());
    expect(postMock).not.toHaveBeenCalled();
    // Anonymous tiles are the correct free-tier view, not a failure.
    expect(getTileToken()).toBeNull();
  });

  it("retires the credential the moment the session ends", async () => {
    postMock.mockResolvedValue(minted("tok-1"));
    const { result, rerender } = renderHook(() => useTileTokenSync(), {
      wrapper: withQueryClient(),
    });
    await waitFor(() => expect(getTileToken()).toBe("tok-1"));

    // Cached query data outlives the session, so a shared browser must not go
    // on resolving the previous rider's zoom cap.
    session.accessToken = null;
    session.userId = null;
    rerender();

    await waitFor(() => expect(result.current).toBeNull());
    expect(getTileToken()).toBeNull();
  });

  it("reports a direct rider switch, which never passes through 'no credential'", async () => {
    // Rider A → rider B with B's token still in TanStack's cache: `data` goes
    // straight from one to the other, so a presence FLAG would stay true across
    // the switch and `MapCanvas` would keep tiles fetched under A — a free B
    // seeing A's paid deep zoom, or a paid B stuck with A's clamped empties.
    postMock.mockResolvedValue(minted("tok-a"));
    const { result, rerender } = renderHook(() => useTileTokenSync(), {
      wrapper: withQueryClient(),
    });
    await waitFor(() => expect(result.current).toBe("rider-1"));

    postMock.mockResolvedValue(minted("tok-b"));
    session.userId = "rider-2";
    rerender();

    await waitFor(() => expect(result.current).toBe("rider-2"));
    expect(getTileToken()).toBe("tok-b");
  });

  it("stops offering a credential once it has expired", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    postMock.mockResolvedValue(minted("tok-short", 60));
    renderHook(() => useTileTokenSync(), { wrapper: withQueryClient() });
    await waitFor(() => expect(getTileToken()).toBe("tok-short"));

    vi.setSystemTime(Date.now() + 61_000);

    // Not an error path: the next tile is simply fetched anonymously and the
    // backend clamps quality to the free tier.
    expect(getTileToken()).toBeNull();
  });

  it("reports an expiry as an identity transition, not just a null token", async () => {
    // The returned flag is what MapCanvas reloads its quality source on. Query
    // data survives a failed refetch by design, so a purely data-driven flag
    // would stay `true` right through an outage — and the anonymous,
    // free-capped tiles cached during it would never be reloaded.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    postMock.mockResolvedValue(minted("tok-short", 60));
    const { result } = renderHook(() => useTileTokenSync(), {
      wrapper: withQueryClient(),
    });
    await waitFor(() => expect(result.current).toBe("rider-1"));

    vi.setSystemTime(Date.now() + 61_000);
    // Expiry is detected on read — the request transform is what reads it.
    getTileToken();

    await waitFor(() => expect(result.current).toBeNull());
  });

  it("keeps retrying when the very first mint fails", async () => {
    // With no credential there is no `expires_in` to schedule from, so a query
    // that stopped polling after its retry budget would leave a rider fetching
    // tiles anonymously — paid deep zoom missing — until an unrelated reconnect
    // or remount happened to poke it.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    postMock.mockResolvedValue({ data: undefined, error: { statusCode: 503 } });

    const { result } = renderHook(() => useTileTokenSync(), {
      wrapper: withQueryClient(),
    });
    await waitFor(() => expect(postMock).toHaveBeenCalled());
    expect(result.current).toBeNull();

    postMock.mockResolvedValue(minted("tok-recovered"));
    await vi.advanceTimersByTimeAsync(TILE_TOKEN_MINT_RETRY_MS + 1_000);

    await waitFor(() => expect(getTileToken()).toBe("tok-recovered"));
  });

  it("retries on the failure cadence after a rotation fails, not the rotation one", async () => {
    // react-query retains the last success, so scheduling from it would wait
    // another full rotation: with a 15-minute token an outage that clears just
    // after the retry budget runs out would leave the map anonymous past the
    // credential's own expiry.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    postMock.mockResolvedValueOnce(minted("tok-1", 900));
    renderHook(() => useTileTokenSync(), { wrapper: withQueryClient() });
    await waitFor(() => expect(getTileToken()).toBe("tok-1"));

    // Rotation comes due and fails.
    postMock.mockResolvedValue({ data: undefined, error: { statusCode: 503 } });
    await vi.advanceTimersByTimeAsync(tileTokenRotationMs(900) + 1_000);
    const attemptsAfterFailure = postMock.mock.calls.length;
    expect(attemptsAfterFailure).toBeGreaterThan(1);

    // The next attempt lands on the retry cadence, far short of a rotation.
    postMock.mockResolvedValue(minted("tok-2", 900));
    await vi.advanceTimersByTimeAsync(TILE_TOKEN_MINT_RETRY_MS * 2);

    await waitFor(() => expect(getTileToken()).toBe("tok-2"));
  });

  it("does not renew a cached token's lifetime on remount", async () => {
    // react-query hands cached data straight back to a remounting hook, so
    // timing the lifetime from adoption would keep resurrecting an old token —
    // appended to tiles, and reported as present, long after it died.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    postMock.mockResolvedValue(minted("tok-1", 60));
    // A client that RETAINS the query across the unmount and does not refetch
    // on the remount — i.e. exactly the cached-data path.
    const wrapper = withQueryClient(
      new QueryClient({
        defaultOptions: {
          queries: { retry: false, gcTime: 5 * 60_000, refetchOnMount: false },
        },
      }),
    );

    const first = renderHook(() => useTileTokenSync(), { wrapper });
    await waitFor(() => expect(getTileToken()).toBe("tok-1"));

    // The token dies while nothing is mounted.
    first.unmount();
    vi.setSystemTime(Date.now() + 61_000);
    __resetTileTokenForTest();

    // A remount adopts the CACHED token; its deadline must be the original one.
    renderHook(() => useTileTokenSync(), { wrapper });

    expect(getTileToken()).toBeNull();
  });

  it("keeps the credential in hand when a mint fails", async () => {
    // react-query retains the last success through a failed refetch, and the
    // hook leans on that: a network blip must not drop a paying rider to the
    // free zoom cap.
    postMock.mockResolvedValueOnce(minted("tok-1"));
    const { rerender } = renderHook(() => useTileTokenSync(), {
      wrapper: withQueryClient(),
    });
    await waitFor(() => expect(getTileToken()).toBe("tok-1"));

    postMock.mockResolvedValue({ data: undefined, error: { statusCode: 503 } });
    rerender();

    expect(getTileToken()).toBe("tok-1");
  });
});
