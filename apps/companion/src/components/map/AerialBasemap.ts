import type { Map as MapLibreMap } from "maplibre-gl";
import { AERIAL_ATTRIBUTION, AERIAL_TILES_URL } from "@/lib/config";

export const AERIAL_SOURCE = "planner-aerial";
export const AERIAL_LAYER = "planner-aerial";

/**
 * First symbol layer in the active style — the base map's labels + POIs begin
 * here (roads/fills/buildings come before it). Slotting the aerial raster BELOW
 * this keeps those labels and OSM POI icons visible over the imagery (a
 * hybrid "aerial with labels") while the vector ground is covered.
 */
export function firstSymbolLayerId(map: MapLibreMap): string | undefined {
  return map.getStyle?.()?.layers?.find((layer) => layer.type === "symbol")?.id;
}

/**
 * Aerial (orthophoto) basemap for the [Map | Aerial] toggle. A raster layer
 * slotted under our overlays (route line, waypoints, markers) so they stay on
 * top. Pass {@link firstSymbolLayerId} as `beforeLayerId` to keep the base
 * map's labels + OSM POI icons visible over the imagery. Hidden by default;
 * `setAerialBasemapVisible` flips it. The tile template and "© ČÚZK"
 * attribution come from config (env-overridable) — MapLibre surfaces the
 * attribution automatically while the layer is visible.
 */
export function ensureAerialBasemap(
  map: MapLibreMap,
  beforeLayerId?: string,
): void {
  if (!map.getSource(AERIAL_SOURCE)) {
    map.addSource(AERIAL_SOURCE, {
      type: "raster",
      tiles: [AERIAL_TILES_URL],
      tileSize: 256,
      attribution: AERIAL_ATTRIBUTION,
    });
  }
  if (!map.getLayer(AERIAL_LAYER)) {
    map.addLayer(
      {
        id: AERIAL_LAYER,
        type: "raster",
        source: AERIAL_SOURCE,
        layout: { visibility: "none" },
        paint: { "raster-opacity": 1 },
      },
      beforeLayerId && map.getLayer(beforeLayerId) ? beforeLayerId : undefined,
    );
  }
}

export function setAerialBasemapVisible(
  map: MapLibreMap,
  visible: boolean,
): void {
  if (!map.getLayer(AERIAL_LAYER)) return;
  map.setLayoutProperty(
    AERIAL_LAYER,
    "visibility",
    visible ? "visible" : "none",
  );
}
