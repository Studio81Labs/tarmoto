import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { RideSegment } from '../../entities/ride-segment.entity.js';
import { RoadSegment } from '../../entities/road-segment.entity.js';
import { Ride } from '../../entities/ride.entity.js';
import {
  ExplorationStatsDto,
  UnriddenSegmentDto,
  RiddenSegmentIdsDto,
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
  ) {}

  async getStats(userId: string): Promise<ExplorationStatsDto> {
    const [riddenResult, totalResult, distanceResult] = await Promise.all([
      this.rideSegmentRepo
        .createQueryBuilder('rs')
        .select('COUNT(DISTINCT rs.road_segment_id)', 'count')
        .innerJoin('rs.ride', 'r')
        .where('r.user_id = :userId', { userId })
        .andWhere("r.status = 'completed'")
        .andWhere('rs.road_segment_id IS NOT NULL')
        .getRawOne<{ count: string }>(),
      this.roadSegmentRepo.count(),
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
}
