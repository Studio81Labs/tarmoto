import type { Formatters } from "@tarmoto/shared";
import { splitCompactMetricDuration } from "@/format/metricTile";

/**
 * Keep a compound duration compact inside the dashboard MetricTile without
 * splitting inside either locale-formatted measurement.
 */
export function splitRideDetailDuration(
  min: number | null,
  format: Formatters,
) {
  return splitCompactMetricDuration(min, format);
}
