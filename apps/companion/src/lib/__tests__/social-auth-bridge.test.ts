import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildSocialBridgePassword,
  exchangeOAuthUserForBackendTokens,
} from "@/lib/social-auth-bridge";
import { apiServer } from "@/lib/api/server";

vi.mock("@/lib/api/server", () => ({
  apiServer: { POST: vi.fn() },
}));

const post = vi.mocked(apiServer.POST);

// Build an openapi-fetch-style result: 2xx populates `data`, otherwise `error`.
function result(status: number, body: unknown) {
  const ok = status >= 200 && status < 300;
  return {
    data: ok ? body : undefined,
    error: ok ? undefined : body,
    response: new Response(null, { status }),
    // The bridge only reads `data` / `error` / `response.ok` / `response.status`.
  } as unknown as Awaited<ReturnType<typeof apiServer.POST>>;
}

const AUTH_RESPONSE = {
  access_token: "access-token",
  refresh_token: "refresh-token",
  expires_in: 3600,
  user: {
    id: "user-1",
    email: "rider@example.com",
    display_name: "Rider One",
    created_at: "2026-04-23T10:00:00.000Z",
  },
};

describe("social auth bridge", () => {
  beforeEach(() => {
    post.mockReset();
  });

  it("derives a stable backend password from the normalized email", async () => {
    expect(
      await buildSocialBridgePassword(" Rider@Example.com ", "secret-key"),
    ).toBe(await buildSocialBridgePassword("rider@example.com", "secret-key"));
  });

  it("registers a new OAuth rider against the backend", async () => {
    post.mockResolvedValueOnce(result(201, AUTH_RESPONSE));

    const authResult = await exchangeOAuthUserForBackendTokens(
      { email: "rider@example.com", displayName: "Rider One" },
      { bridgeSecret: "secret-key" },
    );

    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith("/api/v1/auth/register", {
      body: {
        email: "rider@example.com",
        password: await buildSocialBridgePassword(
          "rider@example.com",
          "secret-key",
        ),
        display_name: "Rider One",
      },
    });
    expect(authResult.access_token).toBe("access-token");
  });

  it("forwards the callback locale when registering a new OAuth rider", async () => {
    post.mockResolvedValueOnce(result(201, AUTH_RESPONSE));

    await exchangeOAuthUserForBackendTokens(
      { email: "rider@example.com", displayName: "Rider One" },
      { bridgeSecret: "secret-key", locale: "en" },
    );

    expect(post).toHaveBeenCalledWith("/api/v1/auth/register", {
      body: {
        email: "rider@example.com",
        password: await buildSocialBridgePassword(
          "rider@example.com",
          "secret-key",
        ),
        display_name: "Rider One",
      },
      headers: { "Accept-Language": "en" },
    });
  });

  it("falls back to backend login when the social account already exists", async () => {
    post
      .mockResolvedValueOnce(
        result(409, { message: "Email already registered" }),
      )
      .mockResolvedValueOnce(result(200, AUTH_RESPONSE));

    const authResult = await exchangeOAuthUserForBackendTokens(
      { email: "rider@example.com", displayName: "Rider One" },
      { bridgeSecret: "secret-key" },
    );

    expect(post).toHaveBeenCalledTimes(2);
    expect(post).toHaveBeenNthCalledWith(2, "/api/v1/auth/login", {
      body: {
        email: "rider@example.com",
        password: await buildSocialBridgePassword(
          "rider@example.com",
          "secret-key",
        ),
      },
    });
    expect(authResult.refresh_token).toBe("refresh-token");
  });

  it("throws a clear collision error when the email already belongs to a password account", async () => {
    post
      .mockResolvedValueOnce(
        result(409, { message: "Email already registered" }),
      )
      .mockResolvedValueOnce(result(401, { message: "Invalid credentials" }));

    await expect(
      exchangeOAuthUserForBackendTokens(
        { email: "rider@example.com", displayName: "Rider One" },
        { bridgeSecret: "secret-key" },
      ),
    ).rejects.toThrow(
      "This email already has a Tarmoto password account. Sign in with your password instead.",
    );

    expect(post).toHaveBeenCalledTimes(2);
  });
});
