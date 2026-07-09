/**
 * Reusable category-POI browse layer for a MapLibre map: a clustered GeoJSON
 * source, cream-circle category pins, and helpers to convert fetched POIs into
 * features. Route-free — the pins carry only `{ poiId, category, name, source }`
 * so a click can resolve back to the fetched `Poi` (via a by-id lookup the
 * caller keeps). Extracted from the planner's inline POI setup so /explore can
 * browse POIs by viewport without the route/waypoint coupling.
 */

import type {
  GeoJSONSource,
  Map as MapLibreMap,
  ExpressionSpecification,
} from "maplibre-gl";
import type { FeatureCollection, Point } from "geojson";
import { OSM_ATTRIBUTION } from "@/components/map/attribution";
import type { Poi, PoiCategory } from "@/lib/planner/types";

export const POI_SOURCE = "map-pois";
export const POI_CLUSTER_LAYER = "map-poi-clusters";
export const POI_CLUSTER_COUNT_LAYER = "map-poi-cluster-count";
export const POI_PIN_LAYER = "map-poi-pins";
const POI_PIN_IMAGE_PREFIX = "tarmoto-poi-pin-";

/** Properties carried on each POI pin feature. */
export interface PoiFeatureProps {
  poiId: string;
  category: PoiCategory;
  name: string;
  source: string;
}

/**
 * Lucide 24x24 icon geometry per category (same glyphs as the toolbar chips) —
 * rasterized into pin images so riders can tell WHAT a pin is before clicking.
 */
const POI_PIN_ICON_CHILDREN: Record<PoiCategory, string> = {
  fuel: '<path d="M14 13h2a2 2 0 0 1 2 2v2a2 2 0 0 0 4 0v-6.998a2 2 0 0 0-.59-1.42L18 5"/><path d="M14 21V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v16"/><path d="M2 21h13"/><path d="M3 9h11"/>',
  food: '<path d="m16 2-2.3 2.3a3 3 0 0 0 0 4.2l1.8 1.8a3 3 0 0 0 4.2 0L22 8"/><path d="M15 15 3.3 3.3a4.2 4.2 0 0 0 0 6l7.3 7.3c.7.7 2 .7 2.8 0L15 15Zm0 0 7 7"/><path d="m2.1 21.8 6.4-6.3"/><path d="m19 5-7 7"/>',
  cafe: '<path d="M10 2v2"/><path d="M14 2v2"/><path d="M16 8a1 1 0 0 1 1 1v8a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V9a1 1 0 0 1 1-1h14a4 4 0 1 1 0 8h-1"/><path d="M6 2v2"/>',
  viewpoint:
    '<path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/>',
  campground:
    '<path d="M3.5 21 14 3"/><path d="M20.5 21 10 3"/><path d="M15.5 21 12 15l-3.5 6"/><path d="M2 21h20"/>',
  biker_hotel:
    '<circle cx="18.5" cy="17.5" r="3.5"/><circle cx="5.5" cy="17.5" r="3.5"/><circle cx="15" cy="5" r="1"/><path d="M12 17.5V14l-3-3 4-3 2 3h2"/>',
  mountain_pass:
    '<path d="m8 3 4 8 5-5 5 15H2L8 3z"/><path d="M4.14 15.08c2.62-1.57 5.24-1.43 7.86.42 2.74 1.94 5.49 2 8.23.19"/>',
  // Design frame glyph — S-bends, not the lucide route icon.
  twisty_highlight:
    '<path d="M5 20c3 0 3-5 6-5s3 5 6 5M5 9c3 0 3-5 6-5s3 5 6 5"/>',
};

/** Rasterize a cream-circle + ink-glyph pin image per category. */
function installPoiPinImages(map: MapLibreMap): void {
  for (const [category, children] of Object.entries(POI_PIN_ICON_CHILDREN)) {
    const imageId = `${POI_PIN_IMAGE_PREFIX}${category}`;
    if (map.hasImage?.(imageId)) continue;
    // Unified pin language: cream circle + ink glyph and ring — except twisty
    // highlights, our derived layer, which invert to accent.
    const accent = category === "twisty_highlight";
    const fill = accent ? "#FF6A1A" : "#F5EFE6";
    const ring = accent ? "#F5EFE6" : "#0E0E10";
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="56" height="56" viewBox="0 0 56 56">' +
      `<circle cx="28" cy="28" r="24" fill="${fill}" stroke="${ring}" stroke-width="5"/>` +
      `<g transform="translate(15,15) scale(1.083)" fill="none" stroke="${ring}" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round">` +
      children +
      "</g></svg>";
    const image = new Image(56, 56);
    image.onload = () => {
      if (!map.hasImage?.(imageId)) {
        map.addImage(imageId, image, { pixelRatio: 2 });
      }
    };
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  }
}

/**
 * Register the clustered POI source + cluster/pin layers. `beforeId` slots them
 * under a given layer (e.g. route pins on the planner); omit it on maps with no
 * higher-priority markers so the pins sit on top.
 */
export function ensurePoiLayers(map: MapLibreMap, beforeId?: string): void {
  installPoiPinImages(map);
  const before = beforeId && map.getLayer(beforeId) ? beforeId : undefined;
  if (!map.getSource(POI_SOURCE)) {
    map.addSource(POI_SOURCE, {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
      cluster: true,
      clusterMaxZoom: 10,
      clusterRadius: 46,
      // ODbL: the browse POIs are OpenStreetMap data, so MapLibre's attribution
      // control credits OSM whenever the layer is present (same string as the
      // base-map credit → MapLibre dedupes it to one entry).
      attribution: OSM_ATTRIBUTION,
    });
  }
  if (!map.getLayer(POI_CLUSTER_LAYER)) {
    map.addLayer(
      {
        id: POI_CLUSTER_LAYER,
        type: "circle",
        source: POI_SOURCE,
        filter: ["has", "point_count"],
        paint: {
          "circle-color": "#FF6A1A",
          "circle-opacity": 0.9,
          "circle-radius": [
            "step",
            ["get", "point_count"],
            13,
            5,
            16,
            15,
            20,
          ] as ExpressionSpecification,
          "circle-stroke-color": "#F5EFE6",
          "circle-stroke-width": 2,
        },
      },
      before,
    );
  }
  if (!map.getLayer(POI_CLUSTER_COUNT_LAYER)) {
    map.addLayer(
      {
        id: POI_CLUSTER_COUNT_LAYER,
        type: "symbol",
        source: POI_SOURCE,
        filter: ["has", "point_count"],
        layout: {
          "text-field": ["get", "point_count_abbreviated"],
          "text-size": 11,
          "text-font": ["Noto Sans Regular"],
        },
        paint: { "text-color": "#F5EFE6" },
      },
      before,
    );
  }
  if (!map.getLayer(POI_PIN_LAYER)) {
    map.addLayer(
      {
        id: POI_PIN_LAYER,
        type: "symbol",
        source: POI_SOURCE,
        filter: ["!", ["has", "point_count"]],
        layout: {
          "icon-image": [
            "concat",
            POI_PIN_IMAGE_PREFIX,
            ["get", "category"],
          ] as ExpressionSpecification,
          "icon-size": 1,
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
        },
      },
      before,
    );
  }
}

/** Build the pin FeatureCollection for the POI source from fetched POIs. */
export function poisToFeatureCollection(
  pois: readonly Poi[],
): FeatureCollection<Point, PoiFeatureProps> {
  return {
    type: "FeatureCollection",
    features: pois.map((poi) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [poi.lng, poi.lat] },
      properties: {
        poiId: poi.id,
        category: poi.category,
        name: poi.name,
        source: poi.source,
      },
    })),
  };
}

/** Replace the POI source's features (no-op if the source isn't ready). */
export function setPoiSourceData(map: MapLibreMap, pois: readonly Poi[]): void {
  const source = map.getSource(POI_SOURCE) as GeoJSONSource | undefined;
  source?.setData(poisToFeatureCollection(pois));
}
