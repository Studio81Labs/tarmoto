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

import { useMonthlyStats } from "./useMonthlyStats";

describe("useMonthlyStats", () => {
  beforeEach(() => getMock.mockReset());

  it("fetches the monthly stats and surfaces them", async () => {
    getMock.mockResolvedValue({
      data: {
        this_month_km: 842,
        prev_month_km: 712,
        ride_hours: 32.4,
        prev_ride_hours: 28.1,
        new_roads: 14,
        max_lean_deg: 47,
        max_lean_ride_name: "Stelvio",
        max_lean_at: "2026-04-18T08:00:00Z",
        last_synced_at: "2026-04-18T12:12:00Z",
      },
      error: undefined,
    });
    const { result } = renderHook(() => useMonthlyStats(), {
      wrapper: withQueryClient(),
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(getMock).toHaveBeenCalledWith("/api/v1/users/me/stats/monthly", {
      signal: expect.anything(),
    });
    expect(result.current.stats?.this_month_km).toBe(842);
    expect(result.current.stats?.max_lean_ride_name).toBe("Stelvio");
  });

  it("keeps stats null when the API returns an error", async () => {
    getMock.mockResolvedValue({ data: undefined, error: { message: "boom" } });
    const { result } = renderHook(() => useMonthlyStats(), {
      wrapper: withQueryClient(),
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.stats).toBeNull();
  });
});
