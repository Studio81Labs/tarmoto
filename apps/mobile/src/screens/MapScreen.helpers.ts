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

import type { LineLayerStyle } from "@maplibre/maplibre-react-native";
import { colors } from "@/theme";

const DEV_API_BASE = "http://localhost:3000/v1";
const PROD_API_BASE = "https://api.tarmoto.app/v1";

/**
 * Return the MapLibre xyz tile URL template for the road-quality MVT layer.
 * MapLibre substitutes `{z}/{x}/{y}` at fetch time; we keep the query string
 * on the end so only the quality layer is decoded on the wire.
 */
export function getQualityTileUrlTemplate(isDev: boolean = __DEV__): string {
  const base = isDev ? DEV_API_BASE : PROD_API_BASE;
  return `${base}/roads/tiles/{z}/{x}/{y}.mvt?layers=quality`;
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
 *   doesn't pretend to be authoritative.
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
