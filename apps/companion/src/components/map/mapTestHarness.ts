/**
 * Reusable MapLibre test harness for map-component tests (#1161).
 *
 * `MapCanvas.test.tsx` proved the recipe — replace `maplibre-gl` with a
 * hand-rolled map stub and drive the component by firing the captured `load`
 * handler — but its stub was local to that file and too small for consumers
 * like `QualityMap`, whose layer helpers guard on `getSource`/`getLayer`
 * (an always-truthy `getLayer` silently skips every `ensure*Layers` call).
 *
 * This module packages that recipe for reuse:
 *  - {@link createMapStub}: a REGISTRY-BACKED stub — sources and layers are
 *    actually recorded, so `ensure*`/`set*Visible`/`setData` helpers run for
 *    real and tests can assert on the resulting registry state instead of
 *    call minutiae.
 *  - {@link maplibreMockModule}: the module shape for
 *    `vi.mock("maplibre-gl", …)`. Its `Map` constructor creates a fresh stub
 *    per map instance (seeded with the constructor's center/zoom) and
 *    records it so the test can fetch it with {@link getMapStub}.
 *  - {@link installMapTestGlobals}: the jsdom globals map components expect
 *    (`ResizeObserver`, a light-scheme `matchMedia`).
 *
 * Usage (see `QualityMap.test.tsx`):
 *
 *   vi.mock("maplibre-gl", async () =>
 *     (await import("@/components/map/mapTestHarness")).maplibreMockModule(),
 *   );
 *   beforeEach(() => resetMapTestHarness());
 *   render(<QualityMap … />);
 *   const map = getMapStub();
 *   act(() => map.fire("load"));
 *   expect(map.layerVisibility(HAZARD_BG)).toBe("visible");
 */

import type { Mock } from "vitest";

type AnyRecord = Record<string, unknown>;
type Handler = (...args: unknown[]) => void;

export interface MapStubSource {
  readonly spec: AnyRecord;
  setData: Mock;
  getClusterExpansionZoom: Mock;
}

export interface MapStubLayer {
  id: string;
  layout?: AnyRecord;
  paint?: AnyRecord;
  filter?: unknown;
  [key: string]: unknown;
}

export interface MapStubView {
  lng: number;
  lat: number;
  zoom: number;
}

export interface MapStub {
  // ── event registry ──
  on: Mock;
  off: Mock;
  /** Fire every handler registered for a plain (non-layer-scoped) event. */
  fire(event: string, ...args: unknown[]): void;

  // ── sources / layers (registry-backed) ──
  addSource: Mock;
  getSource: Mock;
  removeSource: Mock;
  addLayer: Mock;
  getLayer: Mock;
  removeLayer: Mock;
  setLayoutProperty: Mock;
  setPaintProperty: Mock;
  setFilter: Mock;
  setLayerZoomRange: Mock;
  /** The stored layer spec, or undefined if never added / removed. */
  layer(id: string): MapStubLayer | undefined;
  /** The stored source record, or undefined. */
  source(id: string): MapStubSource | undefined;
  /** Current `layout.visibility` of a layer ("visible" when unset). */
  layerVisibility(id: string): string | undefined;
  /** The FeatureCollection most recently passed to a source's `setData`. */
  lastSetData(sourceId: string): unknown;

  // ── view ──
  getCenter: Mock;
  getZoom: Mock;
  getBounds: Mock;
  flyTo: Mock;
  easeTo: Mock;
  /** Mutate the stub's camera; the next getters/events read these values. */
  setView(view: Partial<MapStubView>): void;

  // ── misc surface the components/helpers touch ──
  project: Mock;
  queryRenderedFeatures: Mock;
  getCanvas: Mock;
  getStyle: Mock;
  hasImage: Mock;
  addImage: Mock;
  addControl: Mock;
  removeControl: Mock;
  resize: Mock;
  remove: Mock;
  dragPan: { isEnabled: Mock; enable: Mock; disable: Mock };
}

/** Half-extent (deg) of the synthetic viewport `getBounds` reports. */
const BOUNDS_HALF_EXTENT_DEG = 0.2;

export function createMapStub(initialView?: Partial<MapStubView>): MapStub {
  const view: MapStubView = {
    lng: 14.5,
    lat: 50.1,
    zoom: 7,
    ...initialView,
  };
  const sources = new Map<string, MapStubSource>();
  const layers = new Map<string, MapStubLayer>();
  // Plain events (`on(event, handler)`). Layer-scoped registrations
  // (`on(event, layerId, handler)`) are accepted but not fireable — none of
  // the current tests drive hover cursors.
  const handlers = new Map<string, Set<Handler>>();

  const canvas = {
    style: { cursor: "" },
    getBoundingClientRect: () => ({
      left: 0,
      top: 0,
      right: 600,
      bottom: 400,
      width: 600,
      height: 400,
      x: 0,
      y: 0,
    }),
  };

  const boundsObject = () => ({
    getWest: () => view.lng - BOUNDS_HALF_EXTENT_DEG,
    getEast: () => view.lng + BOUNDS_HALF_EXTENT_DEG,
    getSouth: () => view.lat - BOUNDS_HALF_EXTENT_DEG,
    getNorth: () => view.lat + BOUNDS_HALF_EXTENT_DEG,
    getNorthEast: () => ({
      lng: view.lng + BOUNDS_HALF_EXTENT_DEG,
      lat: view.lat + BOUNDS_HALF_EXTENT_DEG,
    }),
    getSouthWest: () => ({
      lng: view.lng - BOUNDS_HALF_EXTENT_DEG,
      lat: view.lat - BOUNDS_HALF_EXTENT_DEG,
    }),
  });

  const stub: MapStub = {
    on: vi.fn((event: string, a: unknown, b?: unknown) => {
      // 3-arg form = layer-scoped; recorded via the mock's own call log only.
      if (typeof b === "function") return;
      if (typeof a !== "function") return;
      const set = handlers.get(event) ?? new Set<Handler>();
      set.add(a as Handler);
      handlers.set(event, set);
    }),
    off: vi.fn((event: string, a: unknown, b?: unknown) => {
      if (typeof b === "function") return;
      if (typeof a !== "function") return;
      handlers.get(event)?.delete(a as Handler);
    }),
    fire(event, ...args) {
      for (const handler of [...(handlers.get(event) ?? [])]) {
        handler(...args);
      }
    },

    addSource: vi.fn((id: string, spec: AnyRecord) => {
      sources.set(id, {
        spec,
        setData: vi.fn(),
        getClusterExpansionZoom: vi.fn(() => Promise.resolve(12)),
      });
    }),
    getSource: vi.fn((id: string) => sources.get(id)),
    removeSource: vi.fn((id: string) => {
      sources.delete(id);
    }),
    addLayer: vi.fn((spec: MapStubLayer) => {
      layers.set(spec.id, spec);
    }),
    getLayer: vi.fn((id: string) => layers.get(id)),
    removeLayer: vi.fn((id: string) => {
      layers.delete(id);
    }),
    setLayoutProperty: vi.fn((id: string, prop: string, value: unknown) => {
      const layer = layers.get(id);
      if (!layer) return;
      layer.layout = { ...(layer.layout ?? {}), [prop]: value };
    }),
    setPaintProperty: vi.fn((id: string, prop: string, value: unknown) => {
      const layer = layers.get(id);
      if (!layer) return;
      layer.paint = { ...(layer.paint ?? {}), [prop]: value };
    }),
    setFilter: vi.fn((id: string, filter: unknown) => {
      const layer = layers.get(id);
      if (!layer) return;
      layer.filter = filter;
    }),
    setLayerZoomRange: vi.fn(),
    layer: (id) => layers.get(id),
    source: (id) => sources.get(id),
    layerVisibility(id) {
      const layer = layers.get(id);
      if (!layer) return undefined;
      const visibility = layer.layout?.visibility;
      return typeof visibility === "string" ? visibility : "visible";
    },
    lastSetData(sourceId) {
      const src = sources.get(sourceId);
      return src?.setData.mock.lastCall?.[0];
    },

    getCenter: vi.fn(() => ({ lng: view.lng, lat: view.lat })),
    getZoom: vi.fn(() => view.zoom),
    getBounds: vi.fn(boundsObject),
    flyTo: vi.fn((target: { center?: [number, number]; zoom?: number }) => {
      if (target?.center) {
        view.lng = target.center[0];
        view.lat = target.center[1];
      }
      if (typeof target?.zoom === "number") view.zoom = target.zoom;
    }),
    easeTo: vi.fn(),
    setView(next) {
      Object.assign(view, next);
    },

    // Deterministic linear projection — enough for popover re-positioning and
    // nearest-line distance math.
    project: vi.fn((lngLat: [number, number]) => ({
      x: (lngLat[0] - view.lng) * 1000 + 300,
      y: (view.lat - lngLat[1]) * 1000 + 200,
    })),
    queryRenderedFeatures: vi.fn(() => []),
    getCanvas: vi.fn(() => canvas),
    getStyle: vi.fn(() => ({ layers: [] })),
    hasImage: vi.fn(() => false),
    addImage: vi.fn(),
    addControl: vi.fn(),
    removeControl: vi.fn(),
    resize: vi.fn(),
    remove: vi.fn(),
    dragPan: {
      isEnabled: vi.fn(() => true),
      enable: vi.fn(),
      disable: vi.fn(),
    },
  };

  return stub;
}

// ── module-mock plumbing ──

let currentMap: MapStub | null = null;

/** The most recently constructed map stub (i.e. the one the component under
 *  test is driving). Throws when no map was constructed yet — render first. */
export function getMapStub(): MapStub {
  if (!currentMap) {
    throw new Error(
      "No map stub constructed yet — render a component that mounts a map " +
        "(and make sure maplibre-gl is mocked via maplibreMockModule()).",
    );
  }
  return currentMap;
}

/** Drop the recorded map stub between tests (call from `beforeEach`). */
export function resetMapTestHarness(): void {
  currentMap = null;
}

/**
 * Module factory for `vi.mock("maplibre-gl", …)`. The mocked `Map`
 * constructor creates a fresh {@link MapStub} seeded from the constructor
 * options' center/zoom (so the stub camera matches the component's props)
 * and records it for {@link getMapStub}.
 */
export function maplibreMockModule(): Record<string, unknown> {
  class NavigationControl {}
  class GeolocateControl {}
  class ScaleControl {}
  class AttributionControl {}
  const MapMock = vi.fn(function MockMap(options?: {
    center?: [number, number];
    zoom?: number;
  }) {
    currentMap = createMapStub({
      ...(options?.center
        ? { lng: options.center[0], lat: options.center[1] }
        : {}),
      ...(typeof options?.zoom === "number" ? { zoom: options.zoom } : {}),
    });
    return currentMap;
  });
  return {
    default: {
      Map: MapMock,
      NavigationControl,
      GeolocateControl,
      ScaleControl,
      AttributionControl,
    },
    Map: MapMock,
    NavigationControl,
    GeolocateControl,
    ScaleControl,
    AttributionControl,
  };
}

/**
 * jsdom globals the map components expect: `ResizeObserver` and a
 * `matchMedia` that reports a LIGHT color-scheme preference (the companion
 * ships cream-only; `useMapColorScheme` must not see `matches: true` for the
 * dark query). Call once from `beforeAll`/`beforeEach`.
 */
export function installMapTestGlobals(): void {
  class MockResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal("ResizeObserver", MockResizeObserver);
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
    })),
  });
}
