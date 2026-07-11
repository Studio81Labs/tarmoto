import { renderHook } from "@testing-library/react";
import { createRef } from "react";
import type { Map as MapLibreMap } from "maplibre-gl";
import { useViewportHazards } from "./useViewportHazards";

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
