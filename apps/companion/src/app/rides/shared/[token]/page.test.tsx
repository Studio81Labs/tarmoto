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

const serverKillSwitchMock = vi.fn();
vi.mock("@/lib/serverFlags", () => ({
  serverKillSwitch: (k: string) => serverKillSwitchMock(k),
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
    fetchSharedRideMock.mockResolvedValue(RIDE);
  });

  it("renders the quality tile while the flag is live", async () => {
    serverKillSwitchMock.mockResolvedValue(true);
    render(await SharedRidePage({ params }));
    expect(screen.getByText("Quality")).toBeInTheDocument();
  });

  it("omits the quality tile entirely when the overlay is killed", async () => {
    serverKillSwitchMock.mockResolvedValue(false);
    const { container } = render(await SharedRidePage({ params }));

    // The label goes with the number. An em dash where a score used to be
    // still tells an anonymous visitor the figure exists and is withheld —
    // and this page renders straight into public HTML.
    expect(screen.queryByText("Quality")).not.toBeInTheDocument();
    expect(container.innerHTML).not.toContain("4.7");
    // Curviness is a sibling aggregate, not derived from quality, so it stays.
    expect(screen.getByText("Curviness")).toBeInTheDocument();
  });

  it("gates on road_quality_overlay specifically", async () => {
    serverKillSwitchMock.mockResolvedValue(true);
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
    serverKillSwitchMock.mockImplementation(async () => {
      flagStarted = true;
      expect(rideResolved).toBe(false);
      return true;
    });
    render(await SharedRidePage({ params }));
    expect(flagStarted).toBe(true);
  });
});
