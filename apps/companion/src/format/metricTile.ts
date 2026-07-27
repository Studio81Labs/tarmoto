import type { Formatters } from "@tarmoto/shared";

export type CompactMetricDuration =
  | { value: string; unit?: never; unitPosition?: never }
  | { value: string; unit: string; unitPosition: "after" };

/**
 * Keep a compound duration compact in a MetricTile without splitting inside
 * either locale-formatted measurement.
 */
export function splitCompactMetricDuration(
  min: number | null,
  format: Formatters,
): CompactMetricDuration {
  if (min == null) return { value: "—" };
  const total = Math.max(0, Math.round(min));
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  if (hours === 0 || minutes === 0) {
    return { value: format.durationCompact(total) };
  }
  return {
    value: format.durationCompact(hours * 60),
    unit: format.durationCompact(minutes),
    unitPosition: "after",
  };
}
