import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const connectSocket = vi.fn();
const disconnectSocket = vi.fn();
vi.mock("@/lib/socket", () => ({
  connectSocket: (...args: unknown[]) => connectSocket(...args),
  disconnectSocket: (...args: unknown[]) => disconnectSocket(...args),
}));

const usePathname = vi.fn<() => string>();
vi.mock("next/navigation", () => ({
  usePathname: () => usePathname(),
}));

vi.mock("@/i18n/I18nProvider", () => ({
  useTranslation: () => (s: string) => s,
}));

vi.mock("@/stores/auth", () => ({
  useAuthStore: (selector: (s: { accessToken: string | null }) => unknown) =>
    selector({ accessToken: "token-1" }),
}));

import { RealtimeProvider } from "./RealtimeProvider";

describe("RealtimeProvider", () => {
  beforeEach(() => {
    connectSocket.mockClear();
    disconnectSocket.mockClear();
  });

  it("connects the shared socket on app routes", () => {
    usePathname.mockReturnValue("/explore");
    render(<RealtimeProvider />);
    expect(connectSocket).toHaveBeenCalledWith("token-1", expect.any(Function));
  });

  it("stays socketless on the auth routes — the login flow's full-page navigation would kill the socket mid-handshake and log a false wss failure", () => {
    for (const route of ["/login", "/register", "/forgot-password"]) {
      connectSocket.mockClear();
      usePathname.mockReturnValue(route);
      const { unmount } = render(<RealtimeProvider />);
      expect(connectSocket).not.toHaveBeenCalled();
      unmount();
    }
  });

  it("tears the socket down when navigating into an auth route", () => {
    usePathname.mockReturnValue("/explore");
    const { rerender } = render(<RealtimeProvider />);
    expect(connectSocket).toHaveBeenCalledTimes(1);

    usePathname.mockReturnValue("/login");
    rerender(<RealtimeProvider />);
    expect(disconnectSocket).toHaveBeenCalled();
    expect(connectSocket).toHaveBeenCalledTimes(1);
  });
});
