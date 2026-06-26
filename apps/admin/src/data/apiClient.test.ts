import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  adminFetchWithRefresh,
  ADMIN_AUTH_EXPIRED_EVENT,
} from "./apiClient.js";

describe("adminFetchWithRefresh", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("passes through a successful response", async () => {
    const ok = new Response("{}", { status: 200 });
    const fetchMock = vi.fn().mockResolvedValue(ok);
    vi.stubGlobal("fetch", fetchMock);
    const res = await adminFetchWithRefresh("/api/v1/admin/metrics", {});
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refreshes once on 401 then replays the original request", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("", { status: 401 })) // original
      .mockResolvedValueOnce(new Response("", { status: 201 })) // refresh
      .mockResolvedValueOnce(new Response("{}", { status: 200 })); // replay
    vi.stubGlobal("fetch", fetchMock);
    const res = await adminFetchWithRefresh("/api/v1/admin/metrics", {});
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/v1/admin/auth/refresh",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("recovers from a benign concurrent-refresh race (first refresh 401, second refresh 200)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("", { status: 401 })) // original
      .mockResolvedValueOnce(new Response("", { status: 401 })) // first refresh fails (race loser)
      .mockResolvedValueOnce(new Response("", { status: 201 })) // second refresh succeeds (rotated cookie)
      .mockResolvedValueOnce(new Response("{}", { status: 200 })); // replay
    vi.stubGlobal("fetch", fetchMock);
    const handler = vi.fn();
    window.addEventListener(ADMIN_AUTH_EXPIRED_EVENT, handler);
    const res = await adminFetchWithRefresh("/api/v1/admin/metrics", {});
    window.removeEventListener(ADMIN_AUTH_EXPIRED_EVENT, handler);
    expect(res.status).toBe(200);
    expect(handler).not.toHaveBeenCalled();
    const refreshCalls = fetchMock.mock.calls.filter(
      (args) => args[0] === "/api/v1/admin/auth/refresh",
    );
    expect(refreshCalls).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("dispatches the expiry event only when both refresh attempts fail", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("", { status: 401 })) // original
      .mockResolvedValueOnce(new Response("", { status: 401 })) // first refresh fails
      .mockResolvedValueOnce(new Response("", { status: 401 })); // second refresh also fails
    vi.stubGlobal("fetch", fetchMock);
    const handler = vi.fn();
    window.addEventListener(ADMIN_AUTH_EXPIRED_EVENT, handler);
    const res = await adminFetchWithRefresh("/api/v1/admin/metrics", {});
    window.removeEventListener(ADMIN_AUTH_EXPIRED_EVENT, handler);
    expect(res.status).toBe(401);
    expect(handler).toHaveBeenCalledTimes(1);
    const refreshCalls = fetchMock.mock.calls.filter(
      (args) => args[0] === "/api/v1/admin/auth/refresh",
    );
    expect(refreshCalls).toHaveLength(2);
  });

  it.each([
    "/api/v1/admin/auth/refresh",
    "/api/v1/admin/auth/login",
    "/api/v1/admin/auth/logout",
  ])("does not try to refresh the auth endpoint %s on 401", async (path) => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    await adminFetchWithRefresh(path, { method: "POST" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fires refresh exactly once for two concurrent 401s (dedup)", async () => {
    const callsPerUrl: Record<string, number> = {};
    const fetchMock = vi.fn().mockImplementation((url: string | Request) => {
      const key = typeof url === "string" ? url : (url as Request).url;
      callsPerUrl[key] = (callsPerUrl[key] ?? 0) + 1;
      if (key === "/api/v1/admin/auth/refresh") {
        return Promise.resolve(new Response("", { status: 200 }));
      }
      // first two calls to the real endpoint are the originals → 401; replays → 200
      return Promise.resolve(
        new Response("{}", { status: callsPerUrl[key] <= 2 ? 401 : 200 }),
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const [resA, resB] = await Promise.all([
      adminFetchWithRefresh("/api/v1/admin/metrics", {}),
      adminFetchWithRefresh("/api/v1/admin/metrics", {}),
    ]);

    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);
    // Refresh fired exactly once — this is the core dedup property
    expect(callsPerUrl["/api/v1/admin/auth/refresh"]).toBe(1);
    // 2 originals + 1 refresh + 2 replays
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });
});
