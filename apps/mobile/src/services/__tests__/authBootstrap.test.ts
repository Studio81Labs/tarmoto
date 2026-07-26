import { bootstrapAuth, refreshEntitlements } from "../authBootstrap";
import type { User } from "@/types";

function user(id: string): User {
  return { id, email: id + "@example.com" } as User;
}

describe("bootstrapAuth", () => {
  it("ends loading as signed out when no token exists", async () => {
    const setUser = jest.fn();
    await bootstrapAuth({
      getSessionSnapshot: () => null,
      getCachedProfile: () => null,
      getProfile: jest.fn(),
      cacheProfile: jest.fn(),
      setUser,
      setLoading: jest.fn(),
    });
    expect(setUser).toHaveBeenCalledWith(null);
  });

  it("hydrates the cached rider before refreshing from the backend", async () => {
    const cached = user("cached");
    const fresh = user("fresh");
    const setUser = jest.fn();
    const cacheProfile = jest.fn();
    await bootstrapAuth({
      getSessionSnapshot: () => ({
        accessToken: "token",
        userId: fresh.id,
      }),
      getCachedProfile: () => cached,
      getProfile: async () => fresh,
      cacheProfile,
      setUser,
      setLoading: jest.fn(),
    });
    expect(setUser.mock.calls).toEqual([[cached], [fresh]]);
    expect(cacheProfile).toHaveBeenCalledWith(fresh);
  });

  it("keeps the cached rider on an offline refresh failure", async () => {
    const cached = user("cached");
    const setUser = jest.fn();
    const setLoading = jest.fn();
    await bootstrapAuth({
      getSessionSnapshot: () => ({
        accessToken: "token",
        userId: cached.id,
      }),
      getCachedProfile: () => cached,
      getProfile: async () => {
        throw new Error("offline");
      },
      cacheProfile: jest.fn(),
      setUser,
      setLoading,
    });
    expect(setUser).toHaveBeenCalledTimes(1);
    expect(setUser).toHaveBeenCalledWith(cached);
    expect(setLoading).toHaveBeenCalledWith(false);
  });

  it("clears the rider when refresh invalidates the token", async () => {
    let authenticated = true;
    const setUser = jest.fn();
    await bootstrapAuth({
      getSessionSnapshot: () =>
        authenticated ? { accessToken: "token", userId: "cached" } : null,
      getCachedProfile: () => user("cached"),
      getProfile: async () => {
        authenticated = false;
        throw new Error("unauthorized");
      },
      cacheProfile: jest.fn(),
      setUser,
      setLoading: jest.fn(),
    });
    expect(setUser).toHaveBeenLastCalledWith(null);
  });

  it("discards an upgraded-install refresh after an account switch", async () => {
    let session = {
      accessToken: "account-a-token",
      userId: null as string | null,
    };
    let resolveProfile!: (profile: User) => void;
    const cacheProfile = jest.fn();
    const setUser = jest.fn();
    const setLoading = jest.fn();
    const bootstrap = bootstrapAuth({
      getSessionSnapshot: () => session,
      getCachedProfile: () => null,
      getProfile: () =>
        new Promise<User>((resolve) => {
          resolveProfile = resolve;
        }),
      cacheProfile,
      setUser,
      setLoading,
    });

    session = { accessToken: "account-b-token", userId: "account-b" };
    resolveProfile(user("account-a"));
    await bootstrap;

    expect(cacheProfile).not.toHaveBeenCalled();
    expect(setUser).not.toHaveBeenCalled();
    expect(setLoading).toHaveBeenCalledWith(false);
  });

  it("drops a superseded refresh so an out-of-order resolve can't clobber a newer snapshot", async () => {
    // A (older) reads the stale unlimited snapshot slowly; B (newer, started
    // after A) reads the fresh downgrade and resolves first. A's late response
    // must not overwrite B's.
    const stale = { id: "u1", subscription_tier: "premium" } as User;
    const fresh = { id: "u1", subscription_tier: "free" } as User;
    const setUser = jest.fn();
    const session = { accessToken: "token", userId: "u1" };

    let resolveStale!: (u: User) => void;
    const stalePending = new Promise<User>((r) => (resolveStale = r));
    let resolveFresh!: (u: User) => void;
    const freshPending = new Promise<User>((r) => (resolveFresh = r));

    const deps = (getProfile: () => Promise<User>) => ({
      getSessionSnapshot: () => session,
      getCachedProfile: () => null,
      getProfile,
      cacheProfile: jest.fn(),
      setUser,
      setLoading: jest.fn(),
    });

    const aDone = bootstrapAuth(deps(() => stalePending));
    const bDone = bootstrapAuth(deps(() => freshPending));

    resolveFresh(fresh);
    await bDone;
    resolveStale(stale);
    await aDone;

    expect(setUser).toHaveBeenCalledTimes(1);
    expect(setUser).toHaveBeenCalledWith(fresh);
  });
});

describe("refreshEntitlements", () => {
  const session = { accessToken: "token", userId: "u1" };
  // A /users/me response — entitlement slices plus an editable field. `over`
  // is loose so tests can supply partial `features`/`limits` fixtures (the real
  // DTOs are full objects, but the merge copies whatever it's given).
  function profileResponse(over: Record<string, unknown> = {}): User {
    return {
      id: "u1",
      email: "u1@example.com",
      subscription_tier: "free",
      features: { gpx_export: false },
      limits: { road_quality_max_zoom: 12 },
      crash_detection_enabled: false,
      ...over,
    } as unknown as User;
  }

  it("merges only the entitlement slices, preserving a concurrent PATCH's fields", async () => {
    // The live profile already reflects a preference PATCH that landed while
    // the GET was in flight (crash detection just toggled ON).
    const live = profileResponse({
      crash_detection_enabled: true,
      subscription_tier: "premium",
      features: { gpx_export: true },
      limits: { road_quality_max_zoom: null },
    });
    // The GET carries the OLD editable field but the authoritative (downgraded)
    // entitlements.
    const fetched = profileResponse({
      crash_detection_enabled: false,
      subscription_tier: "free",
      features: { gpx_export: false },
      limits: { road_quality_max_zoom: 12 },
    });
    const setUser = jest.fn();
    const cacheProfile = jest.fn();

    await refreshEntitlements({
      getSessionSnapshot: () => session,
      getProfile: async () => fetched,
      getCurrentUser: () => live,
      setUser,
      cacheProfile,
    });

    const published = setUser.mock.calls[0][0] as User;
    // Entitlements taken from the GET…
    expect(published.subscription_tier).toBe("free");
    expect(published.features).toEqual({ gpx_export: false });
    expect(published.limits).toEqual({ road_quality_max_zoom: 12 });
    // …but the concurrently-PATCHed editable field is NOT clobbered.
    expect(
      (published as { crash_detection_enabled?: boolean })
        .crash_detection_enabled,
    ).toBe(true);
    expect(cacheProfile).toHaveBeenCalledWith(published);
  });

  it("drops the refresh when a different rider is in the store (account switch)", async () => {
    const setUser = jest.fn();
    await refreshEntitlements({
      getSessionSnapshot: () => session,
      getProfile: async () => profileResponse(),
      getCurrentUser: () => user("someone-else"),
      setUser,
      cacheProfile: jest.fn(),
    });
    expect(setUser).not.toHaveBeenCalled();
  });

  it("a failed refresh doesn't strand an in-flight cold-start bootstrap (empty store)", async () => {
    // Cold start with no cache: bootstrap is in flight (store empty). A
    // foreground refresh fires, supersedes it, then FAILS network-only. The
    // bootstrap's own success must still publish — not be discarded as
    // superseded — or the app is stuck empty + isLoading forever.
    const setUser = jest.fn();
    const cacheProfile = jest.fn();

    let resolveBootstrap!: (u: User) => void;
    const bootstrapProfile = new Promise<User>((r) => (resolveBootstrap = r));

    const bootDone = bootstrapAuth({
      getSessionSnapshot: () => session,
      getCachedProfile: () => null,
      getProfile: () => bootstrapProfile,
      cacheProfile,
      setUser,
      setLoading: jest.fn(),
    });

    // Foreground refresh: supersedes bootstrap, then fails (session intact).
    await refreshEntitlements({
      getSessionSnapshot: () => session,
      getProfile: async () => {
        throw new Error("offline");
      },
      getCurrentUser: () => null,
      setUser,
      cacheProfile: jest.fn(),
    });

    const profile = profileResponse();
    resolveBootstrap(profile);
    await bootDone;

    expect(setUser).toHaveBeenCalledWith(profile);
  });

  it("establishes the baseline profile when the store is empty (cold-start race)", async () => {
    // Authenticated cold start with no usable cache, foregrounded before the
    // initial bootstrap finished: the session + profile are already validated,
    // so publish the full profile rather than deadlocking in auth loading.
    const setUser = jest.fn();
    const cacheProfile = jest.fn();
    const profile = profileResponse({ subscription_tier: "premium" });
    await refreshEntitlements({
      getSessionSnapshot: () => session,
      getProfile: async () => profile,
      getCurrentUser: () => null,
      setUser,
      cacheProfile,
    });
    expect(setUser).toHaveBeenCalledWith(profile);
    expect(cacheProfile).toHaveBeenCalledWith(profile);
  });

  it("retains the snapshot on a NETWORK failure with the session intact (offline-first)", async () => {
    const setUser = jest.fn();
    const cacheProfile = jest.fn();
    await refreshEntitlements({
      getSessionSnapshot: () => session, // session still present
      getProfile: async () => {
        throw new Error("offline");
      },
      getCurrentUser: () => profileResponse(),
      setUser,
      cacheProfile,
    });
    expect(setUser).not.toHaveBeenCalled();
    expect(cacheProfile).not.toHaveBeenCalled();
  });

  it("signs out when a failed refresh cleared the session (401 → tokens gone)", async () => {
    const setUser = jest.fn();
    // The 401 refresh path clears tokens before the GET rejects.
    let live: typeof session | null = session;
    await refreshEntitlements({
      getSessionSnapshot: () => live,
      getProfile: async () => {
        live = null;
        throw new Error("401");
      },
      getCurrentUser: () => profileResponse(),
      setUser,
      cacheProfile: jest.fn(),
    });
    expect(setUser).toHaveBeenCalledWith(null);
  });

  it("drops a superseded refresh so an older slice set can't win", async () => {
    const setUser = jest.fn();
    const live = profileResponse();

    let resolveStale!: (u: User) => void;
    const stalePending = new Promise<User>((r) => (resolveStale = r));
    let resolveFresh!: (u: User) => void;
    const freshPending = new Promise<User>((r) => (resolveFresh = r));

    const deps = (getProfile: () => Promise<User>) => ({
      getSessionSnapshot: () => session,
      getProfile,
      getCurrentUser: () => live,
      setUser,
      cacheProfile: jest.fn(),
    });

    const aDone = refreshEntitlements(deps(() => stalePending));
    const bDone = refreshEntitlements(deps(() => freshPending));

    resolveFresh(profileResponse({ subscription_tier: "free" }));
    await bDone;
    resolveStale(profileResponse({ subscription_tier: "premium" }));
    await aDone;

    expect(setUser).toHaveBeenCalledTimes(1);
    expect((setUser.mock.calls[0][0] as User).subscription_tier).toBe("free");
  });
});
