import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { withQueryClient } from "./test-utils";

const getMock = vi.fn();
const { authState } = vi.hoisted(() => ({
  authState: { user: { id: "u1" } as { id: string } | null },
}));
vi.mock("@/lib/api", () => ({
  api: { GET: (...a: unknown[]) => getMock(...a) },
}));
vi.mock("@/stores/auth", () => ({
  useAuthStore: (sel: (s: { user: { id: string } | null }) => unknown) =>
    sel(authState),
}));

import { useEntitlements, useFeature, useLimit } from "./useEntitlements";

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
