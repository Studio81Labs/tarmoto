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
    expect(result.current.user).toBeNull();
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

  it("rejects and sets error when loginWithPassword fails", async () => {
    (
      adminAuthApi.getCurrentAdmin as ReturnType<typeof vi.fn>
    ).mockResolvedValue(null);
    (
      adminAuthApi.loginWithPassword as ReturnType<typeof vi.fn>
    ).mockRejectedValue(new Error("network failure"));

    const { result } = renderHook(() => useAdminAuth());
    await waitFor(() => expect(result.current.status).toBe("unauthenticated"));

    let caught: unknown;
    await act(async () => {
      try {
        await result.current.loginWithPassword("bad@example.com", "wrong");
      } catch (err) {
        caught = err;
      }
    });

    expect(caught).toBeInstanceOf(Error);
    expect(result.current.error).not.toBeNull();
    expect(result.current.error).toMatch(/credentials/i);
  });

  it("drives status to unauthenticated and user to null after logout", async () => {
    (
      adminAuthApi.getCurrentAdmin as ReturnType<typeof vi.fn>
    ).mockResolvedValue(admin);
    (adminAuthApi.logout as ReturnType<typeof vi.fn>).mockResolvedValue(
      undefined,
    );

    const { result } = renderHook(() => useAdminAuth());
    await waitFor(() => expect(result.current.status).toBe("authenticated"));

    await act(async () => {
      await result.current.logout();
    });

    expect(result.current.status).toBe("unauthenticated");
    expect(result.current.user).toBeNull();
  });
});
