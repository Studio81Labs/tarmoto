import type { GeoJSONSource, Map as MapLibreMap } from "maplibre-gl";
import type { ExpressionSpecification } from "@/lib/maplibre-expression";
import type { Feature, FeatureCollection, Polygon } from "geojson";
import type { FunZoneListItem } from "@/lib/discover";

export const FUN_ZONES_SOURCE = "fun-zones-src";
export const FUN_ZONES_FILL = "fun-zones-fill";
export const FUN_ZONES_LINE = "fun-zones-line";
export const FUN_ZONES_SELECTED = "fun-zones-selected";
export const FUN_ZONES_LABEL = "fun-zones-label";

export interface FunZoneFeatureProps {
  id: string;
  composite_score: number;
  rank: number;
  name: string | null;
}

const EMPTY: FeatureCollection<Polygon, FunZoneFeatureProps> = {
  type: "FeatureCollection",
  features: [],
};

/**
 * Installs the Fun Zone GeoJSON source + fill/line/label layers on `map`.
 * Idempotent: no-ops when the source already exists.
 */
export function installFunZoneLayer(map: MapLibreMap): void {
  if (map.getSource(FUN_ZONES_SOURCE)) return;

  map.addSource(FUN_ZONES_SOURCE, {
    type: "geojson",
    data: EMPTY,
  });

  // Fill: opacity low so underlying quality heatmap stays visible. Color
  // ramps from a muted warm grey (low score) to canonical accent (high) so
  // the best zones pop visually against the light basemap.
  map.addLayer({
    id: FUN_ZONES_FILL,
    type: "fill",
    source: FUN_ZONES_SOURCE,
    paint: {
      "fill-color": buildCompositeScoreColor(),
      "fill-opacity": 0.25,
    },
  });

  map.addLayer({
    id: FUN_ZONES_LINE,
    type: "line",
    source: FUN_ZONES_SOURCE,
    paint: {
      "line-color": buildCompositeScoreColor(),
      "line-width": 1.5,
      "line-opacity": 0.8,
    },
  });

  // Selected zone: thicker cyan outline, filtered via the `id` property.
  // Filter is set to a non-matching id at install and swapped when the
  // selection changes.
  map.addLayer({
    id: FUN_ZONES_SELECTED,
    type: "line",
    source: FUN_ZONES_SOURCE,
    filter: ["==", ["get", "id"], "__none__"],
    paint: {
      "line-color": "#0ED3CF",
      "line-width": 3,
      "line-opacity": 1,
    },
  });

  map.addLayer({
    id: FUN_ZONES_LABEL,
    type: "symbol",
    source: FUN_ZONES_SOURCE,
    layout: {
      "text-field": ["to-string", ["get", "rank"]],
      "text-font": [
        "Noto Sans Bold",
        "Open Sans Bold",
        "Arial Unicode MS Bold",
      ],
      "text-size": 14,
      "text-allow-overlap": true,
    },
    paint: {
      "text-color": "#ffffff",
      "text-halo-color": "#0e0e10", // ink — reads on the light basemap
      "text-halo-width": 1.5,
    },
  });
}

const FUN_ZONE_LAYERS = [
  FUN_ZONES_FILL,
  FUN_ZONES_LINE,
  FUN_ZONES_SELECTED,
  FUN_ZONES_LABEL,
] as const;

/** Toggles all Fun Zone layers' visibility (source data stays loaded). */
export function setFunZoneLayersVisible(
  map: MapLibreMap,
  visible: boolean,
): void {
  for (const id of FUN_ZONE_LAYERS) {
    if (!map.getLayer(id)) continue;
    map.setLayoutProperty(id, "visibility", visible ? "visible" : "none");
  }
}

/**
 * Replaces the GeoJSON source data with freshly-ranked features. Ranks are
 * assigned by the caller's sort order (highest composite_score first).
 */
export function updateFunZoneLayerData(
  map: MapLibreMap,
  zones: FunZoneListItem[],
): void {
  const src = map.getSource(FUN_ZONES_SOURCE) as GeoJSONSource | undefined;
  if (!src) return;
  const features: Feature<Polygon, FunZoneFeatureProps>[] = zones.map(
    (zone, i) => ({
      // OpenAPI generation currently types `boundary` as `Record<string, never>[]`
      // even though the runtime payload is `{ lat, lng }[]`.
      // Cast once here so the geometry mapping stays explicit.
      type: "Feature",
      id: zone.id,
      geometry: {
        type: "Polygon",
        coordinates: [
          (zone.boundary as unknown as Array<{ lng: number; lat: number }>).map(
            (point) => [point.lng, point.lat],
          ),
        ],
      },
      properties: {
        id: zone.id,
        composite_score: zone.composite_score,
        rank: i + 1,
        name: zone.name ?? null,
      },
    }),
  );
  src.setData({ type: "FeatureCollection", features });
}

/**
 * Updates the `fun-zones-selected` layer filter so the outline highlights
 * the chosen zone. Pass null to clear the highlight.
 */
export function setFunZoneSelection(
  map: MapLibreMap,
  zoneId: string | null,
): void {
  if (!map.getLayer(FUN_ZONES_SELECTED)) return;
  map.setFilter(FUN_ZONES_SELECTED, [
    "==",
    ["get", "id"],
    zoneId ?? "__none__",
  ]);
}

function buildCompositeScoreColor(): ExpressionSpecification {
  return [
    "interpolate",
    ["linear"],
    ["get", "composite_score"],
    0,
    "#8a877e", // muted warm grey (low score) — legible on the light basemap
    5,
    "#FF6A1A", // canonical accent (high score)
  ];
}
