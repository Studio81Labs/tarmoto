import { render } from "@testing-library/react";

vi.mock("@/i18n/server", () => ({
  readLocale: vi.fn(async () => "en"),
  t: (key: string) => key,
}));
vi.mock("@/format/server", () => ({
  getServerFormatters: vi.fn(async () => ({
    decimal: (v: number) => String(v),
    distanceKm: (v: number) => `${v} km`,
    number: (v: number) => String(v),
    month: () => "month",
  })),
}));
vi.mock("@/lib/site", () => ({ siteUrl: () => "https://tarmoto.com" }));

const fetchBestRoadsMock = vi.fn();
// `stripRoadQuality` stays REAL — it is the thing under test.
vi.mock("@/lib/bestRoads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/bestRoads")>()),
  fetchBestRoads: (...a: unknown[]) => fetchBestRoadsMock(...a),
}));

const serverKillSwitchMock = vi.fn();
vi.mock("@/lib/serverFlags", () => ({
  serverKillSwitch: (k: string) => serverKillSwitchMock(k),
}));

const bodyProps = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("../_components/BestRoadsPageBody", () => ({
  BestRoadsPageBody: (props: unknown) => {
    bodyProps.current = props;
    return <div data-testid="body" />;
  },
}));

import BestRoadsSubRegionPage from "./page";

const road = {
  id: "seg-1",
  road_name: "Timmelsjoch",
  road_number: null,
  quality_score: 4.7,
  curviness_score: 3.2,
  surface_type: "asphalt",
  length_m: 22000,
  confidence: 0.8,
  geometry: [
    { lat: 47.0, lng: 10.0 },
    { lat: 47.1, lng: 10.1 },
  ],
};

const params = Promise.resolve({
  country: "at",
  region: "tyrol",
  subregion: "alpine-passes",
});

/**
 * The sub-region page is its OWN route entry point with its own copy of the
 * strip + propagate logic, so it can regress while the region suite stays
 * green. Same two guarantees asserted here, against this route's params.
 */
describe("BestRoadsSubRegionPage — road_quality_overlay", () => {
  beforeEach(() => {
    fetchBestRoadsMock.mockReset();
    serverKillSwitchMock.mockReset();
    bodyProps.current = null;
    fetchBestRoadsMock.mockResolvedValue({ roads: [road] });
  });

  it("passes the quality score through when the flag is live", async () => {
    serverKillSwitchMock.mockResolvedValue(true);
    render(await BestRoadsSubRegionPage({ params }));
    const props = bodyProps.current as {
      roads: Record<string, unknown>[];
      qualityOverlayKilled: boolean;
    };
    expect(props.roads[0]).toHaveProperty("quality_score", 4.7);
    expect(props.qualityOverlayKilled).toBe(false);
  });

  it("REMOVES the key and hands the kill down when the overlay is killed", async () => {
    serverKillSwitchMock.mockResolvedValue(false);
    render(await BestRoadsSubRegionPage({ params }));

    const props = bodyProps.current as {
      roads: Record<string, unknown>[];
      qualityOverlayKilled: boolean;
    };
    expect(props.roads[0]).not.toHaveProperty("quality_score");
    // Both halves: stripping alone leaves the client map re-deriving the flag
    // through a fail-safe hook that shows the overlay until it settles.
    expect(props.qualityOverlayKilled).toBe(true);
    // Nothing of the score survives anywhere in the serialized props.
    const serialized = JSON.stringify(bodyProps.current);
    expect(serialized).not.toContain("quality_score");
    expect(serialized).not.toContain("4.7");
  });

  it("reads the roads and the flag CONCURRENTLY", async () => {
    // Serial awaits would add the flags round trip — up to its full timeout —
    // to every render of a page whose roads had already arrived.
    let flagStarted = false;
    let roadsResolved = false;
    fetchBestRoadsMock.mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(() => {
            roadsResolved = true;
            resolve({ roads: [road] });
          }, 10),
        ),
    );
    serverKillSwitchMock.mockImplementation(async () => {
      flagStarted = true;
      // The flag lookup must begin BEFORE the roads response lands.
      expect(roadsResolved).toBe(false);
      return true;
    });

    render(await BestRoadsSubRegionPage({ params }));
    expect(flagStarted).toBe(true);
  });
});
