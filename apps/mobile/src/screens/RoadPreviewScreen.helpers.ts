/**
 * Pure formatting helpers for RoadPreviewScreen.
 *
 * Kept in a separate module from the screen so tests can exercise them
 * without pulling React Native, navigation, or theme into the module graph.
 */

import type { LatLng } from '@/types';

export function formatLengthKm(m: number): string {
  if (!Number.isFinite(m) || m <= 0) return '';
  const rounded = Math.round(m);
  return rounded >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${rounded} m`;
}

export function formatSurface(surface: string): string {
  return surface.charAt(0).toUpperCase() + surface.slice(1);
}

export function formatHazardType(type: string): string {
  return type.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export function formatRelativeTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const diffS = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (diffS < 60) return 'just now';
  const mins = Math.floor(diffS / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

export function curvinessLabel(score: number): string {
  if (score >= 4.5) return 'Very twisty — a full-on playground.';
  if (score >= 3.5) return 'Plenty of curves to lean into.';
  if (score >= 2.5) return 'Mixed — sweepers with occasional straights.';
  if (score >= 1.5) return 'Mostly straight with a few bends.';
  return 'Straight, transit-style road.';
}

/**
 * Count the number of distinct curves in a road segment geometry.
 *
 * Approach:
 *   1. Walk the polyline leg-by-leg and collect the bearing of every leg
 *      that has positive length. Zero-length legs (duplicate GPS samples)
 *      are dropped so they don't split a turning stretch in two.
 *   2. Compare each adjacent bearing pair; a pair whose heading delta
 *      exceeds `turnThresholdDeg` marks a "turning" boundary.
 *   3. Coalesce consecutive turning boundaries so a single hairpin sampled
 *      as many tight bends still counts as one curve — we only increment
 *      when we enter a turning stretch from a straight one.
 *
 * This is a geometric approximation of the ML-derived curve_count used on
 * rides: coarser than a bank-angle-based count but stable, deterministic,
 * and doesn't need backend plumbing. Tuning notes:
 *   - `turnThresholdDeg` default (25°) was picked to ignore GPS noise on
 *     straightaways while still catching gentle sweepers.
 */
export function computeCurveCount(
  geometry: LatLng[],
  turnThresholdDeg = 25,
): number {
  if (!Array.isArray(geometry) || geometry.length < 3) return 0;

  const bearings: number[] = [];
  for (let i = 1; i < geometry.length; i++) {
    const b = bearingDeg(geometry[i - 1], geometry[i]);
    if (b !== null) bearings.push(b);
  }
  if (bearings.length < 2) return 0;

  let count = 0;
  let inTurn = false;
  for (let i = 1; i < bearings.length; i++) {
    const delta = Math.abs(
      normalizeBearingDelta(bearings[i] - bearings[i - 1]),
    );
    if (delta > turnThresholdDeg) {
      if (!inTurn) {
        count += 1;
        inTurn = true;
      }
    } else {
      inTurn = false;
    }
  }
  return count;
}

/**
 * Initial bearing (great-circle) from `from` → `to`, in degrees 0..360,
 * or `null` if the two points are coincident (within ~1 cm) — callers
 * treat a null leg as a GPS duplicate and skip it rather than synthesizing
 * a bearing from noise.
 */
function bearingDeg(from: LatLng, to: LatLng): number | null {
  const φ1 = (from.lat * Math.PI) / 180;
  const φ2 = (to.lat * Math.PI) / 180;
  const Δλ = ((to.lng - from.lng) * Math.PI) / 180;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x =
    Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  if (Math.abs(y) < 1e-12 && Math.abs(x) < 1e-12) return null;
  const θ = Math.atan2(y, x);
  return ((θ * 180) / Math.PI + 360) % 360;
}

/** Wrap a bearing difference to the range (-180, 180]. */
function normalizeBearingDelta(deltaDeg: number): number {
  let d = ((deltaDeg + 180) % 360) - 180;
  if (d <= -180) d += 360;
  return d;
}

/**
 * Normalize a quality breakdown into display-ready segments.
 * Filters out non-positive entries and returns an empty array if total ≤ 0.
 */
export function normalizeBreakdown<K extends string>(
  keys: readonly K[],
  breakdown: Record<K, number>,
): Array<{ key: K; pct: number }> {
  const total = keys.reduce(
    (acc, k) => acc + Math.max(0, breakdown[k] || 0),
    0,
  );
  if (total <= 0) return [];
  return keys
    .map((k) => ({ key: k, pct: Math.max(0, breakdown[k] || 0) / total }))
    .filter((e) => e.pct > 0);
}

/**
 * True only when the profile has ≥2 finite samples that are all equal —
 * i.e. the road really is level. Degenerate inputs (fewer than 2 finite
 * samples) return `false` so callers don't mislabel insufficient data as
 * "flat"; they're expected to hide the chart block entirely in that case.
 */
export function isFlatElevationProfile(elevations: readonly number[]): boolean {
  if (!Array.isArray(elevations) || elevations.length < 2) return false;
  let finiteCount = 0;
  let first: number | null = null;
  for (const v of elevations) {
    if (!Number.isFinite(v)) continue;
    finiteCount++;
    if (first === null) first = v;
    else if (v !== first) return false;
  }
  return finiteCount >= 2;
}

/**
 * Sum of positive / negative elevation deltas along the profile, in meters.
 * Used by RoadPreview to surface ascent/descent next to the elevation chart
 * without re-running it from `geometry`. NaN/Infinity samples are skipped so
 * a single bad reading can't poison the rolling totals.
 */
export function computeElevationStats(elevations: readonly number[]): {
  ascent: number;
  descent: number;
} {
  if (!Array.isArray(elevations) || elevations.length < 2) {
    return { ascent: 0, descent: 0 };
  }
  let ascent = 0;
  let descent = 0;
  let prev: number | null = null;
  for (const sample of elevations) {
    if (!Number.isFinite(sample)) continue;
    if (prev !== null) {
      const delta = sample - prev;
      if (delta > 0) ascent += delta;
      else descent += -delta;
    }
    prev = sample;
  }
  return { ascent, descent };
}

/**
 * Project an elevation profile onto a chart of `width × height` and return
 * SVG path strings: `line` for the polyline and `area` for a filled region
 * down to the baseline. Uses the actual sample min/max for the y-domain so
 * tiny variation still renders as a visible curve. Returns `null` when the
 * profile is too short (< 2 finite samples) or has zero range — callers
 * skip rendering the chart in that case.
 */
export function buildElevationChartPaths(
  elevations: readonly number[],
  width: number,
  height: number,
): { line: string; area: string; min: number; max: number } | null {
  if (!Array.isArray(elevations) || elevations.length < 2) return null;
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
  if (width <= 0 || height <= 0) return null;

  const finite = elevations.filter((v) => Number.isFinite(v));
  if (finite.length < 2) return null;

  let min = finite[0];
  let max = finite[0];
  for (const v of finite) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  // A perfectly flat profile would degenerate the line to the bottom edge —
  // bail out so the caller can show a "flat" hint instead of a misleading
  // chart pinned to one pixel row.
  if (max - min === 0) return null;

  const span = max - min;
  const stepX = width / (elevations.length - 1);
  const points: Array<{ x: number; y: number }> = [];
  let prevY = height;
  for (let i = 0; i < elevations.length; i++) {
    const v = elevations[i];
    const x = i * stepX;
    // Forward-fill non-finite samples so a single dropped reading doesn't
    // create a chart gap; the path stays continuous and visually plausible.
    const y = Number.isFinite(v) ? height - ((v - min) / span) * height : prevY;
    points.push({ x, y });
    prevY = y;
  }

  const line = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${fmt(p.x)} ${fmt(p.y)}`)
    .join(' ');
  const area =
    `M${fmt(points[0].x)} ${fmt(height)} ` +
    points.map((p) => `L${fmt(p.x)} ${fmt(p.y)}`).join(' ') +
    ` L${fmt(points[points.length - 1].x)} ${fmt(height)} Z`;

  return { line, area, min, max };
}

function fmt(n: number): string {
  return Number.isFinite(n) ? n.toFixed(2) : '0';
}
