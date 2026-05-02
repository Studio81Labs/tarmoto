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
    region?: string;
    limit?: number;
    currentUserId?: string;
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
    const [topRows, meRow] = await Promise.all([
      this.queryTopN(cfg, region, limit),
      currentUserId
        ? this.queryMeRow(cfg, region, currentUserId)
        : Promise.resolve(null),
    ]);

    const entries = topRows.map((r) => this.toEntry(r));
    // Reuse the in-list me row when present so rank/value match exactly the
    // top-N rendering (same query, same tiebreakers).
    const meFromTop = currentUserId
      ? (entries.find((e) => e.user_id === currentUserId) ?? null)
      : null;
    const me = meFromTop ?? (meRow ? this.toEntry(meRow) : null);

    return { dimension: cfg.dimension, unit: cfg.unit, entries, me };
  }

  private async queryTopN(
    cfg: DimensionConfig,
    region: string | null,
    limit: number,
  ): Promise<RankedRow[]> {
    const sql = `
      ${this.cteHeader(cfg)}
      SELECT user_id, display_name, home_region, value, rank
      FROM ranked
      ORDER BY value DESC, user_id ASC
      LIMIT $2
    `;
    return await this.dataSource.query<RankedRow[]>(sql, [region, limit]);
  }

  private async queryMeRow(
    cfg: DimensionConfig,
    region: string | null,
    userId: string,
  ): Promise<RankedRow | null> {
    const sql = `
      ${this.cteHeader(cfg)}
      SELECT user_id, display_name, home_region, value, rank
      FROM ranked
      WHERE user_id = $2
      LIMIT 1
    `;
    const rows = await this.dataSource.query<RankedRow[]>(sql, [
      region,
      userId,
    ]);
    return rows[0] ?? null;
  }

  /**
   * Common CTE prefix used by both the top-N and me-row queries.
   *
   * `dim_values` produces per-rider scores from the dimension's source — its
   * `GROUP BY user_id` already excludes riders with no activity, so joining
   * `users` with INNER JOIN means we only ever pay for active riders rather
   * than scanning every non-deleted account on each request. The privacy /
   * soft-delete / region filters then narrow further. `ranked` projects the
   * dense competition rank used in the response — splitting it from the
   * filter step keeps ties consistent with the visible top-N order.
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
               RANK() OVER (ORDER BY value DESC) AS rank
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
