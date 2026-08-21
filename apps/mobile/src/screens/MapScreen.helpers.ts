/**
 * Pure helpers for MapScreen — kept separate so they're unit-testable
 * without pulling in MapLibre's native bindings (which explode in Jest).
 *
 * Scope:
 *   - `getQualityTileUrlTemplate` — builds the xyz template that MapLibre
 *     interpolates into actual tile requests.
 *   - `qualityLineStyle` — MapLibre style expression mapping
 *     `quality_score` (1..5) → color buckets and zoom → line width.
 *   - `APP_MAP_STYLE_URL` — configurable production basemap.
 */

import type {
  CircleLayerSpecification,
  FillLayerSpecification,
  LineLayerSpecification,
} from "@maplibre/maplibre-react-native";
import { API_BASE_URL, MAP_STYLE_URL } from "@/config";
import { MIN_QUALITY_BOUNDS } from "@/theme";
import {
  brandColorsLight,
  QUALITY_COLORS,
  statusFg,
  UNSCORED_COLOR,
} from "@/theme/brand";
import type {
  FunZone,
  Hazard,
  HazardAlertEvent,
  LatLng,
  MountainPass,
  PassStatus,
  Severity,
} from "@/types";
import { translate, type EnglishMessageKey, type Translate } from "@/i18n";

export type LineLayerConfig = {
  paint: NonNullable<LineLayerSpecification["paint"]>;
  layout: NonNullable<LineLayerSpecification["layout"]>;
};

type CircleLayerConfig = {
  paint: NonNullable<CircleLayerSpecification["paint"]>;
};

type FillLayerConfig = {
  paint: NonNullable<FillLayerSpecification["paint"]>;
};

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
  return `${apiBase}/api/v1/roads/tiles/{z}/{x}/{y}.mvt?layers=quality`;
}

/**
 * The same template for the SURFACE layer — road geometry with `id`,
 * `surface_type`, `curviness_score` and `length_m`, but no quality reading.
 *
 * For overlays that need road GEOMETRY rather than paid quality detail
 * (#1279). The quality layer is subject to `road_quality_max_zoom`, and since
 * tile fetches carry identity the backend withholds it above the requester's
 * cap — so anything sourcing geometry from it goes blank at street-detail
 * zooms for a free rider. The surface layer carries no quality data and is
 * never clamped.
 */
export function getSurfaceTileUrlTemplate(
  apiBase: string = API_BASE_URL,
): string {
  return `${apiBase}/api/v1/roads/tiles/{z}/{x}/{y}.mvt?layers=surface`;
}

export const APP_MAP_STYLE_URL = MAP_STYLE_URL;

const FUN_ZONE_SEASON_LABELS = {
  spring: "Spring",
  summer: "Summer",
  autumn: "Autumn",
  year_round: "Year-round",
} as const satisfies Record<string, EnglishMessageKey>;

/** Translate every season value currently emitted by the fun-zone query. */
export function formatFunZoneSeason(
  season: string,
  t: Translate = translate,
): string {
  const key =
    FUN_ZONE_SEASON_LABELS[season as keyof typeof FUN_ZONE_SEASON_LABELS];
  return t(key ?? "Unknown");
}

/**
 * Quality-score bucket boundaries. Mirror the brand `qualityIndex` half-point
 * buckets (Math.round on a 1..5 score) so the overlay colour matches every
 * other surface in the app (segment cards, commute card, ride active screen).
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
export const qualityLineStyle = {
  paint: {
    "line-color": [
      "step",
      ["get", "quality_score"],
      QUALITY_COLORS[0],
      QUALITY_STEP_BREAKS[0],
      QUALITY_COLORS[1],
      QUALITY_STEP_BREAKS[1],
      QUALITY_COLORS[2],
      QUALITY_STEP_BREAKS[2],
      QUALITY_COLORS[3],
      QUALITY_STEP_BREAKS[3],
      QUALITY_COLORS[4],
    ],
    "line-width": [
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
    "line-opacity": [
      "interpolate",
      ["linear"],
      ["get", "confidence"],
      0,
      0.35,
      100,
      1,
    ],
  },
  layout: {
    "line-cap": "round",
    "line-join": "round",
  },
} satisfies LineLayerConfig;

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
 * are painted in the neutral unscored grey and faded to
 * `BELOW_THRESHOLD_OPACITY`.
 *
 * We compare against `minQuality - 0.5` to match the half-point buckets that
 * `qualityLabel` / the brand quality ramp use: a "Fair or better" filter
 * (minQuality 3) must keep a 2.8-scored segment — it still labels as "Fair".
 *
 * When `minQuality` is at or below the minimum bound (1), no filtering is
 * needed and we return the baseline `qualityLineStyle` untouched so the step
 * expression tests (and MapLibre's style diffing) stay cheap.
 */
export function buildQualityLineStyle(minQuality: number): LineLayerConfig {
  if (minQuality <= MIN_QUALITY_BOUNDS.min) return qualityLineStyle;

  const threshold = minQuality - 0.5;

  return {
    ...qualityLineStyle,
    paint: {
      ...qualityLineStyle.paint,
      "line-color": [
        "case",
        ["<", ["get", "quality_score"], threshold],
        UNSCORED_COLOR,
        qualityLineStyle.paint["line-color"],
      ],
      "line-opacity": [
        "case",
        ["<", ["get", "quality_score"], threshold],
        BELOW_THRESHOLD_OPACITY,
        qualityLineStyle.paint["line-opacity"],
      ],
    },
  };
}

// ── US-11 mountain passes ──

/**
 * Status → marker fill color. These render both as map markers on the light
 * basemap AND as dots on the dark `INK_PILL` passes legend, so they use the
 * bright quality-ramp green/red (not the deep `statusFg` text tones, which
 * only reach ~2.9:1 on the ink legend): Q5 green = open, Q1 red = closed,
 * neutral grey = unknown. The ink marker ring carries the edge on the basemap.
 */
export const PASS_STATUS_COLORS: Record<PassStatus, string> = {
  open: QUALITY_COLORS[4],
  closed: QUALITY_COLORS[0],
  unknown: UNSCORED_COLOR,
};

/** Status → human label used in the legend and trip warning copy. */
export const PASS_STATUS_LABELS: Record<PassStatus, EnglishMessageKey> = {
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
export const passMarkerStyle: CircleLayerConfig = {
  paint: {
    "circle-color": [
      "match",
      ["get", "status"],
      "open",
      PASS_STATUS_COLORS.open,
      "closed",
      PASS_STATUS_COLORS.closed,
      PASS_STATUS_COLORS.unknown,
    ],
    "circle-radius": ["interpolate", ["linear"], ["zoom"], 6, 5, 10, 7, 14, 10],
    "circle-stroke-color": brandColorsLight.fg,
    "circle-stroke-width": 2,
    "circle-opacity": 0.95,
  },
};

// ── US-6 Fun Zones ──
//
// Composite scores come back as floats on a rough 0-5 scale (see
// `roads.service.spec.ts` seeds), mirroring the road-quality score. We reuse
// the brand quality colour ramp + half-point breaks so zones feel consistent
// with every other score surface in the app: a "4.5+" fun zone reads as the
// same Q5, same as a 4.5+ road segment.

/** Composite-score bucket boundaries. Mirror the brand quality buckets. */
export const FUN_ZONE_SCORE_BREAKS = [1.5, 2.5, 3.5, 4.5] as const;

/** Ordered (worst → best) score → colour mapping for the fun-zone layer. */
export const FUN_ZONE_COLORS: {
  veryPoor: string;
  poor: string;
  fair: string;
  good: string;
  excellent: string;
} = {
  veryPoor: QUALITY_COLORS[0],
  poor: QUALITY_COLORS[1],
  fair: QUALITY_COLORS[2],
  good: QUALITY_COLORS[3],
  excellent: QUALITY_COLORS[4],
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
  if (!first || !last) return ring;
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
export const funZoneFillStyle: FillLayerConfig = {
  paint: {
    "fill-color": [
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
    "fill-opacity": [
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
  },
};

/**
 * Outline style for the Fun Zone overlay. Uses the same colour ramp as the
 * fill so the boundary keeps reading as part of the same zone even when the
 * fill fades out at high zoom.
 */
export const funZoneLineStyle: LineLayerConfig = {
  paint: {
    "line-color": [
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
    "line-width": ["interpolate", ["linear"], ["zoom"], 6, 1, 12, 1.5, 16, 2],
    "line-opacity": 0.85,
  },
  layout: {
    "line-join": "round",
  },
};

// ── #341 Hazard markers ──

/**
 * Severity → marker fill color. Mirrors `severityColor` in CommuteScreen
 * so a hazard pin on the map and its row in the commute list always
 * read the same. Low severity has no brand "info" tone (the palette is
 * cream/ink + the three status colours), so it reads as neutral ink.
 */
export const HAZARD_SEVERITY_COLORS: Record<Severity, string> = {
  high: statusFg.danger,
  medium: statusFg.warning,
  low: brandColorsLight.dim,
};

/**
 * Build a GeoJSON FeatureCollection from a list of hazards. Carries
 * `severity` on the feature properties so a single circle layer can
 * colour markers data-driven via a `match` expression — no per-feature
 * rendering churn.
 */
export function hazardsToFeatureCollection(
  hazards: Hazard[],
): GeoJSON.FeatureCollection<
  GeoJSON.Point,
  { id: string; severity: Severity; hazard_type: string }
> {
  return {
    type: "FeatureCollection",
    features: hazards.map((h) => ({
      type: "Feature",
      id: h.id,
      properties: {
        id: h.id,
        severity: h.severity,
        hazard_type: h.hazard_type,
      },
      geometry: { type: "Point", coordinates: [h.lng, h.lat] },
    })),
  };
}

/**
 * Marker style for the hazard layer. Markers grow with zoom so they're
 * still visible at country level but don't dominate at street level.
 */
export const hazardMarkerStyle: CircleLayerConfig = {
  paint: {
    "circle-color": [
      "match",
      ["get", "severity"],
      "high",
      HAZARD_SEVERITY_COLORS.high,
      "medium",
      HAZARD_SEVERITY_COLORS.medium,
      HAZARD_SEVERITY_COLORS.low,
    ],
    "circle-radius": ["interpolate", ["linear"], ["zoom"], 6, 4, 10, 6, 14, 9],
    "circle-stroke-color": brandColorsLight.fg,
    "circle-stroke-width": 2,
    "circle-opacity": 0.9,
  },
};

/**
 * Drop hazards from a REST snapshot that were dismissed (moderated/removed)
 * at or after the fetch started — the snapshot predates the dismissal and
 * may still carry them. Prunes spent tombstones (dismissed before the fetch
 * started, so the server snapshot already excludes them). Pure: uses only
 * the passed `fetchStartedAt`, never Date.now().
 */
export function filterDismissedFromRest(
  restResult: Hazard[],
  dismissedAt: Map<string, number>,
  fetchStartedAt: number,
): Hazard[] {
  for (const [id, t] of dismissedAt) {
    if (t < fetchStartedAt) dismissedAt.delete(id);
  }
  return restResult.filter((h) => {
    const t = dismissedAt.get(h.id);
    return t === undefined || t < fetchStartedAt;
  });
}

/**
 * Merge a REST hazard snapshot with:
 *   (a) dismissal filtering — hazards in `restResult` whose `dismissedAt`
 *       entry is >= `fetchStartedAt` are dropped (the snapshot predates the
 *       admin action). Spent tombstones (t < fetchStartedAt) are pruned.
 *   (b) WS arrival preservation — hazards currently in `current` that
 *       arrived via WebSocket at or after `fetchStartedAt` and are NOT
 *       already in the (filtered) REST result are appended so they don't
 *       disappear when the REST response overwrites local state. WS arrival
 *       entries for ids already covered by REST are cleared to avoid stale
 *       entries accumulating across many fetches.
 *
 * Pure: call with `fetchStartedAt = Date.now()` at the call site; never
 * calls Date.now() itself so the function stays testable in isolation.
 *
 * Mirrors `mergeHazardsWithInFlightWsArrivals` in
 * `apps/companion/src/lib/hazard-merge.ts` — keep the two in sync.
 */
export function mergeHazardsRest(
  restResult: Hazard[],
  current: Hazard[],
  wsArrivalAt: Map<string, number>,
  dismissedAt: Map<string, number>,
  fetchStartedAt: number,
): Hazard[] {
  // Drop REST hazards dismissed after the fetch started — the snapshot
  // predates the admin action and would resurrect a moderated marker.
  const filteredRest = restResult.filter((h) => {
    const t = dismissedAt.get(h.id);
    return t === undefined || t < fetchStartedAt;
  });

  // Prune spent tombstones: the dismissal occurred before this fetch
  // started, so the server already excluded the hazard from its snapshot.
  for (const [id, t] of dismissedAt) {
    if (t < fetchStartedAt) dismissedAt.delete(id);
  }

  const restIds = new Set(filteredRest.map((h) => h.id));

  // Preserve current hazards that arrived via WS during the in-flight fetch
  // window and aren't already in the REST result.
  const preserved = current.filter((h) => {
    const arrivedAt = wsArrivalAt.get(h.id);
    return (
      arrivedAt !== undefined &&
      arrivedAt >= fetchStartedAt &&
      !restIds.has(h.id)
    );
  });

  // Hazards now covered by REST no longer need WS preservation — clear
  // their arrival entries so the map doesn't grow unboundedly.
  for (const id of restIds) wsArrivalAt.delete(id);

  return [...filteredRest, ...preserved];
}

/**
 * Apply a `hazard:new` WebSocket event to a local hazard list and
 * return the updated list (or the original list if nothing changed,
 * to keep `===` referential equality stable for memoization).
 *
 * - `severity === "dismissed"` removes the hazard.
 * - An incoming hazard whose `id` already exists is replaced (covers
 *   the confirm path which re-broadcasts the full updated payload).
 * - Otherwise the hazard is appended.
 */
export function applyHazardAlert(
  hazards: Hazard[],
  event: HazardAlertEvent,
): Hazard[] {
  if (event.severity === "dismissed") {
    const next = hazards.filter((h) => h.id !== event.id);
    return next.length === hazards.length ? hazards : next;
  }
  // After the dismissed branch above, the union narrows to `Severity`.
  const incoming: Hazard = { ...event, severity: event.severity };
  const idx = hazards.findIndex((h) => h.id === incoming.id);
  if (idx === -1) return [...hazards, incoming];
  const next = hazards.slice();
  next[idx] = incoming;
  return next;
}
