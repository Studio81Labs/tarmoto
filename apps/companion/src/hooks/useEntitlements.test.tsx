import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { createTestQueryClient, withQueryClient } from "./test-utils";

const getMock = vi.fn();
const { authState, sessionState } = vi.hoisted(() => ({
  authState: { user: { id: "u1" } as { id: string } | null },
  sessionState: {
    status: "authenticated" as "loading" | "authenticated" | "unauthenticated",
  },
}));
vi.mock("@/lib/api", () => ({
  api: { GET: (...a: unknown[]) => getMock(...a) },
}));
vi.mock("@/stores/auth", () => ({
  useAuthStore: (sel: (s: { user: { id: string } | null }) => unknown) =>
    sel(authState),
}));
vi.mock("next-auth/react", () => ({
  useSession: () => ({ data: null, status: sessionState.status }),
}));

import {
  CONFIG_LIMITS_QUERY_KEY,
  USERS_ME_QUERY_KEY,
  useEntitlements,
  useFeature,
  useFeatureGrantNonce,
  useLimit,
  useRoadQualityZoomCap,
  useSystemSwitch,
} from "./useEntitlements";

const ME = {
  id: "u1",
  subscription_tier: "free",
  features: { group_rides: false, basic_navigation: true },
  limits: { max_active_trips: 1, max_trip_collaborators: 0 },
};

describe("useEntitlements", () => {
  beforeEach(() => {
    getMock.mockReset();
    authState.user = { id: "u1" };
    sessionState.status = "authenticated";
  });

  it("exposes the resolved tier/features/limits from /users/me", async () => {
    getMock.mockResolvedValue({ data: ME, error: undefined });
    const { result } = renderHook(() => useEntitlements(), {
      wrapper: withQueryClient(),
    });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(getMock).toHaveBeenCalledWith("/api/v1/users/me", {
      signal: expect.anything(),
    });
    expect(result.current.tier).toBe("free");
    expect(result.current.limits?.max_active_trips).toBe(1);
    expect(result.current.isSuccess).toBe(true);
  });

  it("useLimit is unresolved before auth hydrates (query disabled, no userId)", async () => {
    authState.user = null; // AuthSync hasn't copied the session in yet
    const { result } = renderHook(() => useLimit("max_active_trips"), {
      wrapper: withQueryClient(),
    });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    // A disabled query is NOT resolved — must not read as "unlimited".
    expect(result.current.isSuccess).toBe(false);
    expect(result.current.isError).toBe(false);
    expect(result.current.limit).toBeNull();
    expect(getMock).not.toHaveBeenCalled();
  });

  it("useFeature indexes the resolved snapshot (does not re-resolve from tier)", async () => {
    // Premium nominally qualifies for group_rides, but the resolved snapshot
    // says false (e.g. a server-side global force_off). A tier-deriving
    // implementation would wrongly return true here; reading the snapshot
    // returns false — proving the hook trusts the resolved data, not the tier.
    const MEForceOff = {
      ...ME,
      subscription_tier: "premium",
      features: { ...ME.features, group_rides: false },
    };
    getMock.mockResolvedValue({ data: MEForceOff, error: undefined });
    const { result } = renderHook(() => useFeature("group_rides"), {
      wrapper: withQueryClient(),
    });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.enabled).toBe(false);
  });

  it("useLimit returns the resolved numeric limit", async () => {
    getMock.mockResolvedValue({ data: ME, error: undefined });
    const { result } = renderHook(() => useLimit("max_active_trips"), {
      wrapper: withQueryClient(),
    });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.limit).toBe(1);
  });

  it("useLimit keeps an explicit null value as unlimited", async () => {
    getMock.mockResolvedValue({
      data: { ...ME, limits: { max_active_trips: null } },
      error: undefined,
    });
    const { result } = renderHook(() => useLimit("max_active_trips"), {
      wrapper: withQueryClient(),
    });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.limit).toBeNull(); // present + null = unlimited
  });

  it("useLimit reports isError with a null limit when the entitlement query fails", async () => {
    getMock.mockResolvedValue({ data: undefined, error: { message: "boom" } });
    const { result } = renderHook(() => useLimit("max_active_trips"), {
      wrapper: withQueryClient(),
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    // Errored ≠ unlimited — the cap is unknown; callers must fail closed.
    expect(result.current.limit).toBeNull();
    expect(result.current.isLoading).toBe(false);
  });

  it("useLimit is not resolved when a successful response omits the whole limits object", async () => {
    // Rolling deploy: profile pod still on the pre-limits DTO. The query
    // succeeds but carries no cap — treat it as unknown, not unlimited.
    getMock.mockResolvedValue({
      data: { ...ME, limits: undefined },
      error: undefined,
    });
    const { result } = renderHook(() => useLimit("max_active_trips"), {
      wrapper: withQueryClient(),
    });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.isSuccess).toBe(false); // query ok, but cap unknown
    expect(result.current.limit).toBeNull();
  });

  it("polls /users/me on an interval so a revoked entitlement can't persist on an active tab", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      getMock.mockImplementation(() => {
        calls += 1;
        return Promise.resolve({ data: ME, error: undefined });
      });
      renderHook(() => useEntitlements(), { wrapper: withQueryClient() });
      // Initial fetch.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(calls).toBe(1);
      // Past the 5-minute active-session poll → the snapshot refetches, so a
      // client-enforced entitlement (gpx_export, road-quality zoom) can't stay
      // stale indefinitely after an operator revokes it.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5 * 60_000);
      });
      expect(calls).toBeGreaterThanOrEqual(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("useLimit fails closed (0) when the key is missing from a resolved snapshot", async () => {
    // Partial deploy / stale shape: `limits` resolved but lacks the key. Must
    // NOT read as unlimited — fall back to the restrictive shared default.
    getMock.mockResolvedValue({
      data: { ...ME, limits: { max_trip_collaborators: 0 } },
      error: undefined,
    });
    const { result } = renderHook(() => useLimit("max_active_trips"), {
      wrapper: withQueryClient(),
    });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.limit).toBe(0);
  });
});

describe("useRoadQualityZoomCap", () => {
  beforeEach(() => {
    getMock.mockReset();
    authState.user = { id: "u1" };
    sessionState.status = "authenticated";
  });

  it("uses the authenticated /users/me cap when signed in", async () => {
    authState.user = { id: "u1" };
    getMock.mockImplementation((path: string) =>
      path === "/api/v1/config/limits"
        ? Promise.resolve({ data: {}, error: undefined })
        : Promise.resolve({
            data: { ...ME, limits: { road_quality_max_zoom: 12 } },
            error: undefined,
          }),
    );
    const { result } = renderHook(() => useRoadQualityZoomCap(), {
      wrapper: withQueryClient(),
    });
    await waitFor(() => expect(result.current.isResolved).toBe(true));
    expect(result.current.limit).toBe(12);
  });

  it("is UNRESOLVED for a signed-in rider until the public override loads (fail closed)", async () => {
    // /users/me resolves but /config/limits errors — must NOT report resolved
    // using only the stale profile, or the map could render above an operator
    // clamp the profile hasn't caught up to yet.
    authState.user = { id: "u1" };
    getMock.mockImplementation((path: string) =>
      path === "/api/v1/config/limits"
        ? Promise.resolve({ data: undefined, error: { message: "down" } })
        : Promise.resolve({
            data: { ...ME, limits: { road_quality_max_zoom: null } },
            error: undefined,
          }),
    );
    const { result } = renderHook(() => useRoadQualityZoomCap(), {
      wrapper: withQueryClient(),
    });
    // The public query settles in error; the cap stays unresolved (fail closed).
    await waitFor(() => expect(getMock).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(result.current.isResolved).toBe(false);
  });

  it("clamps a signed-in rider DOWN with a finite public override the cached snapshot missed", async () => {
    // Rider's /users/me still says unlimited (null), but the operator has since
    // set a finite global override — apply it as a downward clamp immediately.
    authState.user = { id: "u1" };
    getMock.mockImplementation((path: string) =>
      path === "/api/v1/config/limits"
        ? Promise.resolve({
            data: { road_quality_max_zoom: 8 },
            error: undefined,
          })
        : Promise.resolve({
            data: { ...ME, limits: { road_quality_max_zoom: null } },
            error: undefined,
          }),
    );
    const { result } = renderHook(() => useRoadQualityZoomCap(), {
      wrapper: withQueryClient(),
    });
    await waitFor(() => expect(result.current.isResolved).toBe(true));
    expect(result.current.limit).toBe(8); // clamped down from unlimited
  });

  it("never RAISES a signed-in rider's cap via the public override", async () => {
    // /users/me says 12 (free), a null global override (launch mode) must not
    // lift it here (min only lowers) — the authenticated snapshot already folded
    // the override in, so this branch just guards against raising.
    authState.user = { id: "u1" };
    getMock.mockImplementation((path: string) =>
      path === "/api/v1/config/limits"
        ? Promise.resolve({
            data: { road_quality_max_zoom: null },
            error: undefined,
          })
        : Promise.resolve({
            data: { ...ME, limits: { road_quality_max_zoom: 12 } },
            error: undefined,
          }),
    );
    const { result } = renderHook(() => useRoadQualityZoomCap(), {
      wrapper: withQueryClient(),
    });
    await waitFor(() => expect(result.current.isResolved).toBe(true));
    expect(result.current.limit).toBe(12); // unchanged — a null override can't raise
  });

  it("resolves anonymous viewers to UNLIMITED under the launch-mode global override (null)", async () => {
    // Logged out: /users/me is disabled; the public /config/limits map carries
    // the launch seed (road_quality_max_zoom → null = unlimited).
    authState.user = null;
    sessionState.status = "unauthenticated";
    getMock.mockImplementation((path: string) =>
      path === "/api/v1/config/limits"
        ? Promise.resolve({
            data: { road_quality_max_zoom: null },
            error: undefined,
          })
        : Promise.resolve({ data: undefined, error: { message: "no auth" } }),
    );
    const { result } = renderHook(() => useRoadQualityZoomCap(), {
      wrapper: withQueryClient(),
    });
    await waitFor(() => expect(result.current.isResolved).toBe(true));
    expect(result.current.limit).toBeNull(); // unlimited → overlay never clamped
  });

  it("resolves anonymous viewers to the free cap when no global override (post-launch)", async () => {
    authState.user = null;
    sessionState.status = "unauthenticated";
    getMock.mockImplementation((path: string) =>
      path === "/api/v1/config/limits"
        ? Promise.resolve({ data: {}, error: undefined })
        : Promise.resolve({ data: undefined, error: { message: "no auth" } }),
    );
    const { result } = renderHook(() => useRoadQualityZoomCap(), {
      wrapper: withQueryClient(),
    });
    await waitFor(() => expect(result.current.isResolved).toBe(true));
    expect(result.current.limit).toBe(12); // free-tier default
  });

  it("keeps a cached finite anonymous override when a later refetch fails (outage can't widen the cap)", async () => {
    // A z5 override loaded successfully; a later polling/focus refetch fails but
    // the last-good value is still cached. The cap must stay at z5 rather than
    // discard the known clamp and widen to the free z12.
    authState.user = null;
    sessionState.status = "unauthenticated";
    let calls = 0;
    getMock.mockImplementation((path: string) => {
      if (path !== "/api/v1/config/limits") {
        return Promise.resolve({
          data: undefined,
          error: { message: "no auth" },
        });
      }
      calls += 1;
      return calls === 1
        ? Promise.resolve({
            data: { road_quality_max_zoom: 5 },
            error: undefined,
          })
        : Promise.resolve({ data: undefined, error: { message: "down" } });
    });
    const client = createTestQueryClient();
    const { result } = renderHook(() => useRoadQualityZoomCap(), {
      wrapper: withQueryClient(client),
    });
    await waitFor(() => expect(result.current.limit).toBe(5));

    // Force a refetch that fails; the cached z5 must survive.
    await act(async () => {
      await client.invalidateQueries({ queryKey: CONFIG_LIMITS_QUERY_KEY });
    });
    await waitFor(() => expect(calls).toBeGreaterThan(1));
    await new Promise((r) => setTimeout(r, 0));

    expect(result.current.limit).toBe(5);
  });

  it("is unresolved for an anonymous viewer while the global map errors", async () => {
    authState.user = null;
    sessionState.status = "unauthenticated";
    getMock.mockResolvedValue({
      data: undefined,
      error: { message: "boom" },
    });
    const { result } = renderHook(() => useRoadQualityZoomCap(), {
      wrapper: withQueryClient(),
    });
    await waitFor(() => expect(result.current.isResolved).toBe(false));
    expect(result.current.limit).toBeNull();
  });

  it("stays fail-closed for a signed-in rider whose auth is still hydrating (userId null, status loading)", async () => {
    // Hard navigation: AuthSync hasn't copied the session into the store yet, so
    // userId is null while the session is still resolving. Resolving the
    // anonymous cap here could render quality above the rider's per-user cap —
    // even if the public override map has already loaded. Must stay unresolved.
    authState.user = null;
    sessionState.status = "loading";
    getMock.mockImplementation((path: string) =>
      path === "/api/v1/config/limits"
        ? Promise.resolve({
            data: { road_quality_max_zoom: null }, // permissive launch seed
            error: undefined,
          })
        : Promise.resolve({ data: undefined, error: { message: "no auth" } }),
    );
    const { result } = renderHook(() => useRoadQualityZoomCap(), {
      wrapper: withQueryClient(),
    });
    // Let the public query settle so this can't pass merely because it's slow.
    await waitFor(() => expect(getMock).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(result.current.isResolved).toBe(false);
    expect(result.current.limit).toBeNull();
  });

  it("refetches /users/me when the operator changes the global override (go-live)", async () => {
    // Launch mode: both /users/me and /config/limits say unlimited. When the
    // operator removes the launch override, the cached profile (which folded in
    // the old override server-side) is stale — the override change must
    // invalidate /users/me so an authed free rider re-resolves to the free cap.
    authState.user = { id: "u1" };
    sessionState.status = "authenticated";
    let zoomLimit: number | null = null;
    let globalOverride: Record<string, number | null> = {
      road_quality_max_zoom: null,
    };
    getMock.mockImplementation((path: string) =>
      path === "/api/v1/config/limits"
        ? Promise.resolve({ data: globalOverride, error: undefined })
        : Promise.resolve({
            data: { ...ME, limits: { road_quality_max_zoom: zoomLimit } },
            error: undefined,
          }),
    );
    const client = createTestQueryClient();
    const { result } = renderHook(() => useRoadQualityZoomCap(), {
      wrapper: withQueryClient(client),
    });
    await waitFor(() => expect(result.current.isResolved).toBe(true));
    expect(result.current.limit).toBeNull(); // unlimited under launch mode

    // Operator deletes the launch override; the server now resolves the free
    // cap. Refetching /config/limits flips `override` null → undefined.
    globalOverride = {}; // road_quality_max_zoom absent
    zoomLimit = 12;
    await act(async () => {
      await client.invalidateQueries({ queryKey: CONFIG_LIMITS_QUERY_KEY });
    });

    // The override change invalidated /users/me, which re-resolved to z12.
    await waitFor(() => expect(result.current.limit).toBe(12));
  });

  it("fails closed while /users/me refetches after the override is removed (go-live)", async () => {
    // Removing the launch override must not keep serving the stale unlimited
    // profile: the reset makes /users/me UNRESOLVED during its refetch, so the
    // cap reads fail-closed (free) rather than unlimited until the new value
    // lands.
    authState.user = { id: "u1" };
    sessionState.status = "authenticated";
    let globalOverride: Record<string, number | null> = {
      road_quality_max_zoom: null,
    };
    let resolveProfile: (() => void) | null = null;
    let profileCalls = 0;
    getMock.mockImplementation((path: string) => {
      if (path === "/api/v1/config/limits") {
        return Promise.resolve({ data: globalOverride, error: undefined });
      }
      profileCalls += 1;
      if (profileCalls === 1) {
        return Promise.resolve({
          data: { ...ME, limits: { road_quality_max_zoom: null } },
          error: undefined,
        });
      }
      // The post-reset refetch hangs until we release it.
      return new Promise((res) => {
        resolveProfile = () =>
          res({
            data: { ...ME, limits: { road_quality_max_zoom: 12 } },
            error: undefined,
          });
      });
    });
    const client = createTestQueryClient();
    const { result } = renderHook(() => useRoadQualityZoomCap(), {
      wrapper: withQueryClient(client),
    });
    await waitFor(() => expect(result.current.isResolved).toBe(true));
    expect(result.current.limit).toBeNull(); // unlimited under launch

    // Operator removes the launch override; the /users/me refetch hangs.
    globalOverride = {};
    await act(async () => {
      await client.invalidateQueries({ queryKey: CONFIG_LIMITS_QUERY_KEY });
    });

    // The profile was RESET, not just invalidated, so during its (hanging)
    // refetch the cap reads unresolved — NOT the stale unlimited snapshot.
    await waitFor(() => expect(result.current.isResolved).toBe(false));

    // Completing the refetch re-resolves to the free cap.
    await act(async () => {
      resolveProfile?.();
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.limit).toBe(12));
  });

  it("preserves a finite global override while auth is still hydrating (does not widen to free)", async () => {
    // /config/limits already resolved a restrictive z5 override, but NextAuth is
    // still loading. The cap must reflect z5 (clamped by
    // resolveQualityLayerMaxZoom), not fall back to the free z12 default and
    // render quality above the operator's cap during hydration.
    authState.user = null; // store not hydrated yet
    sessionState.status = "loading";
    getMock.mockImplementation((path: string) =>
      path === "/api/v1/config/limits"
        ? Promise.resolve({
            data: { road_quality_max_zoom: 5 },
            error: undefined,
          })
        : Promise.resolve({ data: undefined, error: { message: "no auth" } }),
    );
    const { result } = renderHook(() => useRoadQualityZoomCap(), {
      wrapper: withQueryClient(),
    });
    // Wait for the public override to load; the cap stays unresolved (hydrating)
    // but carries the known finite clamp rather than null.
    await waitFor(() => expect(result.current.limit).toBe(5));
    expect(result.current.isResolved).toBe(false);
  });

  it("stays fail-closed when the session is authenticated but the store hasn't hydrated yet", async () => {
    // The narrow gap where NextAuth reports "authenticated" but AuthSync's
    // effect hasn't run — userId still null. Treated like loading, not anonymous.
    authState.user = null;
    sessionState.status = "authenticated";
    getMock.mockImplementation((path: string) =>
      path === "/api/v1/config/limits"
        ? Promise.resolve({
            data: { road_quality_max_zoom: null },
            error: undefined,
          })
        : Promise.resolve({ data: undefined, error: { message: "no auth" } }),
    );
    const { result } = renderHook(() => useRoadQualityZoomCap(), {
      wrapper: withQueryClient(),
    });
    await waitFor(() => expect(getMock).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(result.current.isResolved).toBe(false);
    expect(result.current.limit).toBeNull();
  });
});

describe("useFeatureGrantNonce", () => {
  beforeEach(() => {
    getMock.mockReset();
    authState.user = { id: "u1" };
    sessionState.status = "authenticated";
  });

  function renderNonce(key: Parameters<typeof useFeatureGrantNonce>[0]) {
    const client = createTestQueryClient();
    const view = renderHook(
      () => ({
        nonce: useFeatureGrantNonce(key),
        feature: useFeature(key),
      }),
      { wrapper: withQueryClient(client) },
    );
    return { client, ...view };
  }

  it("bumps on a disabled→enabled transition (upgrade / operator re-enable)", async () => {
    let grantRides = false;
    getMock.mockImplementation(() =>
      Promise.resolve({
        data: { ...ME, features: { ...ME.features, group_rides: grantRides } },
        error: undefined,
      }),
    );
    const { client, result } = renderNonce("group_rides");
    await waitFor(() => expect(result.current.feature.isSuccess).toBe(true));
    expect(result.current.feature.enabled).toBe(false);
    // First resolution must NOT count as a grant — nothing stale to replace.
    expect(result.current.nonce).toBe(0);

    // Access is granted; a /users/me refetch flips the snapshot enabled.
    grantRides = true;
    await act(async () => {
      await client.invalidateQueries();
    });
    await waitFor(() => expect(result.current.feature.enabled).toBe(true));
    expect(result.current.nonce).toBe(1);
  });

  it("bumps on the FIRST resolution when it lands enabled (concurrent-grant race)", async () => {
    // The ride request and /users/me are concurrent: the flag can flip enabled
    // in between, so the ride comes back gated while the first snapshot is
    // already enabled. The first enabled resolution must therefore bump so the
    // consumer can refetch the stale payload (it gates the actual refetch on
    // having a payload to enrich).
    getMock.mockResolvedValue({
      data: { ...ME, features: { ...ME.features, group_rides: true } },
      error: undefined,
    });
    const { result } = renderNonce("group_rides");
    await waitFor(() => expect(result.current.feature.isSuccess).toBe(true));
    expect(result.current.feature.enabled).toBe(true);
    expect(result.current.nonce).toBe(1);
  });

  it("does NOT bump when /users/me is already cached-enabled before mount", async () => {
    // No race: the snapshot is resolved enabled from the first render, so the
    // consuming page's ride fetch and the entitlement agree. Bumping here would
    // needlessly cancel+restart that in-flight ride GET on ordinary entitled
    // navigation, double-hitting the backend.
    const enabledMe = {
      ...ME,
      features: { ...ME.features, group_rides: true },
    };
    const client = createTestQueryClient();
    client.setQueryData(USERS_ME_QUERY_KEY("u1"), enabledMe);
    getMock.mockResolvedValue({ data: enabledMe, error: undefined });
    const { result } = renderHook(
      () => ({
        nonce: useFeatureGrantNonce("group_rides"),
        feature: useFeature("group_rides"),
      }),
      { wrapper: withQueryClient(client) },
    );
    await waitFor(() => expect(result.current.feature.isSuccess).toBe(true));
    expect(result.current.feature.enabled).toBe(true);
    // Seeded from the resolved-enabled snapshot → no bump.
    expect(result.current.nonce).toBe(0);
  });

  it("does NOT bump on a first DISABLED resolution", async () => {
    getMock.mockResolvedValue({
      data: { ...ME, features: { ...ME.features, group_rides: false } },
      error: undefined,
    });
    const { result } = renderNonce("group_rides");
    await waitFor(() => expect(result.current.feature.isSuccess).toBe(true));
    expect(result.current.feature.enabled).toBe(false);
    expect(result.current.nonce).toBe(0);
  });

  it("does NOT bump on an enabled→disabled transition (locking is snapshot-driven)", async () => {
    let grantRides = true;
    getMock.mockImplementation(() =>
      Promise.resolve({
        data: { ...ME, features: { ...ME.features, group_rides: grantRides } },
        error: undefined,
      }),
    );
    const { client, result } = renderNonce("group_rides");
    await waitFor(() => expect(result.current.feature.enabled).toBe(true));
    // First enabled resolution bumps to 1…
    expect(result.current.nonce).toBe(1);

    grantRides = false;
    await act(async () => {
      await client.invalidateQueries();
    });
    await waitFor(() => expect(result.current.feature.enabled).toBe(false));
    // …and the enabled→disabled transition does NOT bump again.
    expect(result.current.nonce).toBe(1);
  });
});

describe("useSystemSwitch", () => {
  beforeEach(() => {
    getMock.mockReset();
    authState.user = { id: "u1" };
    sessionState.status = "authenticated";
  });

  it("is ENABLED (default-on) when no operator override is present", async () => {
    getMock.mockResolvedValue({ data: {}, error: undefined });
    const { result } = renderHook(() => useSystemSwitch("sys_aerial_basemap"), {
      wrapper: withQueryClient(),
    });
    await waitFor(() => expect(result.current.isResolved).toBe(true));
    expect(getMock).toHaveBeenCalledWith("/api/v1/config/flags", {
      signal: expect.anything(),
    });
    expect(result.current.enabled).toBe(true);
  });

  it("is DISABLED when the operator force_off's it", async () => {
    getMock.mockResolvedValue({
      data: { sys_aerial_basemap: "force_off" },
      error: undefined,
    });
    const { result } = renderHook(() => useSystemSwitch("sys_aerial_basemap"), {
      wrapper: withQueryClient(),
    });
    await waitFor(() => expect(result.current.isResolved).toBe(true));
    expect(result.current.enabled).toBe(false);
  });

  it("stays ENABLED under a force_on override", async () => {
    getMock.mockResolvedValue({
      data: { sys_aerial_basemap: "force_on" },
      error: undefined,
    });
    const { result } = renderHook(() => useSystemSwitch("sys_aerial_basemap"), {
      wrapper: withQueryClient(),
    });
    await waitFor(() => expect(result.current.isResolved).toBe(true));
    expect(result.current.enabled).toBe(true);
  });

  it("fails SAFE (enabled) while the flags fetch is unresolved", () => {
    getMock.mockReturnValue(new Promise(() => {})); // never resolves
    const { result } = renderHook(() => useSystemSwitch("sys_aerial_basemap"), {
      wrapper: withQueryClient(),
    });
    // A KILL switch must not flash the feature off on every load.
    expect(result.current.enabled).toBe(true);
    expect(result.current.isResolved).toBe(false);
  });
});
