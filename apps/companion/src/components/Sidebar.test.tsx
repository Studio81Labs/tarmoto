import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { Sidebar } from "./Sidebar";
import { FormatProvider } from "@/format/FormatProvider";

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
    region_riders_behind: number | null;
    percentile: number | null;
  } | null,
};
// Kill switches fail SAFE (enabled until a confirmed `force_off`); this suite
// renders without a QueryClientProvider, which the real hook needs.
const killSwitches: Record<string, boolean> = vi.hoisted(() => ({}));
vi.mock("@/hooks/useEntitlements", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/useEntitlements")>()),
  useFeatureKillSwitch: (key: string) => ({
    enabled: killSwitches[key] ?? true,
    isResolved: true,
  }),
}));
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
  for (const key of Object.keys(killSwitches)) delete killSwitches[key];
  pathnameRef.current = "/";
  contributionRef.current = null;
});

afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
});

// Stub matchMedia so a test can pretend it's on a compact (tablet) viewport:
// the compact query "(max-width: 1023px)" reports matched.
function stubCompactViewport(compact: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: compact && query.includes("max-width: 1023px"),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
}

// A controllable matchMedia for the compact query: captures the `change`
// listener so a test can simulate crossing the breakpoint (setCompact) and
// assert the sidebar reacts — the initial-read stub above can't cover that.
function installControllableMatchMedia(initialCompact = false) {
  const state = { compact: initialCompact };
  let listener: (() => void) | null = null;
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      get matches() {
        return state.compact && query.includes("max-width: 1023px");
      },
      addEventListener: (_event: string, cb: () => void) => {
        listener = cb;
      },
      removeEventListener: () => {
        listener = null;
      },
    })),
  );
  return {
    setCompact(compact: boolean) {
      state.compact = compact;
      act(() => listener?.());
    },
  };
}

describe("Sidebar — Web App v2 nav", () => {
  it("hides the contribution badge when the rider has mapped nothing", () => {
    contributionRef.current = {
      km_mapped: 0,
      segments_mapped: 0,
      home_region: null,
      rank_in_region: null,
      region_rider_count: null,
      region_riders_behind: null,
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
      region_riders_behind: 37,
      percentile: 8,
    };
    render(<Sidebar />);
    expect(screen.getByText(/your contribution/i)).toBeInTheDocument();
    expect(screen.getByText(/4,284/)).toBeInTheDocument();
    expect(
      screen.getByText(/top 8% of riders in lombardy/i),
    ).toBeInTheDocument();
  });

  it("drops the regional line for the sole contributor in a region", () => {
    contributionRef.current = {
      km_mapped: 2771,
      segments_mapped: 510,
      home_region: "Beskydy, CZ",
      rank_in_region: 1,
      region_rider_count: 1,
      region_riders_behind: 0,
      percentile: 100,
    };
    render(<Sidebar />);
    // The km total still shows…
    expect(screen.getByText(/your contribution/i)).toBeInTheDocument();
    expect(screen.getByText(/2,771/)).toBeInTheDocument();
    // …but no "Top 100%" line.
    expect(screen.queryByText(/top .* riders/i)).not.toBeInTheDocument();
  });

  it("drops the regional line for a last-place rider tied behind others", () => {
    // DENSE_RANK gives rank 2 of 3 when two riders tie above the last one, so
    // rank<count would wrongly show it — gate on region_riders_behind (0 here).
    contributionRef.current = {
      km_mapped: 40,
      segments_mapped: 8,
      home_region: "Lombardy",
      rank_in_region: 2,
      region_rider_count: 3,
      region_riders_behind: 0,
      percentile: 67,
    };
    render(<Sidebar />);
    expect(screen.getByText(/your contribution/i)).toBeInTheDocument();
    expect(screen.queryByText(/top .* riders/i)).not.toBeInTheDocument();
  });

  it("still shows the rank for a non-last rider whose percentile rounds to 100", () => {
    // Large region: ceil(100 / 101 * 100) === 100, but the rider is ahead of
    // one other (region_riders_behind > 0) — the line must still render.
    contributionRef.current = {
      km_mapped: 640,
      segments_mapped: 120,
      home_region: "Lombardy",
      rank_in_region: 100,
      region_rider_count: 101,
      region_riders_behind: 1,
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
      region_riders_behind: null,
      percentile: null,
    };
    render(<Sidebar />);
    expect(screen.getByText(/your contribution/i)).toBeInTheDocument();
    expect(screen.getByText(/0\.3/)).toBeInTheDocument();
  });

  it("keeps the mapped descriptor after a locale-leading distance unit", () => {
    contributionRef.current = {
      km_mapped: 0.3,
      segments_mapped: 3,
      home_region: null,
      rank_in_region: null,
      region_rider_count: null,
      region_riders_behind: null,
      percentile: null,
    };
    render(
      <FormatProvider formatLocale="sw" timeZone="UTC" units="metric">
        <Sidebar />
      </FormatProvider>,
    );

    const measurement = screen.getByText("MAPPED").parentElement;
    expect(measurement?.textContent).toBe("km0.3MAPPED");
  });

  it("renders the km but drops the regional line when no home region", () => {
    contributionRef.current = {
      km_mapped: 1200,
      segments_mapped: 90,
      home_region: null,
      rank_in_region: null,
      region_rider_count: null,
      region_riders_behind: null,
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

  it("defaults to collapsed on a compact (tablet) viewport with no saved preference", () => {
    stubCompactViewport(true);
    render(<Sidebar />);

    // Collapsed: the expand affordance shows, and nav/section labels are hidden.
    expect(screen.getByLabelText(/expand sidebar/i)).toBeInTheDocument();
    expect(screen.queryByText("Home")).not.toBeInTheDocument();
    expect(screen.queryByText("Plan")).not.toBeInTheDocument();
    // A viewport-driven default is not written to storage — only a real toggle
    // persists (so a later desktop visit still opens expanded).
    expect(localStorage.getItem("tarmoto:sidebar-collapsed")).toBeNull();
  });

  it("follows the viewport across the breakpoint until a preference is saved", () => {
    const mq = installControllableMatchMedia(false);
    render(<Sidebar />);

    // Desktop: expanded.
    expect(screen.getByText("Home")).toBeInTheDocument();

    // Crossing below 1024px collapses it (the change listener must fire — if
    // it were dropped, the sidebar would stay expanded and this would fail).
    mq.setCompact(true);
    expect(screen.getByLabelText(/expand sidebar/i)).toBeInTheDocument();
    expect(screen.queryByText("Home")).not.toBeInTheDocument();

    // Back to desktop re-expands.
    mq.setCompact(false);
    expect(screen.getByText("Home")).toBeInTheDocument();

    // Once the rider collapses by hand, resizing no longer moves it.
    fireEvent.click(screen.getByLabelText(/collapse sidebar/i));
    mq.setCompact(false); // desktop again
    expect(screen.getByLabelText(/expand sidebar/i)).toBeInTheDocument();
  });

  it("lets a saved preference win over the compact-viewport default", () => {
    // Compact viewport, but the rider previously chose expanded.
    stubCompactViewport(true);
    localStorage.setItem("tarmoto:sidebar-collapsed", "false");
    render(<Sidebar />);

    expect(screen.getByText("Home")).toBeInTheDocument();
    expect(screen.getByLabelText(/collapse sidebar/i)).toBeInTheDocument();
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

  it("advertises Community normally", () => {
    render(<Sidebar />);
    expect(
      screen.getByRole("link", { name: /community/i }),
    ).toBeInTheDocument();
  });

  it("drops the Community nav entry when the operator kills it", () => {
    // The layout behind this link already replaces every destination with the
    // unavailable card, so leaving the entry up means the primary navigation
    // advertises a route that can only fail.
    killSwitches.community_access = false;
    render(<Sidebar />);
    expect(screen.queryByRole("link", { name: /community/i })).toBeNull();
    // The neighbouring entries in the same group stay.
    expect(
      screen.getByRole("link", { name: /achievements/i }),
    ).toBeInTheDocument();
  });

  it("keeps hazard and follower items out of the inbox when their switches are killed", async () => {
    // The inbox is a SECOND reception path, independent of the map overlay and
    // the community routes: the backend keeps writing these rows during a kill,
    // so whatever was generated while the switch was off is sitting here when
    // the rider next opens the bell.
    killSwitches.hazard_alerts = false;
    killSwitches.community_access = false;
    getNotificationsMock.mockResolvedValue({
      data: {
        items: [
          {
            id: "n1",
            title: "Pothole reported on your commute",
            body: "Loose gravel",
            created_at: "2026-05-01T10:00:00.000Z",
            read_at: null,
            data: { type: "hazard_alert" },
          },
          {
            id: "n2",
            title: "Jane started following you",
            body: "New follower",
            created_at: "2026-05-01T11:00:00.000Z",
            read_at: null,
            data: { type: "new_follower", follower_id: "u-jane" },
          },
          {
            id: "n3",
            title: "Trip shared with you",
            body: "Alpine loop",
            created_at: "2026-05-01T12:00:00.000Z",
            read_at: null,
            data: { type: "trip_collaboration", trip_id: "t1" },
          },
        ],
        unread_count: 3,
      },
    });

    render(<Sidebar />);
    fireEvent.click(screen.getByRole("button", { name: "Notifications" }));

    expect(await screen.findByText("Trip shared with you")).toBeInTheDocument();
    expect(screen.queryByText("Pothole reported on your commute")).toBeNull();
    expect(screen.queryByText("Jane started following you")).toBeNull();
    // No link into the killed community area survives either.
    for (const link of screen.getAllByRole("link")) {
      expect(link.getAttribute("href")).not.toMatch(/^\/community\//);
    }
  });

  it("recomputes the unread count from what is actually shown", async () => {
    // A count including items the rider cannot see is its own bug: the bell
    // says there is something new, they open it, everything is read, and the
    // indicator never clears. Here the ONLY unread item is the hidden hazard,
    // so after filtering there is nothing unread left.
    killSwitches.hazard_alerts = false;
    getNotificationsMock.mockResolvedValue({
      data: {
        items: [
          {
            id: "n1",
            title: "Pothole reported on your commute",
            body: "Loose gravel",
            created_at: "2026-05-01T10:00:00.000Z",
            read_at: null,
            data: { type: "hazard_alert" },
          },
          {
            id: "n2",
            title: "Trip shared with you",
            body: "Alpine loop",
            created_at: "2026-05-01T12:00:00.000Z",
            read_at: "2026-05-01T12:30:00.000Z",
            data: { type: "trip_collaboration", trip_id: "t1" },
          },
        ],
        unread_count: 1,
      },
    });

    render(<Sidebar />);
    fireEvent.click(screen.getByRole("button", { name: "Notifications" }));
    await screen.findByText("Trip shared with you");

    // 1 from the server minus the 1 unread hazard item that is now hidden.
    expect(
      screen.getByRole("button", { name: "Mark all as read" }),
    ).toBeDisabled();
  });
});
