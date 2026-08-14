import { render } from "@testing-library/react";

vi.mock("@/i18n/server", () => ({
  t: (key: string) => key,
  getServerLocale: () => "en",
}));
// Real formatters — a hand-rolled partial mock silently drifts from the
// `Formatters` surface the page uses, and the failure looks like a test bug
// rather than the coverage gap it is.
vi.mock("@/format/server", async () => {
  const { createFormatters } = await import("@tarmoto/shared");
  const format = createFormatters({ locale: "en", units: "metric" });
  return { getServerFormatters: async () => format };
});

const fetchSharedMapMock = vi.fn();
vi.mock("@/lib/map-share", () => ({
  fetchSharedMap: (...a: unknown[]) => fetchSharedMapMock(...a),
}));

const serverKillSwitchMock = vi.fn();
vi.mock("@/lib/serverFlags", () => ({
  serverKillSwitch: (k: string) => serverKillSwitchMock(k),
}));

// Capture what crosses into the `"use client"` map.
const mapProps = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("./SharedMap.client", () => ({
  SharedMap: (props: unknown) => {
    mapProps.current = props;
    return <div data-testid="shared-map" />;
  },
}));

import SharedRoadMapPage from "./page";

// The FULL `RiddenSegmentDto` — a fixture missing a field cannot catch that
// field leaking.
const SEGMENT = {
  id: "seg-1",
  last_ridden_at: "2026-05-01T08:00:00.000Z",
  last_quality_score: 4.7,
  ride_count: 3,
};

function share() {
  return {
    owner_name: "Rider",
    snapshot: {
      version: 1,
      generated_at: "2026-05-01T08:00:00.000Z",
      period: "all",
      stats: {
        ridden_segments: 4,
        total_segments: 10,
        percent_explored: 12,
        total_distance_km: 340,
      },
      segments: [SEGMENT],
      initial_center: { lat: 49.2, lng: 16.6, zoom: 10 },
    },
  };
}

const params = Promise.resolve({ token: "t".repeat(32) });

function segmentsHandedDown(): Record<string, unknown>[] {
  // Fail loudly rather than vacuously: if the snapshot fixture ever stops
  // parsing, the map is not rendered at all and every "no trace" assertion
  // below would pass against `null` while proving nothing.
  if (mapProps.current === null) {
    throw new Error("SharedMap was never rendered — snapshot fixture rejected");
  }
  return (mapProps.current as { segments: Record<string, unknown>[] }).segments;
}

describe("SharedRoadMapPage — road_quality_overlay", () => {
  beforeEach(() => {
    fetchSharedMapMock.mockReset();
    serverKillSwitchMock.mockReset();
    mapProps.current = null;
    fetchSharedMapMock.mockResolvedValue(share());
  });

  it("passes the segment quality through when the flag is live", async () => {
    serverKillSwitchMock.mockResolvedValue(true);
    render(await SharedRoadMapPage({ params }));
    expect(segmentsHandedDown()[0]).toHaveProperty("last_quality_score", 4.7);
    expect(mapProps.current).toHaveProperty("qualityOverlayKilled", false);
  });

  it("REMOVES the score and hands the kill down when the overlay is killed", async () => {
    serverKillSwitchMock.mockResolvedValue(false);
    render(await SharedRoadMapPage({ params }));

    const [first] = segmentsHandedDown();
    // Absent, not null: these segments are serialized into the RSC Flight
    // payload embedded in the HTML on their way to the client map, and this
    // page is reachable by anyone with the link.
    expect(first).not.toHaveProperty("last_quality_score");
    expect(Object.keys(first!).sort()).toEqual([
      "id",
      "last_ridden_at",
      "ride_count",
    ]);
    // Stripping alone is not enough — the map's own hook fails safe and would
    // show the popover until its browser request settled.
    expect(mapProps.current).toHaveProperty("qualityOverlayKilled", true);
  });

  it("projects an ALLOWLIST, so a new backend field cannot leak by default", async () => {
    // With the current DTO a blocklist would agree; only an unlisted field
    // separates them, and that is the case the allowlist is for.
    serverKillSwitchMock.mockResolvedValue(false);
    const withExtra = share();
    withExtra.snapshot.segments = [
      { ...SEGMENT, some_future_quality_field: 4.7 },
    ] as never;
    fetchSharedMapMock.mockResolvedValue(withExtra);
    render(await SharedRoadMapPage({ params }));
    expect(segmentsHandedDown()[0]).not.toHaveProperty(
      "some_future_quality_field",
    );
    expect(JSON.stringify(mapProps.current)).not.toContain("4.7");
  });

  it("leaves no trace of the score in the serialized props", async () => {
    serverKillSwitchMock.mockResolvedValue(false);
    render(await SharedRoadMapPage({ params }));
    expect(segmentsHandedDown()).toHaveLength(1);
    const serialized = JSON.stringify(mapProps.current);
    expect(serialized).not.toContain("last_quality_score");
    expect(serialized).not.toContain("4.7");
  });

  it("gates on road_quality_overlay specifically", async () => {
    serverKillSwitchMock.mockResolvedValue(true);
    render(await SharedRoadMapPage({ params }));
    expect(serverKillSwitchMock).toHaveBeenCalledWith("road_quality_overlay");
  });

  it("reads the share and the flag CONCURRENTLY", async () => {
    let flagStarted = false;
    let shareResolved = false;
    fetchSharedMapMock.mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(() => {
            shareResolved = true;
            resolve(share());
          }, 10),
        ),
    );
    serverKillSwitchMock.mockImplementation(async () => {
      flagStarted = true;
      expect(shareResolved).toBe(false);
      return true;
    });
    render(await SharedRoadMapPage({ params }));
    expect(flagStarted).toBe(true);
  });
});
