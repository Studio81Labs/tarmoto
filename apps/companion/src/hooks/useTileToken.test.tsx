import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { TILE_TOKEN_MINT_RETRY_MS } from "@tarmoto/shared";
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

    await waitFor(() => expect(result.current).toBe(true));
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

    await waitFor(() => expect(result.current).toBe(false));
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

    await waitFor(() => expect(result.current).toBe(false));
    expect(getTileToken()).toBeNull();
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
    await waitFor(() => expect(result.current).toBe(true));

    vi.setSystemTime(Date.now() + 61_000);
    // Expiry is detected on read — the request transform is what reads it.
    getTileToken();

    await waitFor(() => expect(result.current).toBe(false));
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
    expect(result.current).toBe(false);

    postMock.mockResolvedValue(minted("tok-recovered"));
    await vi.advanceTimersByTimeAsync(TILE_TOKEN_MINT_RETRY_MS + 1_000);

    await waitFor(() => expect(getTileToken()).toBe("tok-recovered"));
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
