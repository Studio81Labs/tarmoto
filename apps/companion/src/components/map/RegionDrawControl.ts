import type {
  GeoJSONSource,
  Map as MapLibreMap,
  MapMouseEvent,
} from "maplibre-gl";
import type { Feature, FeatureCollection, Point, Polygon } from "geojson";

const PREVIEW_SOURCE = "region-preview-src";
const DRAWN_SOURCE = "region-drawn-src";
const HANDLES_SOURCE = "region-handles-src";
const PREVIEW_FILL = "region-preview-fill";
const PREVIEW_LINE = "region-preview-line";
const DRAWN_FILL = "region-drawn-fill";
const DRAWN_LINE = "region-drawn-line";
const HANDLES_LAYER = "region-handles";

const MIN_BBOX_DEGREES = 0.0001;
// Pixel radius for handle hit-testing. Slightly larger than the painted
// circle so the affordance is forgiving on touch and high-DPI displays.
const HANDLE_HIT_PIXELS = 10;

const EMPTY_POLY: FeatureCollection<Polygon> = {
  type: "FeatureCollection",
  features: [],
};
const EMPTY_PT: FeatureCollection<Point, HandleProps> = {
  type: "FeatureCollection",
  features: [],
};

export type RegionDrawBbox = [number, number, number, number];

export type RegionDrawMode = "idle" | "drawing" | "editing";

export type RegionHandle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

interface HandleProps {
  handle: RegionHandle;
}

export interface RegionDrawControl {
  start(): void;
  cancel(): void;
  clearDrawn(): void;
  setDrawn(bbox: RegionDrawBbox | null): void;
  destroy(): void;
  getMode(): RegionDrawMode;
  /**
   * Returns true if the given map pixel point currently overlaps the
   * drawn region (including its edit handles). Used by the consumer to
   * suppress map-level click handlers that would otherwise add a
   * waypoint when the rider just selected the region.
   */
  hitTest(point: { x: number; y: number }): boolean;
}

interface Options {
  onRegionDrawn: (bbox: RegionDrawBbox) => void;
  onRegionCleared?: () => void;
  onModeChange?: (mode: RegionDrawMode) => void;
}

type DragKind = "create" | "move" | RegionHandle;

export function createRegionDrawControl(
  map: MapLibreMap,
  opts: Options,
): RegionDrawControl {
  installSourcesAndLayers(map);

  let mode: RegionDrawMode = "idle";
  let drawnBbox: RegionDrawBbox | null = null;
  let dragKind: DragKind | null = null;
  let dragStartLngLat: [number, number] | null = null;
  let bboxAtDragStart: RegionDrawBbox | null = null;
  let bboxChangedDuringDrag = false;
  let wasDragPanEnabled = true;

  const previewSrc = map.getSource(PREVIEW_SOURCE) as GeoJSONSource | undefined;
  const drawnSrc = map.getSource(DRAWN_SOURCE) as GeoJSONSource | undefined;
  const handlesSrc = map.getSource(HANDLES_SOURCE) as GeoJSONSource | undefined;

  function setMode(next: RegionDrawMode) {
    if (mode === next) return;
    mode = next;
    opts.onModeChange?.(next);
  }

  function paintBbox(bbox: RegionDrawBbox | null) {
    if (!drawnSrc || !handlesSrc) return;
    if (!bbox) {
      drawnSrc.setData(EMPTY_POLY);
      handlesSrc.setData(EMPTY_PT);
      return;
    }
    drawnSrc.setData(
      rectangleFeatureCollection([bbox[0], bbox[1]], [bbox[2], bbox[3]]),
    );
    handlesSrc.setData(handleFeatureCollection(bbox));
  }

  function onDown(e: MapMouseEvent) {
    if (mode === "drawing") {
      e.preventDefault();
      dragKind = "create";
      dragStartLngLat = [e.lngLat.lng, e.lngLat.lat];
      bboxChangedDuringDrag = false;
      return;
    }

    if (mode !== "idle" || !drawnBbox) return;

    const handle = hitHandle(map, e.point, drawnBbox);
    if (handle) {
      e.preventDefault();
      dragKind = handle;
      dragStartLngLat = [e.lngLat.lng, e.lngLat.lat];
      bboxAtDragStart = [...drawnBbox] as RegionDrawBbox;
      bboxChangedDuringDrag = false;
      enterEditMode();
      return;
    }

    if (insideBbox([e.lngLat.lng, e.lngLat.lat], drawnBbox)) {
      e.preventDefault();
      dragKind = "move";
      dragStartLngLat = [e.lngLat.lng, e.lngLat.lat];
      bboxAtDragStart = [...drawnBbox] as RegionDrawBbox;
      bboxChangedDuringDrag = false;
      enterEditMode();
      return;
    }
  }

  function onMove(e: MapMouseEvent) {
    if (!dragKind) {
      // Mouse is hovering: keep the cursor in sync with the affordance
      // under the pointer so riders can tell handles apart from the body.
      if (mode === "idle" && drawnBbox) {
        const handle = hitHandle(map, e.point, drawnBbox);
        const cursor = handle
          ? handleCursor(handle)
          : insideBbox([e.lngLat.lng, e.lngLat.lat], drawnBbox)
            ? "move"
            : "";
        if (map.getCanvas().style.cursor !== cursor) {
          map.getCanvas().style.cursor = cursor;
        }
      }
      return;
    }

    if (dragKind === "create") {
      if (!dragStartLngLat || !previewSrc) return;
      previewSrc.setData(
        rectangleFeatureCollection(dragStartLngLat, [
          e.lngLat.lng,
          e.lngLat.lat,
        ]),
      );
      return;
    }

    if (!bboxAtDragStart || !dragStartLngLat) return;
    const dx = e.lngLat.lng - dragStartLngLat[0];
    const dy = e.lngLat.lat - dragStartLngLat[1];
    const next =
      dragKind === "move"
        ? translateBbox(bboxAtDragStart, dx, dy)
        : applyResize(bboxAtDragStart, dragKind, dx, dy);
    drawnBbox = normalizeBbox(next);
    bboxChangedDuringDrag = true;
    paintBbox(drawnBbox);
  }

  function onUp(e: MapMouseEvent) {
    if (!dragKind) return;

    if (dragKind === "create") {
      const start = dragStartLngLat;
      dragStartLngLat = null;
      dragKind = null;
      if (!start) {
        previewSrc?.setData(EMPTY_POLY);
        exitDrawMode();
        return;
      }
      const [x1, y1] = start;
      const x2 = e.lngLat.lng;
      const y2 = e.lngLat.lat;
      previewSrc?.setData(EMPTY_POLY);
      if (
        Math.abs(x2 - x1) < MIN_BBOX_DEGREES ||
        Math.abs(y2 - y1) < MIN_BBOX_DEGREES
      ) {
        exitDrawMode();
        return;
      }
      const bbox: RegionDrawBbox = [
        Math.min(x1, x2),
        Math.min(y1, y2),
        Math.max(x1, x2),
        Math.max(y1, y2),
      ];
      drawnBbox = bbox;
      paintBbox(drawnBbox);
      exitDrawMode();
      opts.onRegionDrawn(bbox);
      return;
    }

    // move or resize finishing
    const changed = bboxChangedDuringDrag;
    dragStartLngLat = null;
    bboxAtDragStart = null;
    dragKind = null;
    bboxChangedDuringDrag = false;
    exitEditMode();
    if (changed && drawnBbox) {
      opts.onRegionDrawn(drawnBbox);
    }
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

  function enterEditMode() {
    wasDragPanEnabled = map.dragPan.isEnabled();
    map.dragPan.disable();
    setMode("editing");
  }

  function exitEditMode() {
    if (wasDragPanEnabled) map.dragPan.enable();
    map.getCanvas().style.cursor = "";
    setMode("idle");
  }

  map.on("mousedown", onDown);
  map.on("mousemove", onMove);
  map.on("mouseup", onUp);

  return {
    start() {
      // Only enter draw mode from idle. Re-entering from `editing`
      // would clobber `wasDragPanEnabled` (already false from the
      // active edit drag), so the drag's mouseup would never restore
      // dragPan and the map would become un-pannable.
      if (mode !== "idle") return;
      enterDrawMode();
    },
    cancel() {
      previewSrc?.setData(EMPTY_POLY);
      dragStartLngLat = null;
      bboxAtDragStart = null;
      dragKind = null;
      bboxChangedDuringDrag = false;
      if (mode === "drawing") exitDrawMode();
      else if (mode === "editing") exitEditMode();
    },
    clearDrawn() {
      // Cancel any in-flight drag before nulling the bbox: otherwise
      // the next mousemove would resurrect the region from the stale
      // `bboxAtDragStart` and emit a stale `onRegionDrawn` on mouseup.
      dragStartLngLat = null;
      bboxAtDragStart = null;
      dragKind = null;
      bboxChangedDuringDrag = false;
      previewSrc?.setData(EMPTY_POLY);
      if (mode === "drawing") exitDrawMode();
      else if (mode === "editing") exitEditMode();
      drawnBbox = null;
      paintBbox(null);
      opts.onRegionCleared?.();
    },
    setDrawn(bbox) {
      drawnBbox = bbox ? (normalizeBbox([...bbox]) as RegionDrawBbox) : null;
      paintBbox(drawnBbox);
    },
    destroy() {
      map.off("mousedown", onDown);
      map.off("mousemove", onMove);
      map.off("mouseup", onUp);
      for (const id of [
        PREVIEW_FILL,
        PREVIEW_LINE,
        DRAWN_FILL,
        DRAWN_LINE,
        HANDLES_LAYER,
      ]) {
        if (map.getLayer(id)) map.removeLayer(id);
      }
      for (const id of [PREVIEW_SOURCE, DRAWN_SOURCE, HANDLES_SOURCE]) {
        if (map.getSource(id)) map.removeSource(id);
      }
    },
    getMode() {
      return mode;
    },
    hitTest(point) {
      if (!drawnBbox) return false;
      if (hitHandle(map, point, drawnBbox)) return true;
      try {
        const hits = map.queryRenderedFeatures(
          [
            [point.x - 1, point.y - 1],
            [point.x + 1, point.y + 1],
          ],
          { layers: [DRAWN_FILL] },
        );
        return hits.length > 0;
      } catch {
        return false;
      }
    },
  };
}

function installSourcesAndLayers(map: MapLibreMap): void {
  if (!map.getSource(PREVIEW_SOURCE)) {
    map.addSource(PREVIEW_SOURCE, { type: "geojson", data: EMPTY_POLY });
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
    map.addSource(DRAWN_SOURCE, { type: "geojson", data: EMPTY_POLY });
    map.addLayer({
      id: DRAWN_FILL,
      type: "fill",
      source: DRAWN_SOURCE,
      paint: { "fill-color": "#0ED3CF", "fill-opacity": 0.08 },
    });
    map.addLayer({
      id: DRAWN_LINE,
      type: "line",
      source: DRAWN_SOURCE,
      paint: {
        "line-color": "#0ED3CF",
        "line-width": 2,
        "line-dasharray": [3, 3],
      },
    });
  }
  if (!map.getSource(HANDLES_SOURCE)) {
    map.addSource(HANDLES_SOURCE, { type: "geojson", data: EMPTY_PT });
    map.addLayer({
      id: HANDLES_LAYER,
      type: "circle",
      source: HANDLES_SOURCE,
      paint: {
        "circle-radius": 6,
        "circle-color": "#0ED3CF",
        "circle-stroke-color": "#020617",
        "circle-stroke-width": 2,
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

function handleFeatureCollection(
  bbox: RegionDrawBbox,
): FeatureCollection<Point, HandleProps> {
  const positions = handlePositions(bbox);
  return {
    type: "FeatureCollection",
    features: (Object.keys(positions) as RegionHandle[]).map((handle) => ({
      type: "Feature",
      properties: { handle },
      geometry: { type: "Point", coordinates: positions[handle] },
    })),
  };
}

function handlePositions(
  bbox: RegionDrawBbox,
): Record<RegionHandle, [number, number]> {
  const [west, south, east, north] = bbox;
  const cx = (west + east) / 2;
  const cy = (south + north) / 2;
  return {
    nw: [west, north],
    n: [cx, north],
    ne: [east, north],
    e: [east, cy],
    se: [east, south],
    s: [cx, south],
    sw: [west, south],
    w: [west, cy],
  };
}

function hitHandle(
  map: MapLibreMap,
  point: { x: number; y: number },
  bbox: RegionDrawBbox,
): RegionHandle | null {
  const positions = handlePositions(bbox);
  let bestHandle: RegionHandle | null = null;
  let bestDist = HANDLE_HIT_PIXELS * HANDLE_HIT_PIXELS;
  for (const handle of Object.keys(positions) as RegionHandle[]) {
    const [lng, lat] = positions[handle];
    const projected = map.project([lng, lat]);
    const dx = projected.x - point.x;
    const dy = projected.y - point.y;
    const distSq = dx * dx + dy * dy;
    if (distSq <= bestDist) {
      bestDist = distSq;
      bestHandle = handle;
    }
  }
  return bestHandle;
}

function insideBbox(point: [number, number], bbox: RegionDrawBbox): boolean {
  const [west, south, east, north] = bbox;
  return (
    point[0] >= west &&
    point[0] <= east &&
    point[1] >= south &&
    point[1] <= north
  );
}

function translateBbox(
  bbox: RegionDrawBbox,
  dx: number,
  dy: number,
): RegionDrawBbox {
  return [bbox[0] + dx, bbox[1] + dy, bbox[2] + dx, bbox[3] + dy];
}

function applyResize(
  bbox: RegionDrawBbox,
  handle: RegionHandle,
  dx: number,
  dy: number,
): RegionDrawBbox {
  let [west, south, east, north] = bbox;
  if (handle.includes("w")) west += dx;
  if (handle.includes("e")) east += dx;
  if (handle.includes("n")) north += dy;
  if (handle.includes("s")) south += dy;
  return [west, south, east, north];
}

function normalizeBbox(bbox: number[]): RegionDrawBbox {
  const [a, b, c, d] = bbox;
  const west = Math.min(a, c);
  let east = Math.max(a, c);
  const south = Math.min(b, d);
  let north = Math.max(b, d);
  // Guarantee a non-degenerate rectangle so resize handles can never
  // collapse the region into a line.
  if (east - west < MIN_BBOX_DEGREES) east = west + MIN_BBOX_DEGREES;
  if (north - south < MIN_BBOX_DEGREES) north = south + MIN_BBOX_DEGREES;
  return [west, south, east, north];
}

function handleCursor(handle: RegionHandle): string {
  switch (handle) {
    case "n":
    case "s":
      return "ns-resize";
    case "e":
    case "w":
      return "ew-resize";
    case "ne":
    case "sw":
      return "nesw-resize";
    case "nw":
    case "se":
      return "nwse-resize";
  }
}
