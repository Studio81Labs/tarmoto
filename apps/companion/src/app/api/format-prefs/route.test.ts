import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";
import { POST } from "./route";
import { auth } from "@/lib/auth";
import { apiServer } from "@/lib/api/server";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/api/server", () => ({ apiServer: { PATCH: vi.fn() } }));

// Same type-only cast rationale as api/locale/route.test.ts: `auth` is
// overloaded and vi.mocked only sees the last overload.
const mockedAuth = vi.mocked(auth as unknown as () => Promise<Session | null>);
const patch = vi.mocked(apiServer.PATCH);

const AUTHENTICATED_SESSION: Session = {
  user: {
    id: "user-1",
    email: "rider@example.com",
    displayName: "Rider One",
    language: "en",
  },
  accessToken: "access-token-abc",
  expires: "2099-01-01T00:00:00.000Z",
};

// Mirrors FORMAT_PREFS_SYNC_TIMEOUT_MS in route.ts (internal constant).
const SYNC_TIMEOUT_MS = 3000;

function postRequest(body: unknown) {
  return new Request("http://localhost/api/format-prefs", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

function patchResult(status: number, body: unknown = {}) {
  const ok = status >= 200 && status < 300;
  return {
    data: ok ? body : undefined,
    error: ok ? undefined : body,
    response: new Response(null, { status }),
  } as unknown as Awaited<ReturnType<typeof apiServer.PATCH>>;
}

const VALID = { format_locale: "cs-CZ", timezone: "Europe/Prague" };

describe("POST /api/format-prefs", () => {
  beforeEach(() => {
    mockedAuth.mockReset();
    patch.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sets both cookies and persists to the user record when authenticated", async () => {
    mockedAuth.mockResolvedValueOnce(AUTHENTICATED_SESSION);
    patch.mockResolvedValueOnce(patchResult(200, {}));

    const response = await POST(postRequest(VALID));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(VALID);
    expect(response.cookies.get("tarmoto-format-locale")?.value).toBe("cs-CZ");
    expect(response.cookies.get("tarmoto-timezone")?.value).toBe(
      "Europe/Prague",
    );

    expect(patch).toHaveBeenCalledTimes(1);
    expect(patch).toHaveBeenCalledWith("/api/v1/users/me", {
      body: {
        preferences: { format_locale: "cs-CZ", timezone: "Europe/Prague" },
      },
      headers: { Authorization: "Bearer access-token-abc" },
      signal: expect.any(AbortSignal),
    });
  });

  it("canonicalizes the locale before storing and echoing it", async () => {
    mockedAuth.mockResolvedValueOnce(null);

    const response = await POST(
      postRequest({ format_locale: "CS-cz", timezone: "Europe/Prague" }),
    );

    expect(response.status).toBe(200);
    expect(response.cookies.get("tarmoto-format-locale")?.value).toBe("cs-CZ");
    await expect(response.json()).resolves.toMatchObject({
      format_locale: "cs-CZ",
    });
  });

  it("does not call the backend when unauthenticated, but still sets cookies", async () => {
    mockedAuth.mockResolvedValueOnce(null);

    const response = await POST(postRequest(VALID));

    expect(response.status).toBe(200);
    expect(response.cookies.get("tarmoto-format-locale")?.value).toBe("cs-CZ");
    expect(patch).not.toHaveBeenCalled();
  });

  it("returns the cookie response even when auth() hangs indefinitely", async () => {
    vi.useFakeTimers();
    mockedAuth.mockReturnValueOnce(new Promise<Session | null>(() => {}));

    const responsePromise = POST(postRequest(VALID));
    await vi.advanceTimersByTimeAsync(SYNC_TIMEOUT_MS + 1);
    const response = await responsePromise;

    expect(response.status).toBe(200);
    expect(response.cookies.get("tarmoto-timezone")?.value).toBe(
      "Europe/Prague",
    );
    expect(patch).not.toHaveBeenCalled();
  });

  it("does not fire a stale PATCH when auth() resolves after the deadline", async () => {
    vi.useFakeTimers();
    let releaseAuth!: (session: Session | null) => void;
    mockedAuth.mockReturnValueOnce(
      new Promise<Session | null>((resolve) => {
        releaseAuth = resolve;
      }),
    );

    const responsePromise = POST(postRequest(VALID));
    await vi.advanceTimersByTimeAsync(SYNC_TIMEOUT_MS + 1);
    await responsePromise;

    releaseAuth(AUTHENTICATED_SESSION);
    await vi.advanceTimersByTimeAsync(0);

    expect(patch).not.toHaveBeenCalled();
  });

  it("swallows backend failures and still returns the cookie-set response", async () => {
    mockedAuth.mockResolvedValueOnce(AUTHENTICATED_SESSION);
    patch.mockRejectedValueOnce(new Error("backend unreachable"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await POST(postRequest(VALID));

    expect(response.status).toBe(200);
    expect(response.cookies.get("tarmoto-format-locale")?.value).toBe("cs-CZ");
    expect(errorSpy).toHaveBeenCalledWith(
      "Failed to persist format preferences to user record",
      expect.any(Error),
    );

    errorSpy.mockRestore();
  });

  it("rejects an invalid format_locale with 400, before auth or backend", async () => {
    const response = await POST(
      postRequest({ format_locale: "!!bad!!", timezone: "Europe/Prague" }),
    );
    expect(response.status).toBe(400);
    expect(mockedAuth).not.toHaveBeenCalled();
    expect(patch).not.toHaveBeenCalled();
  });

  it("rejects an invalid or missing timezone with 400", async () => {
    expect(
      (
        await POST(
          postRequest({ format_locale: "cs-CZ", timezone: "Mars/Olympus" }),
        )
      ).status,
    ).toBe(400);
    expect((await POST(postRequest({ format_locale: "cs-CZ" }))).status).toBe(
      400,
    );
    expect((await POST(postRequest(null))).status).toBe(400);
  });
});
