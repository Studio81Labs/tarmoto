import type { Map as MapLibreMap } from "maplibre-gl";
import { AERIAL_ATTRIBUTION, AERIAL_TILES_URL } from "@/lib/config";

export const AERIAL_SOURCE = "planner-aerial";
export const AERIAL_LAYER = "planner-aerial";

/**
 * Aerial (orthophoto) basemap for the planner's [Map | Aerial] toggle.
 * A raster layer slotted UNDER every planner overlay so the
 * quality-colored route line, waypoints, and markers stay on top. Hidden
 * by default; `setAerialBasemapVisible` flips it. The tile template and
 * "© ČÚZK" attribution come from config (env-overridable) — MapLibre
 * surfaces the attribution automatically while the layer is visible.
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
