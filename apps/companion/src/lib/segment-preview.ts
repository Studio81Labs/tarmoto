import type { RoutePreviewSegment } from "@/lib/types";
import type { EnglishMessageKey } from "@/i18n";
import { formatSplitValueUnitRange, type Formatters } from "@tarmoto/shared";

/**
 * Build the `d` attribute of an SVG path for a sparkline rendered inside the
 * box `[0, width] × [0, height]`. Flat inputs render as a horizontal middle
 * line so callers don't have to special-case zero variance.
 */
export function buildSparklinePath(
  values: readonly number[],
  width: number,
  height: number,
): string {
  if (values.length === 0 || width <= 0 || height <= 0) return "";
  if (values.length === 1) {
    const y = height / 2;
    return `M 0 ${y} L ${width} ${y}`;
  }

  let min = values[0]!;
  let max = values[0]!;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }

  const span = max - min;
  const xStep = width / (values.length - 1);

  return values
    .map((v, i) => {
      const x = i * xStep;
      const y = span === 0 ? height / 2 : height - ((v - min) / span) * height;
      return `${i === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(" ");
}

const CURVINESS_LABELS: readonly [number, EnglishMessageKey][] = [
  [80, "Very twisty"],
  [60, "Twisty"],
  [40, "Mixed"],
  [20, "Flowing"],
  [0, "Straight"],
];

export function curvinessLabel(score: number): EnglishMessageKey {
  for (const [threshold, label] of CURVINESS_LABELS) {
    if (score >= threshold) return label;
  }
  return "Straight";
}

/**
 * Return the min and max of a profile using a for-loop so arrays larger
 * than the JS argument limit (~65K in V8) can't crash with a spread-based
 * `Math.min(...arr)`. Elevation profiles are aligned with segment geometry
 * vertices, which can exceed that limit on long detailed roads.
 */
export function profileExtrema(
  profile: readonly number[],
): { min: number; max: number } | null {
  if (profile.length === 0) return null;
  let min = profile[0]!;
  let max = profile[0]!;
  for (const v of profile) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return { min, max };
}

export function formatElevationRange(
  profile: readonly number[],
  format: Formatters,
): string {
  const ext = profileExtrema(profile);
  if (!ext) return "—";
  const min = format.splitElevation(ext.min);
  const max = format.splitElevation(ext.max);
  return formatSplitValueUnitRange(min, max);
}

export function segmentHazardSeverity(
  segment: Pick<RoutePreviewSegment, "activeHazards">,
): "none" | "low" | "medium" | "high" {
  if (segment.activeHazards.length === 0) return "none";
  const seen = new Set(segment.activeHazards.map((h) => h.severity));
  if (seen.has("high")) return "high";
  if (seen.has("medium")) return "medium";
  return "low";
}
