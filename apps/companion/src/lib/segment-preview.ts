import type { RoutePreviewSegment } from "@/lib/types";

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

const CURVINESS_LABELS: readonly [number, string][] = [
  [80, "Very twisty"],
  [60, "Twisty"],
  [40, "Mixed"],
  [20, "Flowing"],
  [0, "Straight"],
];

export function curvinessLabel(score: number): string {
  for (const [threshold, label] of CURVINESS_LABELS) {
    if (score >= threshold) return label;
  }
  return "Straight";
}

export function formatElevationRange(profile: readonly number[]): string {
  if (profile.length === 0) return "—";
  let min = profile[0]!;
  let max = profile[0]!;
  for (const v of profile) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return `${Math.round(min)} – ${Math.round(max)} m`;
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
