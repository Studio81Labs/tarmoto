import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";
import { POST } from "./route";
import { auth } from "@/lib/auth";
import { apiServer } from "@/lib/api/server";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/api/server", () => ({ apiServer: { PATCH: vi.fn() } }));

// `auth` is overloaded (bare call in Server Components/Route Handlers vs.
// wrapping a `NextMiddleware` in `middleware.ts`); `vi.mocked` only sees the
// last overload, so cast to the signature this route actually calls before
// wrapping it — a type-only cast, the mock itself is still the same `vi.fn()`.
const mockedAuth = vi.mocked(auth as unknown as () => Promise<Session | null>);
const patch = vi.mocked(apiServer.PATCH);

const AUTHENTICATED_SESSION: Session = {
  user: {
    id: "user-1",
    email: "rider@example.com",
    displayName: "Rider One",
  },
  accessToken: "access-token-abc",
  expires: "2099-01-01T00:00:00.000Z",
};

// Mirrors `LOCALE_SYNC_TIMEOUT_MS` in route.ts. Kept as a separate local
// constant rather than imported: route.ts intentionally exports only the
// HTTP handler and Next.js route-config fields, not internal constants.
const SYNC_TIMEOUT_MS = 3000;

function postRequest(locale: unknown) {
  return new Request("http://localhost/api/locale", {
    method: "POST",
    body: JSON.stringify({ locale }),
  });
}

// Build an openapi-fetch-style result: 2xx populates `data`, otherwise `error`.
function patchResult(status: number, body: unknown = {}) {
  const ok = status >= 200 && status < 300;
  return {
    data: ok ? body : undefined,
    error: ok ? undefined : body,
    response: new Response(null, { status }),
  } as unknown as Awaited<ReturnType<typeof apiServer.PATCH>>;
}

describe("POST /api/locale", () => {
  beforeEach(() => {
    mockedAuth.mockReset();
    patch.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("persists the language to the user record when the request is authenticated", async () => {
    mockedAuth.mockResolvedValueOnce(AUTHENTICATED_SESSION);
    patch.mockResolvedValueOnce(patchResult(200, { language: "en" }));

    const response = await POST(postRequest("en"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ locale: "en" });
    expect(response.cookies.get("tarmoto-locale")?.value).toBe("en");

    expect(patch).toHaveBeenCalledTimes(1);
    expect(patch).toHaveBeenCalledWith("/api/v1/users/me", {
      body: { language: "en" },
      headers: { Authorization: "Bearer access-token-abc" },
      signal: expect.any(AbortSignal),
    });
  });

  it("bounds the backend sync call with a timeout signal so a hanging backend can't block the cookie response", async () => {
    mockedAuth.mockResolvedValueOnce(AUTHENTICATED_SESSION);
    patch.mockResolvedValueOnce(patchResult(200, { language: "en" }));

    await POST(postRequest("en"));

    expect(patch).toHaveBeenCalledTimes(1);
    // `patch.mock.calls[0]` is typed against the generic, overloaded
    // `ClientMethod` signature, which collapses the options arg to `never`
    // outside of a resolved call — a type-only cast to the shape we care
    // about here, same rationale as the `mockedAuth` cast above.
    const [, opts] = patch.mock.calls[0] as unknown as [
      string,
      { signal?: AbortSignal },
    ];
    expect(opts.signal).toBeInstanceOf(AbortSignal);
  });

  it("returns the cookie response even when auth() hangs indefinitely (e.g. stuck refreshing an expired token)", async () => {
    vi.useFakeTimers();
    // For a session mid-refresh, `auth()` runs the NextAuth JWT callback →
    // `dedupedRefresh()` → a backend call with no abort signal of its own.
    // If that backend call hangs, `auth()` itself never resolves — simulate
    // the worst case with a promise that never settles, and prove the outer
    // race in `POST` still bounds the total wait.
    mockedAuth.mockReturnValueOnce(new Promise<Session | null>(() => {}));

    const responsePromise = POST(postRequest("en"));
    await vi.advanceTimersByTimeAsync(SYNC_TIMEOUT_MS + 1);
    const response = await responsePromise;

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ locale: "en" });
    expect(response.cookies.get("tarmoto-locale")?.value).toBe("en");
    expect(patch).not.toHaveBeenCalled();
  });

  it("does not fire a stale PATCH when auth() only resolves after the sync deadline already fired", async () => {
    vi.useFakeTimers();
    // Simulate request A: its `auth()` (e.g. a token refresh) stalls past the
    // deadline. Unlike the "hangs indefinitely" test above, this `auth()`
    // eventually resolves — but only after `POST` has already returned,
    // which is exactly when a second, faster request could have persisted a
    // newer locale. The fix must block this request from PATCHing at all.
    let releaseAuth!: (session: Session | null) => void;
    mockedAuth.mockReturnValueOnce(
      new Promise<Session | null>((resolve) => {
        releaseAuth = resolve;
      }),
    );

    const responsePromise = POST(postRequest("en"));
    await vi.advanceTimersByTimeAsync(SYNC_TIMEOUT_MS + 1);
    const response = await responsePromise;

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ locale: "en" });
    expect(response.cookies.get("tarmoto-locale")?.value).toBe("en");

    // Only now does the stalled auth() resolve — after the deadline already
    // aborted the controller. The `signal.aborted` guard must stop the PATCH.
    releaseAuth(AUTHENTICATED_SESSION);
    await vi.advanceTimersByTimeAsync(0);

    expect(patch).not.toHaveBeenCalled();
  });

  it("does not call the backend when unauthenticated, but still sets the cookie", async () => {
    mockedAuth.mockResolvedValueOnce(null);

    const response = await POST(postRequest("en"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ locale: "en" });
    expect(response.cookies.get("tarmoto-locale")?.value).toBe("en");

    expect(patch).not.toHaveBeenCalled();
  });

  it("swallows a backend rejection and still returns the cookie-set success response", async () => {
    mockedAuth.mockResolvedValueOnce(AUTHENTICATED_SESSION);
    patch.mockRejectedValueOnce(new Error("backend unreachable"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await POST(postRequest("en"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ locale: "en" });
    expect(response.cookies.get("tarmoto-locale")?.value).toBe("en");
    expect(errorSpy).toHaveBeenCalledWith(
      "Failed to persist language to user record",
      expect.any(Error),
    );

    errorSpy.mockRestore();
  });

  it("swallows a non-2xx backend response and still returns the cookie-set success response", async () => {
    mockedAuth.mockResolvedValueOnce(AUTHENTICATED_SESSION);
    patch.mockResolvedValueOnce(patchResult(401, { message: "Unauthorized" }));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await POST(postRequest("en"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ locale: "en" });
    expect(response.cookies.get("tarmoto-locale")?.value).toBe("en");
    expect(errorSpy).toHaveBeenCalledWith(
      "Failed to persist language to user record",
      { message: "Unauthorized" },
    );

    errorSpy.mockRestore();
  });

  it("swallows an auth() rejection and still returns the cookie-set success response", async () => {
    mockedAuth.mockRejectedValueOnce(new Error("token refresh failed"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await POST(postRequest("en"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ locale: "en" });
    expect(response.cookies.get("tarmoto-locale")?.value).toBe("en");
    expect(errorSpy).toHaveBeenCalledWith(
      "Failed to persist language to user record",
      expect.any(Error),
    );
    expect(patch).not.toHaveBeenCalled();

    errorSpy.mockRestore();
  });

  it("still rejects an unsupported locale with 400, without checking auth or touching the backend", async () => {
    const response = await POST(postRequest("xx"));

    expect(response.status).toBe(400);
    expect(mockedAuth).not.toHaveBeenCalled();
    expect(patch).not.toHaveBeenCalled();
  });
});
