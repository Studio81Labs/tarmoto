/**
 * Pure helpers for MapScreen — kept separate so they're unit-testable
 * without pulling in MapLibre's native bindings (which explode in Jest).
 *
 * Scope:
 *   - `getQualityTileUrlTemplate` — builds the xyz template that MapLibre
 *     interpolates into actual tile requests.
 *   - `qualityLineStyle` — MapLibre style expression mapping
 *     `quality_score` (1..5) → color buckets and zoom → line width.
 *   - `DEV_MAP_STYLE_URL` — default basemap until the Tarmoto style ships.
 */

import type {
  CircleLayerStyle,
  LineLayerStyle,
} from "@maplibre/maplibre-react-native";
import { API_BASE_URL } from "@/config";
import { colors } from "@/theme";
import type { MountainPass, PassStatus } from "@/types";

/**
 * Return the MapLibre xyz tile URL template for the road-quality MVT layer.
 * MapLibre substitutes `{z}/{x}/{y}` at fetch time; we keep the query string
 * on the end so only the quality layer is decoded on the wire.
 *
 * The `apiBase` argument defaults to the shared `API_BASE_URL` so production
 * code never specifies it — the parameter only exists so unit tests can
 * assert both dev and prod without mocking `__DEV__`.
 */
export function getQualityTileUrlTemplate(
  apiBase: string = API_BASE_URL,
): string {
  return `${apiBase}/roads/tiles/{z}/{x}/{y}.mvt?layers=quality`;
}

/**
 * Fallback basemap style. The Tarmoto-branded style lives at
 * `MAP_STYLE_URL` (see `.env.example`) but isn't deployed yet — falling
 * back to MapLibre's public demo tiles keeps the map rendering during
 * development without blocking this feature on infra work.
 */
export const DEV_MAP_STYLE_URL = "https://demotiles.maplibre.org/style.json";

/**
 * Quality-score bucket boundaries. Mirror theme.qualityColor()'s half-point
 * thresholds so the overlay colour matches every other surface in the app
 * (segment cards, commute card, ride active screen).
 */
export const QUALITY_STEP_BREAKS = [1.5, 2.5, 3.5, 4.5] as const;

/**
 * MapLibre `LineLayer` style for the road-quality overlay.
 *
 * `lineColor` — `step` expression keyed on `quality_score`. The first
 *   argument is the "below 1.5" default (Very Poor); each subsequent pair
 *   is `(threshold, color)`.
 *
 * `lineWidth` — `interpolate` on `zoom` so roads stay legible from country
 *   view (z8) all the way to street level (z20). US-1 AC: "Quality shown at
 *   all zoom levels".
 *
 * `lineOpacity` — fade segments with low `confidence` so sparse data
 *   doesn't pretend to be authoritative. `confidence` arrives from the
 *   backend on a 0-100 integer scale (see
 *   `apps/backend/.../road-segment.dto.ts`, "0-100, based on number of
 *   readings"), not 0-1 — so the interpolation stops match that range.
 */
export const qualityLineStyle: LineLayerStyle = {
  lineColor: [
    "step",
    ["get", "quality_score"],
    colors.quality.veryPoor,
    QUALITY_STEP_BREAKS[0],
    colors.quality.poor,
    QUALITY_STEP_BREAKS[1],
    colors.quality.fair,
    QUALITY_STEP_BREAKS[2],
    colors.quality.good,
    QUALITY_STEP_BREAKS[3],
    colors.quality.excellent,
  ],
  lineWidth: [
    "interpolate",
    ["linear"],
    ["zoom"],
    8,
    1.5,
    12,
    2.5,
    16,
    5,
    20,
    8,
  ],
  lineCap: "round",
  lineJoin: "round",
  lineOpacity: [
    "interpolate",
    ["linear"],
    ["get", "confidence"],
    0,
    0.35,
    100,
    1,
  ],
};

// ── US-11 mountain passes ──

/** Status → marker fill color. Mirrors PASS_LEGEND copy below. */
export const PASS_STATUS_COLORS: Record<PassStatus, string> = {
  open: colors.success,
  closed: colors.danger,
  unknown: colors.textTertiary,
};

/** Status → human label used in the legend and trip warning copy. */
export const PASS_STATUS_LABELS: Record<PassStatus, string> = {
  open: "Open",
  closed: "Closed",
  unknown: "Unknown",
};

/**
 * Build a GeoJSON FeatureCollection from a list of passes so a single
 * `ShapeSource` can drive both the marker and (potential future) label
 * layers. We carry `status` on the feature properties so the data-driven
 * style can colour markers without per-feature rendering churn.
 */
export function passesToFeatureCollection(
  passes: MountainPass[],
): GeoJSON.FeatureCollection<
  GeoJSON.Point,
  { id: string; status: PassStatus }
> {
  return {
    type: "FeatureCollection",
    features: passes.map((p) => ({
      type: "Feature",
      id: p.id,
      properties: { id: p.id, status: p.status },
      geometry: { type: "Point", coordinates: [p.lng, p.lat] },
    })),
  };
}

/**
 * Marker style for the mountain-pass layer.
 *
 * `circleColor` — `match` expression on `status` so each marker takes its
 *   colour from the status carried on the feature properties (no need
 *   to split passes into separate sources per status).
 *
 * `circleRadius` — interpolates with zoom so passes stay visible at
 *   country level (z6) and don't dominate the map up close (z14+).
 */
export const passMarkerStyle: CircleLayerStyle = {
  circleColor: [
    "match",
    ["get", "status"],
    "open",
    PASS_STATUS_COLORS.open,
    "closed",
    PASS_STATUS_COLORS.closed,
    PASS_STATUS_COLORS.unknown,
  ],
  circleRadius: ["interpolate", ["linear"], ["zoom"], 6, 5, 10, 7, 14, 10],
  circleStrokeColor: colors.bg,
  circleStrokeWidth: 2,
  circleOpacity: 0.95,
};
