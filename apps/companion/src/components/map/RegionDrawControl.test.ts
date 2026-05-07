import { describe, expect, it, vi } from "vitest";
import {
  createRegionDrawControl,
  type RegionDrawBbox,
  type RegionDrawMode,
} from "./RegionDrawControl";
import type { Map as MapLibreMap } from "maplibre-gl";
import type { FeatureCollection } from "geojson";

interface FakeSource {
  data: FeatureCollection;
  setData(data: FeatureCollection): void;
}

type FakeMouseEvent = {
  point: { x: number; y: number };
  lngLat: { lng: number; lat: number };
  preventDefault?: () => void;
};

interface FakeMap {
  map: MapLibreMap;
  emit: (event: string, payload: FakeMouseEvent) => void;
  sources: Map<string, FakeSource>;
  layers: Set<string>;
  cursor: () => string;
  dragPanEnabled: () => boolean;
}

function buildFakeMap(): FakeMap {
  const handlers = new Map<string, Array<(e: FakeMouseEvent) => void>>();
  const sources = new Map<string, FakeSource>();
  const layers = new Set<string>();
  const canvasStyle = { cursor: "" };
  let dragPanEnabled = true;

  const map = {
    addSource: vi.fn((id: string, options: { data: FeatureCollection }) => {
      const source: FakeSource = {
        data: options.data,
        setData(next: FeatureCollection) {
          this.data = next;
        },
      };
      sources.set(id, source);
    }),
    getSource: vi.fn((id: string) => sources.get(id)),
    removeSource: vi.fn((id: string) => sources.delete(id)),
    addLayer: vi.fn((options: { id: string }) => {
      layers.add(options.id);
    }),
    getLayer: vi.fn((id: string) => (layers.has(id) ? { id } : undefined)),
    removeLayer: vi.fn((id: string) => layers.delete(id)),
    on: vi.fn((event: string, handler: (e: FakeMouseEvent) => void) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    }),
    off: vi.fn((event: string, handler: (e: FakeMouseEvent) => void) => {
      const list = handlers.get(event) ?? [];
      handlers.set(
        event,
        list.filter((h) => h !== handler),
      );
    }),
    getCanvas: vi.fn(() => ({ style: canvasStyle })),
    dragPan: {
      isEnabled: () => dragPanEnabled,
      enable: () => {
        dragPanEnabled = true;
      },
      disable: () => {
        dragPanEnabled = false;
      },
    },
    // Identity projection so pixel coordinates match degrees: keeps the
    // handle hit-test math straightforward inside the unit test while
    // still exercising the production geometry helpers.
    project: vi.fn(([lng, lat]: [number, number]) => ({ x: lng, y: lat })),
    queryRenderedFeatures: vi.fn(() => []),
  };

  return {
    map: map as unknown as MapLibreMap,
    emit(event, payload) {
      const list = handlers.get(event) ?? [];
      for (const handler of list) {
        handler({
          preventDefault: () => undefined,
          ...payload,
        });
      }
    },
    sources,
    layers,
    cursor: () => canvasStyle.cursor,
    dragPanEnabled: () => dragPanEnabled,
  };
}

function makeMouseEvent(lng: number, lat: number, px = lng, py = lat) {
  return {
    point: { x: px, y: py },
    lngLat: { lng, lat },
  };
}

describe("createRegionDrawControl", () => {
  it("creates a region from drag and emits onRegionDrawn with the bbox", () => {
    const fake = buildFakeMap();
    const onRegionDrawn = vi.fn<(bbox: RegionDrawBbox) => void>();
    const onModeChange = vi.fn<(mode: RegionDrawMode) => void>();
    const control = createRegionDrawControl(fake.map, {
      onRegionDrawn,
      onModeChange,
    });

    control.start();
    expect(control.getMode()).toBe("drawing");
    expect(fake.dragPanEnabled()).toBe(false);

    fake.emit("mousedown", makeMouseEvent(10, 20));
    fake.emit("mousemove", makeMouseEvent(15, 25));
    fake.emit("mouseup", makeMouseEvent(15, 25));

    expect(onRegionDrawn).toHaveBeenCalledTimes(1);
    expect(onRegionDrawn).toHaveBeenCalledWith([10, 20, 15, 25]);
    expect(control.getMode()).toBe("idle");
    expect(fake.dragPanEnabled()).toBe(true);
    expect(onModeChange).toHaveBeenCalledWith("drawing");
    expect(onModeChange).toHaveBeenCalledWith("idle");
  });

  it("ignores degenerate drags below the minimum bbox size", () => {
    const fake = buildFakeMap();
    const onRegionDrawn = vi.fn<(bbox: RegionDrawBbox) => void>();
    const control = createRegionDrawControl(fake.map, { onRegionDrawn });

    control.start();
    fake.emit("mousedown", makeMouseEvent(10, 20));
    fake.emit("mouseup", makeMouseEvent(10, 20));

    expect(onRegionDrawn).not.toHaveBeenCalled();
    expect(control.getMode()).toBe("idle");
  });

  it("moves a drawn region when the rider drags inside it", () => {
    const fake = buildFakeMap();
    const onRegionDrawn = vi.fn<(bbox: RegionDrawBbox) => void>();
    const onModeChange = vi.fn<(mode: RegionDrawMode) => void>();
    const control = createRegionDrawControl(fake.map, {
      onRegionDrawn,
      onModeChange,
    });
    // Use a generous rectangle so the interior pointer below stays
    // well outside the handle hit-radius (10px under identity projection).
    control.setDrawn([0, 0, 100, 100]);

    fake.emit("mousedown", makeMouseEvent(50, 50));
    expect(control.getMode()).toBe("editing");

    fake.emit("mousemove", makeMouseEvent(60, 70));
    fake.emit("mouseup", makeMouseEvent(60, 70));

    expect(onRegionDrawn).toHaveBeenCalledTimes(1);
    expect(onRegionDrawn).toHaveBeenCalledWith([10, 20, 110, 120]);
    expect(control.getMode()).toBe("idle");
    expect(fake.dragPanEnabled()).toBe(true);
  });

  it("resizes from a corner handle, leaving the opposite corner anchored", () => {
    const fake = buildFakeMap();
    const onRegionDrawn = vi.fn<(bbox: RegionDrawBbox) => void>();
    const control = createRegionDrawControl(fake.map, { onRegionDrawn });
    control.setDrawn([0, 0, 100, 100]);

    // NE corner sits at (100, 100). Drag it to (115, 120) — only east
    // and north should move; west and south stay anchored.
    fake.emit("mousedown", makeMouseEvent(100, 100));
    fake.emit("mousemove", makeMouseEvent(115, 120));
    fake.emit("mouseup", makeMouseEvent(115, 120));

    expect(onRegionDrawn).toHaveBeenCalledTimes(1);
    expect(onRegionDrawn).toHaveBeenCalledWith([0, 0, 115, 120]);
  });

  it("resizes from an edge handle along a single axis", () => {
    const fake = buildFakeMap();
    const onRegionDrawn = vi.fn<(bbox: RegionDrawBbox) => void>();
    const control = createRegionDrawControl(fake.map, { onRegionDrawn });
    control.setDrawn([0, 0, 100, 100]);

    // North edge midpoint sits at (50, 100). Drag it up to (50, 120) —
    // only north should change.
    fake.emit("mousedown", makeMouseEvent(50, 100));
    fake.emit("mousemove", makeMouseEvent(50, 120));
    fake.emit("mouseup", makeMouseEvent(50, 120));

    expect(onRegionDrawn).toHaveBeenCalledTimes(1);
    expect(onRegionDrawn).toHaveBeenCalledWith([0, 0, 100, 120]);
  });

  it("normalizes a resize that crosses the opposite edge", () => {
    const fake = buildFakeMap();
    const onRegionDrawn = vi.fn<(bbox: RegionDrawBbox) => void>();
    const control = createRegionDrawControl(fake.map, { onRegionDrawn });
    control.setDrawn([0, 0, 100, 100]);

    // NE corner dragged way down-and-left of the SW corner. The bbox
    // must remain non-degenerate after normalization.
    fake.emit("mousedown", makeMouseEvent(100, 100));
    fake.emit("mousemove", makeMouseEvent(-50, -50));
    fake.emit("mouseup", makeMouseEvent(-50, -50));

    expect(onRegionDrawn).toHaveBeenCalledTimes(1);
    const bbox = onRegionDrawn.mock.calls[0]![0];
    expect(bbox[0]).toBeLessThan(bbox[2]);
    expect(bbox[1]).toBeLessThan(bbox[3]);
  });

  it("does not emit onRegionDrawn when a drag finishes without movement", () => {
    const fake = buildFakeMap();
    const onRegionDrawn = vi.fn<(bbox: RegionDrawBbox) => void>();
    const control = createRegionDrawControl(fake.map, { onRegionDrawn });
    control.setDrawn([0, 0, 100, 100]);

    fake.emit("mousedown", makeMouseEvent(50, 50));
    fake.emit("mouseup", makeMouseEvent(50, 50));

    expect(onRegionDrawn).not.toHaveBeenCalled();
    expect(control.getMode()).toBe("idle");
  });

  it("clearDrawn fires onRegionCleared and removes the handles", () => {
    const fake = buildFakeMap();
    const onRegionCleared = vi.fn();
    const control = createRegionDrawControl(fake.map, {
      onRegionDrawn: vi.fn(),
      onRegionCleared,
    });
    control.setDrawn([0, 0, 100, 100]);
    expect(fake.sources.get("region-handles-src")?.data.features).toHaveLength(
      8,
    );

    control.clearDrawn();
    expect(onRegionCleared).toHaveBeenCalledTimes(1);
    expect(fake.sources.get("region-handles-src")?.data.features).toHaveLength(
      0,
    );
    expect(fake.sources.get("region-drawn-src")?.data.features).toHaveLength(0);
  });

  it("renders eight handles for the drawn rectangle (four corners + four edges)", () => {
    const fake = buildFakeMap();
    const control = createRegionDrawControl(fake.map, {
      onRegionDrawn: vi.fn(),
    });
    control.setDrawn([0, 0, 100, 100]);

    const features = fake.sources.get("region-handles-src")?.data.features;
    expect(features).toHaveLength(8);
    const handles = (features ?? [])
      .map((f) => (f.properties as { handle: string }).handle)
      .sort();
    expect(handles).toEqual(["e", "n", "ne", "nw", "s", "se", "sw", "w"]);
  });

  it("hitTest returns true when the pointer is inside the drawn rectangle", () => {
    const fake = buildFakeMap();
    const control = createRegionDrawControl(fake.map, {
      onRegionDrawn: vi.fn(),
    });
    control.setDrawn([0, 0, 100, 100]);

    // Make queryRenderedFeatures answer true so the fill branch wins.
    (
      fake.map as unknown as { queryRenderedFeatures: ReturnType<typeof vi.fn> }
    ).queryRenderedFeatures.mockReturnValue([{ id: 1 }]);

    expect(control.hitTest({ x: 200, y: 200 })).toBe(true);
  });

  it("hitTest returns false when no region is drawn", () => {
    const fake = buildFakeMap();
    const control = createRegionDrawControl(fake.map, {
      onRegionDrawn: vi.fn(),
    });
    expect(control.hitTest({ x: 0, y: 0 })).toBe(false);
  });

  it("cancel during editing restores the idle mode", () => {
    const fake = buildFakeMap();
    const onModeChange = vi.fn<(mode: RegionDrawMode) => void>();
    const control = createRegionDrawControl(fake.map, {
      onRegionDrawn: vi.fn(),
      onModeChange,
    });
    control.setDrawn([0, 0, 100, 100]);

    fake.emit("mousedown", makeMouseEvent(50, 50));
    expect(control.getMode()).toBe("editing");

    control.cancel();
    expect(control.getMode()).toBe("idle");
    expect(fake.dragPanEnabled()).toBe(true);
  });

  it("destroy removes all sources, layers, and listeners", () => {
    const fake = buildFakeMap();
    const onRegionDrawn = vi.fn<(bbox: RegionDrawBbox) => void>();
    const control = createRegionDrawControl(fake.map, { onRegionDrawn });
    control.setDrawn([0, 0, 100, 100]);

    control.destroy();
    expect(fake.layers.size).toBe(0);
    expect(fake.sources.size).toBe(0);

    // After destroy, emitted events should not call the consumer back.
    fake.emit("mousedown", makeMouseEvent(50, 50));
    fake.emit("mouseup", makeMouseEvent(60, 70));
    expect(onRegionDrawn).not.toHaveBeenCalled();
  });
});
