import type { QualitySource, SurfaceType } from "@tarmoto/shared";
import type { QualityTier, HazardType } from "@/lib/types";
import type { EnglishMessageKey } from "@/i18n";

// ── Surface ──

// Canonical English display labels for each surface enum value (the raw enum,
// e.g. "gravel", is not renderable copy). Translate at the render site via
// t(SURFACE_LABELS[surface]). Shared by the map legend and the planner's
// flagged-section cards so the surface word localizes consistently.
export const SURFACE_LABELS: Record<SurfaceType, EnglishMessageKey> = {
  asphalt: "Asphalt",
  concrete: "Concrete",
  cobblestone: "Cobblestone",
  gravel: "Gravel",
  dirt: "Dirt",
  unknown: "Unknown",
};

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
  { label: EnglishMessageKey; color: string; bg: string; hex: string }
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
): EnglishMessageKey | null {
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
  { label: EnglishMessageKey; emoji: string; hex: string }
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
