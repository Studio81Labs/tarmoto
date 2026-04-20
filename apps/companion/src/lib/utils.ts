import { kmToMiles, metersToFeet, type UnitSystem } from "@tarmoto/shared";
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

// ── Hazard Types ──

export const HAZARD_CONFIG: Record<
  HazardType,
  { label: string; emoji: string }
> = {
  pothole: { label: "Pothole", emoji: "🕳️" },
  gravel: { label: "Gravel", emoji: "🪨" },
  oil_spill: { label: "Oil spill", emoji: "🛢️" },
  roadworks: { label: "Roadworks", emoji: "🚧" },
  animals: { label: "Animals", emoji: "🦌" },
  police: { label: "Police", emoji: "👮" },
  flooding: { label: "Flooding", emoji: "🌊" },
  ice: { label: "Ice", emoji: "🧊" },
};

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

export function formatDuration(minutes: number | null | undefined): string {
  if (minutes == null || Number.isNaN(minutes) || minutes < 0) return "—";
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  if (h === 0) return `${m} min`;
  return `${h}h ${m}m`;
}

export function formatElevation(meters: number): string {
  return `${Math.round(meters)} m`;
}

export function formatSpeed(kmh: number): string {
  return `${Math.round(kmh)} km/h`;
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

export function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return formatDate(iso);
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
