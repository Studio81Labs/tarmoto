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

  it("dispatches the expiry event when refresh fails", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("", { status: 401 }))
      .mockResolvedValueOnce(new Response("", { status: 401 })); // refresh fails
    vi.stubGlobal("fetch", fetchMock);
    const handler = vi.fn();
    window.addEventListener(ADMIN_AUTH_EXPIRED_EVENT, handler);
    const res = await adminFetchWithRefresh("/api/v1/admin/metrics", {});
    window.removeEventListener(ADMIN_AUTH_EXPIRED_EVENT, handler);
    expect(res.status).toBe(401);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("does not try to refresh the refresh endpoint itself", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    await adminFetchWithRefresh("/api/v1/admin/auth/refresh", {
      method: "POST",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
