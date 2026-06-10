/**
 * Wire shape for `GET /users/me/contribution` — the sidebar "Your
 * contribution" badge.
 *
 * "Mapped" distance is the rider's road-quality contribution: roads they've
 * uploaded sensor readings for (gated by `road_data_contribution`),
 * de-duplicated by segment so riding the same road twice doesn't double-count.
 * It is distinct from "distance ridden" — a rider can travel a road without
 * contributing quality data.
 *
 * The regional rank/percentile place the rider among others in their
 * `home_region` by the same metric, mirroring the leaderboard eligibility
 * (soft-deleted and `profile_visibility = 'private'` riders are excluded,
 * except the viewer themselves). All rank fields are `null` when the rider
 * has no `home_region` set or hasn't contributed anything yet.
 *
 * Backend `ContributionStatsDto` implements this interface; the companion
 * consumes it via the generated client.
 */
export interface ContributionStats {
  /** Distinct road-segment length the rider contributed quality data to, in km. */
  km_mapped: number;
  /** Count of distinct road segments the rider contributed quality data to. */
  segments_mapped: number;
  /** The rider's `home_region`, or `null` when unset. */
  home_region: string | null;
  /**
   * 1-based DENSE_RANK within `home_region` by `km_mapped`. `null` when the
   * rider has no region set or has contributed nothing.
   */
  rank_in_region: number | null;
  /** Riders ranked in the region (the rank denominator). `null` when unranked. */
  region_rider_count: number | null;
  /**
   * Region riders strictly below the viewer by `km_mapped`. The tie-aware
   * "ahead of someone" signal: `rank_in_region` is a DENSE_RANK, so comparing
   * it to `region_rider_count` can't tell a genuinely-last rider from one tied
   * behind others — this strict-less count can. `0` means the viewer is last
   * (or sole); `null` when unranked.
   */
  region_riders_behind: number | null;
  /**
   * "Top N%" = `ceil(rank_in_region / region_rider_count * 100)`, 1–100.
   * `null` when unranked.
   */
  percentile: number | null;
}
