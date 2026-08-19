jest.mock("react-native-mmkv", () => ({
  createMMKV: () => mockCreateMemoryStorage(),
}));

jest.mock("@tarmoto/openapi-client", () => ({
  createTarmotoClient: () => ({ use: jest.fn() }),
}));

jest.mock("@/config", () => ({
  API_BASE_URL: "https://api.example.test",
}));

import {
  __getTokenPairForTest,
  __refreshAccessTokenForTest,
  __setAuthStorageForTest,
  getSessionEpoch,
  hydrateAuthTokens,
  storeTokens,
} from "../typedClient";
import type { Schemas } from "@/types";

// The backend hands back the SAME rich profile on login / register / refresh
// (toUserResponse), so a realistic refresh body carries `user` — the fixture
// used to omit it, masking that the epoch must be gated on the CALLER, not the
// body.
const RICH_USER = { id: "account-a" } as Schemas["UserResponseDto"];

interface MemoryStorage {
  getString(key: string): string | undefined;
  set(key: string, value: string): void;
  remove(key: string): void;
}

function mockCreateMemoryStorage(
  initial: Record<string, string> = {},
): MemoryStorage {
  const values = new Map(Object.entries(initial));
  return {
    getString: (key) => values.get(key),
    set: (key, value) => values.set(key, value),
    remove: (key) => {
      values.delete(key);
    },
  };
}

/**
 * Establish a signed-in session the way an upgraded install does: the legacy
 * plaintext pair sits in MMKV, `hydrateAuthTokens()` adopts it into the
 * (mocked) keychain and the in-memory cache. Exercises the #1231 migration on
 * every seeded test.
 */
async function seedSession(tokens: {
  access?: string;
  refresh?: string;
  userId?: string;
}): Promise<MemoryStorage> {
  const initial: Record<string, string> = {};
  if (tokens.access) initial.access_token = tokens.access;
  if (tokens.refresh) initial.refresh_token = tokens.refresh;
  if (tokens.userId) initial.user_id = tokens.userId;
  const storage = mockCreateMemoryStorage(initial);
  __setAuthStorageForTest(storage);
  await hydrateAuthTokens();
  return storage;
}

function keychainFake() {
  return require("react-native-keychain") as {
    __entriesForTest: Map<string, { username: string; password: string }>;
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function refreshResponse(body: Record<string, unknown>, ok = true): Response {
  return {
    ok,
    json: async () => body,
  } as Response;
}

describe("typed client token refresh", () => {
  beforeEach(() => {
    keychainFake().__entriesForTest.clear();
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("stores a successful refresh when the session is unchanged", async () => {
    const storage = await seedSession({
      access: "account-a-old-access",
      refresh: "account-a-old-refresh",
      userId: "account-a",
    });
    const epochBefore = getSessionEpoch();
    jest.spyOn(global, "fetch").mockResolvedValue(
      refreshResponse({
        access_token: "account-a-new-access",
        refresh_token: "account-a-new-refresh",
        user: RICH_USER,
      }),
    );

    await expect(__refreshAccessTokenForTest()).resolves.toBe(
      "account-a-new-access",
    );
    expect(__getTokenPairForTest()).toEqual({
      accessToken: "account-a-new-access",
      refreshToken: "account-a-new-refresh",
    });
    expect(storage.getString("user_id")).toBe("account-a");
    // The plaintext pair must not resurface in MMKV after rotation (#1231).
    expect(storage.getString("access_token")).toBeUndefined();
    expect(storage.getString("refresh_token")).toBeUndefined();
    // A rotation carries `user` but must NOT advance the epoch — else an
    // in-flight /users/me across a normal 1h token expiry would be rejected.
    expect(getSessionEpoch()).toBe(epochBefore);
  });

  it("advances the session epoch only for a login/register, not a refresh", async () => {
    await seedSession({ userId: "account-a" });
    const before = getSessionEpoch();

    // A refresh (caller omits newSession) does NOT bump.
    storeTokens({
      access_token: "a1",
      refresh_token: "r1",
      user: RICH_USER,
    } as never);
    expect(getSessionEpoch()).toBe(before);

    // A login (newSession) DOES bump.
    storeTokens(
      { access_token: "a2", refresh_token: "r2", user: RICH_USER } as never,
      { newSession: true },
    );
    expect(getSessionEpoch()).toBe(before + 1);
  });

  it("does not overwrite a replacement session with an old refresh", async () => {
    await seedSession({
      access: "account-a-access",
      refresh: "account-a-refresh",
    });
    const response = deferred<Response>();
    jest.spyOn(global, "fetch").mockReturnValue(response.promise);

    const refresh = __refreshAccessTokenForTest();
    // A different rider signs in while the old session's refresh is in flight.
    storeTokens(
      {
        access_token: "account-b-access",
        refresh_token: "account-b-refresh",
        user: { id: "account-b" } as Schemas["UserResponseDto"],
      } as never,
      { newSession: true },
    );
    response.resolve(
      refreshResponse({
        access_token: "account-a-new-access",
        refresh_token: "account-a-new-refresh",
      }),
    );

    await expect(refresh).resolves.toBeNull();
    expect(__getTokenPairForTest()).toEqual({
      accessToken: "account-b-access",
      refreshToken: "account-b-refresh",
    });
  });

  it("keeps the current session's tokens when the refresh request fails transiently (offline)", async () => {
    const storage = await seedSession({
      access: "account-a-access",
      refresh: "account-a-refresh",
      userId: "account-a",
    });
    jest.spyOn(global, "fetch").mockRejectedValue(new Error("network down"));

    await expect(__refreshAccessTokenForTest()).resolves.toBeNull();
    // A dead-zone blip must NOT sign the rider out — the session survives so a
    // later request retries once connectivity returns.
    expect(__getTokenPairForTest()).toEqual({
      accessToken: "account-a-access",
      refreshToken: "account-a-refresh",
    });
    expect(storage.getString("user_id")).toBe("account-a");
  });

  it("clears the session on a malformed 2xx refresh body (unusable response)", async () => {
    await seedSession({
      access: "account-a-access",
      refresh: "account-a-refresh",
      userId: "account-a",
    });
    // 2xx but the body can't be parsed — NOT a transient fetch failure, so it
    // must invalidate rather than retain-and-retry.
    jest.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      json: async () => {
        throw new Error("Unexpected token < in JSON");
      },
    } as unknown as Response);

    await expect(__refreshAccessTokenForTest()).resolves.toBeNull();
    expect(__getTokenPairForTest()).toEqual({
      accessToken: null,
      refreshToken: null,
    });
  });

  it("clears a partially written session when storeTokens fails mid-write", async () => {
    // The token pair itself is one atomic in-memory assignment now (#1231),
    // but storeTokens still writes the profile cache to MMKV afterwards — a
    // throw there leaves new tokens beside a stale profile/user id. The
    // refresh path must clear the mixed session entirely.
    const values = new Map<string, string>([
      ["access_token", "old-access"],
      ["refresh_token", "old-refresh"],
      ["user_id", "account-a"],
    ]);
    const storage = {
      getString: (k: string) => values.get(k),
      set: (k: string, v: string) => {
        if (k === "cached_user") throw new Error("mmkv write failed");
        values.set(k, v);
      },
      remove: (k: string) => {
        values.delete(k);
      },
    };
    __setAuthStorageForTest(storage);
    await hydrateAuthTokens();
    jest.spyOn(global, "fetch").mockResolvedValue(
      refreshResponse({
        access_token: "new-access",
        refresh_token: "new-refresh",
        user: RICH_USER,
      }),
    );

    await expect(__refreshAccessTokenForTest()).resolves.toBeNull();
    // The mixed session is cleared entirely rather than left inconsistent.
    expect(__getTokenPairForTest()).toEqual({
      accessToken: null,
      refreshToken: null,
    });
    expect(values.get("user_id")).toBeUndefined();
  });

  it.each([
    ["empty token strings", { access_token: "", refresh_token: "" }],
    ["missing token fields", { user: { id: "account-a" } }],
    ["wrongly-typed tokens", { access_token: 123, refresh_token: true }],
  ])(
    "clears the session on a contract-invalid 2xx body (%s)",
    async (_label, body) => {
      await seedSession({
        access: "account-a-access",
        refresh: "account-a-refresh",
        userId: "account-a",
      });
      jest.spyOn(global, "fetch").mockResolvedValue(refreshResponse(body));

      await expect(__refreshAccessTokenForTest()).resolves.toBeNull();
      // Empty/invalid credentials must NOT replace the usable session.
      expect(__getTokenPairForTest()).toEqual({
        accessToken: null,
        refreshToken: null,
      });
    },
  );

  it("clears the current session's tokens on a genuine rejection (!res.ok)", async () => {
    const storage = await seedSession({
      access: "account-a-access",
      refresh: "account-a-refresh",
      userId: "account-a",
    });
    jest.spyOn(global, "fetch").mockResolvedValue(refreshResponse({}, false));

    await expect(__refreshAccessTokenForTest()).resolves.toBeNull();
    // A rejected refresh token IS a real sign-out.
    expect(__getTokenPairForTest()).toEqual({
      accessToken: null,
      refreshToken: null,
    });
    expect(storage.getString("user_id")).toBeUndefined();
  });

  it("does not clear a replacement session when the old refresh fails", async () => {
    await seedSession({
      access: "account-a-access",
      refresh: "account-a-refresh",
      userId: "account-a",
    });
    const response = deferred<Response>();
    jest.spyOn(global, "fetch").mockReturnValue(response.promise);

    const refresh = __refreshAccessTokenForTest();
    storeTokens(
      {
        access_token: "account-b-access",
        refresh_token: "account-b-refresh",
        user: { id: "account-b" } as Schemas["UserResponseDto"],
      } as never,
      { newSession: true },
    );
    response.resolve(refreshResponse({}, false));

    await expect(refresh).resolves.toBeNull();
    expect(__getTokenPairForTest()).toEqual({
      accessToken: "account-b-access",
      refreshToken: "account-b-refresh",
    });
  });
});

describe("token hydration and #1231 migration", () => {
  beforeEach(() => {
    keychainFake().__entriesForTest.clear();
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("adopts a legacy plaintext MMKV pair into the keychain and deletes it", async () => {
    const storage = await seedSession({
      access: "legacy-access",
      refresh: "legacy-refresh",
    });

    expect(__getTokenPairForTest()).toEqual({
      accessToken: "legacy-access",
      refreshToken: "legacy-refresh",
    });
    // The plaintext copy is GONE from MMKV — the point of #1231.
    expect(storage.getString("access_token")).toBeUndefined();
    expect(storage.getString("refresh_token")).toBeUndefined();
    // And the pair is persisted in the keychain for the next cold start.
    const entry = keychainFake().__entriesForTest.get(
      "app.tarmoto.auth-tokens",
    );
    expect(entry).toBeDefined();
    expect(JSON.parse(entry!.password)).toEqual({
      accessToken: "legacy-access",
      refreshToken: "legacy-refresh",
    });
  });

  it("drops half a legacy pair instead of adopting an unusable session", async () => {
    const storage = await seedSession({ access: "legacy-access-only" });

    expect(__getTokenPairForTest()).toEqual({
      accessToken: null,
      refreshToken: null,
    });
    expect(storage.getString("access_token")).toBeUndefined();
  });

  it("hydrates a keychain-persisted pair on cold start", async () => {
    keychainFake().__entriesForTest.set("app.tarmoto.auth-tokens", {
      username: "tarmoto",
      password: JSON.stringify({
        accessToken: "kc-access",
        refreshToken: "kc-refresh",
      }),
    });
    __setAuthStorageForTest(mockCreateMemoryStorage());
    await hydrateAuthTokens();

    expect(__getTokenPairForTest()).toEqual({
      accessToken: "kc-access",
      refreshToken: "kc-refresh",
    });
  });

  it("starts signed out on a corrupt keychain payload instead of crashing the boot", async () => {
    keychainFake().__entriesForTest.set("app.tarmoto.auth-tokens", {
      username: "tarmoto",
      password: "not json",
    });
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    __setAuthStorageForTest(mockCreateMemoryStorage());
    await hydrateAuthTokens();

    expect(__getTokenPairForTest()).toEqual({
      accessToken: null,
      refreshToken: null,
    });
    expect(warn).toHaveBeenCalled();
  });

  it("clearTokens removes the keychain entry so the pair cannot survive logout", async () => {
    await seedSession({ access: "a", refresh: "r", userId: "account-a" });
    expect(keychainFake().__entriesForTest.has("app.tarmoto.auth-tokens")).toBe(
      true,
    );

    const { clearTokens } = require("../typedClient") as {
      clearTokens: () => void;
    };
    clearTokens();
    // The reset is async fire-and-forget — flush microtasks.
    await Promise.resolve();
    await Promise.resolve();

    expect(keychainFake().__entriesForTest.has("app.tarmoto.auth-tokens")).toBe(
      false,
    );
    expect(__getTokenPairForTest()).toEqual({
      accessToken: null,
      refreshToken: null,
    });
  });
});
