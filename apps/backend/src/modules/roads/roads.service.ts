import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { RoadSegment } from '../../entities/road-segment.entity.js';
import { FunZone } from '../../entities/fun-zone.entity.js';
import { HazardResponseDto } from '../hazards/dto/hazard-response.dto.js';
import {
  ReviewResponseDto,
  sanitizeReviewPhotos,
} from '../reviews/dto/review.dto.js';
import { findRegion } from '@tarmoto/shared';
import { QueryNearbyDto } from './dto/query-nearby.dto.js';
import {
  RoadSegmentDto,
  RoadSegmentDetailDto,
} from './dto/road-segment.dto.js';
import { QueryFunZonesDto } from './dto/query-fun-zones.dto.js';
import { FunZoneDto } from './dto/fun-zone.dto.js';
import { QueryBestRoadsDto } from './dto/query-best-roads.dto.js';
import { BestRoadsResponseDto, BestRoadDto } from './dto/best-roads.dto.js';

const RECENT_REVIEW_LIMIT = 5;
const ACTIVE_HAZARD_LIMIT = 10;
const BEST_ROADS_MIN_CONFIDENCE = 3;
const BEST_ROADS_MIN_LENGTH_M = 500;
const BEST_ROADS_DEFAULT_LIMIT = 10;

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
        rs.elevation_min, rs.elevation_max, rs.elevation_profile,
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
    const elevationProfile = normalizeElevationProfile(
      row.elevation_profile,
      geometry.length,
    );

    // Run all six independent queries in parallel. Share a single `asOf`
    // cutoff for the hazard count + hazard-rows queries so a report that
    // expires between the two Promise.all statements can't drift the count
    // away from what's in the returned array.
    const asOf = new Date();
    /* eslint-disable @typescript-eslint/no-unsafe-assignment */
    const [
      breakdownRows,
      hazardCountRows,
      hazardRows,
      reviewStatsRows,
      reviewRows,
      riderRows,
    ] = await Promise.all([
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
          AND is_active = true AND expires_at > $2`,
        [segmentId, asOf],
      ),
      // Top-N most-recent active hazards with reporter + road name. Joining
      // on road_segments here so the response shape matches the standalone
      // /hazards endpoint, which the mobile RoadPreview screen renders.
      this.segmentRepo.query(
        `SELECT
          h.id, h.hazard_type, h.severity, h.note, h.confirmations,
          h.created_at, h.expires_at,
          ST_X(h.location::geometry) AS lng,
          ST_Y(h.location::geometry) AS lat,
          u.display_name AS reporter,
          rs.road_name AS road_name
        FROM hazard_reports h
        LEFT JOIN users u ON u.id = h.user_id
        LEFT JOIN road_segments rs ON rs.id = h.road_segment_id
        WHERE h.road_segment_id = $1
          AND h.is_active = true AND h.expires_at > $2
        ORDER BY h.created_at DESC
        LIMIT $3`,
        [segmentId, asOf, ACTIVE_HAZARD_LIMIT],
      ),
      this.segmentRepo.query(
        `SELECT COUNT(*)::int AS count, AVG(rating)::float AS avg_rating
        FROM road_reviews
        WHERE road_segment_id = $1`,
        [segmentId],
      ),
      this.segmentRepo.query(
        `SELECT
          rr.id, rr.rating, rr.comment, rr.bike_model, rr.photos, rr.created_at,
          u.display_name
        FROM road_reviews rr
        LEFT JOIN users u ON u.id = rr.user_id
        WHERE rr.road_segment_id = $1
        ORDER BY rr.created_at DESC
        LIMIT $2`,
        [segmentId, RECENT_REVIEW_LIMIT],
      ),
      this.segmentRepo.query(
        `SELECT COUNT(DISTINCT user_id)::int AS count
        FROM surface_readings
        WHERE road_segment_id = $1
          AND recorded_at > NOW() - INTERVAL '30 days'`,
        [segmentId],
      ),
    ]);
    /* eslint-enable @typescript-eslint/no-unsafe-assignment */

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

    const activeHazardCount =
      (hazardCountRows as Array<{ count: number }>)[0]?.count ?? 0;
    const reviewStats = (
      reviewStatsRows as Array<{ count: number; avg_rating: number | null }>
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
      elevation_profile: elevationProfile,
      quality_breakdown: breakdown,
      active_hazards: mapHazardRows(hazardRows),
      active_hazard_count: activeHazardCount,
      recent_reviews: mapReviewRows(reviewRows),
      review_count: reviewStats?.count ?? 0,
      avg_review_rating: reviewStats?.avg_rating
        ? Math.round(reviewStats.avg_rating * 10) / 10
        : null,
      riders_per_month: ridersPerMonth,
    };
  }

  async findBest(query: QueryBestRoadsDto): Promise<BestRoadsResponseDto> {
    const region = findRegion(query.country, query.region);
    if (!region) {
      throw new NotFoundException('Region not found');
    }
    const limit = query.limit ?? BEST_ROADS_DEFAULT_LIMIT;
    const [w, s, e, n] = region.bbox;

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const rows = await this.segmentRepo.query(
      `SELECT
        rs.id, rs.road_name, rs.road_number,
        rs.quality_score, rs.curviness_score, rs.surface_type,
        rs.length_m, rs.confidence,
        ST_AsGeoJSON(rs.geom)::json AS geojson,
        (
          rs.quality_score * 2.0
          + rs.curviness_score * 1.0
          + LEAST(rs.length_m / 1000.0, 20.0) * 0.1
        ) AS best_score
      FROM road_segments rs
      WHERE ST_Intersects(
        rs.geom,
        ST_MakeEnvelope($1, $2, $3, $4, 4326)
      )
        AND rs.quality_score IS NOT NULL
        AND rs.confidence >= $5
        AND rs.length_m >= $6
      ORDER BY best_score DESC NULLS LAST
      LIMIT $7`,
      [w, s, e, n, BEST_ROADS_MIN_CONFIDENCE, BEST_ROADS_MIN_LENGTH_M, limit],
    );

    const roads: BestRoadDto[] = (rows as Record<string, unknown>[]).map(
      (row) => {
        const geojson = row.geojson as { coordinates: number[][] };
        return {
          id: row.id as string,
          road_name: (row.road_name as string) ?? null,
          road_number: (row.road_number as string) ?? null,
          quality_score: (row.quality_score as number) ?? null,
          curviness_score: row.curviness_score as number,
          surface_type: row.surface_type as string,
          length_m: row.length_m as number,
          confidence: row.confidence as number,
          geometry: geojson.coordinates.map((c) => ({ lat: c[1], lng: c[0] })),
          best_score: row.best_score as number,
        };
      },
    );

    return {
      region: {
        slug: region.slug,
        country: region.country,
        name: region.name,
        bbox: region.bbox,
      },
      roads,
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

function mapHazardRows(rows: unknown): HazardResponseDto[] {
  if (!Array.isArray(rows)) return [];
  return (rows as Array<Record<string, unknown>>).map((r) => ({
    id: r.id as string,
    lat: Number(r.lat),
    lng: Number(r.lng),
    hazard_type: r.hazard_type as string,
    severity: r.severity as string,
    note: (r.note as string) ?? null,
    confirmations: r.confirmations as number,
    reporter: (r.reporter as string) ?? null,
    road_name: (r.road_name as string) ?? null,
    created_at: (r.created_at as Date).toISOString(),
    expires_at: (r.expires_at as Date).toISOString(),
  }));
}

function mapReviewRows(rows: unknown): ReviewResponseDto[] {
  if (!Array.isArray(rows)) return [];
  return (rows as Array<Record<string, unknown>>).map((r) => ({
    id: r.id as string,
    user_display_name: (r.display_name as string) ?? 'Unknown',
    rating: r.rating as number,
    comment: (r.comment as string) ?? null,
    bike_model: (r.bike_model as string) ?? null,
    photos: sanitizeReviewPhotos(r.photos),
    created_at: (r.created_at as Date).toISOString(),
  }));
}

// Validate the elevation_profile column matches the geometry length so a stale
// profile (left behind after a geometry edit) can't render a misaligned chart.
function normalizeElevationProfile(
  raw: unknown,
  geometryLength: number,
): number[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  if (raw.length !== geometryLength) return null;
  const profile: number[] = [];
  for (const v of raw) {
    // Reject null/undefined explicitly: `Number(null) === 0` would otherwise
    // pass the isFinite check and turn a missing sample into a sea-level
    // reading, producing a phantom drop-to-zero on any alpine segment.
    if (v === null || v === undefined) return null;
    const n = typeof v === 'number' ? v : Number(v);
    if (!Number.isFinite(n)) return null;
    profile.push(n);
  }
  return profile;
}
