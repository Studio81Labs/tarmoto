/**
 * Reusable condition (closure + pass) marker layer for a MapLibre map: a
 * closure line plus rotated-square "diamond" markers for closures and
 * (non-open) passes, zoom-gated so they don't clutter at country zoom.
 * Extracted from the trip planner so every map surface can show conditions.
 * The caller owns the fetch → collection building and the marker click handlers
 * (which open the shared MapPointPopover); this module owns the sources, the
 * layers, their visibility, and the diamond pin images.
 */

import type { GeoJSONSource, Map as MapLibreMap } from "maplibre-gl";
import type { ExpressionSpecification } from "@/lib/maplibre-expression";
import type { FeatureCollection } from "geojson";
import { CONDITION_COLORS, type ConditionKind } from "@/lib/conditions-visual";
import type { PlannerClosure } from "@/lib/closures-summary";
import type { MountainPass } from "@/lib/passes-summary";
import {
  buildPlannerClosureLineCollection,
  buildPlannerClosureMarkerCollection,
  buildPlannerPassMarkerCollection,
} from "@/lib/trip-planner-overlays";

export const CLOSURE_LINE_SOURCE = "trip-planner-closure-lines";
export const CLOSURE_MARKER_SOURCE = "trip-planner-closure-markers";
export const PASS_MARKER_SOURCE = "trip-planner-pass-markers";
export const CLOSURE_LINE_LAYER = "trip-planner-closure-lines";
export const CLOSURE_MARKER_LAYER = "trip-planner-closure-markers";
export const PASS_MARKER_LAYER = "trip-planner-pass-markers";

/** Country zoom hides individual markers (revision 7). */
const CONDITION_MARKER_MINZOOM = 7;
const CONDITION_IMAGE_PREFIX = "tarmoto-condition-";

const EMPTY: FeatureCollection = { type: "FeatureCollection", features: [] };

/**
 * Diamond icon badges, deliberately OFF the road-quality palette so a closed
 * road never reads as a "red quality" line: crimson closures, amber roadworks,
 * slate/blue mountain passes.
 */
const CONDITION_BADGES: Record<
  ConditionKind,
  { color: string; glyph: string }
> = {
  "closure-full": {
    color: CONDITION_COLORS["closure-full"],
    glyph: '<circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8"/>',
  },
  "closure-partial": {
    color: CONDITION_COLORS["closure-partial"],
    glyph: '<path d="M12 2 2 20h20z"/><path d="M12 9v5M12 17h.01"/>',
  },
  roadworks: {
    color: CONDITION_COLORS.roadworks,
    glyph:
      '<path d="M10 2v2M14 2v2M3 22l4-11h10l4 11M8.5 11l-2 11M15.5 11l2 11M6 16h12"/>',
  },
  pass: {
    color: CONDITION_COLORS.pass,
    glyph: '<path d="m3 20 6-10 4 5 3-4 5 9z"/>',
  },
};

/** Rasterize the diamond badge images (async; jsdom renders none). */
function installConditionImages(map: MapLibreMap): void {
  for (const [key, badge] of Object.entries(CONDITION_BADGES)) {
    const imageId = `${CONDITION_IMAGE_PREFIX}${key}`;
    if (map.hasImage?.(imageId)) continue;
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="60" height="60" viewBox="0 0 60 60">' +
      `<rect x="12" y="12" width="36" height="36" rx="9" transform="rotate(45 30 30)" fill="#F5EFE6" stroke="${badge.color}" stroke-width="4"/>` +
      `<g transform="translate(21,21) scale(0.75)" fill="none" stroke="${badge.color}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">` +
      badge.glyph +
      "</g></svg>";
    const image = new Image(60, 60);
    image.onload = () => {
      if (!map.hasImage?.(imageId)) {
        map.addImage(imageId, image, { pixelRatio: 2 });
      }
    };
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  }
}

/**
 * Register the closure line + closure/pass marker sources and layers (once).
 * `beforeId` slots them under a given layer (e.g. route pins on the planner);
 * omit it on maps with no higher-priority markers.
 */
export function ensureConditionLayers(
  map: MapLibreMap,
  beforeId?: string,
  options?: {
    /**
     * Include open passes in the pass marker layer. Default off — the planner
     * keeps its ambient-awareness view (only passes you might not clear). The
     * explorer opts in so every listed pass is a marker you can focus.
     */
    includeOpenPasses?: boolean;
  },
): void {
  installConditionImages(map);
  const before = beforeId && map.getLayer(beforeId) ? beforeId : undefined;
  if (!map.getSource(CLOSURE_LINE_SOURCE)) {
    map.addSource(CLOSURE_LINE_SOURCE, { type: "geojson", data: EMPTY });
  }
  if (!map.getLayer(CLOSURE_LINE_LAYER)) {
    map.addLayer(
      {
        id: CLOSURE_LINE_LAYER,
        type: "line",
        source: CLOSURE_LINE_SOURCE,
        paint: {
          "line-color": [
            "match",
            ["get", "severity"],
            "full",
            "#FB7185",
            "partial",
            "#FBBF24",
            "#38BDF8",
          ] as ExpressionSpecification,
          "line-width": [
            "interpolate",
            ["linear"],
            ["zoom"],
            7,
            2,
            11,
            4,
            14,
            6,
          ] as ExpressionSpecification,
          "line-opacity": 0.85,
        },
      },
      before,
    );
  }
  if (!map.getSource(CLOSURE_MARKER_SOURCE)) {
    map.addSource(CLOSURE_MARKER_SOURCE, { type: "geojson", data: EMPTY });
  }
  if (!map.getLayer(CLOSURE_MARKER_LAYER)) {
    map.addLayer(
      {
        id: CLOSURE_MARKER_LAYER,
        type: "symbol",
        source: CLOSURE_MARKER_SOURCE,
        minzoom: CONDITION_MARKER_MINZOOM,
        layout: {
          "icon-image": [
            "case",
            ["==", ["get", "severity"], "full"],
            `${CONDITION_IMAGE_PREFIX}closure-full`,
            ["==", ["get", "reason"], "roadworks"],
            `${CONDITION_IMAGE_PREFIX}roadworks`,
            `${CONDITION_IMAGE_PREFIX}closure-partial`,
          ] as ExpressionSpecification,
          "icon-size": 1,
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
        },
      },
      before,
    );
  }
  if (!map.getSource(PASS_MARKER_SOURCE)) {
    map.addSource(PASS_MARKER_SOURCE, { type: "geojson", data: EMPTY });
  }
  if (!map.getLayer(PASS_MARKER_LAYER)) {
    map.addLayer(
      {
        id: PASS_MARKER_LAYER,
        type: "symbol",
        source: PASS_MARKER_SOURCE,
        minzoom: CONDITION_MARKER_MINZOOM,
        // Ambient awareness cares about passes you might NOT clear — open
        // passes stay off the map (revision 7), unless the caller opts them in
        // (the explorer, so every listed pass is focusable).
        ...(options?.includeOpenPasses
          ? {}
          : { filter: ["!=", ["get", "status"], "open"] as const }),
        layout: {
          "icon-image": `${CONDITION_IMAGE_PREFIX}pass`,
          "icon-size": 1,
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
        },
      },
      before,
    );
  }
}

/**
 * Replace the three condition sources' features from raw closures + passes
 * (no-op per source that isn't ready). Mirrors `setHazardSourceData` so a
 * caller only owns the fetch, not the GeoJSON projection — the planner keeps
 * its own memoised `syncGeoJsonSource` wiring; the explorer uses this.
 */
export function setConditionSourceData(
  map: MapLibreMap,
  {
    closures,
    passes,
  }: { closures: readonly PlannerClosure[]; passes: readonly MountainPass[] },
): void {
  const line = map.getSource(CLOSURE_LINE_SOURCE) as GeoJSONSource | undefined;
  line?.setData(buildPlannerClosureLineCollection(closures));
  const marker = map.getSource(CLOSURE_MARKER_SOURCE) as
    GeoJSONSource | undefined;
  marker?.setData(buildPlannerClosureMarkerCollection(closures));
  const pass = map.getSource(PASS_MARKER_SOURCE) as GeoJSONSource | undefined;
  pass?.setData(buildPlannerPassMarkerCollection(passes));
}

/** Toggle every condition layer's visibility. */
export function setConditionLayersVisible(
  map: MapLibreMap,
  visible: boolean,
): void {
  for (const id of [
    CLOSURE_LINE_LAYER,
    CLOSURE_MARKER_LAYER,
    PASS_MARKER_LAYER,
  ]) {
    if (map.getLayer(id)) {
      map.setLayoutProperty(id, "visibility", visible ? "visible" : "none");
    }
  }
}
