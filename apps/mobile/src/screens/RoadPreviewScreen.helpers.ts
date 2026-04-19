/**
 * Pure formatting helpers for RoadPreviewScreen.
 *
 * Kept in a separate module from the screen so tests can exercise them
 * without pulling React Native, navigation, or theme into the module graph.
 */

import type { LatLng } from "@/types";

export function formatLengthKm(m: number): string {
  if (!Number.isFinite(m) || m <= 0) return "";
  const rounded = Math.round(m);
  return rounded >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${rounded} m`;
}

export function formatSurface(surface: string): string {
  return surface.charAt(0).toUpperCase() + surface.slice(1);
}

export function formatHazardType(type: string): string {
  return type.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export function formatRelativeTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const diffS = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (diffS < 60) return "just now";
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
  if (score >= 4.5) return "Very twisty — a full-on playground.";
  if (score >= 3.5) return "Plenty of curves to lean into.";
  if (score >= 2.5) return "Mixed — sweepers with occasional straights.";
  if (score >= 1.5) return "Mostly straight with a few bends.";
  return "Straight, transit-style road.";
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
    if (delta >= turnThresholdDeg) {
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
