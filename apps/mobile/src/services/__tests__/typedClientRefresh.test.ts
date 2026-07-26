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
  __refreshAccessTokenForTest,
  __setAuthStorageForTest,
} from "../typedClient";

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
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("stores a successful refresh when the session is unchanged", async () => {
    const storage = mockCreateMemoryStorage({
      access_token: "account-a-old-access",
      refresh_token: "account-a-old-refresh",
      user_id: "account-a",
    });
    __setAuthStorageForTest(storage);
    jest.spyOn(global, "fetch").mockResolvedValue(
      refreshResponse({
        access_token: "account-a-new-access",
        refresh_token: "account-a-new-refresh",
      }),
    );

    await expect(__refreshAccessTokenForTest()).resolves.toBe(
      "account-a-new-access",
    );
    expect(storage.getString("access_token")).toBe("account-a-new-access");
    expect(storage.getString("refresh_token")).toBe("account-a-new-refresh");
    expect(storage.getString("user_id")).toBe("account-a");
  });

  it("does not overwrite a replacement session with an old refresh", async () => {
    const storage = mockCreateMemoryStorage({
      access_token: "account-a-access",
      refresh_token: "account-a-refresh",
    });
    __setAuthStorageForTest(storage);
    const response = deferred<Response>();
    jest.spyOn(global, "fetch").mockReturnValue(response.promise);

    const refresh = __refreshAccessTokenForTest();
    storage.set("access_token", "account-b-access");
    storage.set("refresh_token", "account-b-refresh");
    storage.set("user_id", "account-b");
    response.resolve(
      refreshResponse({
        access_token: "account-a-new-access",
        refresh_token: "account-a-new-refresh",
      }),
    );

    await expect(refresh).resolves.toBeNull();
    expect(storage.getString("access_token")).toBe("account-b-access");
    expect(storage.getString("refresh_token")).toBe("account-b-refresh");
    expect(storage.getString("user_id")).toBe("account-b");
  });

  it("keeps the current session's tokens when the refresh request fails transiently (offline)", async () => {
    const storage = mockCreateMemoryStorage({
      access_token: "account-a-access",
      refresh_token: "account-a-refresh",
      user_id: "account-a",
    });
    __setAuthStorageForTest(storage);
    jest.spyOn(global, "fetch").mockRejectedValue(new Error("network down"));

    await expect(__refreshAccessTokenForTest()).resolves.toBeNull();
    // A dead-zone blip must NOT sign the rider out — the session survives so a
    // later request retries once connectivity returns.
    expect(storage.getString("access_token")).toBe("account-a-access");
    expect(storage.getString("refresh_token")).toBe("account-a-refresh");
    expect(storage.getString("user_id")).toBe("account-a");
  });

  it("clears the current session's tokens on a genuine rejection (!res.ok)", async () => {
    const storage = mockCreateMemoryStorage({
      access_token: "account-a-access",
      refresh_token: "account-a-refresh",
      user_id: "account-a",
    });
    __setAuthStorageForTest(storage);
    jest.spyOn(global, "fetch").mockResolvedValue(refreshResponse({}, false));

    await expect(__refreshAccessTokenForTest()).resolves.toBeNull();
    // A rejected refresh token IS a real sign-out.
    expect(storage.getString("access_token")).toBeUndefined();
    expect(storage.getString("refresh_token")).toBeUndefined();
    expect(storage.getString("user_id")).toBeUndefined();
  });

  it("does not clear a replacement session when the old refresh fails", async () => {
    const storage = mockCreateMemoryStorage({
      access_token: "account-a-access",
      refresh_token: "account-a-refresh",
      user_id: "account-a",
    });
    __setAuthStorageForTest(storage);
    const response = deferred<Response>();
    jest.spyOn(global, "fetch").mockReturnValue(response.promise);

    const refresh = __refreshAccessTokenForTest();
    storage.set("access_token", "account-b-access");
    storage.set("refresh_token", "account-b-refresh");
    storage.set("user_id", "account-b");
    response.resolve(refreshResponse({}, false));

    await expect(refresh).resolves.toBeNull();
    expect(storage.getString("access_token")).toBe("account-b-access");
    expect(storage.getString("refresh_token")).toBe("account-b-refresh");
    expect(storage.getString("user_id")).toBe("account-b");
  });
});
