import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { useAdminAuth } from "./useAdminAuth.js";
import { adminAuthApi } from "./adminAuthApi.js";
import { ADMIN_AUTH_EXPIRED_EVENT } from "../data/apiClient.js";

vi.mock("./adminAuthApi.js", () => ({
  adminAuthApi: {
    getCurrentAdmin: vi.fn(),
    loginWithPassword: vi.fn(),
    logout: vi.fn(),
    startGithubSso: vi.fn(),
  },
}));

const admin = {
  id: "a1",
  email: "ops@tarmoto.app",
  role: "admin" as const,
  status: "active" as const,
};

describe("useAdminAuth", () => {
  beforeEach(() => vi.clearAllMocks());

  it("resolves to authenticated when a session exists", async () => {
    (
      adminAuthApi.getCurrentAdmin as ReturnType<typeof vi.fn>
    ).mockResolvedValue(admin);
    const { result } = renderHook(() => useAdminAuth());
    await waitFor(() => expect(result.current.status).toBe("authenticated"));
    expect(result.current.user).toEqual(admin);
  });

  it("resolves to unauthenticated when there is no session", async () => {
    (
      adminAuthApi.getCurrentAdmin as ReturnType<typeof vi.fn>
    ).mockResolvedValue(null);
    const { result } = renderHook(() => useAdminAuth());
    await waitFor(() => expect(result.current.status).toBe("unauthenticated"));
  });

  it("drops to unauthenticated on the expiry event", async () => {
    (
      adminAuthApi.getCurrentAdmin as ReturnType<typeof vi.fn>
    ).mockResolvedValue(admin);
    const { result } = renderHook(() => useAdminAuth());
    await waitFor(() => expect(result.current.status).toBe("authenticated"));
    act(() => {
      window.dispatchEvent(new Event(ADMIN_AUTH_EXPIRED_EVENT));
    });
    await waitFor(() => expect(result.current.status).toBe("unauthenticated"));
  });
});
