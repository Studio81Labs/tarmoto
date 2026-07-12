import { beforeEach, describe, expect, it, vi } from "vitest";
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
    });
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
