/**
 * Pure helpers that derive presentation data for the ride detail page from
 * `GET /api/v1/rides/:rideId`. Kept side-effect free so the page can re-derive
 * every derived view from a single fetch and so the helpers are unit-testable
 * without rendering React.
 */

export const QUALITY_TIERS = [
  "excellent",
  "good",
  "fair",
  "poor",
  "very-poor",
] as const;
export type QualityTier = (typeof QUALITY_TIERS)[number];

export interface QualityTierMeta {
  tier: QualityTier;
  label: string;
  color: string;
  className: string;
}

export const QUALITY_TIER_META: Record<QualityTier, QualityTierMeta> = {
  excellent: {
    tier: "excellent",
    label: "Excellent",
    color: "#22C55E",
    className: "quality-excellent",
  },
  good: {
    tier: "good",
    label: "Good",
    color: "#84CC16",
    className: "quality-good",
  },
  fair: {
    tier: "fair",
    label: "Fair",
    color: "#EAB308",
    className: "quality-fair",
  },
  poor: {
    tier: "poor",
    label: "Poor",
    color: "#F97316",
    className: "quality-poor",
  },
  "very-poor": {
    tier: "very-poor",
    label: "Very poor",
    color: "#EF4444",
    className: "quality-very-poor",
  },
};

// Backend stores quality as a 1-5 reading. Map to tier using standard buckets:
// 5 → excellent, 4 → good, 3 → fair, 2 → poor, 1 → very-poor. Non-integer
// readings are floored so 3.7 counts as 3 (fair).
export function qualityReadingToTier(
  reading: number | null | undefined,
): QualityTier | null {
  if (reading == null || Number.isNaN(reading)) return null;
  const rounded = Math.floor(reading);
  if (rounded >= 5) return "excellent";
  if (rounded === 4) return "good";
  if (rounded === 3) return "fair";
  if (rounded === 2) return "poor";
  if (rounded <= 1) return "very-poor";
  return null;
}

export interface RideSegmentLike {
  road_name: string | null;
  quality_reading: number | null;
  speed_avg: number | null;
  lean_angle_max: number | null;
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
    const tier = qualityReadingToTier(seg.quality_reading);
    if (!tier) continue;
    counts[tier] += 1;
    total += 1;
  }
  return QUALITY_TIERS.map((tier) => {
    const count = counts[tier];
    const percent = total === 0 ? 0 : Math.round((count / total) * 100);
    const meta = QUALITY_TIER_META[tier];
    return { tier, label: meta.label, color: meta.color, count, percent };
  });
}

// Formats `duration_min` as "2h 15m" / "45m". Returns "—" for null/invalid so
// callers can render the raw value directly without conditionals.
export function formatDuration(minutes: number | null | undefined): string {
  if (minutes == null || Number.isNaN(minutes) || minutes < 0) return "—";
  const whole = Math.round(minutes);
  const hours = Math.floor(whole / 60);
  const mins = whole % 60;
  if (hours === 0) return `${mins}m`;
  if (mins === 0) return `${hours}h`;
  return `${hours}h ${mins}m`;
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
