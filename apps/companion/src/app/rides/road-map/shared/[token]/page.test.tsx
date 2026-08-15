import { render, screen } from "@testing-library/react";

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
// KEYED across BOTH registries. This route now resolves three switches with
// different blast radii — `community_access` and `sys_gamification` take the
// page down, `road_quality_overlay` only strips scores — so a shared boolean
// would let a gate on the wrong key pass every assertion here (#1204).
const systemSwitches = vi.hoisted(
  () => ({ sys_gamification: true }) as Record<string, boolean>,
);
const serverSystemSwitchMock = vi.fn();
vi.mock("@/lib/serverFlags", () => ({
  serverKillSwitch: async (k: string) => {
    serverKillSwitchMock(k);
    return killSwitches[k] ?? true;
  },
  serverSystemSwitch: async (k: string) => {
    serverSystemSwitchMock(k);
    return systemSwitches[k] ?? true;
  },
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
    killSwitches.community_access = true;
    killSwitches.road_quality_overlay = true;
    systemSwitches.sys_gamification = true;
    mapProps.current = null;
    fetchSharedMapMock.mockResolvedValue(share());
  });

  it("passes the segment quality through when the flag is live", async () => {
    render(await SharedRoadMapPage({ params }));
    expect(segmentsHandedDown()[0]).toHaveProperty("last_quality_score", 4.7);
    expect(mapProps.current).toHaveProperty("qualityOverlayKilled", false);
  });

  it("REMOVES the score and hands the kill down when the overlay is killed", async () => {
    killSwitches.road_quality_overlay = false;
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
    killSwitches.road_quality_overlay = false;
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
    killSwitches.road_quality_overlay = false;
    render(await SharedRoadMapPage({ params }));
    expect(segmentsHandedDown()).toHaveLength(1);
    const serialized = JSON.stringify(mapProps.current);
    expect(serialized).not.toContain("last_quality_score");
    expect(serialized).not.toContain("4.7");
  });

  it("takes the map legend down with the layers it labels", async () => {
    // The legend names the two layers ("Ridden" / "Unridden"), both hidden
    // under the kill. Left up, it describes overlays that are not on the page.
    killSwitches.road_quality_overlay = false;
    const { queryByText } = render(await SharedRoadMapPage({ params }));
    expect(queryByText("Unridden")).not.toBeInTheDocument();
  });

  it("keeps the legend while the flag is live", async () => {
    const { getByText } = render(await SharedRoadMapPage({ params }));
    expect(getByText("Unridden")).toBeInTheDocument();
  });

  it("gates on road_quality_overlay specifically", async () => {
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
    // Keyed: `community_access` resolves BEFORE the fetch by design, so an
    // unkeyed probe would be asserting concurrency about the wrong switch.
    serverKillSwitchMock.mockImplementation((key: string) => {
      if (key !== "road_quality_overlay") return;
      flagStarted = true;
      expect(shareResolved).toBe(false);
    });
    render(await SharedRoadMapPage({ params }));
    expect(flagStarted).toBe(true);
  });
});

describe("SharedRoadMapPage — community_access", () => {
  beforeEach(() => {
    fetchSharedMapMock.mockReset();
    serverKillSwitchMock.mockReset();
    killSwitches.community_access = true;
    killSwitches.road_quality_overlay = true;
    systemSwitches.sys_gamification = true;
    mapProps.current = null;
    fetchSharedMapMock.mockResolvedValue(share());
  });

  it("renders the shared map while the flag is live", async () => {
    const { getByTestId } = render(await SharedRoadMapPage({ params }));
    expect(fetchSharedMapMock).toHaveBeenCalled();
    expect(getByTestId("shared-map")).toBeInTheDocument();
  });

  it("NEVER FETCHES the snapshot under the kill", async () => {
    killSwitches.community_access = false;
    render(await SharedRoadMapPage({ params }));
    expect(fetchSharedMapMock).not.toHaveBeenCalled();
  });

  it("mounts no client map, so no segment reaches the Flight payload", async () => {
    // The sharpest assertion available here: `SharedMap` is a `"use client"`
    // component, so anything handed to it is serialized into the HTML. Under
    // the kill it must not be rendered at all — not rendered-with-empty-props.
    killSwitches.community_access = false;
    const { queryByTestId, container } = render(
      await SharedRoadMapPage({ params }),
    );

    expect(queryByTestId("shared-map")).not.toBeInTheDocument();
    expect(mapProps.current).toBeNull();
    expect(
      screen.getByText("This shared page is temporarily unavailable"),
    ).toBeInTheDocument();
    expect(container.innerHTML).not.toContain("Rider");
  });

  it("keeps the page up for a road_quality_overlay kill", async () => {
    killSwitches.road_quality_overlay = false;
    const { getByTestId, queryByText } = render(
      await SharedRoadMapPage({ params }),
    );
    expect(getByTestId("shared-map")).toBeInTheDocument();
    expect(
      queryByText("This shared page is temporarily unavailable"),
    ).not.toBeInTheDocument();
  });
});

describe("SharedRoadMapPage — sys_gamification", () => {
  beforeEach(() => {
    fetchSharedMapMock.mockReset();
    serverKillSwitchMock.mockReset();
    serverSystemSwitchMock.mockReset();
    killSwitches.community_access = true;
    killSwitches.road_quality_overlay = true;
    systemSwitches.sys_gamification = true;
    mapProps.current = null;
    fetchSharedMapMock.mockResolvedValue(share());
  });

  it("NEVER FETCHES the snapshot when gamification is off", async () => {
    // The registry scopes this switch to "badges, challenges, personal road
    // map", and this page serves anonymous visitors — so the exploration
    // totals and every ridden segment must not be read at all, let alone
    // rendered. A client-side gate would be too late: they are already in the
    // HTML and the Flight payload by then.
    systemSwitches.sys_gamification = false;
    render(await SharedRoadMapPage({ params }));

    expect(fetchSharedMapMock).not.toHaveBeenCalled();
    expect(mapProps.current).toBeNull();
  });

  it("resolves the switch SERVER-side", async () => {
    render(await SharedRoadMapPage({ params }));
    expect(serverSystemSwitchMock).toHaveBeenCalledWith("sys_gamification");
  });

  it("is independent of the other two switches", async () => {
    // Three switches, two registries. Without this, a gate written against the
    // wrong key would satisfy every other assertion in this file.
    killSwitches.road_quality_overlay = false;
    render(await SharedRoadMapPage({ params }));
    expect(fetchSharedMapMock).toHaveBeenCalled();
  });
});
