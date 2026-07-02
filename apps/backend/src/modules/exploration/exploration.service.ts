import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { canShowPersonalizedRecommendations } from '@tarmoto/shared';
import { RideSegment } from '../../entities/ride-segment.entity.js';
import { RoadSegment } from '../../entities/road-segment.entity.js';
import { Ride } from '../../entities/ride.entity.js';
import { PrivacyPreferencesService } from '../account/privacy-preferences.service.js';
import {
  ExplorationStatsDto,
  UnriddenSegmentDto,
  RiddenSegmentIdsDto,
  RiddenSegmentsListDto,
  RiddenSegmentDto,
} from './dto/exploration.dto.js';

@Injectable()
export class ExplorationService {
  constructor(
    @InjectRepository(RideSegment)
    private readonly rideSegmentRepo: Repository<RideSegment>,
    @InjectRepository(RoadSegment)
    private readonly roadSegmentRepo: Repository<RoadSegment>,
    @InjectRepository(Ride)
    private readonly rideRepo: Repository<Ride>,
    private readonly privacy: PrivacyPreferencesService,
  ) {}

  async getStats(userId: string): Promise<ExplorationStatsDto> {
    const [riddenResult, totalResult, distanceResult] = await Promise.all([
      // Numerator: distinct LIVE road segments the rider has completed. Join
      // road_segments so a segment tombstoned after being ridden (#835) drops out
      // of the count too — otherwise, with the active-only denominator below, the
      // ratio could exceed 100 %.
      this.rideSegmentRepo
        .createQueryBuilder('rs')
        .select('COUNT(DISTINCT rs.road_segment_id)', 'count')
        .innerJoin('rs.ride', 'r')
        .innerJoin('road_segments', 'seg', 'seg.id = rs.road_segment_id')
        .where('r.user_id = :userId', { userId })
        .andWhere("r.status = 'completed'")
        .andWhere('seg.deactivated_at IS NULL')
        .getRawOne<{ count: string }>(),
      // Denominator is the ACTIVE network — tombstoned (split/merged-away) roads
      // must not dilute the explored percentage (#835).
      this.roadSegmentRepo.count({ where: { deactivated_at: IsNull() } }),
      this.rideRepo
        .createQueryBuilder('r')
        .select('COALESCE(SUM(r.distance_km), 0)', 'total')
        .where('r.user_id = :userId', { userId })
        .andWhere("r.status = 'completed'")
        .getRawOne<{ total: string }>(),
    ]);

    const ridden = parseInt(riddenResult?.count ?? '0', 10);
    const total = totalResult;
    const percent = total > 0 ? Math.round((ridden / total) * 100) : 0;

    return {
      ridden_segments: ridden,
      total_segments: total,
      percent_explored: percent,
      total_distance_km: parseFloat(distanceResult?.total ?? '0'),
    };
  }

  async getNearbyUnridden(
    userId: string,
    lat: number,
    lng: number,
    radiusKm: number,
    limit: number,
  ): Promise<UnriddenSegmentDto[]> {
    // #279 / #501 — `nearby-unridden` is genuinely personalised: the
    // result set is filtered against the rider's completed-ride history.
    // When the rider has opted out of personalised recommendations there
    // is no "non-personalised" version of "what haven't I ridden" — we
    // simply return an empty list. Mirrors the framing in
    // `personalized_recommendations_consent`'s entity comment: opted-out
    // riders fall back to nothing rather than to a generic global feed.
    const prefs = await this.privacy.loadPreferences(userId);
    if (!canShowPersonalizedRecommendations(prefs)) {
      return [];
    }

    const radiusM = radiusKm * 1000;

    const results = await this.roadSegmentRepo
      .createQueryBuilder('seg')
      .select([
        'seg.id AS id',
        'seg.road_name AS road_name',
        'seg.length_m AS length_m',
        'seg.quality_score AS quality_score',
        'seg.surface_type AS surface_type',
        'ST_Distance(seg.geom::geography, ST_SetSRID(ST_MakePoint(:lng, :lat), 4326)::geography) AS distance_m',
      ])
      .where(
        'ST_DWithin(seg.geom::geography, ST_SetSRID(ST_MakePoint(:lng, :lat), 4326)::geography, :radius)',
        { lng, lat, radius: radiusM },
      )
      .andWhere('seg.deactivated_at IS NULL')
      .andWhere(
        `seg.id NOT IN (
          SELECT DISTINCT rs.road_segment_id
          FROM ride_segments rs
          INNER JOIN rides r ON r.id = rs.ride_id
          WHERE r.user_id = :userId
            AND r.status = 'completed'
            AND rs.road_segment_id IS NOT NULL
        )`,
        { userId },
      )
      .orderBy('distance_m', 'ASC')
      .limit(limit)
      .getRawMany<{
        id: string;
        road_name: string | null;
        length_m: number;
        quality_score: number | null;
        surface_type: string;
        distance_m: number;
      }>();

    return results.map((r) => ({
      id: r.id,
      road_name: r.road_name,
      length_m: r.length_m,
      quality_score: r.quality_score,
      surface_type: r.surface_type,
      distance_m: Math.round(r.distance_m),
    }));
  }

  async getRiddenIds(userId: string): Promise<RiddenSegmentIdsDto> {
    const results = await this.rideSegmentRepo
      .createQueryBuilder('rs')
      .select('DISTINCT rs.road_segment_id', 'id')
      .innerJoin('rs.ride', 'r')
      .where('r.user_id = :userId', { userId })
      .andWhere("r.status = 'completed'")
      .andWhere('rs.road_segment_id IS NOT NULL')
      .getRawMany<{ id: string }>();

    return {
      segment_ids: results.map((r) => r.id),
    };
  }

  /**
   * Per-segment metadata for the personal road-map layer (US-50). Returns
   * one row per ridden segment with the most-recent ride timestamp and
   * quality reading so the map can both period-filter client-side and
   * show a hover popup without a second round-trip.
   *
   * Both the latest-reading and ride-count subqueries are scoped to the
   * caller's completed rides, then joined to each other directly — the
   * outer query never touches `ride_segments` for other users, so cost
   * scales with the caller's history, not the global table size.
   *
   * `last_ridden_at` resolves to the segment-touch time
   * (`COALESCE(rs.exited_at, rs.entered_at, r.started_at)`) rather than
   * the ride start. Long rides that span period boundaries (an
   * overnight tour, a year-end ride) would otherwise be misclassified —
   * a segment ridden after midnight would still bucket into the
   * previous period because the ride's `started_at` is older.
   *
   * Tie-breaking on `DISTINCT ON`: rides sharing the same touch time
   * (e.g. data-import collisions, multiple passes in one ride) order by
   * `rs.id DESC` to pick a deterministic row. Without it the "latest
   * quality" value would flap between concurrent reads.
   */
  async getRiddenSegments(userId: string): Promise<RiddenSegmentsListDto> {
    const lastTouchExpr =
      'COALESCE(rs2.exited_at, rs2.entered_at, r2.started_at)';
    const rows = await this.rideSegmentRepo.manager
      .createQueryBuilder()
      .select('latest.segment_id', 'id')
      .addSelect('latest.last_ridden_at', 'last_ridden_at')
      .addSelect('latest.last_quality_score', 'last_quality_score')
      .addSelect('counts.ride_count', 'ride_count')
      .from((qb) => {
        // `distinctOn(...)` is the API for Postgres `SELECT DISTINCT ON`.
        // Inlining it into the first `select()` expression looks
        // ergonomic but TypeORM reorders the column list when
        // assembling the SELECT clause (the DISTINCT ON column lands
        // mid-list instead of right after SELECT), which Postgres
        // rejects with `syntax error at or near "DISTINCT"` — exactly
        // the 500 #557 was reporting.
        return qb
          .subQuery()
          .select('rs2.road_segment_id', 'segment_id')
          .addSelect(lastTouchExpr, 'last_ridden_at')
          .addSelect('rs2.quality_reading', 'last_quality_score')
          .distinctOn(['rs2.road_segment_id'])
          .from('ride_segments', 'rs2')
          .innerJoin('rides', 'r2', 'r2.id = rs2.ride_id')
          .where('r2.user_id = :userId', { userId })
          .andWhere("r2.status = 'completed'")
          .andWhere('rs2.road_segment_id IS NOT NULL')
          .orderBy('rs2.road_segment_id')
          .addOrderBy(lastTouchExpr, 'DESC', 'NULLS LAST')
          .addOrderBy('rs2.id', 'DESC');
      }, 'latest')
      .innerJoin(
        (qb) =>
          qb
            .subQuery()
            .select('rs3.road_segment_id', 'segment_id')
            .addSelect('COUNT(DISTINCT rs3.ride_id)', 'ride_count')
            .from('ride_segments', 'rs3')
            .innerJoin('rides', 'r3', 'r3.id = rs3.ride_id')
            .where('r3.user_id = :userId', { userId })
            .andWhere("r3.status = 'completed'")
            .andWhere('rs3.road_segment_id IS NOT NULL')
            .groupBy('rs3.road_segment_id'),
        'counts',
        'counts.segment_id = latest.segment_id',
      )
      .getRawMany<{
        id: string;
        last_ridden_at: Date | string;
        last_quality_score: number | null;
        ride_count: string | number;
      }>();

    const segments: RiddenSegmentDto[] = rows.map((row) => ({
      id: row.id,
      last_ridden_at:
        row.last_ridden_at instanceof Date
          ? row.last_ridden_at.toISOString()
          : new Date(row.last_ridden_at).toISOString(),
      last_quality_score: row.last_quality_score,
      ride_count:
        typeof row.ride_count === 'number'
          ? row.ride_count
          : parseInt(row.ride_count, 10),
    }));

    return { segments };
  }
}
