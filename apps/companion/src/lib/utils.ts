import {
  kmToMiles,
  metersToFeet,
  type UnitSystem,
  type QualitySource,
} from "@tarmoto/shared";
import type { QualityTier, HazardType } from "@/lib/types";

// ── Road Quality ──

// Canonical ordering used everywhere the app renders tier lists (legends,
// breakdown charts, filter panels). Keep this in sync with the `QualityTier`
// string union.
export const QUALITY_TIERS = [
  "excellent",
  "good",
  "fair",
  "poor",
  "very-poor",
] as const satisfies readonly QualityTier[];

export const QUALITY_CONFIG: Record<
  QualityTier,
  { label: string; color: string; bg: string; hex: string }
> = {
  excellent: {
    label: "Excellent",
    color: "text-quality-excellent",
    bg: "bg-quality-excellent",
    hex: "#22C55E",
  },
  good: {
    label: "Good",
    color: "text-quality-good",
    bg: "bg-quality-good",
    hex: "#84CC16",
  },
  fair: {
    label: "Fair",
    color: "text-quality-fair",
    bg: "bg-quality-fair",
    hex: "#EAB308",
  },
  poor: {
    label: "Poor",
    color: "text-quality-poor",
    bg: "bg-quality-poor",
    hex: "#F97316",
  },
  "very-poor": {
    label: "Very Poor",
    color: "text-quality-very-poor",
    bg: "bg-quality-very-poor",
    hex: "#EF4444",
  },
};

export function scoreToTier(score: number): QualityTier {
  if (score >= 4.5) return "excellent";
  if (score >= 3.5) return "good";
  if (score >= 2.5) return "fair";
  if (score >= 1.5) return "poor";
  return "very-poor";
}

export function scoreToColor(score: number): string {
  return QUALITY_CONFIG[scoreToTier(score)].color;
}

/**
 * Road-detail provenance label — "estimated" only while a segment's quality
 * is still purely OSM-seeded (no rider reports); null once riders back the
 * blended score with real readings (design 2026-07-15). Mirrors
 * `apps/mobile/src/theme/index.ts`'s `qualityProvenanceLabel` — keep both in
 * sync if the copy changes.
 */
export function qualityProvenanceLabel(
  source: QualitySource | null,
  readingCount: number,
): string | null {
  if (readingCount > 0 || source === null) return null;
  switch (source) {
    case "osm_smoothness":
      return "Estimated from surveyed smoothness";
    case "osm_surface":
      return "Estimated from road surface";
    case "osm_highway":
      return "Estimated from road type";
    default:
      return null;
  }
}

// ── Hazard Types ──

// Canonical ordering for hazard UI (filter checkboxes, legend, URL encoding).
// Keeps `other` last so the common types stay grouped at the top of lists.
export const HAZARD_TYPES_UI = [
  "pothole",
  "gravel",
  "oil_spill",
  "roadworks",
  "animals",
  "police",
  "flooding",
  "ice",
  "other",
] as const satisfies readonly HazardType[];

// Single source of truth for hazard labels, emoji, and fill colors — consumed
// directly by the map layer expression, popup/legend renderers, and the
// filter sidebar. Change here and everything follows.
export const HAZARD_CONFIG: Record<
  HazardType,
  { label: string; emoji: string; hex: string }
> = {
  pothole: { label: "Pothole", emoji: "🕳️", hex: "#ef4444" },
  gravel: { label: "Gravel", emoji: "🪨", hex: "#f59e0b" },
  oil_spill: { label: "Oil spill", emoji: "🛢️", hex: "#78350f" },
  roadworks: { label: "Roadworks", emoji: "🚧", hex: "#facc15" },
  animals: { label: "Animals", emoji: "🦌", hex: "#84cc16" },
  police: { label: "Police", emoji: "👮", hex: "#3b82f6" },
  flooding: { label: "Flooding", emoji: "🌊", hex: "#0ea5e9" },
  ice: { label: "Ice", emoji: "🧊", hex: "#67e8f9" },
  other: { label: "Other", emoji: "⚠️", hex: "#94a3b8" },
};

// Opacity for a hazard marker based on its age. Fresh reports render fully
// opaque; opacity falls linearly toward `min` as the hazard approaches its
// expiry timestamp. Returns `min` past expiry so stale rows stay visible but
// muted. Expiry windows differ per hazard type on the backend (24–72 h), so we
// interpolate against the actual `created_at` → `expires_at` span rather than
// hard-coding a duration.
export function hazardFadeOpacity(
  createdAtIso: string,
  expiresAtIso: string,
  now: number = Date.now(),
  min: number = 0.35,
): number {
  const created = new Date(createdAtIso).getTime();
  const expires = new Date(expiresAtIso).getTime();
  if (!Number.isFinite(created) || !Number.isFinite(expires)) return 1;
  const span = expires - created;
  if (span <= 0) return 1;
  const age = now - created;
  if (age <= 0) return 1;
  if (age >= span) return min;
  return 1 - (1 - min) * (age / span);
}

// ── Formatting ──

// Single cutover point between feet and miles in imperial mode, expressed in
// metres so both distance formatters can reference it directly. 160.934 m is
// exactly 0.1 mi.
const IMPERIAL_FEET_CUTOFF_M = 160.934;

/**
 * Distance formatter used across the companion dashboard. The metric branch
 * matches the pre-existing `formatDistance(km)` output exactly so callers
 * that don't opt into a unit system render as before (short distances in
 * metres, km with one decimal, zero → `"0 m"`). The only new metric
 * behaviour is a defensive fallback for NaN / negative inputs, which
 * weren't meaningfully supported either way.
 *
 * The imperial branch is new: a tiered label (sub-0.1 mi in feet, 1–10 mi
 * with one decimal, ≥10 mi whole) that pages opt into by passing `units`.
 *
 * NOTE: `@tarmoto/shared` exports a simpler `formatDistance` too. Always
 * import from `@/lib/utils` inside the companion so the dashboard renders
 * distances consistently. The shared version is meant for contexts (e.g.
 * mobile) that don't need the imperial branch.
 */
export function formatDistance(
  km: number,
  units: UnitSystem = "metric",
): string {
  if (units === "imperial") {
    if (!Number.isFinite(km) || km <= 0) return "0 mi";
    const meters = km * 1000;
    if (meters < IMPERIAL_FEET_CUTOFF_M) {
      return `${metersToFeet(meters)} ft`;
    }
    const mi = kmToMiles(km);
    if (mi < 10) return `${mi.toFixed(1)} mi`;
    return `${mi.toFixed(0)} mi`;
  }
  if (!Number.isFinite(km) || km < 0) return "0 m";
  if (km < 1) return `${Math.round(km * 1000)} m`;
  return `${km.toFixed(1)} km`;
}

/**
 * Speed (backend km/h) as a rounded value + uppercased unit, honouring the
 * rider's unit preference (km/h vs mph). For MetricTile-style displays that
 * format the number themselves.
 */
export function splitFormattedSpeed(
  kmh: number,
  units: UnitSystem = "metric",
): { value: number; unit: string } {
  return units === "imperial"
    ? { value: Math.round(kmToMiles(kmh)), unit: "MPH" }
    : { value: Math.round(kmh), unit: "KM/H" };
}

/**
 * Elevation (backend metres) as a rounded value + uppercased unit, honouring
 * the rider's unit preference (m vs ft).
 */
export function splitFormattedElevation(
  meters: number,
  units: UnitSystem = "metric",
): { value: number; unit: string } {
  return units === "imperial"
    ? { value: Math.round(metersToFeet(meters)), unit: "FT" }
    : { value: Math.round(meters), unit: "M" };
}

/**
 * Thin wrapper for sources whose native unit is metres (road segment lengths,
 * distance-to-point from /exploration/nearby-unridden). Kept next to
 * `formatDistance` so a single display rule covers both shapes.
 */
export function formatDistanceFromMeters(
  meters: number,
  units: UnitSystem = "metric",
): string {
  if (!Number.isFinite(meters) || meters <= 0) {
    return units === "imperial" ? "0 ft" : "0 m";
  }
  if (units === "imperial" && meters < IMPERIAL_FEET_CUTOFF_M) {
    return `${metersToFeet(meters)} ft`;
  }
  if (units === "metric" && meters < 1000) {
    return `${Math.round(meters)} m`;
  }
  return formatDistance(meters / 1000, units);
}

/**
 * Round a backend road-quality score (0–5 scale) to a 1–5 QualityBars tier,
 * or null when there's no score. Canonical home for this clamp — new code
 * should import this rather than re-deriving it.
 */
export function scoreToQualityTier(
  q: number | null | undefined,
): 1 | 2 | 3 | 4 | 5 | null {
  if (q == null) return null;
  return Math.min(5, Math.max(1, Math.round(q))) as 1 | 2 | 3 | 4 | 5;
}

export function roundCoordinate(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

/**
 * Keep only the rides whose `started_at` falls in the window (now − days …
 * now], preserving input order. Both bounds matter: the lower cutoff keeps
 * the home "Last 30 days" heading truthful (a rider whose latest ride is
 * older than the window gets an empty list), and the `<= now` upper bound
 * drops future-dated rides (clock skew / GPX import) so an impossible ride
 * can't render under that heading. The caller keeps the unwindowed list
 * for the returning-vs-first-time check. `now` is injectable for tests.
 */
export function ridesWithinDays<T extends { started_at: string }>(
  rides: T[],
  days: number,
  now: number = Date.now(),
): T[] {
  const cutoff = now - days * 24 * 60 * 60 * 1000;
  return rides.filter((r) => {
    const t = new Date(r.started_at).getTime();
    return t >= cutoff && t <= now;
  });
}

export function formatRideType(value: string): string {
  if (!value) return "Ride";
  return value.charAt(0).toUpperCase() + value.slice(1);
}

// ── Confidence ──

export function confidenceLabel(confidence: number): string {
  if (confidence >= 0.8) return "High";
  if (confidence >= 0.5) return "Medium";
  return "Low";
}

export function confidenceColor(confidence: number): string {
  if (confidence >= 0.8) return "text-quality-excellent";
  if (confidence >= 0.5) return "text-quality-fair";
  return "text-quality-poor";
}
