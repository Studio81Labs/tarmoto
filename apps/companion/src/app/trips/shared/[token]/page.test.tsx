import { render, screen } from "@testing-library/react";
import { withQueryClient } from "@/hooks/test-utils";

vi.mock("@/i18n/server", () => ({
  readLocale: vi.fn(async () => "en"),
  t: (key: string) => key,
}));
vi.mock("@/format/server", async () => {
  const { createFormatters } = await import("@tarmoto/shared");
  const format = createFormatters({ locale: "en", units: "metric" });
  return { getServerFormatters: async () => format };
});

const fetchSharedTripMock = vi.fn();
// The snapshot parsing/summarising helpers stay REAL — only the network read
// is mocked, so the fixture has to be a shape the real parser accepts.
vi.mock("@/lib/trip-share", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/trip-share")>()),
  fetchSharedTrip: (...a: unknown[]) => fetchSharedTripMock(...a),
}));

// KEYED. This route reads `community_access` on the server and `trip_planning`
// inside `SharedTripJoinCta` — two switches with different blast radii, so a
// single boolean would let a gate on the wrong key pass (#1204).
const killSwitches = vi.hoisted(
  () =>
    ({ community_access: true, trip_planning: true }) as Record<
      string,
      boolean
    >,
);
const serverKillSwitchMock = vi.fn();
vi.mock("@/lib/serverFlags", () => ({
  serverKillSwitch: async (k: string) => {
    serverKillSwitchMock(k);
    return killSwitches[k] ?? true;
  },
}));

// The join CTA is a client island with its own store/router dependencies; it
// is covered by `SharedTripJoinCta.test.tsx`. Stub it so this suite is about
// the server gate, but record whether it mounted at all.
const ctaMounted = vi.hoisted(() => ({ current: false }));
vi.mock("./SharedTripJoinCta", () => ({
  SharedTripJoinCta: () => {
    ctaMounted.current = true;
    return <div data-testid="join-cta" />;
  },
}));

import SharedTripPage from "./page";

const SHARE = {
  trip_id: "trip-1",
  owner_name: "Rider",
  snapshot: {
    title: "Alpine loop",
    days: [
      {
        day: 1,
        distance_km: 120,
        duration_min: 180,
        route_geometry: {
          type: "LineString",
          coordinates: [
            [16.6, 49.2],
            [16.7, 49.3],
          ],
        },
        stops: [],
      },
    ],
  },
};

const params = Promise.resolve({ token: "t".repeat(32) });

describe("SharedTripPage — community_access", () => {
  beforeEach(() => {
    fetchSharedTripMock.mockReset();
    serverKillSwitchMock.mockReset();
    killSwitches.community_access = true;
    killSwitches.trip_planning = true;
    ctaMounted.current = false;
    fetchSharedTripMock.mockResolvedValue(SHARE);
  });

  it("renders the shared trip while the flag is live", async () => {
    render(await SharedTripPage({ params }), { wrapper: withQueryClient() });
    // Positive precondition: without this, every absence assertion below could
    // pass simply because the page failed to render for an unrelated reason.
    expect(fetchSharedTripMock).toHaveBeenCalled();
    expect(screen.getByTestId("join-cta")).toBeInTheDocument();
  });

  it("NEVER FETCHES the trip under the kill", async () => {
    // The acceptance criterion: the gate sits in front of the read. A trip
    // share URL can be posted publicly, so during a moderation incident this
    // route must stop pulling the snapshot out of the backend entirely.
    killSwitches.community_access = false;
    render(await SharedTripPage({ params }));
    expect(fetchSharedTripMock).not.toHaveBeenCalled();
  });

  it("serves the neutral unavailable body with no trace of the trip", async () => {
    killSwitches.community_access = false;
    const { container } = render(await SharedTripPage({ params }));

    expect(
      screen.getByText("This shared page is temporarily unavailable"),
    ).toBeInTheDocument();
    expect(screen.getByText(/The link still works/)).toBeInTheDocument();
    expect(container.innerHTML).not.toContain("Alpine loop");
    expect(container.innerHTML).not.toContain("Rider");
    // The join island must not mount either — it would otherwise put a live
    // action on a page whose content is meant to be down.
    expect(ctaMounted.current).toBe(false);
  });

  it("gates on community_access, not on trip_planning", async () => {
    // `trip_planning` removes only the JOIN action and deliberately leaves the
    // preview up (see `SharedTripJoinCta`). The two must not be confused: a
    // page-level gate written against `trip_planning` would take down a
    // perfectly servable preview every time planning is paused.
    killSwitches.trip_planning = false;
    render(await SharedTripPage({ params }), { wrapper: withQueryClient() });

    expect(fetchSharedTripMock).toHaveBeenCalled();
    expect(
      screen.queryByText("This shared page is temporarily unavailable"),
    ).not.toBeInTheDocument();
    expect(serverKillSwitchMock).toHaveBeenCalledWith("community_access");
  });
});
