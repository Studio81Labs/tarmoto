import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { Sidebar } from "./Sidebar";

const signOutMock = vi.fn();
const getNotificationsMock = vi.fn();

vi.mock("next-auth/react", () => ({
  useSession: () => ({
    data: { user: { displayName: "Rider Smith" } },
    status: "authenticated",
  }),
  signOut: (...args: unknown[]) => signOutMock(...args),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/",
}));

vi.mock("@/lib/api", () => ({
  accountApi: {
    getNotifications: () => getNotificationsMock(),
    markNotificationRead: vi.fn(() => Promise.resolve({ data: undefined })),
    markAllNotificationsRead: vi.fn(() =>
      Promise.resolve({ data: { items: [], unread_count: 0 } }),
    ),
  },
}));

vi.mock("@/stores/auth", () => ({
  useAuthStore: (selector: (s: { accessToken: string | null }) => unknown) =>
    selector({ accessToken: "test-token" }),
}));

vi.mock("@/stores/realtime", () => ({
  useRealtimeStore: (selector: (s: { status: string }) => unknown) =>
    selector({ status: "connected" }),
}));

beforeEach(() => {
  signOutMock.mockReset();
  getNotificationsMock.mockReset();
  getNotificationsMock.mockResolvedValue({
    data: { items: [], unread_count: 0 },
  });
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
});

describe("Sidebar — shell v2", () => {
  it("does not render Settings as a top-level nav item (#568)", () => {
    render(<Sidebar />);
    // Settings was item "06 Account" in the old sidebar; #568 dropped it
    // — it now lives only inside the user menu.
    const navlinks = screen.getAllByRole("link");
    const labels = navlinks.map((el) => el.textContent ?? "");
    expect(labels.some((l) => /account/i.test(l) && /^06/.test(l.trim()))).toBe(
      false,
    );
  });

  it("collapses + expands via the toggle buttons (#575)", () => {
    render(<Sidebar />);

    // Default: expanded — both toggle button + nav labels visible.
    expect(screen.getByLabelText(/collapse sidebar/i)).toBeInTheDocument();
    expect(screen.getByText("Home")).toBeInTheDocument();

    // Collapse.
    fireEvent.click(screen.getByLabelText(/collapse sidebar/i));
    expect(screen.getByLabelText(/expand sidebar/i)).toBeInTheDocument();
    expect(screen.queryByText("Home")).not.toBeInTheDocument();
    expect(
      JSON.parse(localStorage.getItem("tarmoto:sidebar-collapsed") ?? ""),
    ).toBe(true);

    // Expand again.
    fireEvent.click(screen.getByLabelText(/expand sidebar/i));
    expect(screen.getByText("Home")).toBeInTheDocument();
    expect(
      JSON.parse(localStorage.getItem("tarmoto:sidebar-collapsed") ?? ""),
    ).toBe(false);
  });

  it("opens a menu (Settings + Log out) when the user button is clicked (#566)", () => {
    render(<Sidebar />);

    const userBtn = screen.getByRole("button", { name: /rider smith/i });
    expect(userBtn).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("menuitem", { name: /log out/i })).toBeNull();

    fireEvent.click(userBtn);
    expect(userBtn).toHaveAttribute("aria-expanded", "true");
    expect(
      screen.getByRole("menuitem", { name: /settings/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: /log out/i }),
    ).toBeInTheDocument();
  });

  it("user menu Log out triggers signOut", () => {
    render(<Sidebar />);
    fireEvent.click(screen.getByRole("button", { name: /rider smith/i }));
    fireEvent.click(screen.getByRole("menuitem", { name: /log out/i }));
    expect(signOutMock).toHaveBeenCalledWith({ callbackUrl: "/login" });
  });

  it("user menu closes on Escape", () => {
    render(<Sidebar />);
    fireEvent.click(screen.getByRole("button", { name: /rider smith/i }));
    expect(
      screen.queryByRole("menuitem", { name: /settings/i }),
    ).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(
      screen.queryByRole("menuitem", { name: /settings/i }),
    ).not.toBeInTheDocument();
  });
});
