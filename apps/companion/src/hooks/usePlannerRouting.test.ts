import { renderHook, act, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { usePlannerRouting } from "./usePlannerRouting";
import { routingApi } from "@/lib/api";

vi.mock("@/lib/api", () => ({ routingApi: { route: vi.fn() } }));
const routeMock = vi.mocked(routingApi.route);

const wp = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ lat: 50 + i, lng: 14 + i }));

describe("usePlannerRouting", () => {
  beforeEach(() => {
    routeMock.mockReset();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it("does nothing with fewer than 2 waypoints", () => {
    renderHook(() => usePlannerRouting(wp(1), {}, vi.fn(), vi.fn()));
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(routeMock).not.toHaveBeenCalled();
  });

  it("debounces then calls onResult with the routed response", async () => {
    routeMock.mockResolvedValueOnce({
      data: { geometry: [], distance_km: 5 },
    } as never);
    const onResult = vi.fn();
    renderHook(() => usePlannerRouting(wp(2), {}, onResult, vi.fn()));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    // waitFor relies on real setTimeout for its polling loop; restore before waiting.
    vi.useRealTimers();
    await waitFor(() =>
      expect(onResult).toHaveBeenCalledWith(
        { geometry: [], distance_km: 5 },
        null,
      ),
    );
    expect(routeMock).toHaveBeenCalledTimes(1);
  });

  it("echoes back the requestKey that was current when the request fired", async () => {
    routeMock.mockResolvedValueOnce({
      data: { geometry: [], distance_km: 7 },
    } as never);
    const onResult = vi.fn();
    // requestKey = 2 (e.g. the planner day this request was built for).
    renderHook(() => usePlannerRouting(wp(2), {}, onResult, vi.fn(), true, 2));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    vi.useRealTimers();
    // The key is passed back so the caller can apply the result to the day the
    // request was fired for, even if the selection changed before it resolved.
    await waitFor(() =>
      expect(onResult).toHaveBeenCalledWith(
        { geometry: [], distance_km: 7 },
        2,
      ),
    );
  });

  it("does NOT call routingApi.route when enabled=false, even with ≥2 waypoints", () => {
    renderHook(() => usePlannerRouting(wp(2), {}, vi.fn(), vi.fn(), false));
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(routeMock).not.toHaveBeenCalled();
  });

  it("returns routing:false immediately when enabled=false", () => {
    const { result } = renderHook(() =>
      usePlannerRouting(wp(2), {}, vi.fn(), vi.fn(), false),
    );
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(result.current.routing).toBe(false);
  });

  it("calls routingApi.route when enabled=true (default behavior unchanged)", async () => {
    routeMock.mockResolvedValueOnce({
      data: { geometry: [], distance_km: 10 },
    } as never);
    const onResult = vi.fn();
    renderHook(() => usePlannerRouting(wp(2), {}, onResult, vi.fn(), true));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    vi.useRealTimers();
    await waitFor(() => expect(onResult).toHaveBeenCalledTimes(1));
    expect(routeMock).toHaveBeenCalledTimes(1);
  });
});
