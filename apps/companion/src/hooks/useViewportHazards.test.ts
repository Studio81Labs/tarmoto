import { renderHook } from "@testing-library/react";
import { createRef } from "react";
import type { Map as MapLibreMap } from "maplibre-gl";
import { useViewportHazards } from "./useViewportHazards";

const killSwitch = vi.hoisted(() => ({ enabled: true }));
vi.mock("@/hooks/useEntitlements", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/useEntitlements")>()),
  // Operator kill switches fail SAFE (enabled until a confirmed `force_off`),
  // so this defaults ON and every existing case keeps exercising the path it
  // was written for. Flip `killSwitch.enabled` to simulate an operator.
  useFeatureKillSwitch: () => ({
    enabled: killSwitch.enabled,
    isResolved: true,
  }),
}));

const findNearby = vi.fn();
vi.mock("@/lib/api", () => ({
  hazardsApi: { findNearby: (...a: unknown[]) => findNearby(...a) },
}));

const setHazardSourceData = vi.fn();
vi.mock("@/components/map/HazardPinLayer", async (orig) => ({
  ...(await orig<typeof import("@/components/map/HazardPinLayer")>()),
  setHazardSourceData: (...a: unknown[]) => setHazardSourceData(...a),
}));

function fakeMap(zoom: number): MapLibreMap {
  return {
    getZoom: () => zoom,
    getCenter: () => ({ lng: 14, lat: 49 }),
    getBounds: () => ({
      getNorthEast: () => ({ lng: 14.2, lat: 49.2 }),
      getSouthWest: () => ({ lng: 13.8, lat: 48.8 }),
    }),
    getSource: () => undefined,
  } as unknown as MapLibreMap;
}

function ref(map: MapLibreMap | null) {
  const r = createRef<{ map: MapLibreMap | null }>();
  r.current = { map };
  return r;
}

describe("useViewportHazards", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    findNearby.mockReset().mockResolvedValue({ data: [{ id: "h1" }] });
    setHazardSourceData.mockReset();
    killSwitch.enabled = true;
  });
  afterEach(() => vi.useRealTimers());

  it("fetches for the viewport when enabled + zoomed in enough", async () => {
    renderHook(() =>
      useViewportHazards(ref(fakeMap(12)), { enabled: true, viewportToken: 1 }),
    );
    await vi.advanceTimersByTimeAsync(400);
    expect(findNearby).toHaveBeenCalledWith(
      expect.objectContaining({ lat: 49, lng: 14 }),
      expect.anything(),
    );
    expect(setHazardSourceData).toHaveBeenCalledWith(
      expect.anything(),
      [{ id: "h1" }],
      expect.any(Number),
    );
  });

  it("does not fetch while the hazard_alerts kill switch is OFF", async () => {
    // Gated inside the hook, so every map that mounts it is covered by one gate
    // rather than each caller remembering to pass the flag through.
    killSwitch.enabled = false;
    renderHook(() =>
      useViewportHazards(ref(fakeMap(12)), { enabled: true, viewportToken: 1 }),
    );
    await vi.advanceTimersByTimeAsync(400);
    expect(findNearby).not.toHaveBeenCalled();
    // Cleared, not merely left alone — an operator flip must remove pins that
    // are already on the map.
    expect(setHazardSourceData).toHaveBeenCalledWith(
      expect.anything(),
      [],
      expect.any(Number),
    );
  });

  it("TEARS DOWN a live layer when an operator flips the switch", async () => {
    // The difference between a kill switch and a mount-time check. Without
    // `active` in the effect's dependency array the hook would keep the stale
    // pins on screen until something else happened to re-run it.
    const mapRef = ref(fakeMap(12));
    const { rerender } = renderHook(() =>
      useViewportHazards(mapRef, { enabled: true, viewportToken: 1 }),
    );
    await vi.advanceTimersByTimeAsync(400);
    expect(findNearby).toHaveBeenCalled();

    killSwitch.enabled = false;
    setHazardSourceData.mockClear();
    rerender();
    await vi.advanceTimersByTimeAsync(400);

    expect(setHazardSourceData).toHaveBeenCalledWith(
      expect.anything(),
      [],
      expect.any(Number),
    );
  });

  it("clears and does not fetch when disabled", async () => {
    renderHook(() =>
      useViewportHazards(ref(fakeMap(12)), {
        enabled: false,
        viewportToken: 1,
      }),
    );
    await vi.advanceTimersByTimeAsync(400);
    expect(findNearby).not.toHaveBeenCalled();
    expect(setHazardSourceData).toHaveBeenCalledWith(
      expect.anything(),
      [],
      expect.any(Number),
    );
  });

  it("clears and does not fetch below the min zoom", async () => {
    renderHook(() =>
      useViewportHazards(ref(fakeMap(5)), { enabled: true, viewportToken: 1 }),
    );
    await vi.advanceTimersByTimeAsync(400);
    expect(findNearby).not.toHaveBeenCalled();
    expect(setHazardSourceData).toHaveBeenCalledWith(
      expect.anything(),
      [],
      expect.any(Number),
    );
  });
});
