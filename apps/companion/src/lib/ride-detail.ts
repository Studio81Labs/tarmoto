/**
 * Pure helpers that derive presentation data for the ride detail page from
 * `GET /api/v1/rides/:rideId`. Kept side-effect free so the page can re-derive
 * every derived view from a single fetch and so the helpers are unit-testable
 * without rendering React.
 *
 * Tier labels, colors, and `formatDuration` live in `lib/utils.ts` — this file
 * only hosts helpers that don't make sense outside the ride detail context.
 */

import type { QualityTier } from "@/lib/types";
import { QUALITY_CONFIG, QUALITY_TIERS, scoreToTier } from "@/lib/utils";

// Null-safe wrapper around `scoreToTier` from utils. Threshold-based so a
// reading of 4.5 maps to "excellent" — aligned with the rest of the app.
export function readingToTier(
  reading: number | null | undefined,
): QualityTier | null {
  if (reading == null || Number.isNaN(reading)) return null;
  return scoreToTier(reading);
}

export interface RideSegmentLike {
  road_name: string | null;
  quality_reading: number | null;
  speed_avg: number | null;
  speed_max?: number | null;
  lean_angle_max: number | null;
  length_m?: number | null;
  elevation_profile?: number[] | null;
}

export interface QualityBreakdownRow {
  tier: QualityTier;
  label: string;
  color: string;
  count: number;
  percent: number;
}

// Returns a fixed-order array (excellent → very-poor) with counts and integer
// percentages. Rows with zero count are included so the UI can render a full
// legend without extra work. Segments without a quality reading are ignored.
export function computeQualityBreakdown(
  segments: readonly RideSegmentLike[],
): QualityBreakdownRow[] {
  const counts: Record<QualityTier, number> = {
    excellent: 0,
    good: 0,
    fair: 0,
    poor: 0,
    "very-poor": 0,
  };
  let total = 0;
  for (const seg of segments) {
    const tier = readingToTier(seg.quality_reading);
    if (!tier) continue;
    counts[tier] += 1;
    total += 1;
  }
  return QUALITY_TIERS.map((tier) => {
    const count = counts[tier];
    const percent = total === 0 ? 0 : Math.round((count / total) * 100);
    const meta = QUALITY_CONFIG[tier];
    return { tier, label: meta.label, color: meta.hex, count, percent };
  });
}

export function formatNumber(
  value: number | null | undefined,
  digits = 0,
): string {
  if (value == null || Number.isNaN(value)) return "—";
  return value.toFixed(digits);
}

export interface RoutePoint {
  lat: number;
  lng: number;
}

export interface RoutePreview {
  path: string;
  viewBox: string;
  bounds: { minLng: number; minLat: number; maxLng: number; maxLat: number };
  width: number;
  height: number;
}

// Projects a route's lat/lng points to an SVG polyline fitted to `size`. Uses
// equirectangular projection scaled to preserve aspect ratio at the route's
// mean latitude — good enough for route previews at any reasonable zoom, and
// avoids pulling in a full projection lib. Returns `null` when the geometry
// has fewer than 2 usable points.
export function buildRoutePreview(
  geometry: readonly RoutePoint[] | null | undefined,
  size = 400,
  padding = 8,
): RoutePreview | null {
  if (!geometry || geometry.length < 2) return null;
  const valid = geometry.filter(
    (p) =>
      Number.isFinite(p.lat) &&
      Number.isFinite(p.lng) &&
      Math.abs(p.lat) <= 90 &&
      Math.abs(p.lng) <= 180,
  );
  if (valid.length < 2) return null;

  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLng = Infinity;
  let maxLng = -Infinity;
  for (const p of valid) {
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lng < minLng) minLng = p.lng;
    if (p.lng > maxLng) maxLng = p.lng;
  }

  const meanLat = (minLat + maxLat) / 2;
  const lngScale = Math.cos((meanLat * Math.PI) / 180);
  // Guard against degenerate bounds (single-point route or identical coords).
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

  const path = valid
    .map((p, i) => {
      const { x, y } = project(p);
      return `${i === 0 ? "M" : "L"}${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(" ");

  return {
    path,
    viewBox: `0 0 ${width + padding * 2} ${height + padding * 2}`,
    bounds: { minLng, minLat, maxLng, maxLat },
    width: width + padding * 2,
    height: height + padding * 2,
  };
}

export interface ElevationProfilePoint {
  distanceKm: number;
  elevationM: number;
}

export function buildElevationProfile(
  segments: readonly RideSegmentLike[],
): ElevationProfilePoint[] {
  const points: ElevationProfilePoint[] = [];
  let cumulativeKm = 0;

  for (const segment of segments) {
    const lengthKm =
      segment.length_m != null && Number.isFinite(segment.length_m)
        ? Math.max(segment.length_m / 1000, 0)
        : 0;
    const profile = segment.elevation_profile;
    if (
      !Array.isArray(profile) ||
      profile.length < 2 ||
      !profile.every(Number.isFinite)
    ) {
      cumulativeKm += lengthKm;
      continue;
    }

    const stepKm = lengthKm > 0 ? lengthKm / (profile.length - 1) : 0;

    profile.forEach((elevationM, index) => {
      if (points.length > 0 && index === 0) return;
      points.push({
        distanceKm: roundProfileDistance(cumulativeKm + stepKm * index),
        elevationM,
      });
    });

    cumulativeKm += lengthKm;
  }

  return points.length >= 2 ? points : [];
}

export interface SpeedProfilePoint {
  label: string;
  distanceKm: number;
  avgKmh: number | null;
  maxKmh: number | null;
}

export function buildSpeedProfile(
  segments: readonly RideSegmentLike[],
): SpeedProfilePoint[] {
  let cumulativeKm = 0;
  const points = segments.flatMap((segment, index) => {
    const lengthKm =
      segment.length_m != null && Number.isFinite(segment.length_m)
        ? Math.max(segment.length_m / 1000, 0)
        : 0;
    cumulativeKm += lengthKm;

    const avgKmh = finiteOrNull(segment.speed_avg);
    const maxKmh = finiteOrNull(segment.speed_max);
    if (avgKmh == null && maxKmh == null) return [];

    return [
      {
        label: segment.road_name ?? `Segment ${index + 1}`,
        distanceKm: roundProfileDistance(cumulativeKm || index + 1),
        avgKmh,
        maxKmh,
      },
    ];
  });

  return points;
}

function finiteOrNull(value: number | null | undefined): number | null {
  return value != null && Number.isFinite(value) ? value : null;
}

function roundProfileDistance(value: number): number {
  return Number(value.toFixed(3));
}
