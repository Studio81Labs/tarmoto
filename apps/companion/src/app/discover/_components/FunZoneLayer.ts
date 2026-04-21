import type {
  ExpressionSpecification,
  GeoJSONSource,
  Map as MapLibreMap,
} from "maplibre-gl";
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
  // ramps from slate-800 (low score) to tarmoto-cyan (high) so the best
  // zones pop visually.
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
      "text-halo-color": "#0f172a",
      "text-halo-width": 1.5,
    },
  });
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
      type: "Feature",
      id: zone.id,
      geometry: {
        type: "Polygon",
        coordinates: [
          zone.boundary.map((p) => [p.lng, p.lat] as [number, number]),
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
    "#1e293b", // slate-800 (low score)
    5,
    "#0ED3CF", // tarmoto-cyan (high score)
  ];
}
