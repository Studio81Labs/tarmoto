import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { RoadSegment } from '../../entities/road-segment.entity.js';
import { FunZone } from '../../entities/fun-zone.entity.js';
import { QueryNearbyDto } from './dto/query-nearby.dto.js';
import {
  RoadSegmentDto,
  RoadSegmentDetailDto,
} from './dto/road-segment.dto.js';
import { QueryFunZonesDto } from './dto/query-fun-zones.dto.js';
import { FunZoneDto } from './dto/fun-zone.dto.js';

@Injectable()
export class RoadsService {
  constructor(
    @InjectRepository(RoadSegment)
    private readonly segmentRepo: Repository<RoadSegment>,
    @InjectRepository(FunZone)
    private readonly funZoneRepo: Repository<FunZone>,
  ) {}

  async findNearby(query: QueryNearbyDto): Promise<RoadSegmentDto[]> {
    const radius = query.radius ?? 5000;
    const params: (string | number)[] = [query.lng, query.lat, radius];
    let paramIdx = 4;

    let sql = `
      SELECT
        rs.id, rs.road_name, rs.road_number, rs.quality_score,
        rs.curviness_score, rs.surface_type, rs.length_m,
        rs.confidence, rs.reading_count, rs.last_updated,
        ST_Distance(
          rs.geom::geography,
          ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography
        ) AS distance_m
      FROM road_segments rs
      WHERE ST_DWithin(
        rs.geom::geography,
        ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography,
        $3
      )
    `;

    if (query.min_quality !== undefined) {
      sql += ` AND rs.quality_score >= $${paramIdx}`;
      params.push(query.min_quality);
      paramIdx++;
    }

    if (query.surface_type) {
      sql += ` AND rs.surface_type = $${paramIdx}`;
      params.push(query.surface_type);
      paramIdx++;
    }

    sql += ` ORDER BY distance_m LIMIT 200`;

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const rows = await this.segmentRepo.query(sql, params);
    return (rows as Record<string, unknown>[]).map((row) => ({
      id: row.id as string,
      road_name: (row.road_name as string) ?? null,
      road_number: (row.road_number as string) ?? null,
      quality_score: (row.quality_score as number) ?? null,
      curviness_score: row.curviness_score as number,
      surface_type: row.surface_type as string,
      length_m: row.length_m as number,
      confidence: row.confidence as number,
      reading_count: row.reading_count as number,
      last_updated: (row.last_updated as Date).toISOString(),
      distance_m: Math.round(row.distance_m as number),
    }));
  }

  async findById(segmentId: string): Promise<RoadSegmentDetailDto> {
    // Get base segment with geometry
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const segmentRows = await this.segmentRepo.query(
      `SELECT
        rs.id, rs.road_name, rs.road_number, rs.quality_score,
        rs.curviness_score, rs.surface_type, rs.length_m,
        rs.confidence, rs.reading_count, rs.last_updated,
        rs.elevation_min, rs.elevation_max,
        ST_AsGeoJSON(rs.geom)::json AS geojson
      FROM road_segments rs
      WHERE rs.id = $1`,
      [segmentId],
    );

    const rows = segmentRows as Record<string, unknown>[];
    if (rows.length === 0) {
      throw new NotFoundException('Road segment not found');
    }

    const row = rows[0];
    const geojson = row.geojson as { coordinates: number[][] };
    const geometry = geojson.coordinates.map((coord) => ({
      lat: coord[1],
      lng: coord[0],
    }));

    // Run all four independent queries in parallel
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const [breakdownRows, hazardRows, reviewRows, riderRows] =
      await Promise.all([
        this.segmentRepo.query(
          `SELECT classification, COUNT(*)::int AS count
          FROM surface_readings
          WHERE road_segment_id = $1
            AND recorded_at > NOW() - INTERVAL '6 months'
          GROUP BY classification`,
          [segmentId],
        ),
        this.segmentRepo.query(
          `SELECT COUNT(*)::int AS count
          FROM hazard_reports
          WHERE road_segment_id = $1
            AND is_active = true AND expires_at > NOW()`,
          [segmentId],
        ),
        this.segmentRepo.query(
          `SELECT COUNT(*)::int AS count, AVG(rating)::float AS avg_rating
          FROM road_reviews
          WHERE road_segment_id = $1`,
          [segmentId],
        ),
        this.segmentRepo.query(
          `SELECT COUNT(DISTINCT user_id)::int AS count
          FROM surface_readings
          WHERE road_segment_id = $1
            AND recorded_at > NOW() - INTERVAL '30 days'`,
          [segmentId],
        ),
      ]);

    const breakdown = { excellent: 0, good: 0, fair: 0, poor: 0, very_poor: 0 };
    let totalReadings = 0;
    for (const br of breakdownRows as Array<{
      classification: string;
      count: number;
    }>) {
      if (br.classification in breakdown) {
        breakdown[br.classification as keyof typeof breakdown] = br.count;
        totalReadings += br.count;
      }
    }
    if (totalReadings > 0) {
      for (const key of Object.keys(breakdown) as Array<
        keyof typeof breakdown
      >) {
        breakdown[key] = Math.round((breakdown[key] / totalReadings) * 100);
      }
    }

    const activeHazards =
      (hazardRows as Array<{ count: number }>)[0]?.count ?? 0;
    const reviewStats = (
      reviewRows as Array<{ count: number; avg_rating: number | null }>
    )[0];
    const ridersPerMonth =
      (riderRows as Array<{ count: number }>)[0]?.count ?? 0;

    return {
      id: row.id as string,
      road_name: (row.road_name as string) ?? null,
      road_number: (row.road_number as string) ?? null,
      quality_score: (row.quality_score as number) ?? null,
      curviness_score: row.curviness_score as number,
      surface_type: row.surface_type as string,
      length_m: row.length_m as number,
      confidence: row.confidence as number,
      reading_count: row.reading_count as number,
      last_updated: (row.last_updated as Date).toISOString(),
      geometry,
      elevation_min: (row.elevation_min as number) ?? null,
      elevation_max: (row.elevation_max as number) ?? null,
      quality_breakdown: breakdown,
      active_hazards: activeHazards,
      review_count: reviewStats?.count ?? 0,
      avg_review_rating: reviewStats?.avg_rating
        ? Math.round(reviewStats.avg_rating * 10) / 10
        : null,
      riders_per_month: ridersPerMonth,
    };
  }

  async findFunZones(query: QueryFunZonesDto): Promise<FunZoneDto[]> {
    const [west, south, east, north] = query.bbox.split(',').map(Number);

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const rows = await this.funZoneRepo.query(
      `SELECT
        fz.id, fz.name, fz.composite_score, fz.road_count,
        fz.total_curve_km, fz.avg_quality, fz.best_season,
        ST_AsGeoJSON(fz.boundary)::json AS geojson
      FROM fun_zones fz
      WHERE ST_Intersects(
        fz.boundary,
        ST_MakeEnvelope($1, $2, $3, $4, 4326)
      )
      ORDER BY fz.composite_score DESC`,
      [west, south, east, north],
    );

    return (rows as Record<string, unknown>[]).map((row) => {
      const geojson = row.geojson as { coordinates: number[][][] };
      const boundary = geojson.coordinates[0].map((coord) => ({
        lat: coord[1],
        lng: coord[0],
      }));

      return {
        id: row.id as string,
        name: (row.name as string) ?? null,
        composite_score: row.composite_score as number,
        road_count: row.road_count as number,
        total_curve_km: (row.total_curve_km as number) ?? null,
        avg_quality: (row.avg_quality as number) ?? null,
        best_season: (row.best_season as string) ?? null,
        boundary,
      };
    });
  }
}
