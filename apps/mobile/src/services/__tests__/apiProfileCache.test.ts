const mockPatch = jest.fn();
const mockPost = jest.fn();
const mockSetCachedUser = jest.fn();
let mockSession: { accessToken: string; userId: string | null } | null = null;

jest.mock("../typedClient", () => ({
  client: {
    GET: jest.fn(),
    POST: (...args: unknown[]) => mockPost(...args),
    PATCH: (...args: unknown[]) => mockPatch(...args),
    PUT: jest.fn(),
    DELETE: jest.fn(),
  },
  clearTokens: jest.fn(),
  getAccessToken: () => mockSession?.accessToken ?? null,
  getAuthenticatedUserId: () => mockSession?.userId ?? null,
  getCachedUser: jest.fn(() => null),
  isAuthenticated: () => mockSession !== null,
  setCachedUser: (...args: unknown[]) => mockSetCachedUser(...args),
  setAuthenticatedUserId: jest.fn(),
  storeTokens: jest.fn(),
  rawFetch: jest.fn(),
}));

jest.mock("@/services/pushRegistration", () => ({
  registerForPush: jest.fn(),
  unregisterPush: jest.fn(),
}));

import { api } from "../api";
import type { User } from "@/types";

function user(id: string): User {
  return { id, email: `${id}@example.com` } as User;
}

function success<T>(data: T) {
  return {
    data,
    response: { status: 200 } as Response,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("profile cache session guards", () => {
  beforeEach(() => {
    mockSession = { accessToken: "account-a-token", userId: "account-a" };
    mockPatch.mockReset();
    mockPost.mockReset();
    mockSetCachedUser.mockReset();
  });

  it("does not cache a profile update after an account switch", async () => {
    const response = deferred<ReturnType<typeof success<User>>>();
    mockPatch.mockReturnValue(response.promise);

    const update = api.updateProfile({ display_name: "Account A" });
    mockSession = { accessToken: "account-b-token", userId: "account-b" };
    response.resolve(success(user("account-a")));

    await expect(update).resolves.toEqual(user("account-a"));
    expect(mockSetCachedUser).not.toHaveBeenCalled();
  });

  it("does not cache an avatar response after an account switch", async () => {
    const response = deferred<ReturnType<typeof success<User>>>();
    mockPost.mockReturnValue(response.promise);

    const upload = api.uploadAvatar({ uri: "file:///avatar.jpg" });
    mockSession = { accessToken: "account-b-token", userId: "account-b" };
    response.resolve(success(user("account-a")));

    await expect(upload).resolves.toEqual(user("account-a"));
    expect(mockSetCachedUser).not.toHaveBeenCalled();
  });

  it("caches an update for the unchanged authenticated rider", async () => {
    const accountA = user("account-a");
    mockPatch.mockResolvedValue(success(accountA));

    await expect(
      api.updateProfile({ display_name: "Account A" }),
    ).resolves.toEqual(accountA);
    expect(mockSetCachedUser).toHaveBeenCalledWith(accountA);
  });
});
