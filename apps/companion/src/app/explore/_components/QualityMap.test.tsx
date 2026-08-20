/**
 * QualityMap seam tests (#1161) on the reusable map-stub harness
 * (`@/components/map/mapTestHarness`). Every other test that touches
 * QualityMap mocks it wholesale; these render the REAL component (plus the
 * real MapCanvas and layer helpers) against a registry-backed map stub, so
 * the seams that carry gating logic finally have red-producing coverage.
 *
 * COVERED — the seams named by the issue:
 *  - hazard pipeline gating: viewport REST fetch, socket subscribe/listener
 *    lifecycle, and layer visibility — including the #1159 path where the
 *    `hazard_alerts` operator kill switch must gate QualityMap's OWN hazard
 *    pipeline (it never calls `useViewportHazards`), live-flip included
 *  - quality overlay: the filter-driven opacity expression reaching the
 *    quality layer, and cap clamping — the zoom upgrade prompt for a capped
 *    free rider and the "no selection past the cap" click gate
 *  - selection layer visibility: `selectedSegmentId` driving the highlight
 *    filter + visibility through the canvas
 *
 * STILL UNTESTED (deliberately — write tests here before relying on them):
 *  - POI category browsing (viewport fetch, clusters, FSQ attribution latch)
 *  - conditions (closures/passes markers, popover reconcile beyond the unit
 *    tests in `conditionPopoverReconcile.test.ts`, pinned-condition flows,
 *    date/month popover resets)
 *  - trip/ride route overlays and their click-through, Fun Zone layers and
 *    the draw-region control, aerial basemap switching
 *  - the imperative handle (`flyTo`, `openConditionPopover`, draw-region
 *    methods) and popover re-projection on map move
 *  - hazard popover contents (`MapPointPopover` has its own tests), hazard
 *    age-fade ticking, WS merge edge races (unit-tested in
 *    `lib/hazard-merge`), reconnect refetch (`reconnectRevision`)
 */
import { act, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps } from "react";
import { QualityMap } from "./QualityMap";
import {
  getMapStub,
  installMapTestGlobals,
  resetMapTestHarness,
  type MapStub,
} from "@/components/map/mapTestHarness";
import {
  HAZARDS_SOURCE,
  HAZARD_BG,
  HAZARD_CLUSTERS,
} from "@/components/map/HazardPinLayer";
import {
  TARMOTO_QUALITY_LAYER,
  TARMOTO_ROAD_HIT_LAYER,
} from "@/components/map/MapCanvas";
import { DEFAULT_MAP_FILTERS, cloneFilters } from "@/lib/map-filters";
import type { HazardResponse } from "@/lib/api";
import { useRealtimeStore } from "@/stores/realtime";

// ── harness state shared with the module mocks ──

const harness = vi.hoisted(() => {
  const unsubscribeSpy = vi.fn();
  return {
    // Operator kill switches by key — absent keys fail SAFE (enabled), like
    // the real hook. `hazard_alerts` gates QualityMap's hazard pipeline;
    // `road_quality_overlay` gates MapCanvas's quality layers.
    killSwitches: {} as Record<string, boolean>,
    tier: "free" as "free" | "pro" | "premium" | null,
    qualityCap: { limit: null as number | null, isResolved: true },
    socket: {
      subscribeHazards: vi.fn(),
      unsubscribeSpy,
      onHazardNew: vi.fn((_cb: (hazard: unknown) => void) => unsubscribeSpy),
    },
    hazardsApi: { findNearby: vi.fn() },
  };
});

vi.mock("maplibre-gl", async () =>
  (await import("@/components/map/mapTestHarness")).maplibreMockModule(),
);

// The map is created only after the curated base-map style resolves; make
// that fetch synchronous and network-free (the stub ignores the style).
vi.mock("@/components/map/attribution", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/map/attribution")>()),
  loadCuratedMapStyle: vi.fn(async () => ({
    version: 8,
    sources: {},
    layers: [],
  })),
}));

vi.mock("@/hooks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks")>()),
  useEntitlements: () => ({ tier: harness.tier }),
  useRoadQualityZoomCap: () => harness.qualityCap,
  // UpgradePrompt dependencies — keep the CTA path deterministic and free of
  // next-auth/session requirements.
  useSystemSwitch: () => ({ enabled: true, isResolved: true }),
  useUpgradeRouting: () => ({ needsCheckout: false, isResolved: true }),
}));

vi.mock("@/hooks/useEntitlements", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/useEntitlements")>()),
  useFeatureKillSwitch: (key: string) => ({
    enabled: harness.killSwitches[key] ?? true,
    isResolved: true,
  }),
}));

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  hazardsApi: harness.hazardsApi,
}));

vi.mock("@/lib/socket", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/socket")>()),
  subscribeHazards: harness.socket.subscribeHazards,
  onHazardNew: harness.socket.onHazardNew,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    prefetch: vi.fn(),
    back: vi.fn(),
  }),
  usePathname: () => "/explore",
  useSearchParams: () => new URLSearchParams(),
}));

// ── fixtures + helpers ──

function makeHazard(id: string, over: Partial<HazardResponse> = {}) {
  return {
    id,
    lat: 50.1,
    lng: 14.5,
    hazard_type: "pothole",
    severity: "medium",
    note: null,
    photo_url: null,
    confirmations: 1,
    reporter: null,
    road_name: null,
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    ...over,
  } as HazardResponse;
}

type Props = ComponentProps<typeof QualityMap>;

function makeProps(overrides: Partial<Props> = {}): Props {
  return {
    center: { lng: 14.5, lat: 50.1 },
    zoom: 10,
    filters: cloneFilters(DEFAULT_MAP_FILTERS),
    showQuality: true,
    showSurface: false,
    showHazards: true,
    showConditions: false,
    conditionBbox: null,
    conditionsMonth: 6,
    conditionsDate: new Date("2026-06-15T00:00:00Z"),
    showMyTrips: false,
    trips: [],
    onTripSelect: vi.fn(),
    showMyRides: false,
    rideTracks: [],
    onRideSelect: vi.fn(),
    showFunZones: false,
    funZones: [],
    selectedFunZoneId: null,
    onFunZoneSelect: vi.fn(),
    ...overrides,
  };
}

function renderQualityMap(overrides: Partial<Props> = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  let current = makeProps(overrides);
  const view = render(
    <QueryClientProvider client={client}>
      <QualityMap {...current} />
    </QueryClientProvider>,
  );
  return {
    ...view,
    /** Re-render with merged prop overrides (also re-reads harness state). */
    update(next: Partial<Props> = {}) {
      current = { ...current, ...next };
      view.rerender(
        <QueryClientProvider client={client}>
          <QualityMap {...current} />
        </QueryClientProvider>,
      );
    },
  };
}

/** Wait for the map to be constructed, then fire its style `load`. */
async function openMap(): Promise<MapStub> {
  await waitFor(() => {
    getMapStub();
  });
  const map = getMapStub();
  act(() => {
    map.fire("load");
  });
  return map;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Feature count of the last FeatureCollection pushed to the hazard source. */
function hazardFeatureCount(map: MapStub): number | undefined {
  const data = map.lastSetData(HAZARDS_SOURCE) as
    { features?: unknown[] } | undefined;
  return data?.features?.length;
}

const clickEventAt = (x: number, y: number) => ({
  point: { x, y },
  lngLat: { lng: 14.5, lat: 50.1 },
  originalEvent: { clientX: x, clientY: y },
});

describe("QualityMap", () => {
  beforeAll(() => {
    installMapTestGlobals();
  });

  beforeEach(() => {
    resetMapTestHarness();
    harness.killSwitches = {};
    harness.tier = "free";
    harness.qualityCap = { limit: null, isResolved: true };
    harness.socket.subscribeHazards.mockClear();
    harness.socket.unsubscribeSpy.mockClear();
    harness.socket.onHazardNew.mockClear();
    harness.hazardsApi.findNearby.mockReset();
    harness.hazardsApi.findNearby.mockResolvedValue({ data: [] });
    useRealtimeStore.setState({ status: "connected" });
  });

  // ── seam: hazard fetch / socket / layer visibility gating (#1159) ──

  it("fetches viewport hazards once ready and paints them into the hazard source", async () => {
    harness.hazardsApi.findNearby.mockResolvedValue({
      data: [makeHazard("hz-1")],
    });
    renderQualityMap();
    const map = await openMap();

    expect(map.layerVisibility(HAZARD_BG)).toBe("visible");
    expect(map.layerVisibility(HAZARD_CLUSTERS)).toBe("visible");

    await waitFor(() =>
      expect(harness.hazardsApi.findNearby).toHaveBeenCalledWith(
        expect.objectContaining({ lat: 50.1, lng: 14.5 }),
        expect.anything(),
      ),
    );
    await waitFor(() => expect(hazardFeatureCount(map)).toBe(1));
    const data = map.lastSetData(HAZARDS_SOURCE) as {
      features: Array<{ properties: { id: string; hazard_type: string } }>;
    };
    expect(data.features[0]?.properties).toMatchObject({
      id: "hz-1",
      hazard_type: "pothole",
    });
  });

  it("subscribes the socket for the viewport (debounced) and registers the hazard listener", async () => {
    renderQualityMap();
    await openMap();

    await waitFor(() => expect(harness.socket.onHazardNew).toHaveBeenCalled());
    await waitFor(() =>
      expect(harness.socket.subscribeHazards).toHaveBeenCalledWith(
        50.1,
        14.5,
        expect.any(Number),
      ),
    );
  });

  it("gates its OWN hazard pipeline on the hazard_alerts kill switch — no fetch, no subscribe, layers hidden (#1159)", async () => {
    harness.killSwitches["hazard_alerts"] = false;
    renderQualityMap({ showHazards: true });
    const map = await openMap();

    // Layers are added hidden at ready time, not merely toggled later.
    expect(map.layerVisibility(HAZARD_BG)).toBe("none");
    expect(map.layerVisibility(HAZARD_CLUSTERS)).toBe("none");

    // Outwait the 300 ms debounce: nothing may have fired.
    await sleep(400);
    expect(harness.hazardsApi.findNearby).not.toHaveBeenCalled();
    expect(harness.socket.subscribeHazards).not.toHaveBeenCalled();
    expect(harness.socket.onHazardNew).not.toHaveBeenCalled();
  });

  it("on a LIVE force_off flip: drops the socket listener, hides the layers, clears painted pins; re-enabling resubscribes", async () => {
    harness.hazardsApi.findNearby.mockResolvedValue({
      data: [makeHazard("hz-1")],
    });
    const view = renderQualityMap();
    const map = await openMap();
    await waitFor(() => expect(hazardFeatureCount(map)).toBe(1));
    await waitFor(() =>
      expect(harness.socket.subscribeHazards).toHaveBeenCalledTimes(1),
    );

    // The operator flips hazard_alerts to force_off while /explore is open.
    harness.killSwitches["hazard_alerts"] = false;
    act(() => {
      view.update();
    });

    // Socket effect cleanup removed the local listener…
    expect(harness.socket.unsubscribeSpy).toHaveBeenCalled();
    // …the layers hid…
    expect(map.layerVisibility(HAZARD_BG)).toBe("none");
    expect(map.layerVisibility(HAZARD_CLUSTERS)).toBe("none");
    // …and the pins it already held were cleared from the source.
    await waitFor(() => expect(hazardFeatureCount(map)).toBe(0));

    // Re-enable: the pipeline comes back without a reload.
    harness.killSwitches["hazard_alerts"] = true;
    act(() => {
      view.update();
    });
    await waitFor(() =>
      expect(harness.hazardsApi.findNearby).toHaveBeenCalledTimes(2),
    );
    await waitFor(() =>
      expect(harness.socket.subscribeHazards).toHaveBeenCalledTimes(2),
    );
    expect(map.layerVisibility(HAZARD_BG)).toBe("visible");
  });

  it("does not fetch or subscribe below the hazard minimum zoom", async () => {
    renderQualityMap({ zoom: 8 });
    await openMap();
    await sleep(400);
    expect(harness.hazardsApi.findNearby).not.toHaveBeenCalled();
    expect(harness.socket.subscribeHazards).not.toHaveBeenCalled();
  });

  it("does not subscribe the socket while realtime is disconnected (REST fetch still runs)", async () => {
    useRealtimeStore.setState({ status: "disconnected" });
    renderQualityMap();
    await openMap();
    await waitFor(() =>
      expect(harness.hazardsApi.findNearby).toHaveBeenCalled(),
    );
    await sleep(350);
    expect(harness.socket.subscribeHazards).not.toHaveBeenCalled();
    expect(harness.socket.onHazardNew).not.toHaveBeenCalled();
  });

  it("appends a hazard:new socket arrival to the painted source", async () => {
    renderQualityMap();
    const map = await openMap();
    await waitFor(() => expect(harness.socket.onHazardNew).toHaveBeenCalled());
    const deliver = harness.socket.onHazardNew.mock.lastCall?.[0];
    if (!deliver) throw new Error("hazard listener was not registered");

    act(() => {
      deliver(makeHazard("hz-ws", { hazard_type: "gravel" }));
    });

    await waitFor(() => {
      const data = map.lastSetData(HAZARDS_SOURCE) as {
        features: Array<{ properties: { id: string } }>;
      };
      expect(data.features.some((f) => f.properties.id === "hz-ws")).toBe(true);
    });
  });

  // ── seam: quality overlay + cap clamping ──

  it("prompts a capped free rider once the view zooms past the cap — and not an unlimited rider", async () => {
    harness.qualityCap = { limit: 12, isResolved: true };
    renderQualityMap();
    const map = await openMap();

    expect(
      screen.queryByText(/Zoom in further for full road-quality detail/),
    ).toBeNull();

    map.setView({ zoom: 13 });
    act(() => {
      map.fire("moveend", { originalEvent: undefined });
    });
    expect(
      screen.getByText(/Zoom in further for full road-quality detail/),
    ).toBeInTheDocument();
  });

  it("never prompts an unlimited (null-cap) rider past the same zoom", async () => {
    harness.qualityCap = { limit: null, isResolved: true };
    renderQualityMap();
    const map = await openMap();

    map.setView({ zoom: 13 });
    act(() => {
      map.fire("moveend", { originalEvent: undefined });
    });
    expect(
      screen.queryByText(/Zoom in further for full road-quality detail/),
    ).toBeNull();
  });

  it("blocks road selection past the resolved quality cap and allows it below", async () => {
    harness.qualityCap = { limit: 12, isResolved: true };
    const onSegmentSelect = vi.fn();
    renderQualityMap({ onSegmentSelect, zoom: 13 });
    const map = await openMap();

    const roadFeature = {
      geometry: {
        type: "LineString",
        coordinates: [
          [14.499, 50.1],
          [14.501, 50.1],
        ],
      },
      properties: { id: "seg-77" },
      layer: { id: TARMOTO_ROAD_HIT_LAYER },
    };
    map.queryRenderedFeatures.mockImplementation(
      (_point: unknown, options?: { layers?: string[] }) =>
        options?.layers?.includes(TARMOTO_ROAD_HIT_LAYER) ? [roadFeature] : [],
    );

    // Past the cap (zoom 13 ≥ cap 12): the hit layer is queryable, but the
    // detail drawer must NOT open — that is the data the cap gates.
    map.setView({ zoom: 13 });
    act(() => {
      map.fire("click", clickEventAt(300, 200));
    });
    expect(onSegmentSelect).not.toHaveBeenCalled();

    // Below the cap the same click selects the segment.
    map.setView({ zoom: 11 });
    act(() => {
      map.fire("click", clickEventAt(300, 200));
    });
    expect(onSegmentSelect).toHaveBeenCalledWith("seg-77");
  });

  it("wires the filter-driven opacity expression onto the quality layer (non-matching grades dim)", async () => {
    const filters = cloneFilters(DEFAULT_MAP_FILTERS);
    filters.quality = new Set(["good"]);
    renderQualityMap({ filters });
    const map = await openMap();

    const opacity = map.layer(TARMOTO_QUALITY_LAYER)?.paint?.[
      "line-opacity"
    ] as unknown[];
    expect(Array.isArray(opacity)).toBe(true);
    // ["case", ["all", qualityMatch, surfaceMatch], ACTIVE, DIMMED]
    expect(opacity[0]).toBe("case");
    expect(opacity[2]).toBe(0.9);
    expect(opacity[3]).toBe(0.15);
    const qualityMatch = (opacity[1] as unknown[])[1] as unknown[];
    // Exactly one grade branch active ("good"); the other four dim.
    expect(qualityMatch.filter((v) => v === true)).toHaveLength(1);
    expect(qualityMatch.filter((v) => v === false)).toHaveLength(4);
  });

  // ── seam: selection layer visibility ──

  it("drives the selection highlight filter + visibility from selectedSegmentId", async () => {
    const view = renderQualityMap({ selectedSegmentId: "seg-9" });
    const map = await openMap();

    for (const id of [
      "tarmoto-segment-selected-outline",
      "tarmoto-segment-selected-glow",
      "tarmoto-segment-selected-line",
    ]) {
      expect(map.layer(id)?.filter).toEqual(["==", ["get", "id"], "seg-9"]);
      expect(map.layerVisibility(id)).toBe("visible");
    }

    act(() => {
      view.update({ selectedSegmentId: null });
    });
    for (const id of [
      "tarmoto-segment-selected-outline",
      "tarmoto-segment-selected-glow",
      "tarmoto-segment-selected-line",
    ]) {
      expect(map.layer(id)?.filter).toEqual(["==", ["get", "id"], ""]);
      expect(map.layerVisibility(id)).toBe("none");
    }
  });
});
