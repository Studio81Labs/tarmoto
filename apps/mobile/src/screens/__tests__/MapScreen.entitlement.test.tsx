import { act, renderHook } from "@testing-library/react-native";
import { useAuthStore } from "@/stores";
import {
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

afterEach(() => useAuthStore.setState({ user: null }));

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
