import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { withQueryClient } from "./test-utils";

const getMock = vi.fn();
vi.mock("@/lib/api", () => ({
  api: { GET: (...a: unknown[]) => getMock(...a) },
}));
vi.mock("@/stores/auth", () => ({
  useAuthStore: (sel: (s: { user: { id: string } | null }) => unknown) =>
    sel({ user: { id: "u1" } }),
}));

import { useRecentRides } from "./useRecentRides";

describe("useRecentRides", () => {
  beforeEach(() => getMock.mockReset());

  it("requests the newest rides capped at the limit", async () => {
    getMock.mockResolvedValue({
      data: {
        rides: [
          {
            id: "r1",
            name: "Stelvio",
            started_at: "2026-04-18T08:00:00Z",
            distance_km: 186,
            duration_min: 252,
            avg_speed: 64,
            avg_road_quality: 4.6,
            status: "completed",
            ride_type: "tour",
            ended_at: "2026-04-18T12:12:00Z",
          },
        ],
        total: 1,
      },
      error: undefined,
    });
    const { result } = renderHook(() => useRecentRides(5), {
      wrapper: withQueryClient(),
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(getMock).toHaveBeenCalledWith("/api/v1/rides", {
      params: { query: { limit: 5, sort: "started_at", order: "desc" } },
      signal: expect.anything(),
    });
    expect(result.current.rides).toHaveLength(1);
    expect(result.current.rides[0].name).toBe("Stelvio");
  });

  it("exposes error=true when the API returns an error", async () => {
    getMock.mockResolvedValue({ data: undefined, error: { message: "boom" } });
    const { result } = renderHook(() => useRecentRides(5), {
      wrapper: withQueryClient(),
    });
    await waitFor(() => expect(result.current.error).toBe(true));
    expect(result.current.rides).toHaveLength(0);
  });
});
