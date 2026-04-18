/**
 * Tarmoto Design System
 * Brand colors, typography, spacing, and component styles.
 */

export const colors = {
  // Brand
  primary: "#0ED3CF",
  primaryDark: "#0A9E9B",
  primaryLight: "#5DE8E5",
  primaryAlpha15: "rgba(14, 211, 207, 0.15)",
  primaryAlpha08: "rgba(14, 211, 207, 0.08)",

  // Backgrounds
  bg: "#070A10",
  bgCard: "#0C1018",
  bgSurface: "#111827",
  bgElevated: "#1A2235",
  bgInput: "#222D42",

  // Text
  textPrimary: "#E8ECF2",
  textSecondary: "#8B95A8",
  textTertiary: "#4A5568",
  textInverse: "#070A10",

  // Borders
  border: "rgba(255, 255, 255, 0.06)",
  borderLight: "rgba(255, 255, 255, 0.12)",
  borderFocus: "rgba(14, 211, 207, 0.4)",

  // Road Quality Scale
  quality: {
    excellent: "#22C55E",
    good: "#84CC16",
    fair: "#EAB308",
    poor: "#F97316",
    veryPoor: "#EF4444",
  },

  // Quality with alpha
  qualityAlpha: {
    excellent: "rgba(34, 197, 94, 0.15)",
    good: "rgba(132, 204, 22, 0.15)",
    fair: "rgba(234, 179, 8, 0.15)",
    poor: "rgba(249, 115, 22, 0.15)",
    veryPoor: "rgba(239, 68, 68, 0.15)",
  },

  // Semantic
  success: "#22C55E",
  warning: "#EAB308",
  danger: "#EF4444",
  info: "#3B82F6",

  // Common
  white: "#FFFFFF",
  black: "#000000",
  transparent: "transparent",
} as const;

export const fonts = {
  // Using system fonts for React Native performance
  // Replace with custom fonts if loading Outfit
  regular: undefined, // falls back to system
  medium: undefined,
  semibold: undefined,
  bold: undefined,
  black: undefined,
} as const;

export const fontSize = {
  xs: 10,
  sm: 12,
  md: 14,
  lg: 16,
  xl: 18,
  xxl: 22,
  h3: 18,
  h2: 24,
  h1: 32,
  hero: 36,
} as const;

export const fontWeight = {
  regular: "400" as const,
  medium: "500" as const,
  semibold: "600" as const,
  bold: "700" as const,
  extrabold: "800" as const,
  black: "900" as const,
};

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
  xxxl: 32,
  section: 40,
} as const;

export const borderRadius = {
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  pill: 100,
} as const;

export const shadows = {
  card: {
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 12,
    elevation: 8,
  },
  button: {
    shadowColor: "#0ED3CF",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.2,
    shadowRadius: 16,
    elevation: 6,
  },
} as const;

/**
 * Map quality score (1-5) to color
 */
export function qualityColor(score: number): string {
  if (score >= 4.5) return colors.quality.excellent;
  if (score >= 3.5) return colors.quality.good;
  if (score >= 2.5) return colors.quality.fair;
  if (score >= 1.5) return colors.quality.poor;
  return colors.quality.veryPoor;
}

/**
 * Map quality score to label
 */
export function qualityLabel(score: number): string {
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
  score: number,
  minQuality: number,
): boolean {
  if (!Number.isFinite(score)) return false;
  return score >= minQuality - 0.5;
}

/**
 * Color for a quality score given the rider's minimum threshold. Segments
 * below the threshold are rendered with the tertiary text color so they
 * recede visually — this is the "gray/excluded" behaviour from US-5.
 */
export function qualityColorWithThreshold(
  score: number,
  minQuality: number,
): string {
  if (!meetsQualityThreshold(score, minQuality)) return colors.textTertiary;
  return qualityColor(score);
}

/**
 * Map hazard type to icon name (@react-native-vector-icons/material-design-icons)
 */
export const hazardIcons: Record<string, string> = {
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
