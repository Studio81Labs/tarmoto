import type { QualityBand } from "./types";

/**
 * Route-quality band vocabulary for the Plan & inspect planner, per the
 * Web App v2 (Full) design frames — harmonized with the cream palette.
 * Single source of truth: the map line, quality strip, flagged cards, and
 * preview card all read from here.
 */
export const QUALITY_BAND_COLORS: Record<QualityBand, string> = {
  good: "#5FB97E",
  fair: "#E8A93C",
  rough: "#E05A3C",
  no_data: "#A89D8B",
};

export const QUALITY_BAND_LABELS: Record<QualityBand, string> = {
  good: "Good or better",
  fair: "Fair",
  rough: "Rough",
  no_data: "No data",
};

/** Short variants used where space is tight (map legend, preview header). */
export const QUALITY_BAND_LABELS_SHORT: Record<QualityBand, string> = {
  good: "Good+",
  fair: "Fair",
  rough: "Rough",
  no_data: "No data",
};

export const GOOD_BAND_MIN_SCORE = 3.5;
export const FAIR_BAND_MIN_SCORE = 2.5;

/**
 * A score backed by this many rider passes or fewer is presented as
 * provisional: dimmed numeric plus a "LOW CONFIDENCE · N PASSES" note.
 */
export const LOW_CONFIDENCE_MAX_PASSES = 3;

export function scoreToBand(score: number | null): QualityBand {
  if (score == null) return "no_data";
  if (score >= GOOD_BAND_MIN_SCORE) return "good";
  if (score >= FAIR_BAND_MIN_SCORE) return "fair";
  return "rough";
}

export function isLowConfidence(passes: number): boolean {
  return passes <= LOW_CONFIDENCE_MAX_PASSES;
}
