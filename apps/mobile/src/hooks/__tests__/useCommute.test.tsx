/**
 * useCommute — focused on the load/refresh contract.
 *
 * The render coverage of this hook lives in `CommuteScreen.test.tsx`.
 * This file pins down the *fan-out* behaviour: secondary fetches
 * (alternatives, stats) must not nuke the previously-rendered cards
 * when they fail on a pull-to-refresh, and `withSecondary: false`
 * must keep them off the wire entirely.
 */

import { act, renderHook, waitFor } from "@testing-library/react-native";
import { useCommute } from "../useCommute";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores";
import type {
  CommuteAlternativesResponse,
  CommuteRoute,
  CommuteStats,
  CommuteStatus,
} from "@/types";

jest.mock("@/services/api", () => ({
  api: {
    getCommuteRoutes: jest.fn(),
    getCommuteStatus: jest.fn(),
    getCommuteAlternatives: jest.fn(),
    getCommuteStats: jest.fn(),
    setPrimaryCommuteRoute: jest.fn(),
  },
}));

jest.mock("@/stores", () => {
  const actual = jest.requireActual("@/stores");
  return {
    ...actual,
    // Tiny fake matching the real store shape — `getSeenHazards` returns
    // an empty list so every hazard would render as "new", but the hook
    // contract doesn't care about that here.
    useCommuteStore: Object.assign(
      (selector: (s: unknown) => unknown) =>
        selector({
          markHazardsSeen: jest.fn(),
          seenHazardsByRoute: {},
          getSeenHazards: () => [],
        }),
      {
        getState: () => ({
          markHazardsSeen: jest.fn(),
          seenHazardsByRoute: {},
          getSeenHazards: () => [],
        }),
      },
    ),
    diffNewHazards: () => [],
  };
});

const baseRoute: CommuteRoute = {
  id: "route-1",
  name: "Home → Work",
  origin: { lat: 49.2, lng: 16.6 },
  destination: { lat: 49.1, lng: 16.75 },
  distance_km: 12.5,
  avg_duration_min: 22,
  avg_quality: 4.2,
  is_primary: true,
  route_geometry: [],
  created_at: "2026-04-20T07:30:00.000Z",
};

const baseStatus: CommuteStatus = {
  route: baseRoute,
  hazards: [],
  hazard_count: 0,
  weather: {
    temperature_c: 14,
    condition: "clear",
    wind_kmh: 8,
    precipitation_chance: 0.1,
    road_condition: "dry",
    description: "Clear",
  },
  estimated_time_min: 22,
  route_quality: 4.2,
  status: "clear",
};

const baseAlternatives: CommuteAlternativesResponse = {
  primary_route: baseRoute,
  primary_hazard_count: 0,
  alternatives: [],
};

const baseStats: CommuteStats = {
  period: "week",
  total_rides: 3,
  total_km: 36.5,
  total_time_min: 60,
  avg_duration_min: 20,
  fuel_estimate_l: 1.8,
  daily_breakdown: [],
  previous_period: {
    total_rides: 2,
    total_km: 25,
    total_time_min: 50,
    avg_duration_min: 25,
    fuel_estimate_l: 1.25,
  },
};

const routesMock = api.getCommuteRoutes as jest.MockedFunction<
  typeof api.getCommuteRoutes
>;
const statusMock = api.getCommuteStatus as jest.MockedFunction<
  typeof api.getCommuteStatus
>;
const altMock = api.getCommuteAlternatives as jest.MockedFunction<
  typeof api.getCommuteAlternatives
>;
const statsMock = api.getCommuteStats as jest.MockedFunction<
  typeof api.getCommuteStats
>;

describe("useCommute", () => {
  beforeEach(() => {
    routesMock.mockReset();
    statusMock.mockReset();
    altMock.mockReset();
    statsMock.mockReset();
    // Entitled by default so the existing fetch/phase tests exercise the
    // loaded path. The entitlement-gating tests below override this.
    useAuthStore.setState({
      user: {
        id: "u1",
        subscription_tier: "pro",
        features: { commuter_mode: true },
        limits: {},
      } as never,
    });
  });

  it("preserves prior alternatives and stats when a refresh's secondary fetches fail", async () => {
    routesMock.mockResolvedValue([baseRoute]);
    statusMock.mockResolvedValue(baseStatus);
    altMock.mockResolvedValueOnce(baseAlternatives);
    statsMock.mockResolvedValueOnce(baseStats);

    const { result } = await renderHook(() => useCommute());

    await waitFor(() => expect(result.current.phase).toBe("ready"));
    expect(result.current.alternatives).toEqual(baseAlternatives);
    expect(result.current.stats).toEqual(baseStats);

    // Refresh with the secondary fetches rejecting. The hook should keep
    // the previously-rendered slices on screen — clearing them would
    // make the alternatives card and weekly summary visibly disappear
    // on a transient 5xx, which the hook's docblock explicitly says it
    // shouldn't do.
    altMock.mockRejectedValueOnce(new Error("alt down"));
    statsMock.mockRejectedValueOnce(new Error("stats down"));

    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.alternatives).toEqual(baseAlternatives);
    expect(result.current.stats).toEqual(baseStats);
  });

  it("skips alternatives and stats fetches when withSecondary is false", async () => {
    routesMock.mockResolvedValue([baseRoute]);
    statusMock.mockResolvedValue(baseStatus);

    const { result } = await renderHook(() =>
      useCommute({ withSecondary: false }),
    );

    await waitFor(() => expect(result.current.phase).toBe("ready"));

    expect(altMock).not.toHaveBeenCalled();
    expect(statsMock).not.toHaveBeenCalled();
    expect(result.current.alternatives).toBeNull();
    expect(result.current.stats).toBeNull();
  });

  describe("commuter_mode entitlement gating", () => {
    it("never fetches /commute/* for a resolved rider without commuter_mode (covers HomeScreen entry)", async () => {
      // HomeScreen mounts this hook at app entry regardless of tier. A Free
      // rider must NOT fire the guarded requests and collect a 403 before
      // ever opening the (separately gated) Commute screen.
      useAuthStore.setState({
        user: {
          id: "u1",
          subscription_tier: "free",
          features: { commuter_mode: false },
          limits: {},
        } as never,
      });

      const { result } = await renderHook(() => useCommute());

      await waitFor(() => expect(result.current.phase).toBe("locked"));
      expect(routesMock).not.toHaveBeenCalled();
      expect(statusMock).not.toHaveBeenCalled();
      expect(altMock).not.toHaveBeenCalled();
      expect(statsMock).not.toHaveBeenCalled();
    });

    it("fails closed while the entitlement snapshot is unresolved — no fetch", async () => {
      // Legacy cached profile with no features/limits slices: `isResolved`
      // is false, so the hook must stay quiet rather than fetch on a guess.
      useAuthStore.setState({
        user: { id: "u1", subscription_tier: "free" } as never,
      });

      const { result } = await renderHook(() => useCommute());

      // Give any (incorrect) fetch a chance to fire.
      await act(async () => {
        await Promise.resolve();
      });
      expect(result.current.phase).toBe("loading");
      expect(routesMock).not.toHaveBeenCalled();
    });

    it("fetches normally once commuter_mode is entitled", async () => {
      routesMock.mockResolvedValue([baseRoute]);
      statusMock.mockResolvedValue(baseStatus);
      // `beforeEach` already seeds an entitled pro user.

      const { result } = await renderHook(() => useCommute());

      await waitFor(() => expect(result.current.phase).toBe("ready"));
      expect(routesMock).toHaveBeenCalled();
    });

    it("discards an in-flight load's result when commuter_mode is revoked mid-load", async () => {
      // Hold the routes fetch open so the load is still awaiting when the
      // revoke lands.
      let resolveRoutes: (v: CommuteRoute[]) => void = () => {};
      routesMock.mockReturnValue(
        new Promise<CommuteRoute[]>((res) => {
          resolveRoutes = res;
        }),
      );
      statusMock.mockResolvedValue(baseStatus);

      const { result } = await renderHook(() => useCommute());

      // Revoke while the routes promise is still pending → phase goes locked.
      await act(async () => {
        useAuthStore.setState({
          user: {
            id: "u1",
            subscription_tier: "free",
            features: { commuter_mode: false },
            limits: {},
          } as never,
        });
        await Promise.resolve();
      });
      await waitFor(() => expect(result.current.phase).toBe("locked"));

      // The stale routes fetch now resolves — it must NOT flip phase back.
      await act(async () => {
        resolveRoutes([baseRoute]);
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(result.current.phase).toBe("locked");
    });
  });
});
