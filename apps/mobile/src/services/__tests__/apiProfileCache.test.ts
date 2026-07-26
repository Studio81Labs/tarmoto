const mockPatch = jest.fn();
const mockPost = jest.fn();
const mockSetCachedUser = jest.fn();
const mockGetCachedUser = jest.fn(() => null as unknown);
let mockSession: {
  accessToken: string;
  userId: string | null;
  epoch?: number;
} | null = null;

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
  getSessionEpoch: () => mockSession?.epoch ?? 0,
  getCachedUser: () => mockGetCachedUser(),
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
    mockSession = {
      accessToken: "account-a-token",
      userId: "account-a",
      epoch: 1,
    };
    mockPatch.mockReset();
    mockPost.mockReset();
    mockSetCachedUser.mockReset();
    mockGetCachedUser.mockReset().mockReturnValue(null);
  });

  it("does not cache an update that spanned a logout→login to the same account", async () => {
    const response = deferred<ReturnType<typeof success<User>>>();
    mockPatch.mockReturnValue(response.promise);

    const update = api.updateProfile({ display_name: "Account A" });
    // Same account, but a logout→login bumped the session epoch mid-request.
    mockSession = {
      accessToken: "account-a-token-2",
      userId: "account-a",
      epoch: 3,
    };
    response.resolve(success(user("account-a")));

    await expect(update).resolves.toEqual(user("account-a"));
    expect(mockSetCachedUser).not.toHaveBeenCalled();
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

  it("preserves the cached entitlement slices when caching a profile update", async () => {
    // The persisted cache holds fresh (downgraded) entitlements — kept current
    // by the entitlement refresh path.
    mockGetCachedUser.mockReturnValue({
      id: "account-a",
      subscription_tier: "free",
      features: { gpx_export: false },
      limits: { road_quality_max_zoom: 12 },
    } as unknown);
    // The PATCH response still carries the pre-downgrade (permissive) snapshot.
    mockPatch.mockResolvedValue(
      success({
        id: "account-a",
        subscription_tier: "premium",
        features: { gpx_export: true },
        limits: { road_quality_max_zoom: null },
        display_name: "New",
      } as unknown as User),
    );

    await api.updateProfile({ display_name: "New" });

    const cached = mockSetCachedUser.mock.calls.at(-1)?.[0] as Record<
      string,
      unknown
    >;
    // MMKV must NOT persist the stale permissive entitlements…
    expect(cached.subscription_tier).toBe("free");
    expect(cached.features).toEqual({ gpx_export: false });
    expect(cached.limits).toEqual({ road_quality_max_zoom: 12 });
    // …but keeps the incoming editable field.
    expect(cached.display_name).toBe("New");
  });
});
