/**
 * Wire shape for `GET /users/me/stats/monthly` — the companion home
 * screen's four KPI tiles plus the mobile-sync pill.
 *
 * All figures are metric and scoped to the current calendar month (UTC),
 * with the previous month's totals included so the client can render
 * deltas ("+18% vs last month") in the rider's locale rather than the
 * server baking English strings. Backend `MonthlyStatsDto` implements
 * this interface; the companion consumes it via the generated client.
 */
export interface MonthlyStats {
  /** Sum of `distance_km` over completed rides started this month. */
  this_month_km: number;
  /** Same, for the previous calendar month (delta baseline). */
  prev_month_km: number;
  /** Ride time (hours) over completed rides this month. */
  ride_hours: number;
  /** Ride time (hours) the previous calendar month. */
  prev_ride_hours: number;
  /** Distinct road segments ridden this month. */
  new_roads: number;
  /**
   * Max lean angle (deg) recorded this month. Null when there is no lean data
   * for the month OR when the viewer lacks the `advanced_ride_stats` (Pro)
   * entitlement — lean is a paid stat, so a non-entitled caller receives null
   * even when data exists. Correlate with the feature snapshot to tell
   * "withheld" apart from "genuinely absent". Same for the two fields below.
   */
  max_lean_deg: number | null;
  /** Name of the ride that set this month's max lean, or null (see `max_lean_deg`). */
  max_lean_ride_name: string | null;
  /** ISO start timestamp of that ride, or null (see `max_lean_deg`). */
  max_lean_at: string | null;
  /** Most recent mobile upload (latest ride row), or null if never synced. */
  last_synced_at: string | null;
}
