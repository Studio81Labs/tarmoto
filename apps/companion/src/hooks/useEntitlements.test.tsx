import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { withQueryClient } from "./test-utils";

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
  useEntitlements,
  useFeature,
  useLimit,
  useRoadQualityZoomCap,
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
