import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import {
  DimensionLeaderboardDto,
  LeaderboardDimension,
  RegionalLeaderboardEntryDto,
  RegionalLeaderboardsResponseDto,
} from './dto/leaderboards.dto.js';

interface RankedRow {
  user_id: string;
  display_name: string;
  home_region: string | null;
  value: string | number | null;
  rank: string | number;
  /**
   * True iff this row is the signed-in rider's row appended outside the
   * top-N window. False for top-N rows (whether or not they happen to
   * match the current user). Lets the JS partition the combined query
   * result without re-comparing user ids.
   */
  extra_me: boolean;
}

interface DimensionConfig {
  dimension: LeaderboardDimension;
  unit: string;
  /**
   * SELECT producing `(user_id, value)` per rider for this dimension. Wrapped
   * as the `dim_values` CTE in `cteHeader` so the privacy/region filter is
   * applied identically for every dimension. The GROUP BY only emits riders
   * with at least one matching row, so the eligible CTE can INNER-JOIN it.
   */
  sourceCte: string;
}

const DIMENSIONS: readonly DimensionConfig[] = [
  {
    dimension: 'total_distance_km',
    unit: 'km',
    sourceCte: `
      SELECT user_id, COALESCE(SUM(distance_km), 0)::float AS value
      FROM rides
      WHERE status = 'completed'
      GROUP BY user_id
    `,
  },
  {
    dimension: 'roads_discovered',
    unit: 'roads',
    sourceCte: `
      SELECT r.user_id, COUNT(DISTINCT rs.road_segment_id)::float AS value
      FROM ride_segments rs
      INNER JOIN rides r ON r.id = rs.ride_id
      WHERE r.status = 'completed' AND rs.road_segment_id IS NOT NULL
      GROUP BY r.user_id
    `,
  },
  {
    dimension: 'hazards_reported',
    unit: 'reports',
    sourceCte: `
      SELECT user_id, COUNT(*)::float AS value
      FROM hazard_reports
      WHERE moderation_status = 'visible'
      GROUP BY user_id
    `,
  },
];

/**
 * Multi-dimensional regional leaderboards (US-57 follow-up to #302).
 *
 * Computes top-N riders for distance / roads-discovered / hazards-reported,
 * optionally filtered to a `home_region`. Each dimension also returns the
 * signed-in rider's row when they have a non-zero score even if they're
 * outside the top N — that's what powers the dashboard's "Your rank" pill.
 *
 * Privacy: riders with `profile_visibility = 'private'` and soft-deleted
 * accounts are excluded everywhere, matching the community feed (#279).
 */
@Injectable()
export class LeaderboardsService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async getRegional(opts: {
    region?: string | undefined;
    limit?: number | undefined;
    currentUserId?: string | undefined;
  }): Promise<RegionalLeaderboardsResponseDto> {
    const limit = opts.limit ?? 20;
    const regionRaw = opts.region?.trim() ?? '';
    const region = regionRaw.length > 0 ? regionRaw : null;
    const currentUserId = opts.currentUserId ?? null;

    const dims = await Promise.all(
      DIMENSIONS.map((cfg) =>
        this.getDimension(cfg, region, limit, currentUserId),
      ),
    );
    const byKey = new Map(dims.map((d) => [d.dimension, d]));

    return {
      region,
      generated_at: new Date().toISOString(),
      total_distance_km: byKey.get('total_distance_km')!,
      roads_discovered: byKey.get('roads_discovered')!,
      hazards_reported: byKey.get('hazards_reported')!,
    };
  }

  private async getDimension(
    cfg: DimensionConfig,
    region: string | null,
    limit: number,
    currentUserId: string | null,
  ): Promise<DimensionLeaderboardDto> {
    const rows = await this.queryDimension(cfg, region, limit, currentUserId);

    const entries = rows.filter((r) => !r.extra_me).map((r) => this.toEntry(r));
    // Reuse the in-list me row when present so rank/value match exactly the
    // top-N rendering (same query, same tiebreakers).
    const meFromTop = currentUserId
      ? (entries.find((e) => e.user_id === currentUserId) ?? null)
      : null;
    const meExtraRow = rows.find((r) => r.extra_me);
    const me = meFromTop ?? (meExtraRow ? this.toEntry(meExtraRow) : null);

    return { dimension: cfg.dimension, unit: cfg.unit, entries, me };
  }

  /**
   * Single round-trip per dimension that returns the top-N rows plus, when
   * applicable, the signed-in rider's row appended outside that window. The
   * `dim_values → eligible → ranked` pipeline runs once and is reused for
   * both branches, so a signed-in viewer pays one CTE evaluation per
   * dimension instead of two.
   *
   * `currentUserId` is forwarded as `$3::uuid`; passing `null` makes the
   * me-row branch match nothing, which is the same as not running it. The
   * me-row branch is also gated on `rn > $2` so a rider already in the
   * top-N doesn't appear twice — that case is handled in the caller via
   * `meFromTop` over the existing top-N rows.
   */
  private async queryDimension(
    cfg: DimensionConfig,
    region: string | null,
    limit: number,
    currentUserId: string | null,
  ): Promise<RankedRow[]> {
    // ORDER BY on a UNION ALL can only reference output columns of the
    // combined result, not internal CTE columns — sorting by `value DESC,
    // user_id ASC` reproduces the same order the `rn` row-number window
    // imposes inside `ranked`, but using columns that exist in the SELECT
    // list of both branches.
    const sql = `
      ${this.cteHeader(cfg)}
      SELECT user_id, display_name, home_region, value, rank, false AS extra_me
      FROM ranked
      WHERE rn <= $2
      UNION ALL
      SELECT user_id, display_name, home_region, value, rank, true AS extra_me
      FROM ranked
      WHERE $3::uuid IS NOT NULL AND user_id = $3::uuid AND rn > $2
      ORDER BY extra_me ASC, value DESC, user_id ASC
    `;
    return await this.dataSource.query<RankedRow[]>(sql, [
      region,
      limit,
      currentUserId,
    ]);
  }

  /**
   * Common CTE prefix shared across all dimensions.
   *
   * `dim_values` produces per-rider scores from the dimension's source — its
   * `GROUP BY user_id` already excludes riders with no activity, so joining
   * `users` with INNER JOIN means we only ever pay for active riders rather
   * than scanning every non-deleted account on each request. The privacy /
   * soft-delete / region filters then narrow further. `ranked` projects two
   * window expressions: the dense competition rank used in the response
   * (so a tie of two at #1 is followed by #2, not #3) and a stable
   * `rn` row-number used to slice the top-N window — splitting them lets
   * ties share a `rank` while `rn` still gives a deterministic ordering.
   *
   * `WHERE value > 0` in `ranked` is defence-in-depth: dim_values can in
   * principle emit a zero (e.g. SUM of all-zero distances) and we never want
   * those riders on the board.
   */
  private cteHeader(cfg: DimensionConfig): string {
    return `
      WITH dim_values AS (${cfg.sourceCte}),
      eligible AS (
        SELECT
          u.id AS user_id,
          u.display_name,
          u.home_region,
          dv.value::float AS value
        FROM dim_values dv
        INNER JOIN users u ON u.id = dv.user_id
        LEFT JOIN privacy_preferences pp ON pp.user_id = u.id
        WHERE u.deleted_at IS NULL
          AND (pp.profile_visibility IS NULL OR pp.profile_visibility <> 'private')
          AND ($1::text IS NULL OR LOWER(TRIM(u.home_region)) = LOWER(TRIM($1::text)))
      ),
      ranked AS (
        SELECT user_id, display_name, home_region, value,
               DENSE_RANK() OVER (ORDER BY value DESC) AS rank,
               ROW_NUMBER() OVER (ORDER BY value DESC, user_id ASC) AS rn
        FROM eligible
        WHERE value > 0
      )
    `;
  }

  private toEntry(row: RankedRow): RegionalLeaderboardEntryDto {
    return {
      rank: typeof row.rank === 'number' ? row.rank : parseInt(row.rank, 10),
      user_id: row.user_id,
      display_name: row.display_name,
      home_region: row.home_region,
      value:
        typeof row.value === 'number'
          ? row.value
          : parseFloat(row.value ?? '0'),
    };
  }
}
