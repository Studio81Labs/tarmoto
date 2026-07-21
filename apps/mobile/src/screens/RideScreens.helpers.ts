/**
 * Pure formatting + shaping helpers for the Ride screens (US-19).
 *
 * Extracted to a separate module so unit tests can exercise the display
 * contract (date buckets, unit suffixes, GeoJSON shape) without pulling
 * React Native, navigation, or MapLibre into the module graph.
 */

import {
  emptyLeanDistribution,
  LEAN_BUCKETS,
  type LeanBucket,
  type LeanBucketId,
  type LeanDistribution,
  type SplitValueUnit,
} from "@tarmoto/shared";
import type { LineLayerSpecification } from "@maplibre/maplibre-react-native";

import type { IconName } from "@/components/Icon";
import { translate, type EnglishMessageKey, type Translate } from "@/i18n";
import { getFormatters } from "@/format";
import type { ClassificationResult } from "@/services/sensors";
import type { LatLng, RideDetail, RideSegment, SurfaceType } from "@/types";
import { QUALITY_COLORS, UNSCORED_COLOR } from "@/theme/brand";

type LineColorExpression = Extract<
  NonNullable<NonNullable<LineLayerSpecification["paint"]>["line-color"]>,
  unknown[]
>;

/**
 * Format an ISO timestamp using the rider/device locale and timezone.
 *
 * Returns an empty string for unparseable input so callers don't render
 * "Invalid Date" — the row simply collapses the date line. A rider sees
 * date + time because two rides on the same day are common (commute
 * morning + evening).
 */
export function formatRideDate(iso: string | undefined | null): string {
  if (!iso) return "";
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return "";
  return getFormatters().dateTime(parsed);
}

/**
 * Format a distance in km with one decimal at <100 km, switching to whole
 * km above (a 240 km ride doesn't need a tenth-of-a-km precision and a
 * decimal there reads as fake precision). Non-finite / negative collapse
 * to "0 km" so we never render NaN.
 */
export function formatDistanceKm(km: number | null | undefined): string {
  const value = km == null || !Number.isFinite(km) || km <= 0 ? 0 : km;
  return getFormatters().distanceKm(value >= 100 ? Math.round(value) : value);
}

function validSpeedKmh(kmh: number | null | undefined): number {
  return kmh == null || !Number.isFinite(kmh) || kmh < 0 ? 0 : kmh;
}

/** Speed formatted in the rider's unit system. Backend already serves km/h. */
export function formatSpeedKmh(kmh: number | null | undefined): string {
  return getFormatters().speed(validSpeedKmh(kmh));
}

/** Split speed value/unit for HUD layouts that style each part separately. */
export function splitSpeedKmh(kmh: number | null | undefined): SplitValueUnit {
  return getFormatters().splitSpeed(validSpeedKmh(kmh));
}

/**
 * Format ride duration. Backend gives us minutes on RideSummary; HUD
 * gives us seconds. Two helpers so callers can't accidentally feed the
 * wrong unit into the wrong formatter.
 */
export function formatDurationMinutes(
  minutes: number | null | undefined,
): string {
  return getFormatters().durationCompact(
    minutes == null || !Number.isFinite(minutes) || minutes <= 0 ? 0 : minutes,
  );
}

/** Elevation gain/loss in meters, prefixed with sign so the row reads "+125 m". */
export function formatElevation(
  meters: number | null | undefined,
  sign: "+" | "-",
): string {
  const value =
    meters == null || !Number.isFinite(meters) || meters <= 0 ? 0 : meters;
  return `${sign}${getFormatters().elevation(value)}`;
}

/** Lean angle in whole degrees. */
export function formatLeanAngle(deg: number | null | undefined): string {
  const value = deg == null || !Number.isFinite(deg) || deg <= 0 ? 0 : deg;
  return `${getFormatters().integer(value)}°`;
}

/** Fuel estimate. Liters with one decimal — fuel pumps round to 0.01 L. */
export function formatFuelLiters(liters: number | null | undefined): string {
  const value =
    liters == null || !Number.isFinite(liters) || liters <= 0 ? 0 : liters;
  return value === 0
    ? `${getFormatters().integer(0)} L`
    : `${getFormatters().decimal(value, 1)} L`;
}

/** Curve count is integer. */
export function formatCurveCount(count: number | null | undefined): string {
  return getFormatters().integer(
    count == null || !Number.isFinite(count) || count <= 0 ? 0 : count,
  );
}

/**
 * Icon name (see `@/components/Icon`) for a road surface. Falls back to a
 * neutral "road" glyph for `unknown` so the icon slot never collapses. Typed
 * as `IconName` so a surface pointing at an unregistered glyph is a compile
 * error rather than a blank slot / invalid-element crash at runtime.
 */
export function surfaceIcon(surface: SurfaceType): IconName {
  switch (surface) {
    case "asphalt":
      return "road";
    case "concrete":
      return "wall";
    case "cobblestone":
      return "view-grid-outline";
    case "gravel":
      return "grain";
    case "dirt":
      return "shovel";
    case "unknown":
    default:
      return "road-variant";
  }
}

/**
 * Display label for a surface type. Shared with the active HUD and the
 * past-ride detail screen so the two can't drift on capitalisation.
 */
export function surfaceLabel(
  surface: SurfaceType | string | undefined | null,
): string {
  if (!surface) return translate("Unknown");
  const labels: Record<SurfaceType, EnglishMessageKey> = {
    asphalt: "Asphalt",
    concrete: "Concrete",
    cobblestone: "Cobblestone",
    gravel: "Gravel",
    dirt: "Dirt",
    unknown: "Unknown",
  };
  const label = labels[surface as SurfaceType];
  return label ? translate(label) : surface;
}

/**
 * Bucketed quality class for a numeric score. Mirrors the buckets used by
 * `qualityLabel` / `qualityColor` in the theme module so the HUD can
 * render an ML classification snapshot consistently.
 */
export function qualityScoreFromClass(
  classification: ClassificationResult | null,
): number {
  if (!classification) return 0;
  if (Number.isFinite(classification.quality_score)) {
    return classification.quality_score;
  }
  switch (classification.quality_class) {
    case "excellent":
      return 5;
    case "good":
      return 4;
    case "fair":
      return 3;
    case "poor":
      return 2;
    case "very_poor":
      return 1;
    default:
      return 0;
  }
}

/**
 * Sentinel `quality_reading` for "no segment data". Negative on purpose
 * so the MapLibre step expression (`rideRouteLineColorExpression`) can
 * keep the no-data colour as the default branch without colliding with
 * a real veryPoor reading at score 1.
 */
export const NO_QUALITY_READING = -1;

/**
 * MapLibre `step` expression that maps `quality_reading` to the shared brand
 * 5-class quality ramp. The boundaries match the brand quality buckets exactly
 * — `value ≥ 4.5` is Q5, `≥ 3.5` is Q4, etc — so the polyline agrees with the
 * histogram and summary badge on the same screen.
 *
 * Branches (post-coalesce, with `NO_QUALITY_READING = -1` as the
 * sentinel for unmapped legs):
 *   - value < 0   → no-data (neutral unscored grey)
 *   - 0..1.5      → Q1
 *   - 1.5..2.5    → Q2
 *   - 2.5..3.5    → Q3
 *   - 3.5..4.5    → Q4
 *   - ≥ 4.5       → Q5
 */
export function rideRouteLineColorExpression(): LineColorExpression {
  return [
    "step",
    ["coalesce", ["get", "quality_reading"], NO_QUALITY_READING],
    UNSCORED_COLOR,
    0,
    QUALITY_COLORS[0],
    1.5,
    QUALITY_COLORS[1],
    2.5,
    QUALITY_COLORS[2],
    3.5,
    QUALITY_COLORS[3],
    4.5,
    QUALITY_COLORS[4],
  ];
}

/**
 * GeoJSON feature collection for a past ride's route, with each leg
 * coloured by the snapped segment's quality reading.
 *
 * Strategy:
 *   - The polyline has many vertices but only `segments.length` quality
 *     samples. We split the polyline into N feature ranges (N =
 *     segments.length) using fractional boundaries so the trailing
 *     segments don't get dropped on the floor when integer chunking
 *     can't divide cleanly.
 *   - When `segments.length` exceeds the available edges
 *     (`geometry.length - 1`), each segment still produces a feature —
 *     they just share / overlap edges. The histogram and summary card
 *     count every segment regardless, so this keeps the map consistent
 *     with them on short / sparsely-sampled rides.
 *   - When `segments` is empty (no samples uploaded yet) we emit a
 *     single feature with `NO_QUALITY_READING` so the rider still sees
 *     the route geometry — rendered in the no-data colour.
 *
 * Pure — no MapLibre, no React. The screen-level layer style consumes
 * `quality_reading` from properties via `rideRouteLineColorExpression`.
 */
export function rideRouteFeatureCollection(
  geometry: LatLng[] | null,
  segments: RideSegment[],
): GeoJSON.FeatureCollection {
  if (!Array.isArray(geometry) || geometry.length < 2) {
    return { type: "FeatureCollection", features: [] };
  }
  if (segments.length === 0) {
    return {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: { quality_reading: NO_QUALITY_READING },
          geometry: {
            type: "LineString",
            coordinates: geometry.map((p) => [p.lng, p.lat]),
          },
        },
      ],
    };
  }

  const lastVertex = geometry.length - 1;
  const features: GeoJSON.Feature[] = [];
  for (let i = 0; i < segments.length; i++) {
    // Fractional boundaries so we don't drop trailing segments when
    // integer chunking couldn't divide cleanly. The last segment
    // always extends to the polyline's final vertex so the rendered
    // route never stops short of where the rider actually finished.
    const rawStart = (i * lastVertex) / segments.length;
    const rawEnd = ((i + 1) * lastVertex) / segments.length;
    const startIdx = Math.max(
      0,
      Math.min(lastVertex - 1, Math.floor(rawStart)),
    );
    let endIdx =
      i === segments.length - 1
        ? lastVertex
        : Math.min(lastVertex, Math.floor(rawEnd));
    // Guarantee every feature has at least one edge. When
    // `segments.length > lastVertex`, several segments collapse onto
    // the same edge — MapLibre paints the last feature on top so the
    // most recent reading wins, which matches the histogram order.
    if (endIdx <= startIdx) {
      endIdx = Math.min(lastVertex, startIdx + 1);
    }
    const slice = geometry.slice(startIdx, endIdx + 1);
    if (slice.length < 2) continue;
    const reading = segments[i]?.quality_reading;
    // The quality scale is 1..5 — treat anything ≤0 (or non-finite or
    // null) as "no data" so the polyline agrees with the SummaryCard,
    // which also reads a `qScore <= 0` average as "no data". Otherwise
    // a segment with `quality_reading: 0` would render in `veryPoor`
    // red on the map while the summary badge above shows "—".
    features.push({
      type: "Feature",
      properties: {
        quality_reading:
          reading != null && Number.isFinite(reading) && reading > 0
            ? reading
            : NO_QUALITY_READING,
      },
      geometry: {
        type: "LineString",
        coordinates: slice.map((p) => [p.lng, p.lat]),
      },
    });
  }
  return { type: "FeatureCollection", features };
}

/**
 * West/south/east/north bounds for fitting the camera to a ride's
 * polyline. Returns `null` when the geometry is too small to bound — the
 * caller should fall back to a default centre.
 */
export function rideBounds(geometry: LatLng[] | null): {
  sw: LatLng;
  ne: LatLng;
} | null {
  if (!Array.isArray(geometry) || geometry.length === 0) return null;
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLng = Infinity;
  let maxLng = -Infinity;
  for (const p of geometry) {
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lng)) continue;
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lng < minLng) minLng = p.lng;
    if (p.lng > maxLng) maxLng = p.lng;
  }
  if (!Number.isFinite(minLat) || !Number.isFinite(minLng)) return null;
  if (minLat === maxLat && minLng === maxLng) {
    // Degenerate single-point ride — pad ~250 m so the camera doesn't
    // zoom to maximum.
    const pad = 0.0025;
    return {
      sw: { lat: minLat - pad, lng: minLng - pad },
      ne: { lat: maxLat + pad, lng: maxLng + pad },
    };
  }
  return {
    sw: { lat: minLat, lng: minLng },
    ne: { lat: maxLat, lng: maxLng },
  };
}

/**
 * Roll up segment-level quality into a counts-per-bucket histogram for
 * the per-segment breakdown card. Buckets follow the shared 5-class
 * scale (1 = veryPoor, 5 = excellent). Non-finite or non-positive
 * readings are dropped — the rest of the screen treats `quality_reading
 * <= 0` as "no data" (the polyline renders it in the no-data tertiary,
 * the summary badge shows "—"), so bucketing it into "Very Poor" here
 * would over-report that bucket and contradict the map. The 1..5
 * scale never produces a real 0, so this only catches missing rows.
 */
export function segmentQualityHistogram(
  segments: RideSegment[],
): Array<{ bucket: 1 | 2 | 3 | 4 | 5; count: number }> {
  const counts: Record<1 | 2 | 3 | 4 | 5, number> = {
    1: 0,
    2: 0,
    3: 0,
    4: 0,
    5: 0,
  };
  for (const seg of segments) {
    const r = seg.quality_reading;
    if (r == null || !Number.isFinite(r) || r <= 0) continue;
    const bucket = bucketForScore(r);
    counts[bucket] += 1;
  }
  return [
    { bucket: 5 as const, count: counts[5] },
    { bucket: 4 as const, count: counts[4] },
    { bucket: 3 as const, count: counts[3] },
    { bucket: 2 as const, count: counts[2] },
    { bucket: 1 as const, count: counts[1] },
  ];
}

function bucketForScore(score: number): 1 | 2 | 3 | 4 | 5 {
  if (score >= 4.5) return 5;
  if (score >= 3.5) return 4;
  if (score >= 2.5) return 3;
  if (score >= 1.5) return 2;
  return 1;
}

/**
 * Histogram row for the per-ride lean breakdown (US-19). Mirrors the
 * shape `RideDetailScreen` consumes: bucket metadata + raw count + the
 * "total samples" denominator so the screen can render a percentage
 * without recomputing the sum on every row.
 */
export interface LeanHistogramRow {
  bucket: LeanBucket;
  count: number;
  /** 0..1 share of the per-ride sample total. */
  ratio: number;
}

/**
 * Coerce a (potentially `null`) `lean_distribution` payload into the
 * fixed-order, fixed-key set of histogram rows the screen renders.
 * Pure — no React, no native modules — so the unit tests can drive it
 * with synthetic distributions.
 */
export function leanHistogramRows(
  distribution: LeanDistribution | null,
): LeanHistogramRow[] {
  const dist = distribution ?? emptyLeanDistribution();
  const total = LEAN_BUCKETS.reduce(
    (acc, bucket) => acc + (dist[bucket.id] ?? 0),
    0,
  );
  return LEAN_BUCKETS.map((bucket) => {
    const count = dist[bucket.id] ?? 0;
    const ratio = total > 0 ? count / total : 0;
    return { bucket, count, ratio };
  });
}

/** Total lean samples across the histogram. Returns 0 for null. */
export function leanSampleTotal(distribution: LeanDistribution | null): number {
  if (!distribution) return 0;
  return LEAN_BUCKETS.reduce(
    (acc, bucket) => acc + (distribution[bucket.id] ?? 0),
    0,
  );
}

/** Re-export so screens can render the canonical bucket labels. */
export type { LeanBucket, LeanBucketId };

/**
 * Build the share-message body for a past ride. Pure so tests can
 * exercise the copy without touching the system Share API.
 */
export function buildRideShareMessage(
  ride: RideDetail,
  t: Translate = translate,
): string {
  const lines: string[] = [];
  lines.push(t("Tarmoto ride"));
  if (ride.started_at) {
    const date = formatRideDate(ride.started_at);
    if (date) lines.push(date);
  }
  lines.push(
    t("Distance: {distance}", {
      distance: formatDistanceKm(ride.distance_km),
    }),
  );
  lines.push(
    t("Duration: {duration}", {
      duration: formatDurationMinutes(ride.duration_min),
    }),
  );
  if (ride.max_speed != null && ride.max_speed > 0) {
    lines.push(
      t("Top speed: {speed}", { speed: formatSpeedKmh(ride.max_speed) }),
    );
  }
  return lines.join("\n");
}
