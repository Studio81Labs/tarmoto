/**
 * Neutral, theme-agnostic domain helpers shared across surfaces — quality
 * labels and thresholds, the fuel-range grid, hazard icon names, and duration
 * formatting.
 *
 * Design tokens (colours, typography, spacing, the quality colour ramp) live
 * in `./brand` — the canonical Atlas brand system. The legacy cyan palette and
 * its `qualityColor` ramp were retired once every surface moved to the brand
 * tokens; this module is deliberately colour-free so it can't reintroduce a
 * second source of truth.
 */

import type { IconName } from "@/components/Icon";

/**
 * Map quality score to label
 */
export function qualityLabel(score: number | null): string {
  if (score == null) return "Unscored";
  if (score >= 4.5) return "Excellent";
  if (score >= 3.5) return "Good";
  if (score >= 2.5) return "Fair";
  if (score >= 1.5) return "Poor";
  return "Very Poor";
}

/**
 * Smallest allowed minimum-quality threshold. `1` means "show everything";
 * `5` means "only Excellent". Keep in sync with the UI slider range.
 */
export const MIN_QUALITY_BOUNDS = { min: 1, max: 5 } as const;

/**
 * Rider-declared fuel range in kilometres. Used by US-10 to flag day
 * routes whose longest fuel-to-fuel leg outruns the bike's tank. The
 * bounds match the coarsest useful bracket — 50 km below is noise for
 * motorcycle planning, 1000 km above is beyond any stock tank we care
 * about. Snapped to 50 km steps by the preferences setter.
 */
export const FUEL_RANGE_BOUNDS = { min: 50, max: 1000 } as const;

/** Step between pill selections on the fuel-range picker. */
export const FUEL_RANGE_STEP_KM = 50;

/** Default range for a mid-size adventure bike — plenty of safety margin. */
export const DEFAULT_FUEL_RANGE_KM = 250;

/**
 * Snap an arbitrary km value onto the fuel-range grid (50..1000 in
 * 50 km steps). Shared between the preferences setter and the picker
 * so the stored value and the highlighted pill can't drift apart —
 * in particular, both agree on the NaN/Infinity fallback
 * (`DEFAULT_FUEL_RANGE_KM`).
 */
export function clampFuelRangeKm(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_FUEL_RANGE_KM;
  const snapped = Math.round(value / FUEL_RANGE_STEP_KM) * FUEL_RANGE_STEP_KM;
  return Math.max(
    FUEL_RANGE_BOUNDS.min,
    Math.min(FUEL_RANGE_BOUNDS.max, snapped),
  );
}

/**
 * Does a segment's quality score pass the rider's minimum-label threshold?
 *
 * The threshold is expressed as an integer that matches `qualityLabel`'s
 * buckets (1 = Very Poor, …, 5 = Excellent). Because `qualityLabel` uses
 * half-point boundaries (≥ 4.5 is Excellent, ≥ 3.5 is Good, …), we must
 * compare against the bucket's lower edge (`minQuality - 0.5`) rather than
 * the integer itself. Otherwise a 2.8-scored road would be labeled "Fair"
 * yet fail a "Fair or better" filter, which is what the UI promises.
 */
export function meetsQualityThreshold(
  score: number | null,
  minQuality: number,
): boolean {
  if (score == null || !Number.isFinite(score)) return false;
  return score >= minQuality - 0.5;
}

/**
 * Map hazard type to a Tarmoto icon name (see `@/components/Icon`). Typed as
 * `IconName` so a hazard pointing at a glyph the registry doesn't define is a
 * compile error rather than a blank icon at runtime.
 */
export const hazardIcons: Record<string, IconName> = {
  pothole: "circle-off-outline",
  gravel: "grain",
  oil_spill: "water-alert",
  roadworks: "hammer-wrench",
  animals: "paw",
  police: "shield-alert",
  flooding: "waves",
  ice: "snowflake",
  other: "alert-circle",
};

/**
 * Format a duration expressed in seconds as `mm:ss` (or `h:mm:ss` past the
 * hour mark). Non-finite / negative inputs collapse to `0:00` so UI
 * surfaces never render `NaN:NaN`. Fractional seconds are floored so a
 * sub-second tick doesn't round up into the next minute.
 *
 * Shared across the CarPlay ride board and any on-phone HUD that renders
 * an active-ride duration — keeping one copy here prevents the two
 * surfaces from drifting when edge-case handling changes.
 */
export function formatDurationSeconds(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return "0:00";
  const seconds = Math.floor(totalSeconds);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) {
    return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  }
  return `${m}:${s.toString().padStart(2, "0")}`;
}
