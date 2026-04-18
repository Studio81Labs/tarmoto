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
  FillLayerStyle,
  LineLayerStyle,
} from "@maplibre/maplibre-react-native";
import { API_BASE_URL } from "@/config";
import { colors, MIN_QUALITY_BOUNDS } from "@/theme";
import type { FunZone, LatLng, MountainPass, PassStatus } from "@/types";

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

/**
 * Opacity applied to segments below the rider's minimum-quality threshold.
 * Keeps the geometry legible so riders can still see what's there (and
 * spot a nicer alternative on a parallel road) without those segments
 * competing with qualifying roads for attention. Mirrors the dimming
 * applied on `RoadPreviewScreen` cards (US-5 AC: "shown in gray/excluded").
 */
export const BELOW_THRESHOLD_OPACITY = 0.2;

/**
 * US-5: build the road-quality line style with the rider's minimum-quality
 * threshold baked into the style expressions. Segments below the threshold
 * are painted in `textTertiary` gray and faded to `BELOW_THRESHOLD_OPACITY`.
 *
 * We compare against `minQuality - 0.5` to match the half-point buckets that
 * `qualityLabel` / `qualityColor` use: a "Fair or better" filter (minQuality
 * 3) must keep a 2.8-scored segment — it still labels as "Fair".
 *
 * When `minQuality` is at or below the minimum bound (1), no filtering is
 * needed and we return the baseline `qualityLineStyle` untouched so the step
 * expression tests (and MapLibre's style diffing) stay cheap.
 */
export function buildQualityLineStyle(minQuality: number): LineLayerStyle {
  if (minQuality <= MIN_QUALITY_BOUNDS.min) return qualityLineStyle;

  const threshold = minQuality - 0.5;

  return {
    ...qualityLineStyle,
    lineColor: [
      "case",
      ["<", ["get", "quality_score"], threshold],
      colors.textTertiary,
      qualityLineStyle.lineColor,
    ] as LineLayerStyle["lineColor"],
    lineOpacity: [
      "case",
      ["<", ["get", "quality_score"], threshold],
      BELOW_THRESHOLD_OPACITY,
      qualityLineStyle.lineOpacity,
    ] as LineLayerStyle["lineOpacity"],
  };
}

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

// ── US-6 Fun Zones ──
//
// Composite scores come back as floats on a rough 0-5 scale (see
// `roads.service.spec.ts` seeds), mirroring the road-quality score. We reuse
// the quality colour ramp + half-point breaks so zones feel consistent with
// every other score surface in the app: a "4.5+" fun zone reads as Excellent,
// same as a 4.5+ road segment.

/** Composite-score bucket boundaries. Mirror theme.qualityColor(). */
export const FUN_ZONE_SCORE_BREAKS = [1.5, 2.5, 3.5, 4.5] as const;

/** Ordered (worst → best) score → colour mapping for the fun-zone layer. */
export const FUN_ZONE_COLORS: {
  veryPoor: string;
  poor: string;
  fair: string;
  good: string;
  excellent: string;
} = {
  veryPoor: colors.quality.veryPoor,
  poor: colors.quality.poor,
  fair: colors.quality.fair,
  good: colors.quality.good,
  excellent: colors.quality.excellent,
};

/**
 * Convert a MapLibre region (centre + zoom + latitude/longitude deltas) into
 * the `west,south,east,north` string the backend expects. The region feature
 * carries visibleBounds as `[[east, north], [west, south]]` in newer
 * MapLibre builds; older builds emitted visibleBounds in the other order, so
 * we sort the corners defensively. Rounded to 4 decimals to keep the URL
 * stable across tiny camera jitter — same bbox, same request, same 304.
 */
export function bboxFromVisibleBounds(
  visibleBounds: [[number, number], [number, number]],
): string {
  const [a, b] = visibleBounds;
  const west = Math.min(a[0], b[0]);
  const east = Math.max(a[0], b[0]);
  const south = Math.min(a[1], b[1]);
  const north = Math.max(a[1], b[1]);
  const round = (n: number): number => Math.round(n * 10000) / 10000;
  return `${round(west)},${round(south)},${round(east)},${round(north)}`;
}

/**
 * Fun zones arrive with boundary as `LatLng[]` — a closed ring (first vertex
 * equals last). GeoJSON polygons want `[lng, lat]` tuples, and MapLibre's
 * polygon renderer requires the ring to be explicitly closed. We enforce
 * both here so the `FillLayer` renders without truncation and the `FillLayer
 * + LineLayer` pair traces the same boundary.
 *
 * Zones with fewer than three unique vertices (degenerate polygons that can
 * slip through from partial backend aggregation) are dropped — MapLibre
 * warns on them but still renders artefacts.
 */
export function funZonesToFeatureCollection(
  zones: FunZone[],
): GeoJSON.FeatureCollection<
  GeoJSON.Polygon,
  {
    id: string;
    name: string | null;
    composite_score: number;
    road_count: number;
    total_curve_km: number | null;
    avg_quality: number | null;
    best_season: string | null;
  }
> {
  const features = zones
    .map((zone) => {
      const ring = toClosedRing(zone.boundary);
      if (ring.length < 4) return null;
      return {
        type: "Feature" as const,
        id: zone.id,
        properties: {
          id: zone.id,
          name: zone.name ?? null,
          composite_score: zone.composite_score,
          road_count: zone.road_count,
          total_curve_km: zone.total_curve_km ?? null,
          avg_quality: zone.avg_quality ?? null,
          best_season: zone.best_season ?? null,
        },
        geometry: {
          type: "Polygon" as const,
          coordinates: [ring],
        },
      };
    })
    .filter((f): f is NonNullable<typeof f> => f !== null);
  return { type: "FeatureCollection", features };
}

function toClosedRing(boundary: LatLng[]): [number, number][] {
  if (boundary.length < 3) return [];
  const ring = boundary.map((p) => [p.lng, p.lat] as [number, number]);
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) {
    ring.push([first[0], first[1]]);
  }
  return ring;
}

/**
 * Fill style for the Fun Zone overlay.
 *
 * `fillColor` — `step` on `composite_score` matching the quality buckets,
 *   so a zone with an excellent composite score shows in the same green as
 *   excellent road segments.
 *
 * `fillOpacity` — `interpolate` on `zoom` so zones read as translucent
 *   heatmap patches at low zoom and fade out before they start obscuring
 *   individual roads at high zoom. US-6 explicitly asks for a heatmap feel.
 */
export const funZoneFillStyle: FillLayerStyle = {
  fillColor: [
    "step",
    ["get", "composite_score"],
    FUN_ZONE_COLORS.veryPoor,
    FUN_ZONE_SCORE_BREAKS[0],
    FUN_ZONE_COLORS.poor,
    FUN_ZONE_SCORE_BREAKS[1],
    FUN_ZONE_COLORS.fair,
    FUN_ZONE_SCORE_BREAKS[2],
    FUN_ZONE_COLORS.good,
    FUN_ZONE_SCORE_BREAKS[3],
    FUN_ZONE_COLORS.excellent,
  ],
  fillOpacity: [
    "interpolate",
    ["linear"],
    ["zoom"],
    6,
    0.35,
    12,
    0.22,
    16,
    0.1,
  ],
};

/**
 * Outline style for the Fun Zone overlay. Uses the same colour ramp as the
 * fill so the boundary keeps reading as part of the same zone even when the
 * fill fades out at high zoom.
 */
export const funZoneLineStyle: LineLayerStyle = {
  lineColor: [
    "step",
    ["get", "composite_score"],
    FUN_ZONE_COLORS.veryPoor,
    FUN_ZONE_SCORE_BREAKS[0],
    FUN_ZONE_COLORS.poor,
    FUN_ZONE_SCORE_BREAKS[1],
    FUN_ZONE_COLORS.fair,
    FUN_ZONE_SCORE_BREAKS[2],
    FUN_ZONE_COLORS.good,
    FUN_ZONE_SCORE_BREAKS[3],
    FUN_ZONE_COLORS.excellent,
  ],
  lineWidth: ["interpolate", ["linear"], ["zoom"], 6, 1, 12, 1.5, 16, 2],
  lineOpacity: 0.85,
  lineJoin: "round",
};

/**
 * Map a composite score to the matching bucket colour. Used by the legend
 * and by the detail card's score chip so the UI never drifts from the layer.
 */
export function funZoneColor(score: number): string {
  if (score >= FUN_ZONE_SCORE_BREAKS[3]) return FUN_ZONE_COLORS.excellent;
  if (score >= FUN_ZONE_SCORE_BREAKS[2]) return FUN_ZONE_COLORS.good;
  if (score >= FUN_ZONE_SCORE_BREAKS[1]) return FUN_ZONE_COLORS.fair;
  if (score >= FUN_ZONE_SCORE_BREAKS[0]) return FUN_ZONE_COLORS.poor;
  return FUN_ZONE_COLORS.veryPoor;
}
