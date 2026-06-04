/**
 * Aggregate KPIs for a filtered set of the rider's rides, served by
 * `GET /rides/stats` with the SAME query params as `GET /rides`. Drives the
 * Ride History "All rides" KPI cards so they reflect the active filter
 * window (search / ride-type / time / distance / quality). Metric units.
 */
export interface RideStats {
  /** Sum of `distance_km` across the filtered, completed rides. */
  total_distance_km: number;
  /** Total ride time (hours) across the filtered, completed rides. */
  total_hours: number;
  /** Distinct road segments touched by the filtered rides ("new roads"). */
  new_roads: number;
  /** Distance-weighted average road quality (0–5), or null if unscored. */
  avg_quality: number | null;
  /** Number of rides matched by the filter (for context / empty states). */
  ride_count: number;
}
