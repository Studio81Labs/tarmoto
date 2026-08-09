import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { plannerApi } from "@/lib/planner/api";
import type { Trip } from "@/lib/types";
import { useRouteQualityHydration } from "./useRouteQualityHydration";

vi.mock("@/lib/planner/api", () => ({
  plannerApi: { getRouteQuality: vi.fn() },
}));
// Kill switches fail SAFE (enabled until a confirmed `force_off`), so the
// default keeps every existing case on the path it was written for.
const killSwitch = vi.hoisted(() => ({ enabled: true }));
vi.mock("@/hooks/useEntitlements", () => ({
  useFeatureKillSwitch: () => ({
    enabled: killSwitch.enabled,
    isResolved: true,
  }),
}));
const getRouteQuality = vi.mocked(plannerApi.getRouteQuality);

function routedTrip(): Trip {
  return {
    id: "t1",
    name: "Trip",
    days: [
      {
        dayNumber: 1,
        waypoints: [],
        distanceKm: 10,
        durationMinutes: 20,
        elevationGain: 0,
        avgQuality: 4,
        routeGeometry: {
          type: "LineString",
          coordinates: [
            [0, 0],
            [1, 0],
          ],
        },
      },
    ],
  } as unknown as Trip;
}

describe("useRouteQualityHydration", () => {
  beforeEach(() => {
    getRouteQuality.mockReset();
    killSwitch.enabled = true;
    // A never-settling request keeps the controller in flight for the test.
    getRouteQuality.mockReturnValue(new Promise(() => {}));
  });

  it("fetches quality once for a routed day lacking it", () => {
    renderHook(() => useRouteQualityHydration(routedTrip(), vi.fn()));
    expect(getRouteQuality).toHaveBeenCalledTimes(1);
  });

  it("aborts the in-flight fetch when the day loses its routable geometry", () => {
    let signal: AbortSignal | undefined;
    getRouteQuality.mockImplementation((_points, _day, init) => {
      signal = init?.signal;
      return new Promise(() => {});
    });
    const { rerender } = renderHook(
      ({ trip }: { trip: Trip }) => useRouteQualityHydration(trip, vi.fn()),
      { initialProps: { trip: routedTrip() } },
    );
    expect(signal?.aborted).toBe(false);

    // Route cleared / finish removed → the day is no longer routable.
    const cleared = routedTrip();
    cleared.days[0]!.routeGeometry = undefined;
    rerender({ trip: cleared });
    expect(signal?.aborted).toBe(true);
  });

  it("aborts in-flight fetches on unmount", () => {
    let signal: AbortSignal | undefined;
    getRouteQuality.mockImplementation((_points, _day, init) => {
      signal = init?.signal;
      return new Promise(() => {});
    });
    const { unmount } = renderHook(() =>
      useRouteQualityHydration(routedTrip(), vi.fn()),
    );
    expect(signal?.aborted).toBe(false);
    unmount();
    expect(signal?.aborted).toBe(true);
  });

  it("aborts everything when the trip goes null", () => {
    let signal: AbortSignal | undefined;
    getRouteQuality.mockImplementation((_points, _day, init) => {
      signal = init?.signal;
      return new Promise(() => {});
    });
    const { rerender } = renderHook(
      ({ trip }: { trip: Trip | null }) =>
        useRouteQualityHydration(trip, vi.fn()),
      { initialProps: { trip: routedTrip() as Trip | null } },
    );
    expect(signal?.aborted).toBe(false);
    rerender({ trip: null });
    expect(signal?.aborted).toBe(true);
  });

  it("requests nothing while the road-quality overlay is killed", () => {
    // Both call sites — the planner and the read-only saved-trip detail —
    // inherit this, which is why the gate lives in the hook. Without it the
    // killed feature keeps issuing `POST /roads/route-quality` for every
    // routed day of every trip the rider opens.
    killSwitch.enabled = false;
    renderHook(() => useRouteQualityHydration(routedTrip(), vi.fn()));
    expect(getRouteQuality).not.toHaveBeenCalled();
  });

  it("aborts in-flight lookups when the switch flips off mid-request", () => {
    // A kill has to stop work already running, not only new work. This is the
    // same teardown the hook already performs when the trip goes away.
    const abortSpy = vi.spyOn(AbortController.prototype, "abort");
    // The SAME trip object on both renders, deliberately: a fresh one changes
    // the effect's `trip` dependency and would re-run it regardless, hiding
    // whether the switch is actually in the dependency array.
    const trip = routedTrip();
    const apply = vi.fn();
    const { rerender } = renderHook(() =>
      useRouteQualityHydration(trip, apply),
    );
    expect(getRouteQuality).toHaveBeenCalledTimes(1);
    abortSpy.mockClear();

    killSwitch.enabled = false;
    rerender();
    expect(abortSpy).toHaveBeenCalled();
    expect(getRouteQuality).toHaveBeenCalledTimes(1);
    abortSpy.mockRestore();
  });
});
