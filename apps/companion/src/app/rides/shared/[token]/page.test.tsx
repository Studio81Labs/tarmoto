import { render, screen } from "@testing-library/react";

vi.mock("@/i18n/server", () => ({
  readLocale: vi.fn(async () => "en"),
  t: (key: string) => key,
}));
vi.mock("@/format/server", async () => {
  const { createFormatters } = await import("@tarmoto/shared");
  const format = createFormatters({ locale: "en", units: "metric" });
  return { getServerFormatters: async () => format };
});

const fetchSharedRideMock = vi.fn();
vi.mock("@/lib/shared-rides", () => ({
  fetchSharedRide: (...a: unknown[]) => fetchSharedRideMock(...a),
}));

// KEYED. This route reads TWO switches with very different blast radii —
// `community_access` takes the whole page down, `road_quality_overlay` only
// strips scores — so a single boolean would let a gate on the wrong key pass
// every assertion in this file (the finding on #1204). The mock below is a
// call RECORDER only, so `mockReset()` cannot strip the keyed behaviour out.
const killSwitches = vi.hoisted(
  () =>
    ({ community_access: true, road_quality_overlay: true }) as Record<
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

import SharedRidePage from "./page";

const RIDE = {
  id: "ride-1",
  rider_name: "Rider",
  ride_type: "trip",
  started_at: "2026-05-01T08:00:00.000Z",
  ended_at: "2026-05-01T10:00:00.000Z",
  distance_km: 120,
  avg_speed: 60,
  avg_road_quality: 4.7,
  avg_curviness: 3.2,
  duration_min: 120,
  view_count: 5,
  shared_at: "2026-05-01T11:00:00.000Z",
  route_geometry: null,
};

const params = Promise.resolve({ token: "t".repeat(32) });

describe("SharedRidePage — road_quality_overlay", () => {
  beforeEach(() => {
    fetchSharedRideMock.mockReset();
    serverKillSwitchMock.mockReset();
    killSwitches.community_access = true;
    killSwitches.road_quality_overlay = true;
    fetchSharedRideMock.mockResolvedValue(RIDE);
  });

  it("renders the quality tile while the flag is live", async () => {
    render(await SharedRidePage({ params }));
    expect(screen.getByText("Quality")).toBeInTheDocument();
  });

  it("omits the quality tile entirely when the overlay is killed", async () => {
    killSwitches.road_quality_overlay = false;
    const { container } = render(await SharedRidePage({ params }));

    // The label goes with the number. An em dash where a score used to be
    // still tells an anonymous visitor the figure exists and is withheld —
    // and this page renders straight into public HTML.
    expect(screen.queryByText("Quality")).not.toBeInTheDocument();
    expect(container.innerHTML).not.toContain("4.7");
    // Curviness is a sibling aggregate, not derived from quality, so it stays.
    expect(screen.getByText("Curviness")).toBeInTheDocument();
  });

  it("drops the desktop column with the tile, leaving no empty slot", async () => {
    killSwitches.road_quality_overlay = false;
    const { container } = render(await SharedRidePage({ params }));
    const grid = container.querySelector(".grid");
    expect(grid?.className).toContain("md:grid-cols-3");
    expect(grid?.className).not.toContain("md:grid-cols-4");
  });

  it("keeps four columns while the flag is live", async () => {
    const { container } = render(await SharedRidePage({ params }));
    expect(container.querySelector(".grid")?.className).toContain(
      "md:grid-cols-4",
    );
  });

  it("gates on road_quality_overlay specifically", async () => {
    render(await SharedRidePage({ params }));
    expect(serverKillSwitchMock).toHaveBeenCalledWith("road_quality_overlay");
  });

  it("reads the ride and the flag CONCURRENTLY", async () => {
    let flagStarted = false;
    let rideResolved = false;
    fetchSharedRideMock.mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(() => {
            rideResolved = true;
            resolve(RIDE);
          }, 10),
        ),
    );
    // Keyed: `community_access` resolves BEFORE the fetch by design, so an
    // unkeyed probe would be asserting concurrency about the wrong switch.
    serverKillSwitchMock.mockImplementation((key: string) => {
      if (key !== "road_quality_overlay") return;
      flagStarted = true;
      expect(rideResolved).toBe(false);
    });
    render(await SharedRidePage({ params }));
    expect(flagStarted).toBe(true);
  });
});

describe("SharedRidePage — community_access", () => {
  beforeEach(() => {
    fetchSharedRideMock.mockReset();
    serverKillSwitchMock.mockReset();
    killSwitches.community_access = true;
    killSwitches.road_quality_overlay = true;
    fetchSharedRideMock.mockResolvedValue(RIDE);
  });

  it("renders the shared ride while the flag is live", async () => {
    render(await SharedRidePage({ params }));
    // Positive precondition for the absence assertions below.
    expect(fetchSharedRideMock).toHaveBeenCalled();
    expect(screen.getByText("Public route share")).toBeInTheDocument();
  });

  it("NEVER FETCHES the ride under the kill", async () => {
    // The acceptance criterion: a moderation kill has to stop the read, not
    // just the render. Hiding a fetched ride still pulls moderated content out
    // of the backend on every hit of a URL that may be posted publicly.
    killSwitches.community_access = false;
    render(await SharedRidePage({ params }));
    expect(fetchSharedRideMock).not.toHaveBeenCalled();
  });

  it("serves the neutral unavailable body with no trace of the ride", async () => {
    killSwitches.community_access = false;
    const { container } = render(await SharedRidePage({ params }));

    expect(
      screen.getByText("This shared page is temporarily unavailable"),
    ).toBeInTheDocument();
    expect(screen.getByText(/The link still works/)).toBeInTheDocument();
    expect(container.innerHTML).not.toContain("Rider");
    expect(screen.queryByText("Public route share")).not.toBeInTheDocument();
  });

  it("keeps the page up for a road_quality_overlay kill", async () => {
    // Independent switches: killing quality strips the tile and leaves the
    // ride readable. Without this, a gate on the wrong key passes everything.
    killSwitches.road_quality_overlay = false;
    render(await SharedRidePage({ params }));
    expect(screen.getByText("Public route share")).toBeInTheDocument();
    expect(
      screen.queryByText("This shared page is temporarily unavailable"),
    ).not.toBeInTheDocument();
  });
});
