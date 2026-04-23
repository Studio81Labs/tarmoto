import {
  buildSocialBridgePassword,
  exchangeOAuthUserForBackendTokens,
} from "@/lib/social-auth-bridge";

describe("social auth bridge", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("derives a stable backend password from the normalized email", () => {
    expect(buildSocialBridgePassword(" Rider@Example.com ", "secret-key")).toBe(
      buildSocialBridgePassword("rider@example.com", "secret-key"),
    );
  });

  it("registers a new OAuth rider against the backend", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          access_token: "access-token",
          refresh_token: "refresh-token",
          expires_in: 3600,
          user: {
            id: "user-1",
            email: "rider@example.com",
            display_name: "Rider One",
            created_at: "2026-04-23T10:00:00.000Z",
          },
        }),
        {
          status: 201,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );

    const result = await exchangeOAuthUserForBackendTokens(
      {
        email: "rider@example.com",
        displayName: "Rider One",
      },
      {
        apiBaseServer: "https://api.example.com/api/v1",
        bridgeSecret: "secret-key",
      },
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.com/api/v1/auth/register",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
      }),
    );
    expect(
      JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body ?? "")),
    ).toEqual({
      email: "rider@example.com",
      display_name: "Rider One",
      password: buildSocialBridgePassword("rider@example.com", "secret-key"),
    });
    expect(result.access_token).toBe("access-token");
  });

  it("falls back to backend login when the social account already exists", async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ message: "Email already registered" }), {
          status: 409,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: "access-token",
            refresh_token: "refresh-token",
            expires_in: 3600,
            user: {
              id: "user-1",
              email: "rider@example.com",
              display_name: "Rider One",
              created_at: "2026-04-23T10:00:00.000Z",
            },
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      );

    const result = await exchangeOAuthUserForBackendTokens(
      {
        email: "rider@example.com",
        displayName: "Rider One",
      },
      {
        apiBaseServer: "https://api.example.com/api/v1",
        bridgeSecret: "secret-key",
      },
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://api.example.com/api/v1/auth/login",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
      }),
    );
    expect(
      JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body ?? "")),
    ).toEqual({
      email: "rider@example.com",
      password: buildSocialBridgePassword("rider@example.com", "secret-key"),
    });
    expect(result.refresh_token).toBe("refresh-token");
  });

  it("throws a clear collision error when the email already belongs to a password account", async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ message: "Email already registered" }), {
          status: 409,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ message: "Invalid credentials" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        }),
      );

    await expect(
      exchangeOAuthUserForBackendTokens(
        {
          email: "rider@example.com",
          displayName: "Rider One",
        },
        {
          apiBaseServer: "https://api.example.com/api/v1",
          bridgeSecret: "secret-key",
        },
      ),
    ).rejects.toThrow(
      "This email already has a Tarmoto password account. Sign in with your password instead.",
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
