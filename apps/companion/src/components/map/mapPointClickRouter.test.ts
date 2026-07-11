import type {
  Map as MapLibreMap,
  MapGeoJSONFeature,
  MapMouseEvent,
} from "maplibre-gl";
import {
  installPointClickRouter,
  resolvePointClick,
  type PointClickRoute,
} from "./mapPointClickRouter";

/** Feature stub carrying just the layer id the router reads. */
function feat(layerId: string): MapGeoJSONFeature {
  return { layer: { id: layerId } } as unknown as MapGeoJSONFeature;
}

/**
 * Fake map whose `queryRenderedFeatures` returns the features staged in
 * `hits` that belong to the queried layer set, and whose `getLayer` reports
 * every id in `known` as present.
 */
function fakeMap({
  known,
  hits,
}: {
  known: string[];
  hits: MapGeoJSONFeature[];
}) {
  const on = vi.fn();
  const off = vi.fn();
  const map = {
    getLayer: (id: string) => (known.includes(id) ? ({} as never) : undefined),
    queryRenderedFeatures: (_point: unknown, opts?: { layers?: string[] }) => {
      const layers = opts?.layers ?? [];
      return hits.filter((h) => layers.includes(h.layer.id));
    },
    on,
    off,
  } as unknown as MapLibreMap;
  return { map, on, off };
}

const event = { point: { x: 10, y: 10 } } as unknown as MapMouseEvent;

describe("resolvePointClick", () => {
  const routes: PointClickRoute[] = [
    { layers: ["waypoint"], handle: () => {} },
    { layers: ["closure", "pass"], handle: () => {} },
    { layers: ["hazard-bg", "hazard-icon"], handle: () => {} },
  ];

  it("returns null when nothing is under the cursor", () => {
    const { map } = fakeMap({ known: ["waypoint", "hazard-bg"], hits: [] });
    expect(resolvePointClick(map, event, routes)).toBeNull();
  });

  it("routes to the single hit layer's owner", () => {
    const { map } = fakeMap({
      known: ["waypoint", "closure", "hazard-bg"],
      hits: [feat("closure")],
    });
    const resolved = resolvePointClick(map, event, routes);
    expect(resolved?.route).toBe(routes[1]);
    expect(resolved?.feature.layer.id).toBe("closure");
  });

  it("prefers the topmost route when several layers overlap", () => {
    const { map } = fakeMap({
      known: ["waypoint", "closure", "hazard-bg"],
      // A hazard + a waypoint under the same click — waypoint route is listed
      // first, so it owns it and the hazard is ignored.
      hits: [feat("hazard-bg"), feat("waypoint")],
    });
    const resolved = resolvePointClick(map, event, routes);
    expect(resolved?.route).toBe(routes[0]);
    expect(resolved?.feature.layer.id).toBe("waypoint");
  });

  it("ignores layers that aren't on the map", () => {
    // Only hazard layers are registered; a stale waypoint hit is impossible
    // because the layer is filtered out of the query set.
    const { map } = fakeMap({
      known: ["hazard-bg", "hazard-icon"],
      hits: [feat("hazard-icon")],
    });
    const resolved = resolvePointClick(map, event, routes);
    expect(resolved?.route).toBe(routes[2]);
  });
});

describe("installPointClickRouter", () => {
  it("dispatches exactly one owning handler and never onMiss on a hit", () => {
    const { map, on } = fakeMap({
      known: ["closure", "hazard-bg"],
      hits: [feat("hazard-bg"), feat("closure")],
    });
    const closureHandle = vi.fn();
    const hazardHandle = vi.fn();
    const onMiss = vi.fn();
    installPointClickRouter(map, {
      routes: [
        { layers: ["closure"], handle: closureHandle },
        { layers: ["hazard-bg"], handle: hazardHandle },
      ],
      onMiss,
    });

    // Fire the registered map click handler.
    expect(on).toHaveBeenCalledWith("click", expect.any(Function));
    const handler = on.mock.calls[0]![1] as (e: MapMouseEvent) => void;
    handler(event);

    expect(closureHandle).toHaveBeenCalledTimes(1);
    expect(hazardHandle).not.toHaveBeenCalled();
    expect(onMiss).not.toHaveBeenCalled();
  });

  it("calls onMiss when the click hits no interactive layer", () => {
    const { map, on } = fakeMap({ known: ["closure"], hits: [] });
    const onMiss = vi.fn();
    installPointClickRouter(map, {
      routes: [{ layers: ["closure"], handle: vi.fn() }],
      onMiss,
    });
    (on.mock.calls[0]![1] as (e: MapMouseEvent) => void)(event);
    expect(onMiss).toHaveBeenCalledTimes(1);
  });

  it("ignores the click entirely while blocked", () => {
    const { map, on } = fakeMap({
      known: ["closure"],
      hits: [feat("closure")],
    });
    const handle = vi.fn();
    const onMiss = vi.fn();
    installPointClickRouter(map, {
      routes: [{ layers: ["closure"], handle }],
      onMiss,
      isBlocked: () => true,
    });
    (on.mock.calls[0]![1] as (e: MapMouseEvent) => void)(event);
    expect(handle).not.toHaveBeenCalled();
    expect(onMiss).not.toHaveBeenCalled();
  });

  it("teardown removes the click handler", () => {
    const { map, on, off } = fakeMap({ known: [], hits: [] });
    const teardown = installPointClickRouter(map, { routes: [] });
    teardown();
    expect(off).toHaveBeenCalledWith("click", on.mock.calls[0]![1]);
  });
});
