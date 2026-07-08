import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { plannerApi } from "@/lib/planner/api";
import type { Trip } from "@/lib/types";
import { useRouteQualityHydration } from "./useRouteQualityHydration";

vi.mock("@/lib/planner/api", () => ({
  plannerApi: { getRouteQuality: vi.fn() },
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
});
