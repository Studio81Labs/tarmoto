import { act, renderHook, waitFor } from "@testing-library/react-native";
import { AppState, type AppStateStatus } from "react-native";
import type { GlobalLimitOverrides } from "@tarmoto/shared";

const mockGetConfigLimits = jest.fn();
jest.mock("@/services/api", () => ({
  api: { getConfigLimits: () => mockGetConfigLimits() },
}));

import { useAuthStore } from "@/stores";
import {
  __resetGlobalLimitsCacheForTest,
  shouldShowQualityUpgradePrompt,
  useQualityLayerMaxZoom,
} from "../MapScreen.entitlement";

const baseUser = {
  id: "u1",
  subscription_tier: "free",
  features: { gpx_export: false, basic_navigation: true },
  limits: {
    max_active_trips: 1,
    road_quality_max_zoom: 12,
    max_trip_collaborators: 0,
  },
};

beforeEach(() => {
  __resetGlobalLimitsCacheForTest();
  mockGetConfigLimits.mockReset().mockResolvedValue({});
  // Confirmed-anonymous requires a SETTLED bootstrap; default false so the
  // logged-out test keeps failing closed, flipped true for the anonymous cases.
  useAuthStore.setState({ user: null, bootstrapSettled: false });
});

afterEach(() => useAuthStore.setState({ user: null, bootstrapSettled: false }));

// `renderHook` is async in the installed @testing-library/react-native
// (14.x) — see useEntitlements.test.ts for the same `await renderHook(...)`
// idiom used elsewhere in this repo.

it("clamps to the free cap for a free rider", async () => {
  useAuthStore.setState({ user: baseUser as never });
  const { result } = await renderHook(() => useQualityLayerMaxZoom());
  expect(result.current.maxzoom).toBe(12);
  expect(result.current.visible).toBe(true);
});

it("clamps to the mobile source ceiling when unlimited", async () => {
  useAuthStore.setState({
    user: { ...baseUser, limits: { road_quality_max_zoom: null } } as never,
  });
  const { result } = await renderHook(() => useQualityLayerMaxZoom());
  expect(result.current.maxzoom).toBe(22);
  expect(result.current.visible).toBe(true);
});

it("fails closed to the free cap when logged out / unresolved", async () => {
  const { result } = await renderHook(() => useQualityLayerMaxZoom());
  expect(result.current.maxzoom).toBe(12);
  expect(result.current.visible).toBe(true);
});

describe("confirmed-anonymous rider (public /config/limits)", () => {
  beforeEach(() => useAuthStore.setState({ bootstrapSettled: true }));

  it("renders to the ceiling under the dark-launch unlimited override (null)", async () => {
    // limit_states seeds road_quality_max_zoom = NULL (unlimited) at launch.
    mockGetConfigLimits.mockResolvedValue({ road_quality_max_zoom: null });
    const { result } = await renderHook(() => useQualityLayerMaxZoom());
    await waitFor(() => expect(result.current.maxzoom).toBe(22));
  });

  it("applies a finite operator override as a cap", async () => {
    mockGetConfigLimits.mockResolvedValue({ road_quality_max_zoom: 14 });
    const { result } = await renderHook(() => useQualityLayerMaxZoom());
    await waitFor(() => expect(result.current.maxzoom).toBe(14));
  });

  it("falls back to the free cap when the override is absent (post go-live)", async () => {
    // No key → no override → an anonymous rider resolves to the free default.
    mockGetConfigLimits.mockResolvedValue({});
    const { result } = await renderHook(() => useQualityLayerMaxZoom());
    await waitFor(() => expect(mockGetConfigLimits).toHaveBeenCalled());
    expect(result.current.maxzoom).toBe(12);
  });

  it("fails closed to the free cap while /config/limits is unresolved (offline)", async () => {
    mockGetConfigLimits.mockRejectedValue(new Error("offline"));
    const { result } = await renderHook(() => useQualityLayerMaxZoom());
    await waitFor(() => expect(mockGetConfigLimits).toHaveBeenCalled());
    expect(result.current.maxzoom).toBe(12);
  });

  it("REACTS to settlement flipping false→true (screen mounted before bootstrap settled)", async () => {
    // The screen mounts before a sessionless bootstrap finishes: settlement is
    // false, so it fails closed to 12 and does NOT fetch. When bootstrap settles
    // (leaving user null), the reactive store subscription must re-render and
    // trigger the /config/limits fetch → z22 under the dark override.
    useAuthStore.setState({ bootstrapSettled: false });
    mockGetConfigLimits.mockResolvedValue({ road_quality_max_zoom: null });

    const { result } = await renderHook(() => useQualityLayerMaxZoom());
    expect(result.current.maxzoom).toBe(12);
    expect(mockGetConfigLimits).not.toHaveBeenCalled();

    await act(async () => {
      useAuthStore.setState({ bootstrapSettled: true });
    });
    await waitFor(() => expect(result.current.maxzoom).toBe(22));
    expect(mockGetConfigLimits).toHaveBeenCalled();
  });

  it("revalidates /config/limits on a foreground transition", async () => {
    const listeners: Array<(s: AppStateStatus) => void> = [];
    const spy = jest
      .spyOn(AppState, "addEventListener")
      .mockImplementation(
        (event: string, listener: (s: AppStateStatus) => void) => {
          if (event === "change") listeners.push(listener);
          return { remove: jest.fn() } as never;
        },
      );
    mockGetConfigLimits.mockResolvedValue({ road_quality_max_zoom: null });
    await renderHook(() => useQualityLayerMaxZoom());
    await waitFor(() => expect(mockGetConfigLimits).toHaveBeenCalledTimes(1));

    // An operator tightens the cap; a foreground transition must pick it up.
    mockGetConfigLimits.mockResolvedValue({ road_quality_max_zoom: 12 });
    await act(async () => {
      listeners.forEach((l) => l("active"));
    });
    await waitFor(() => expect(mockGetConfigLimits).toHaveBeenCalledTimes(2));
    spy.mockRestore();
  });

  it("drops a superseded revalidation so an out-of-order resolve can't restore a stale override", async () => {
    const listeners: Array<(s: AppStateStatus) => void> = [];
    const spy = jest
      .spyOn(AppState, "addEventListener")
      .mockImplementation(
        (event: string, listener: (s: AppStateStatus) => void) => {
          if (event === "change") listeners.push(listener);
          return { remove: jest.fn() } as never;
        },
      );

    // Mount fetch (A) reads the stale unlimited override but resolves SLOWLY;
    // the foreground fetch (B) reads the tightened cap and resolves FIRST.
    let resolveA!: (v: GlobalLimitOverrides) => void;
    const aPending = new Promise<GlobalLimitOverrides>((r) => (resolveA = r));
    let resolveB!: (v: GlobalLimitOverrides) => void;
    const bPending = new Promise<GlobalLimitOverrides>((r) => (resolveB = r));
    mockGetConfigLimits
      .mockReturnValueOnce(aPending)
      .mockReturnValueOnce(bPending);

    const { result } = await renderHook(() => useQualityLayerMaxZoom());
    await waitFor(() => expect(mockGetConfigLimits).toHaveBeenCalledTimes(1));
    await act(async () => {
      listeners.forEach((l) => l("active")); // starts B
    });
    await waitFor(() => expect(mockGetConfigLimits).toHaveBeenCalledTimes(2));

    // B (newer) resolves first with the tightened cap, then A (older) resolves
    // last with the stale unlimited override — which must NOT win.
    await act(async () => {
      resolveB({ road_quality_max_zoom: 12 });
    });
    await act(async () => {
      resolveA({ road_quality_max_zoom: null });
    });
    await waitFor(() => expect(result.current.maxzoom).toBe(12));
    expect(result.current.maxzoom).not.toBe(22);
    spy.mockRestore();
  });
});

it("hides the overlay when an operator override clamps the cap to 0", async () => {
  useAuthStore.setState({
    user: { ...baseUser, limits: { road_quality_max_zoom: 0 } } as never,
  });
  const { result } = await renderHook(() => useQualityLayerMaxZoom());
  expect(result.current.maxzoom).toBe(0);
  expect(result.current.visible).toBe(false);
});

it("reacts to entitlement changes after mount", async () => {
  useAuthStore.setState({ user: baseUser as never });
  const { result } = await renderHook(() => useQualityLayerMaxZoom());
  expect(result.current.maxzoom).toBe(12);
  await act(() =>
    useAuthStore.setState({
      user: { ...baseUser, limits: { road_quality_max_zoom: null } } as never,
    }),
  );
  expect(result.current.maxzoom).toBe(22);
});

describe("shouldShowQualityUpgradePrompt", () => {
  const baseParams = {
    showQualityOverlay: true,
    dismissed: false,
    limit: 12,
    maxzoom: 12,
    viewZoom: 13,
    tier: "free" as const,
  };

  it("fires for a free rider zoomed past the finite free cap", () => {
    expect(shouldShowQualityUpgradePrompt(baseParams)).toBe(true);
  });

  it("stays silent when the overlay is off", () => {
    expect(
      shouldShowQualityUpgradePrompt({
        ...baseParams,
        showQualityOverlay: false,
      }),
    ).toBe(false);
  });

  it("stays silent once dismissed", () => {
    expect(
      shouldShowQualityUpgradePrompt({ ...baseParams, dismissed: true }),
    ).toBe(false);
  });

  it("stays silent when unlimited (no finite cap to zoom past)", () => {
    expect(shouldShowQualityUpgradePrompt({ ...baseParams, limit: null })).toBe(
      false,
    );
  });

  it("stays silent while still at or below the cap", () => {
    expect(
      shouldShowQualityUpgradePrompt({ ...baseParams, viewZoom: 12 }),
    ).toBe(false);
  });

  it("stays silent when an override clamps the cap (no upgrade would lift it)", () => {
    // `limit` (10) no longer matches the free tier's static default (12),
    // so `upgradeTierForLimit` returns null — an override, not the tier,
    // is capping this rider, and no upgrade would help.
    expect(
      shouldShowQualityUpgradePrompt({
        ...baseParams,
        limit: 10,
        maxzoom: 10,
      }),
    ).toBe(false);
  });

  it("stays silent for a pro rider (already past the free tier, next tier is also unlimited)", () => {
    // `road_quality_max_zoom` is `{ free: 12, pro: null, premium: null }` —
    // a resolved finite limit on a non-free tier can only be an override,
    // so `upgradeTierForLimit` returns null via the same override-mismatch
    // path as the case above (there is no finite non-free tier default to
    // legitimately match).
    expect(
      shouldShowQualityUpgradePrompt({
        ...baseParams,
        tier: "pro",
        limit: 15,
        maxzoom: 15,
        viewZoom: 16,
      }),
    ).toBe(false);
  });
});
