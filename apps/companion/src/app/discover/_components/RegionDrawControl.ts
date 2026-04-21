import type {
  GeoJSONSource,
  Map as MapLibreMap,
  MapMouseEvent,
} from "maplibre-gl";
import type { Feature, FeatureCollection, Polygon } from "geojson";
import type { DiscoverBbox } from "./useDiscoverStore";

const PREVIEW_SOURCE = "region-preview-src";
const DRAWN_SOURCE = "region-drawn-src";
const PREVIEW_FILL = "region-preview-fill";
const PREVIEW_LINE = "region-preview-line";
const DRAWN_FILL = "region-drawn-fill";
const DRAWN_LINE = "region-drawn-line";

// Reject accidental clicks / tiny drags (< ~11 m at the equator).
const MIN_BBOX_DEGREES = 0.0001;

const EMPTY: FeatureCollection<Polygon> = {
  type: "FeatureCollection",
  features: [],
};

export interface RegionDrawControl {
  /** Enter draw mode: disable map pan, show crosshair, wait for drag. */
  start(): void;
  /** Exit draw mode without committing. */
  cancel(): void;
  /** Clear the previously committed drawn rectangle from the map + state. */
  clearDrawn(): void;
  /** Paint a previously-drawn bbox (e.g. from URL hydration). */
  setDrawn(bbox: DiscoverBbox | null): void;
  /** Remove sources/layers + listeners. Called by useEffect cleanup. */
  destroy(): void;
  /** Current mode: "idle" (no drawing) or "drawing" (rectangle in progress). */
  getMode(): "idle" | "drawing";
}

interface Options {
  onRegionDrawn: (bbox: DiscoverBbox) => void;
  /** Fired when the mode changes so the button label can flip. */
  onModeChange?: (mode: "idle" | "drawing") => void;
}

/**
 * Creates a rectangle-only draw tool. Uses native MapLibre source/layer
 * primitives — no external draw library. Call `destroy()` in useEffect
 * cleanup to remove listeners and layers.
 */
export function createRegionDrawControl(
  map: MapLibreMap,
  opts: Options,
): RegionDrawControl {
  installSourcesAndLayers(map);

  let mode: "idle" | "drawing" = "idle";
  let startLngLat: [number, number] | null = null;
  let wasDragPanEnabled = true;

  const previewSrc = map.getSource(PREVIEW_SOURCE) as GeoJSONSource | undefined;
  const drawnSrc = map.getSource(DRAWN_SOURCE) as GeoJSONSource | undefined;

  function setMode(next: "idle" | "drawing") {
    if (mode === next) return;
    mode = next;
    opts.onModeChange?.(next);
  }

  function onDown(e: MapMouseEvent) {
    if (mode !== "drawing") return;
    e.preventDefault();
    startLngLat = [e.lngLat.lng, e.lngLat.lat];
  }

  function onMove(e: MapMouseEvent) {
    if (mode !== "drawing" || !startLngLat || !previewSrc) return;
    previewSrc.setData(
      rectangleFeatureCollection(startLngLat, [e.lngLat.lng, e.lngLat.lat]),
    );
  }

  function onUp(e: MapMouseEvent) {
    if (mode !== "drawing" || !startLngLat) return;
    const [x1, y1] = startLngLat;
    const x2 = e.lngLat.lng;
    const y2 = e.lngLat.lat;
    startLngLat = null;

    if (
      Math.abs(x2 - x1) < MIN_BBOX_DEGREES ||
      Math.abs(y2 - y1) < MIN_BBOX_DEGREES
    ) {
      // Treat as a cancel — restore previous state.
      previewSrc?.setData(EMPTY);
      exitDrawMode();
      return;
    }

    const bbox: DiscoverBbox = [
      Math.min(x1, x2),
      Math.min(y1, y2),
      Math.max(x1, x2),
      Math.max(y1, y2),
    ];
    previewSrc?.setData(EMPTY);
    drawnSrc?.setData(
      rectangleFeatureCollection([bbox[0], bbox[1]], [bbox[2], bbox[3]]),
    );
    exitDrawMode();
    opts.onRegionDrawn(bbox);
  }

  function enterDrawMode() {
    wasDragPanEnabled = map.dragPan.isEnabled();
    map.dragPan.disable();
    map.getCanvas().style.cursor = "crosshair";
    setMode("drawing");
  }

  function exitDrawMode() {
    if (wasDragPanEnabled) map.dragPan.enable();
    map.getCanvas().style.cursor = "";
    setMode("idle");
  }

  map.on("mousedown", onDown);
  map.on("mousemove", onMove);
  map.on("mouseup", onUp);

  return {
    start() {
      if (mode === "drawing") return;
      enterDrawMode();
    },
    cancel() {
      previewSrc?.setData(EMPTY);
      startLngLat = null;
      exitDrawMode();
    },
    clearDrawn() {
      drawnSrc?.setData(EMPTY);
    },
    setDrawn(bbox) {
      if (!drawnSrc) return;
      if (!bbox) {
        drawnSrc.setData(EMPTY);
        return;
      }
      drawnSrc.setData(
        rectangleFeatureCollection([bbox[0], bbox[1]], [bbox[2], bbox[3]]),
      );
    },
    destroy() {
      map.off("mousedown", onDown);
      map.off("mousemove", onMove);
      map.off("mouseup", onUp);
      for (const id of [PREVIEW_FILL, PREVIEW_LINE, DRAWN_FILL, DRAWN_LINE]) {
        if (map.getLayer(id)) map.removeLayer(id);
      }
      for (const id of [PREVIEW_SOURCE, DRAWN_SOURCE]) {
        if (map.getSource(id)) map.removeSource(id);
      }
    },
    getMode() {
      return mode;
    },
  };
}

function installSourcesAndLayers(map: MapLibreMap): void {
  if (!map.getSource(PREVIEW_SOURCE)) {
    map.addSource(PREVIEW_SOURCE, { type: "geojson", data: EMPTY });
    map.addLayer({
      id: PREVIEW_FILL,
      type: "fill",
      source: PREVIEW_SOURCE,
      paint: { "fill-color": "#0ED3CF", "fill-opacity": 0.1 },
    });
    map.addLayer({
      id: PREVIEW_LINE,
      type: "line",
      source: PREVIEW_SOURCE,
      paint: {
        "line-color": "#0ED3CF",
        "line-width": 2,
        "line-dasharray": [2, 2],
      },
    });
  }
  if (!map.getSource(DRAWN_SOURCE)) {
    map.addSource(DRAWN_SOURCE, { type: "geojson", data: EMPTY });
    map.addLayer({
      id: DRAWN_FILL,
      type: "fill",
      source: DRAWN_SOURCE,
      paint: { "fill-color": "#ffffff", "fill-opacity": 0.05 },
    });
    map.addLayer({
      id: DRAWN_LINE,
      type: "line",
      source: DRAWN_SOURCE,
      paint: {
        "line-color": "#ffffff",
        "line-width": 1.5,
        "line-dasharray": [3, 3],
      },
    });
  }
}

function rectangleFeatureCollection(
  a: [number, number],
  b: [number, number],
): FeatureCollection<Polygon> {
  const [x1, y1] = a;
  const [x2, y2] = b;
  const west = Math.min(x1, x2);
  const east = Math.max(x1, x2);
  const south = Math.min(y1, y2);
  const north = Math.max(y1, y2);
  const feature: Feature<Polygon> = {
    type: "Feature",
    properties: {},
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [west, south],
          [east, south],
          [east, north],
          [west, north],
          [west, south],
        ],
      ],
    },
  };
  return { type: "FeatureCollection", features: [feature] };
}
