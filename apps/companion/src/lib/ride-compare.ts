/**
 * Pure helpers for side-by-side ride comparison (US-51).
 *
 * Kept side-effect free so the compare page can derive every view from two
 * ride payloads and so the helpers are unit-testable without rendering React.
 *
 * Naming convention: the two rides are called `a` (left) and `b` (right).
 * Deltas are always `b - a` so a positive delta means "more/greater on the
 * right", matching how the UI labels the columns.
 */

import type { components } from "@tarmoto/openapi-client";
import type { Formatters } from "@tarmoto/shared";
import type { QualityTier } from "@/lib/types";
import {
  buildRoutePreview,
  computeQualityBreakdown,
  type QualityBreakdownRow,
  type RideSegmentLike,
  type RoutePoint,
  type RoutePreview,
} from "@/lib/ride-detail";

/**
 * The subset of `RideDetailDto` the comparison helpers read. The scalar +
 * geometry fields are derived from the generated DTO so a backend rename
 * breaks here at typecheck time rather than silently skewing a delta;
 * `segments` keeps the minimal `RideSegmentLike` contract the breakdown
 * helper actually consumes (a full `RideDetailDto` still satisfies it).
 */
export type ComparableRide = Pick<
  components["schemas"]["RideDetailDto"],
  | "id"
  | "started_at"
  | "distance_km"
  | "duration_min"
  | "avg_speed"
  | "max_speed"
  | "avg_road_quality"
  | "elevation_gain"
  | "elevation_loss"
  | "curve_count"
  | "max_lean_angle"
  | "fuel_estimate_l"
  | "route_geometry"
> & { segments: RideSegmentLike[] };

export type StatKey =
  | "distance_km"
  | "duration_min"
  | "avg_speed"
  | "max_speed"
  | "elevation_gain"
  | "elevation_loss"
  | "avg_road_quality"
  | "curve_count"
  | "max_lean_angle";

export interface StatRow {
  key: StatKey;
  label: string;
  unit?: string;
  digits: number;
  /** `higherIsBetter` drives the +/- arrow color. `null` means neutral. */
  higherIsBetter: boolean | null;
  a: number | null;
  b: number | null;
  delta: number | null;
}

const STAT_DEFS: Array<Omit<StatRow, "a" | "b" | "delta"> & { key: StatKey }> =
  [
    {
      key: "distance_km",
      label: "Distance",
      unit: "km",
      digits: 1,
      higherIsBetter: null,
    },
    {
      key: "duration_min",
      label: "Duration",
      unit: "min",
      digits: 0,
      higherIsBetter: null,
    },
    {
      key: "avg_speed",
      label: "Avg speed",
      unit: "km/h",
      digits: 0,
      higherIsBetter: true,
    },
    {
      key: "max_speed",
      label: "Max speed",
      unit: "km/h",
      digits: 0,
      higherIsBetter: true,
    },
    {
      key: "elevation_gain",
      label: "Elevation gain",
      unit: "m",
      digits: 0,
      higherIsBetter: null,
    },
    {
      key: "elevation_loss",
      label: "Elevation loss",
      unit: "m",
      digits: 0,
      higherIsBetter: null,
    },
    {
      key: "avg_road_quality",
      label: "Avg road quality",
      unit: "/5",
      digits: 2,
      higherIsBetter: true,
    },
    {
      key: "curve_count",
      label: "Curve count",
      digits: 0,
      higherIsBetter: null,
    },
    {
      key: "max_lean_angle",
      label: "Max lean",
      unit: "°",
      digits: 0,
      higherIsBetter: true,
    },
  ];

// Builds one StatRow per metric. Both-null rows still appear (with em-dashes)
// so the table layout is stable regardless of which fields the API populated.
export function computeStatRows(
  a: ComparableRide,
  b: ComparableRide,
): StatRow[] {
  return STAT_DEFS.map((def) => {
    const av = a[def.key];
    const bv = b[def.key];
    return {
      ...def,
      a: av,
      b: bv,
      delta: av != null && bv != null ? bv - av : null,
    };
  });
}

export interface QualityDiffRow extends QualityBreakdownRow {
  /** Percent on side B. `label/color/tier` come from side A's row. */
  bPercent: number;
  /** Signed percentage-point delta (b - a). Rounded to match display. */
  deltaPercent: number;
}

/**
 * Computes the quality breakdown for both rides and zips them into one row
 * per tier. Fixed tier order (excellent → very-poor) so callers can render
 * the legend without sorting.
 */
export function diffQualityBreakdown(
  a: ComparableRide,
  b: ComparableRide,
): QualityDiffRow[] {
  const aRows = computeQualityBreakdown(a.segments);
  const bRows = computeQualityBreakdown(b.segments);
  const byTierB = new Map<QualityTier, QualityBreakdownRow>(
    bRows.map((row) => [row.tier, row]),
  );
  return aRows.map((aRow) => {
    const bRow = byTierB.get(aRow.tier)!;
    return {
      ...aRow,
      bPercent: bRow.percent,
      deltaPercent: bRow.percent - aRow.percent,
    };
  });
}

export interface UnifiedRoutePreview {
  a: RoutePreview | null;
  b: RoutePreview | null;
  /** Shared viewBox fitted to the union of both routes. */
  viewBox: string;
  width: number;
  height: number;
}

/**
 * Builds two SVG route previews that share a single coordinate system, so
 * rendering them in split-screen keeps them aligned at the same geographic
 * scale. Without this, each preview would auto-fit to its own bounds and the
 * visual comparison would be meaningless.
 *
 * If one ride has no geometry, the other still renders at its native bounds.
 */
export function buildUnifiedRoutePreview(
  a: ComparableRide,
  b: ComparableRide,
  size = 600,
  padding = 12,
): UnifiedRoutePreview {
  const aGeom = a.route_geometry ?? null;
  const bGeom = b.route_geometry ?? null;
  const validA = aGeom?.filter(isValidLatLng) ?? [];
  const validB = bGeom?.filter(isValidLatLng) ?? [];

  if (validA.length < 2 && validB.length < 2) {
    return {
      a: null,
      b: null,
      viewBox: `0 0 ${size} ${size}`,
      width: size,
      height: size,
    };
  }

  if (validA.length < 2) {
    const bPreview = buildRoutePreview(bGeom, size, padding);
    return {
      a: null,
      b: bPreview,
      viewBox: bPreview?.viewBox ?? `0 0 ${size} ${size}`,
      width: bPreview?.width ?? size,
      height: bPreview?.height ?? size,
    };
  }
  if (validB.length < 2) {
    const aPreview = buildRoutePreview(aGeom, size, padding);
    return {
      a: aPreview,
      b: null,
      viewBox: aPreview?.viewBox ?? `0 0 ${size} ${size}`,
      width: aPreview?.width ?? size,
      height: aPreview?.height ?? size,
    };
  }

  const all = [...validA, ...validB];
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLng = Infinity;
  let maxLng = -Infinity;
  for (const p of all) {
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lng < minLng) minLng = p.lng;
    if (p.lng > maxLng) maxLng = p.lng;
  }

  const meanLat = (minLat + maxLat) / 2;
  const lngScale = Math.cos((meanLat * Math.PI) / 180);
  const latSpan = Math.max(maxLat - minLat, 1e-6);
  const lngSpan = Math.max((maxLng - minLng) * lngScale, 1e-6);

  const inner = Math.max(size - padding * 2, 1);
  const aspect = lngSpan / latSpan;
  const width = aspect >= 1 ? inner : inner * aspect;
  const height = aspect >= 1 ? inner / aspect : inner;

  const project = (p: RoutePoint) => {
    const x = ((p.lng - minLng) * lngScale) / lngSpan;
    const y = (maxLat - p.lat) / latSpan;
    return { x: padding + x * width, y: padding + y * height };
  };

  const pathFor = (points: RoutePoint[]): string =>
    points
      .map((p, i) => {
        const { x, y } = project(p);
        return `${i === 0 ? "M" : "L"}${x.toFixed(2)} ${y.toFixed(2)}`;
      })
      .join(" ");

  const sharedViewBox = `0 0 ${width + padding * 2} ${height + padding * 2}`;
  const sharedBounds = { minLng, minLat, maxLng, maxLat };
  const full = {
    viewBox: sharedViewBox,
    width: width + padding * 2,
    height: height + padding * 2,
    bounds: sharedBounds,
  };

  return {
    a: { path: pathFor(validA), ...full },
    b: { path: pathFor(validB), ...full },
    viewBox: sharedViewBox,
    width: full.width,
    height: full.height,
  };
}

function isValidLatLng(p: RoutePoint): boolean {
  return (
    Number.isFinite(p.lat) &&
    Number.isFinite(p.lng) &&
    Math.abs(p.lat) <= 90 &&
    Math.abs(p.lng) <= 180
  );
}

// ── Display formatting ──

/**
 * Signed delta string with fixed precision. Zero renders as "0" with no sign
 * so we don't visually scream "change" when nothing changed.
 */
export function formatDelta(
  delta: number | null | undefined,
  digits: number,
  format: Formatters,
): string {
  if (delta == null || Number.isNaN(delta)) return "—";
  // Technical rounding to settle the zero/sign branch below — a plain
  // numeric `toFixed`, not routed through `format`: round-tripping a
  // locale-formatted string (e.g. cs-CZ's "0,00") back through `Number()`
  // for this comparison would silently break on the comma separator.
  const rounded = Number(delta.toFixed(digits));
  if (rounded === 0) return format.decimal(0, digits);
  const sign = rounded > 0 ? "+" : "−";
  return `${sign}${format.decimal(Math.abs(rounded), digits)}`;
}

/** Describes whether a delta is an improvement, regression, or neutral. */
export type DeltaDirection = "improved" | "regressed" | "neutral";

export function deltaDirection(
  delta: number | null | undefined,
  higherIsBetter: boolean | null,
  digits = 2,
): DeltaDirection {
  if (delta == null || higherIsBetter == null) return "neutral";
  const rounded = Number(delta.toFixed(digits));
  if (rounded === 0) return "neutral";
  const positive = rounded > 0;
  return positive === higherIsBetter ? "improved" : "regressed";
}
