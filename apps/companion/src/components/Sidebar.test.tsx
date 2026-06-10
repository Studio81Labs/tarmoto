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

const pathnameRef = { current: "/" };
vi.mock("next/navigation", () => ({
  usePathname: () => pathnameRef.current,
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

// Stub the contribution badge's data hook so the nav tests don't need a
// react-query provider. Mutable ref so a test can opt into contribution data;
// defaults to none (the badge hides itself).
const contributionRef = {
  current: null as {
    km_mapped: number;
    segments_mapped: number;
    home_region: string | null;
    rank_in_region: number | null;
    region_rider_count: number | null;
    percentile: number | null;
  } | null,
};
vi.mock("@/hooks/useContribution", () => ({
  useContribution: () => ({
    contribution: contributionRef.current,
    loading: false,
    error: false,
  }),
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
  pathnameRef.current = "/";
  contributionRef.current = null;
});

afterEach(() => {
  localStorage.clear();
});

describe("Sidebar — Web App v2 nav", () => {
  it("hides the contribution badge when the rider has mapped nothing", () => {
    contributionRef.current = {
      km_mapped: 0,
      segments_mapped: 0,
      home_region: null,
      rank_in_region: null,
      region_rider_count: null,
      percentile: null,
    };
    render(<Sidebar />);
    expect(screen.queryByText(/your contribution/i)).not.toBeInTheDocument();
  });

  it("renders the contribution badge with km + regional standing", () => {
    contributionRef.current = {
      km_mapped: 4284.4,
      segments_mapped: 510,
      home_region: "Lombardy",
      rank_in_region: 3,
      region_rider_count: 40,
      percentile: 8,
    };
    render(<Sidebar />);
    expect(screen.getByText(/your contribution/i)).toBeInTheDocument();
    expect(screen.getByText(/4,284/)).toBeInTheDocument();
    expect(
      screen.getByText(/top 8% of riders in lombardy/i),
    ).toBeInTheDocument();
  });

  it("drops the regional line at a misleading 100th percentile (sole/last)", () => {
    contributionRef.current = {
      km_mapped: 2771,
      segments_mapped: 510,
      home_region: "Beskydy, CZ",
      rank_in_region: 1,
      region_rider_count: 1,
      percentile: 100,
    };
    render(<Sidebar />);
    // The km total still shows…
    expect(screen.getByText(/your contribution/i)).toBeInTheDocument();
    expect(screen.getByText(/2,771/)).toBeInTheDocument();
    // …but no "Top 100%" line.
    expect(screen.queryByText(/top .* riders/i)).not.toBeInTheDocument();
  });

  it("still shows the rank for a non-last rider whose percentile rounds to 100", () => {
    // Large region: ceil(100 / 101 * 100) === 100, but the rider is ahead of
    // one other — the line must still render (gate on rank < count, not %).
    contributionRef.current = {
      km_mapped: 640,
      segments_mapped: 120,
      home_region: "Lombardy",
      rank_in_region: 100,
      region_rider_count: 101,
      percentile: 100,
    };
    render(<Sidebar />);
    expect(
      screen.getByText(/top 100% of riders in lombardy/i),
    ).toBeInTheDocument();
  });

  it("keeps a decimal for sub-1km contributions instead of showing 0", () => {
    contributionRef.current = {
      km_mapped: 0.3,
      segments_mapped: 3,
      home_region: null,
      rank_in_region: null,
      region_rider_count: null,
      percentile: null,
    };
    render(<Sidebar />);
    expect(screen.getByText(/your contribution/i)).toBeInTheDocument();
    expect(screen.getByText(/0\.3/)).toBeInTheDocument();
  });

  it("renders the km but drops the regional line when no home region", () => {
    contributionRef.current = {
      km_mapped: 1200,
      segments_mapped: 90,
      home_region: null,
      rank_in_region: null,
      region_rider_count: null,
      percentile: null,
    };
    render(<Sidebar />);
    expect(screen.getByText(/your contribution/i)).toBeInTheDocument();
    expect(screen.queryByText(/top .* riders/i)).not.toBeInTheDocument();
  });

  it("does not render Settings as a top-level nav item", () => {
    render(<Sidebar />);
    const navlinks = screen.getAllByRole("link");
    const labels = navlinks.map((el) => el.textContent ?? "");
    expect(labels.some((l) => /account/i.test(l) && /^06/.test(l.trim()))).toBe(
      false,
    );
  });

  it("renders the v2 flat nav with section splitters", () => {
    render(<Sidebar />);
    // Top-level items show with stamp + label.
    expect(
      screen.getByRole("link", { name: /^00\s*Home$/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /^03\s*Ride History$/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /^04\s*Statistics$/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /^05\s*Community$/ }),
    ).toBeInTheDocument();
    // Section splitters render their label as a stamp.
    expect(screen.getByText("Plan")).toBeInTheDocument();
    expect(screen.getByText("Activity")).toBeInTheDocument();
    expect(screen.getByText("Discover")).toBeInTheDocument();
  });

  it("does not render nested sub-items under any top-level entry", () => {
    pathnameRef.current = "/rides";
    render(<Sidebar />);
    // Old shell-v2 children were nested under Ride History — flat nav drops
    // them entirely (Statistics moves up to top-level, Road map / Compare
    // live as in-page tabs on the parent).
    expect(screen.queryByRole("link", { name: /^road map$/i })).toBeNull();
    expect(screen.queryByRole("link", { name: /^compare rides$/i })).toBeNull();
    expect(screen.queryByRole("link", { name: /^feed$/i })).toBeNull();
    expect(screen.queryByRole("link", { name: /^collections$/i })).toBeNull();
  });

  it("marks the parent active on related sub-routes", () => {
    pathnameRef.current = "/rides/road-map";
    const { rerender } = render(<Sidebar />);
    expect(
      screen.getByRole("link", { name: /^03\s*Ride History$/ }),
    ).toHaveAttribute("aria-current", "page");

    pathnameRef.current = "/community/collections";
    rerender(<Sidebar />);
    expect(
      screen.getByRole("link", { name: /^05\s*Community$/ }),
    ).toHaveAttribute("aria-current", "page");
  });

  it("Statistics wins over Ride History on /rides/stats", () => {
    pathnameRef.current = "/rides/stats";
    render(<Sidebar />);
    expect(
      screen.getByRole("link", { name: /^04\s*Statistics$/ }),
    ).toHaveAttribute("aria-current", "page");
    expect(
      screen.getByRole("link", { name: /^03\s*Ride History$/ }),
    ).not.toHaveAttribute("aria-current", "page");
  });

  it("collapses and expands via the toggle buttons", () => {
    render(<Sidebar />);

    expect(screen.getByLabelText(/collapse sidebar/i)).toBeInTheDocument();
    expect(screen.getByText("Home")).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText(/collapse sidebar/i));
    expect(screen.getByLabelText(/expand sidebar/i)).toBeInTheDocument();
    expect(screen.queryByText("Home")).not.toBeInTheDocument();
    // Section labels also hide when collapsed; only icon rail remains.
    expect(screen.queryByText("Plan")).not.toBeInTheDocument();
    expect(
      JSON.parse(localStorage.getItem("tarmoto:sidebar-collapsed") ?? ""),
    ).toBe(true);

    fireEvent.click(screen.getByLabelText(/expand sidebar/i));
    expect(screen.getByText("Home")).toBeInTheDocument();
    expect(screen.getByText("Plan")).toBeInTheDocument();
    expect(
      JSON.parse(localStorage.getItem("tarmoto:sidebar-collapsed") ?? ""),
    ).toBe(false);
  });

  it("opens a menu (Settings + Log out) when the user button is clicked", () => {
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
