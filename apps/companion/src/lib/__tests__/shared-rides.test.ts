import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchSharedRides } from "../shared-rides";
import { api } from "../api";

vi.mock("../api", async () => {
  const actual = await vi.importActual<typeof import("../api")>("../api");
  return {
    ...actual,
    api: {
      GET: vi.fn(),
    },
  };
});

const apiGet = vi.mocked(api.GET);

function ok<T>(data: T) {
  return {
    data,
    response: new Response(null, { status: 200 }),
  } as unknown as Awaited<ReturnType<typeof api.GET>>;
}

function fail(status: number, body: unknown = { message: "boom" }) {
  return {
    error: body,
    response: new Response(null, { status }),
  } as unknown as Awaited<ReturnType<typeof api.GET>>;
}

beforeEach(() => {
  apiGet.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("fetchSharedRides", () => {
  function ridePayload() {
    return {
      items: [
        {
          id: "ride-1",
          share_token: "tok-1",
          ride_type: "free",
          is_public: true,
          started_at: "2026-04-14T09:00:00.000Z",
          ended_at: "2026-04-14T10:30:00.000Z",
          distance_km: 42.5,
          avg_speed: 65.3,
          avg_road_quality: 4.2,
          avg_curviness: 3.1,
          duration_min: 90,
          view_count: 7,
          shared_at: "2026-04-14T11:00:00.000Z",
          route_geometry: null,
        },
      ],
      total: 1,
      limit: 5,
      offset: 0,
    };
  }

  it("returns the typed payload on success", async () => {
    apiGet.mockResolvedValueOnce(ok(ridePayload()));
    const result = await fetchSharedRides("rider-1", { limit: 5 });
    expect(result?.items).toHaveLength(1);
    expect(result?.items[0]?.share_token).toBe("tok-1");
  });

  it("forwards limit/offset and the abort signal to the typed client", async () => {
    apiGet.mockResolvedValueOnce(ok(ridePayload()));
    const controller = new AbortController();
    await fetchSharedRides("rider-1", {
      limit: 10,
      offset: 20,
      signal: controller.signal,
    });
    expect(apiGet).toHaveBeenCalledWith(
      "/api/v1/users/{userId}/shared-rides",
      expect.objectContaining({
        params: {
          path: { userId: "rider-1" },
          query: { limit: 10, offset: 20 },
        },
        signal: controller.signal,
      }),
    );
  });

  it("collapses 404 to null so the section renders the empty state", async () => {
    // 404 covers "private profile and you're not me", soft-deleted users,
    // and "no such id" — the section can't disambiguate them and the right
    // UX is the same in all three cases.
    apiGet.mockResolvedValueOnce(fail(404));
    const result = await fetchSharedRides("rider-private");
    expect(result).toBeNull();
  });

  it("throws on other non-OK statuses so the section can render the error state", async () => {
    apiGet.mockResolvedValueOnce(fail(500));
    await expect(fetchSharedRides("rider-1")).rejects.toThrow(/500/);
  });
});
