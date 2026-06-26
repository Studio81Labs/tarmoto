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
      expect(onResult).toHaveBeenCalledWith({ geometry: [], distance_km: 5 }),
    );
    expect(routeMock).toHaveBeenCalledTimes(1);
  });
});
