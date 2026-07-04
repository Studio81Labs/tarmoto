import { renderHook, act, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { usePlannerRouting } from "./usePlannerRouting";
import { routingApi } from "@/lib/api";
import type { PlannerRoutingLeg } from "@/lib/planner/leg-routing";

vi.mock("@/lib/api", () => ({ routingApi: { route: vi.fn() } }));
const routeMock = vi.mocked(routingApi.route);

/** N-1 legs through N points at (50+i, 14+i), preference per leg optional. */
function legs(count: number, preferences: string[] = []): PlannerRoutingLeg[] {
  return Array.from({ length: count }, (_, i) => ({
    legId: `w${i}->w${i + 1}`,
    from: { lat: 50 + i, lng: 14 + i },
    to: { lat: 51 + i, lng: 15 + i },
    options: {
      preference: (preferences[i] ?? "direct") as never,
    },
  }));
}

function response(km: number, points = 2) {
  return {
    data: {
      geometry: Array.from({ length: points }, (_, i) => ({
        lat: 50 + i,
        lng: 14 + i,
      })),
      distance_km: km,
      duration_min: km,
      elevation_gain_m: 10,
      avg_quality: 4,
      curviness_score: 30,
      surface_mix: { asphalt: km * 1000 },
    },
  };
}

describe("usePlannerRouting", () => {
  beforeEach(() => {
    routeMock.mockReset();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it("does nothing with zero legs", () => {
    renderHook(() => usePlannerRouting([], vi.fn(), vi.fn()));
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(routeMock).not.toHaveBeenCalled();
  });

  it("debounces then calls onResult with the concatenated response + leg breaks", async () => {
    routeMock.mockResolvedValue(response(5) as never);
    const onResult = vi.fn();
    renderHook(() => usePlannerRouting(legs(1), onResult, vi.fn()));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    // waitFor relies on real setTimeout for its polling loop; restore before waiting.
    vi.useRealTimers();
    await waitFor(() => expect(onResult).toHaveBeenCalledTimes(1));
    expect(routeMock).toHaveBeenCalledTimes(1);
    const [merged, legBreaks, key] = onResult.mock.calls[0]!;
    expect(merged.distance_km).toBe(5);
    expect(legBreaks).toEqual([{ legId: "w0->w1", startVertex: 0 }]);
    expect(key).toBeNull();
  });

  it("requests each leg separately with its own options and concatenates", async () => {
    routeMock.mockResolvedValue(response(10, 3) as never);
    const onResult = vi.fn();
    renderHook(() =>
      usePlannerRouting(
        legs(2, ["direct", "maximum_twisty"]),
        onResult,
        vi.fn(),
      ),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    vi.useRealTimers();
    await waitFor(() => expect(onResult).toHaveBeenCalledTimes(1));
    // One request per leg (revision 3 §C), carrying that leg's preference.
    expect(routeMock).toHaveBeenCalledTimes(2);
    expect(routeMock.mock.calls[0]![0]).toMatchObject({
      options: { preference: "direct" },
    });
    expect(routeMock.mock.calls[1]![0]).toMatchObject({
      options: { preference: "maximum_twisty" },
    });
    const [merged, legBreaks] = onResult.mock.calls[0]!;
    // 3 + 3 vertices sharing the boundary vertex → 5 total.
    expect(merged.geometry).toHaveLength(5);
    expect(merged.distance_km).toBe(20);
    expect(legBreaks).toEqual([
      { legId: "w0->w1", startVertex: 0 },
      { legId: "w1->w2", startVertex: 2 },
    ]);
  });

  it("echoes back the requestKey that was current when the request fired", async () => {
    routeMock.mockResolvedValue(response(7) as never);
    const onResult = vi.fn();
    // requestKey = 2 (e.g. the planner day this request was built for).
    renderHook(() => usePlannerRouting(legs(1), onResult, vi.fn(), true, 2));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    vi.useRealTimers();
    // The key is passed back so the caller can apply the result to the day the
    // request was fired for, even if the selection changed before it resolved.
    await waitFor(() =>
      expect(onResult).toHaveBeenCalledWith(
        expect.objectContaining({ distance_km: 7 }),
        expect.any(Array),
        2,
      ),
    );
  });

  it("does NOT call routingApi.route when enabled=false, even with legs", () => {
    renderHook(() => usePlannerRouting(legs(1), vi.fn(), vi.fn(), false));
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(routeMock).not.toHaveBeenCalled();
  });

  it("returns routing:false immediately when enabled=false", () => {
    const { result } = renderHook(() =>
      usePlannerRouting(legs(1), vi.fn(), vi.fn(), false),
    );
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(result.current.routing).toBe(false);
  });

  it("surfaces a failed leg as a single onError (no partial apply)", async () => {
    routeMock
      .mockResolvedValueOnce(response(10) as never)
      .mockRejectedValueOnce(new Error("leg 2 unroutable"));
    const onResult = vi.fn();
    const onError = vi.fn();
    renderHook(() => usePlannerRouting(legs(2), onResult, onError));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    vi.useRealTimers();
    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(onResult).not.toHaveBeenCalled();
  });
});
