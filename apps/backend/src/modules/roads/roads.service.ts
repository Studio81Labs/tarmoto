import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { RoadSegment } from '../../entities/road-segment.entity.js';
import { FunZone } from '../../entities/fun-zone.entity.js';
import { HazardResponseDto } from '../hazards/dto/hazard-response.dto.js';
import { sanitizeHazardPhotoUrl } from '../hazards/dto/hazard-photo.dto.js';
import {
  ReviewResponseDto,
  sanitizeReviewPhotos,
} from '../reviews/dto/review.dto.js';
import {
  findRegion,
  haversineMeters,
  type SurfaceType,
  type HazardType,
  type HazardSeverity,
} from '@tarmoto/shared';
import { QueryNearbyDto } from './dto/query-nearby.dto.js';
import {
  RoadSegmentDto,
  RoadSegmentDetailDto,
} from './dto/road-segment.dto.js';
import { QueryFunZonesDto } from './dto/query-fun-zones.dto.js';
import { FunZoneDto } from './dto/fun-zone.dto.js';
import { QueryBestRoadsDto } from './dto/query-best-roads.dto.js';
import { BestRoadsResponseDto, BestRoadDto } from './dto/best-roads.dto.js';
import { FunZoneDetailDto, FunZoneRoadDto } from './dto/fun-zone-detail.dto.js';

const RECENT_REVIEW_LIMIT = 5;
const ACTIVE_HAZARD_LIMIT = 10;
const BEST_ROADS_MIN_CONFIDENCE = 3;
const BEST_ROADS_MIN_LENGTH_M = 500;
const BEST_ROADS_DEFAULT_LIMIT = 10;
const FUN_ZONE_TOP_ROADS_LIMIT = 10;

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
      WHERE rs.deactivated_at IS NULL
        AND ST_DWithin(
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
      surface_type: row.surface_type as SurfaceType,
      length_m: row.length_m as number,
      confidence: row.confidence as number,
      reading_count: row.reading_count as number,
      last_updated: (row.last_updated as Date).toISOString(),
      distance_m: Math.round(row.distance_m as number),
    }));
  }

  async findById(segmentId: string): Promise<RoadSegmentDetailDto> {
    // Resolve the requested id's whole OSM way (COALESCE(osm_way_id, id)) and
    // aggregate it, so `/roads/:id` shows the same logical road as `/roads/best`
    // rather than one ~100 m child (#809). Physical attributes (geometry, length,
    // curviness, surface, elevation) aggregate over ALL the way's sub-segments;
    // the quality signal (quality_score, confidence) over the quality-bearing
    // ones, matching best-roads / clustering. A crowd-sourced row (null
    // osm_way_id) is a group of one, so every value equals its raw column and the
    // community sub-queries below run over the single id — behaviour unchanged.
    // `way_segment_ids` is the exact id set every sub-query (reviews included)
    // expands to; the standalone /roads/:id/reviews endpoint resolves the same set.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const segmentRows = await this.segmentRepo.query(
      `WITH target AS (
        SELECT id AS requested_id, COALESCE(osm_way_id::text, id::text) AS way_key
        FROM road_segments WHERE id = $1 AND deactivated_at IS NULL
      )
      SELECT
        ARRAY_AGG(rs.id) AS way_segment_ids,
        MAX(rs.road_name) AS road_name,
        MAX(rs.road_number) AS road_number,
        SUM(rs.quality_score * rs.length_m) FILTER (WHERE rs.quality_score IS NOT NULL)
          / NULLIF(SUM(rs.length_m) FILTER (WHERE rs.quality_score IS NOT NULL), 0) AS quality_score,
        SUM(rs.curviness_score * rs.length_m) / NULLIF(SUM(rs.length_m), 0) AS curviness_score,
        COALESCE(
          SUM(rs.confidence * rs.length_m) FILTER (WHERE rs.quality_score IS NOT NULL)
            / NULLIF(SUM(rs.length_m) FILTER (WHERE rs.quality_score IS NOT NULL), 0),
          0
        ) AS confidence,
        (ARRAY_AGG(rs.surface_type ORDER BY rs.length_m DESC, rs.id))[1] AS surface_type,
        SUM(rs.length_m) AS length_m,
        -- The specific requested segment's own length, for per-segment consumers.
        MAX(rs.length_m) FILTER (WHERE rs.id = target.requested_id) AS segment_length_m,
        SUM(rs.reading_count)::int AS reading_count,
        MAX(rs.last_updated) AS last_updated,
        MIN(rs.elevation_min) AS elevation_min,
        MAX(rs.elevation_max) AS elevation_max,
        CASE WHEN COUNT(*) = 1 THEN MIN(rs.elevation_profile) END AS elevation_profile,
        ST_AsGeoJSON(
          ST_LineMerge(ST_Collect(rs.geom ORDER BY rs.segment_index NULLS FIRST, rs.id))
        )::json AS geojson
      FROM road_segments rs, target
      WHERE COALESCE(rs.osm_way_id::text, rs.id::text) = target.way_key
        AND rs.deactivated_at IS NULL
      GROUP BY target.way_key, target.requested_id`,
      [segmentId],
    );

    const rows = segmentRows as Record<string, unknown>[];
    if (rows.length === 0) {
      throw new NotFoundException('Road segment not found');
    }

    const row = rows[0];
    if (!row) {
      throw new NotFoundException('Road segment not found');
    }
    const geojson = row.geojson as {
      type: string;
      coordinates: number[][] | number[][][];
    };
    const geometry = lineStringToLatLng(geoJsonLineCoordinates(geojson));
    const elevationProfile = normalizeElevationProfile(
      row.elevation_profile,
      geometry.length,
    );
    // The community sub-queries run over every sub-segment of the way.
    const waySegmentIds = row.way_segment_ids as string[];

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
      qualityHistoryRows,
      regionalQualityRows,
    ] = await Promise.all([
      this.segmentRepo.query(
        `SELECT classification, COUNT(*)::int AS count
        FROM surface_readings
        WHERE road_segment_id = ANY($1)
          AND recorded_at > NOW() - INTERVAL '6 months'
        GROUP BY classification`,
        [waySegmentIds],
      ),
      this.segmentRepo.query(
        `SELECT COUNT(*)::int AS count
        FROM hazard_reports
        WHERE road_segment_id = ANY($1)
          AND is_active = true AND expires_at > $2
          AND moderation_status = 'visible'`,
        [waySegmentIds, asOf],
      ),
      // Top-N most-recent active hazards with reporter + road name. Joining
      // on road_segments here so the response shape matches the standalone
      // /hazards endpoint, which the mobile RoadPreview screen renders.
      // #279 / #501 — `reporter` is masked to NULL when the rider has set
      // `profile_visibility = 'private'`, mirroring the same gate on the
      // standalone /hazards endpoints (`HAZARD_SELECT_BASE`). The road
      // detail card is a public surface, so without the LEFT JOIN here a
      // private rider's display name would still leak to anyone opening
      // the segment that contains their report. `is_private_reporter`
      // also flows to `mapHazardRows` so the photo URL (which embeds
      // `<userId>-...` in its filename) can be suppressed alongside the
      // name (Codex review on PR #513 r3212896110).
      this.segmentRepo.query(
        `SELECT
          h.id, h.hazard_type, h.severity, h.note, h.photo_url, h.confirmations,
          h.created_at, h.expires_at,
          ST_X(h.location::geometry) AS lng,
          ST_Y(h.location::geometry) AS lat,
          CASE WHEN pp.profile_visibility = 'private' THEN NULL ELSE u.display_name END AS reporter,
          (pp.profile_visibility = 'private') AS is_private_reporter,
          rs.road_name AS road_name
        FROM hazard_reports h
        LEFT JOIN users u ON u.id = h.user_id
        LEFT JOIN privacy_preferences pp ON pp.user_id = h.user_id
        LEFT JOIN road_segments rs ON rs.id = h.road_segment_id
        WHERE h.road_segment_id = ANY($1)
          AND h.is_active = true AND h.expires_at > $2
          AND h.moderation_status = 'visible'
        ORDER BY h.created_at DESC
        LIMIT $3`,
        [waySegmentIds, asOf, ACTIVE_HAZARD_LIMIT],
      ),
      this.segmentRepo.query(
        // Reviews aggregate over the whole way's segment set, like every other
        // sub-query — a road's rating is the union across its ~100 m sub-segments,
        // consistent with the aggregated list/detail (#809). The standalone
        // /roads/:id/reviews endpoint (ReviewsService.listForSegment) resolves the
        // SAME way set, so the embedded preview and the panel stay in sync.
        `SELECT COUNT(*)::int AS count, AVG(rating)::float AS avg_rating
        FROM road_reviews
        WHERE road_segment_id = ANY($1)
          AND moderation_status = 'visible'`,
        [waySegmentIds],
      ),
      this.segmentRepo.query(
        // Left-join the helpful-vote counts via a lateral subquery so a
        // review with zero votes still returns (0, 0) rather than being
        // silently dropped. `my_vote` is intentionally omitted here — the
        // embedded reviews on /roads/:id are served to anonymous callers,
        // and the standalone /roads/:id/reviews endpoint is where the
        // authenticated viewer personalisation lives.
        // `u.id` and `u.deleted_at` are surfaced so the mapper can mask
        // both `user_id` and the display name when the author has been
        // soft-deleted or hard-deleted (#335) — the review row stays for
        // road-quality history, but the byline must not deep-link to a
        // tombstoned profile.
        // #279 / #501 — `is_private_author` flag joins `privacy_preferences`
        // so the mapper can also mask private riders, mirroring the same
        // gate on the standalone /roads/:id/reviews endpoint
        // (`ReviewsService.toResponse`). The road preview is anonymous-
        // friendly so there's no self-view exemption — every viewer sees
        // the masked tombstone for a private author.
        `SELECT
          rr.id, rr.rating, rr.comment, rr.bike_model, rr.photos, rr.created_at,
          rr.user_id, u.id AS user_join_id, u.deleted_at AS user_deleted_at,
          u.display_name,
          (pp.profile_visibility = 'private') AS is_private_author,
          COALESCE(vc.helpful_count, 0) AS helpful_count,
          COALESCE(vc.not_helpful_count, 0) AS not_helpful_count
        FROM road_reviews rr
        LEFT JOIN users u ON u.id = rr.user_id
        LEFT JOIN privacy_preferences pp ON pp.user_id = rr.user_id
        LEFT JOIN LATERAL (
          SELECT
            COUNT(*) FILTER (WHERE is_helpful = true)::int AS helpful_count,
            COUNT(*) FILTER (WHERE is_helpful = false)::int AS not_helpful_count
          FROM road_review_votes v
          WHERE v.road_review_id = rr.id
        ) vc ON true
        WHERE rr.road_segment_id = ANY($1)
          AND rr.moderation_status = 'visible'
        ORDER BY rr.created_at DESC
        LIMIT $2`,
        [waySegmentIds, RECENT_REVIEW_LIMIT],
      ),
      this.segmentRepo.query(
        `SELECT COUNT(DISTINCT user_id)::int AS count
        FROM surface_readings
        WHERE road_segment_id = ANY($1)
          AND recorded_at > NOW() - INTERVAL '30 days'`,
        [waySegmentIds],
      ),
      // US-45: quality trend — monthly average IRI for the last 2 years.
      this.segmentRepo.query(
        `SELECT
          TO_CHAR(DATE_TRUNC('month', recorded_at), 'YYYY-MM') AS month,
          ROUND(AVG(iri_value)::numeric, 2) AS score
        FROM surface_readings
        WHERE road_segment_id = ANY($1)
          AND recorded_at > NOW() - INTERVAL '24 months'
        GROUP BY DATE_TRUNC('month', recorded_at)
        ORDER BY month`,
        [waySegmentIds],
      ),
      // US-45: regional comparison trend — average across segments within 5 km.
      this.segmentRepo.query(
        `SELECT
          TO_CHAR(DATE_TRUNC('month', sr.recorded_at), 'YYYY-MM') AS month,
          ROUND(AVG(sr.iri_value)::numeric, 2) AS score
        FROM surface_readings sr
        INNER JOIN road_segments rs2 ON rs2.id = sr.road_segment_id
        INNER JOIN road_segments rs ON rs.id = $1
        WHERE rs2.deactivated_at IS NULL
          AND ST_DWithin(rs.geom, rs2.geom, 5000)
          AND sr.road_segment_id <> ALL($2)
          AND sr.recorded_at > NOW() - INTERVAL '24 months'
        GROUP BY DATE_TRUNC('month', sr.recorded_at)
        ORDER BY month`,
        [segmentId, waySegmentIds],
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
      // The DTO id is the REQUESTED segment id — clients feed it straight into the
      // standalone /roads/:id/reviews panel, which resolves that id's whole way
      // (like the embedded reviews above), so preview and panel stay in sync (#809).
      id: segmentId,
      road_name: (row.road_name as string) ?? null,
      road_number: (row.road_number as string) ?? null,
      quality_score: (row.quality_score as number) ?? null,
      curviness_score: row.curviness_score as number,
      surface_type: row.surface_type as SurfaceType,
      length_m: row.length_m as number,
      segment_length_m: row.segment_length_m as number,
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
      quality_history: (
        qualityHistoryRows as Array<{ month: string; score: number }>
      ).map((r) => ({ month: r.month, score: r.score })),
      regional_quality_history: (
        regionalQualityRows as Array<{ month: string; score: number }>
      ).map((r) => ({ month: r.month, score: r.score })),
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
      `WITH candidate AS (
        SELECT
          rs.id, rs.osm_way_id, rs.segment_index,
          rs.road_name, rs.road_number, rs.surface_type,
          rs.quality_score, rs.curviness_score, rs.length_m, rs.confidence, rs.geom
        FROM road_segments rs
        WHERE rs.deactivated_at IS NULL
          AND ST_Intersects(rs.geom, ST_MakeEnvelope($1, $2, $3, $4, 4326))
          AND rs.quality_score IS NOT NULL
      ),
      -- Collapse OSM-imported ~100 m sub-segments into their parent way so the
      -- length filter applies to the whole road, not a stub (#794). Grouping key
      -- COALESCE(osm_way_id, id): a crowd-sourced row has a NULL osm_way_id, so it
      -- is a group of one and every aggregate below equals its raw value —
      -- existing best-roads behaviour is unchanged. Aggregates are length-weighted
      -- so a road's score reflects its constituent segments.
      road AS (
        SELECT
          (ARRAY_AGG(rs.id ORDER BY rs.segment_index NULLS FIRST, rs.id))[1] AS id,
          MAX(rs.road_name) AS road_name,
          MAX(rs.road_number) AS road_number,
          (ARRAY_AGG(rs.surface_type ORDER BY rs.length_m DESC, rs.id))[1] AS surface_type,
          SUM(rs.length_m) AS length_m,
          SUM(rs.quality_score * rs.length_m) / NULLIF(SUM(rs.length_m), 0) AS quality_score,
          SUM(rs.curviness_score * rs.length_m) / NULLIF(SUM(rs.length_m), 0) AS curviness_score,
          SUM(rs.confidence * rs.length_m) / NULLIF(SUM(rs.length_m), 0) AS confidence,
          ST_LineMerge(ST_Collect(rs.geom ORDER BY rs.segment_index NULLS FIRST, rs.id)) AS geom
        FROM candidate rs
        GROUP BY COALESCE(rs.osm_way_id::text, rs.id::text)
      )
      SELECT
        id, road_name, road_number, quality_score, curviness_score, surface_type,
        length_m, confidence,
        ST_AsGeoJSON(geom)::json AS geojson,
        (
          quality_score * 2.0
          + curviness_score * 1.0
          + LEAST(length_m / 1000.0, 20.0) * 0.1
        ) AS best_score
      FROM road
      -- Confidence is applied to the aggregated road (length-weighted), not raw
      -- sub-segments, so a way with a few low-confidence pieces isn't shortened
      -- below the length threshold or dropped when its average still qualifies.
      WHERE length_m >= $6
        AND confidence >= $5
      ORDER BY best_score DESC NULLS LAST
      LIMIT $7`,
      [w, s, e, n, BEST_ROADS_MIN_CONFIDENCE, BEST_ROADS_MIN_LENGTH_M, limit],
    );

    const roads: BestRoadDto[] = (rows as Record<string, unknown>[]).map(
      (row) => {
        const geojson = row.geojson as {
          type: string;
          coordinates: number[][] | number[][][];
        };
        return {
          id: row.id as string,
          road_name: (row.road_name as string) ?? null,
          road_number: (row.road_number as string) ?? null,
          quality_score: (row.quality_score as number) ?? null,
          curviness_score: row.curviness_score as number,
          surface_type: row.surface_type as SurfaceType,
          length_m: row.length_m as number,
          confidence: row.confidence as number,
          geometry: lineStringToLatLng(geoJsonLineCoordinates(geojson)),
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
      const boundary = polygonBoundaryToLatLng(geojson.coordinates);

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

  async findZoneById(zoneId: string): Promise<FunZoneDetailDto> {
    // Resolve the zone first so we can 404 without issuing a useless join
    // against fun_zone_roads for an id that doesn't exist.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const zoneRows = await this.funZoneRepo.query(
      `SELECT
        fz.id, fz.name, fz.composite_score, fz.road_count,
        fz.total_curve_km, fz.avg_quality, fz.best_season,
        ST_AsGeoJSON(fz.boundary)::json AS geojson
      FROM fun_zones fz
      WHERE fz.id = $1`,
      [zoneId],
    );

    const zoneList = zoneRows as Record<string, unknown>[];
    if (zoneList.length === 0) {
      throw new NotFoundException('Fun zone not found');
    }
    const zoneRow = zoneList[0];
    if (!zoneRow) {
      throw new NotFoundException('Fun zone not found');
    }

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const roadRows = await this.funZoneRepo.query(
      `SELECT
        agg.id, agg.road_name, agg.road_number,
        agg.quality_score, agg.curviness_score, agg.surface_type,
        agg.length_m, agg.confidence,
        agg.elevation_min, agg.elevation_max, agg.elevation_profile,
        ST_AsGeoJSON(agg.geom)::json AS geojson,
        fzr.contribution_score
      FROM fun_zone_roads fzr
      INNER JOIN fun_zones fz ON fz.id = fzr.fun_zone_id
      -- Keep the membership even if the stored representative sub-segment is
      -- tombstoned: the lateral re-aggregates the way from its LIVE siblings
      -- (rs.deactivated_at IS NULL) and HAVING COUNT(*) > 0 drops a way only when
      -- ALL its in-zone assessed segments are dead. Filtering the representative
      -- here would instead hide a still-live road until the next reclustering.
      INNER JOIN road_segments member ON member.id = fzr.road_segment_id
      INNER JOIN LATERAL (
        -- The stored member is one representative segment of an aggregated OSM
        -- way (#794); re-aggregate the whole way so the panel shows the real
        -- road, not a ~100 m stub. A crowd-sourced row (null osm_way_id) is a
        -- group of one, so its aggregates equal its raw values.
        SELECT
          (ARRAY_AGG(rs.id ORDER BY rs.segment_index NULLS FIRST, rs.id))[1] AS id,
          MAX(rs.road_name) AS road_name,
          MAX(rs.road_number) AS road_number,
          SUM(rs.quality_score * rs.length_m) / NULLIF(SUM(rs.length_m), 0) AS quality_score,
          SUM(rs.curviness_score * rs.length_m) / NULLIF(SUM(rs.length_m), 0) AS curviness_score,
          (ARRAY_AGG(rs.surface_type ORDER BY rs.length_m DESC, rs.id))[1] AS surface_type,
          SUM(rs.length_m) AS length_m,
          SUM(rs.confidence * rs.length_m) / NULLIF(SUM(rs.length_m), 0) AS confidence,
          MIN(rs.elevation_min) AS elevation_min,
          MAX(rs.elevation_max) AS elevation_max,
          -- Only a group of one keeps its profile; a merged way's per-segment
          -- profiles can't be concatenated meaningfully, so null it. MIN over the
          -- single row returns its profile (and ignores nulls, unlike ARRAY_AGG
          -- which rejects null arrays).
          CASE WHEN COUNT(*) = 1 THEN MIN(rs.elevation_profile) END AS elevation_profile,
          ST_LineMerge(ST_Collect(rs.geom ORDER BY rs.segment_index NULLS FIRST, rs.id)) AS geom
        FROM road_segments rs
        WHERE COALESCE(rs.osm_way_id::text, rs.id::text)
            = COALESCE(member.osm_way_id::text, member.id::text)
          AND rs.deactivated_at IS NULL
          -- Match the clustering aggregation, which only groups quality-bearing
          -- segments; otherwise unassessed siblings inflate length/geom while the
          -- quality numerator skips them, depressing the shown quality score.
          AND rs.quality_score IS NOT NULL
          -- Constrain to the zone's scope: a bbox-scoped clustering run only
          -- aggregated the way's sub-segments inside that run, so re-aggregating
          -- the whole way would pull in out-of-zone km for a border-crossing way
          -- and disagree with the stored contribution/boundary. The boundary hull
          -- contains every in-cluster way, so compact ways are unaffected.
          AND ST_Intersects(rs.geom, fz.boundary)
        -- Drop a stale membership whose way has lost all in-zone assessed
        -- segments: without this the no-GROUP-BY aggregate returns one all-NULL
        -- row, nulling the geometry and 500-ing the mapper.
        HAVING COUNT(*) > 0
      ) agg ON TRUE
      WHERE fzr.fun_zone_id = $1
      ORDER BY fzr.contribution_score DESC NULLS LAST,
               agg.quality_score DESC NULLS LAST
      LIMIT $2`,
      [zoneId, FUN_ZONE_TOP_ROADS_LIMIT],
    );
    const zoneGeo = zoneRow.geojson as { coordinates: number[][][] };
    const boundary = polygonBoundaryToLatLng(zoneGeo.coordinates);

    const top_roads: FunZoneRoadDto[] = (
      roadRows as Record<string, unknown>[]
    ).map((row) => {
      const geojson = row.geojson as {
        type: string;
        coordinates: number[][] | number[][][];
      };
      const geometry = lineStringToLatLng(geoJsonLineCoordinates(geojson));
      return {
        id: row.id as string,
        road_name: (row.road_name as string) ?? null,
        road_number: (row.road_number as string) ?? null,
        quality_score: (row.quality_score as number) ?? null,
        curviness_score: row.curviness_score as number,
        surface_type: row.surface_type as SurfaceType,
        length_m: row.length_m as number,
        confidence: row.confidence as number,
        elevation_min: (row.elevation_min as number) ?? null,
        elevation_max: (row.elevation_max as number) ?? null,
        elevation_profile: normalizeElevationProfile(
          row.elevation_profile,
          geometry.length,
        ),
        geometry,
        contribution_score: (row.contribution_score as number) ?? null,
      };
    });

    return {
      zone: {
        id: zoneRow.id as string,
        name: (zoneRow.name as string) ?? null,
        composite_score: zoneRow.composite_score as number,
        road_count: zoneRow.road_count as number,
        total_curve_km: (zoneRow.total_curve_km as number) ?? null,
        avg_quality: (zoneRow.avg_quality as number) ?? null,
        best_season: (zoneRow.best_season as string) ?? null,
        boundary,
      },
      top_roads,
    };
  }

  async getSegmentTrend(segmentId: string): Promise<{
    segment_id: string;
    points: { month: string; avg_iri: number; reading_count: number }[];
  }> {
    const rows: {
      month: string;
      avg_iri: string;
      reading_count: string;
    }[] = await this.segmentRepo.query(
      // Join road_segments so a tombstoned segment (#835) — which /roads/:id,
      // tiles, and discovery now hide — returns no trend for a cached id either.
      `SELECT
         TO_CHAR(DATE_TRUNC('month', sr.recorded_at), 'YYYY-MM') AS month,
         AVG(sr.iri_value) AS avg_iri,
         COUNT(*)::int AS reading_count
       FROM surface_readings sr
       JOIN road_segments rs
         ON rs.id = sr.road_segment_id AND rs.deactivated_at IS NULL
       WHERE sr.road_segment_id = $1
         AND sr.recorded_at > NOW() - INTERVAL '24 months'
       GROUP BY DATE_TRUNC('month', sr.recorded_at)
       ORDER BY month`,
      [segmentId],
    );

    return {
      segment_id: segmentId,
      points: rows.map((r) => ({
        month: r.month,
        avg_iri: Math.round(parseFloat(r.avg_iri) * 100) / 100,
        reading_count: parseInt(r.reading_count, 10),
      })),
    };
  }
}

function mapHazardRows(rows: unknown): HazardResponseDto[] {
  if (!Array.isArray(rows)) return [];
  return (rows as Array<Record<string, unknown>>).map((r) => {
    // #279 / #501 — managed hazard photos are stored under
    // `/uploads/hazard-photos/<userId>-<ts>-...`, so emitting the
    // URL when the reporter is private would leak the rider's UUID
    // through the filename (Codex review on PR #513 r3212896110).
    // Suppress alongside the name.
    const reporterIsPrivate = r.is_private_reporter === true;
    return {
      id: r.id as string,
      lat: Number(r.lat),
      lng: Number(r.lng),
      hazard_type: r.hazard_type as HazardType,
      severity: r.severity as HazardSeverity,
      note: (r.note as string) ?? null,
      photo_url: reporterIsPrivate ? null : sanitizeHazardPhotoUrl(r.photo_url),
      confirmations: r.confirmations as number,
      reporter: (r.reporter as string) ?? null,
      road_name: (r.road_name as string) ?? null,
      created_at: (r.created_at as Date).toISOString(),
      expires_at: (r.expires_at as Date).toISOString(),
    };
  });
}

function mapReviewRows(rows: unknown): ReviewResponseDto[] {
  if (!Array.isArray(rows)) return [];
  return (rows as Array<Record<string, unknown>>).map((r) => {
    // Mirror `ReviewsService.toResponse`: an author is "visible" only
    // when the join produced a row AND that row is not soft-deleted.
    // When invisible, both `user_id` and `user_display_name` are masked
    // so the client doesn't render a profile link to a tombstone (#335).
    const authorDeleted = r.user_join_id == null || r.user_deleted_at != null;
    // #279 / #501 — also mask private riders. Two distinct tombstones
    // so callers (and operators reading logs) can tell deleted vs
    // opt-out apart: `'Unknown'` for the deleted-author legacy path,
    // `'Hidden rider'` for the privacy mask. Either way `user_id` is
    // null so the byline can't deep-link to a profile we shouldn't
    // expose. Deleted takes precedence — once the cascade runs there
    // is no rider left to be private.
    const authorPrivate = !authorDeleted && r.is_private_author === true;
    const authorMasked = authorDeleted || authorPrivate;
    const displayName = authorDeleted
      ? 'Unknown'
      : authorPrivate
        ? 'Hidden rider'
        : (r.display_name as string);
    return {
      id: r.id as string,
      user_id: authorMasked ? null : (r.user_id as string),
      user_display_name: displayName,
      rating: r.rating as number,
      comment: (r.comment as string) ?? null,
      bike_model: (r.bike_model as string) ?? null,
      // #279 / #501 — managed review photos embed `<segmentId>-
      // <userId>-...` in their filenames, so emitting the URL list
      // for a masked author would leak the rider's UUID through
      // the path even with `user_id` nulled (Codex review on PR
      // #513 r3212896111). Suppress on every masked path
      // (deleted + private). The road preview is anonymous-
      // friendly, so there's no self-view exemption here.
      photos: authorMasked ? null : sanitizeReviewPhotos(r.photos),
      created_at: (r.created_at as Date).toISOString(),
      helpful_count: (r.helpful_count as number) ?? 0,
      not_helpful_count: (r.not_helpful_count as number) ?? 0,
      // Embedded-reviews on /roads/:id is an anonymous-friendly endpoint;
      // per-viewer state belongs on /roads/:id/reviews, which uses the
      // OptionalAuthGuard.
      my_vote: null,
      is_mine: false,
    };
  });
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

/**
 * Convert a GeoJSON LineString coordinate list (`[lng, lat]` pairs) into
 * `{ lat, lng }` points, rejecting any coordinate missing a component so a
 * malformed geometry surfaces as a clear error instead of `NaN` lat/lng.
 */
/**
 * Coordinate array for a response polyline from a GeoJSON LineString or, when an
 * aggregated OSM way's assessed sub-segments are non-contiguous (a gap),
 * `ST_LineMerge` returns a MultiLineString (#794). The `geometry` DTO is a single
 * polyline, so rather than concatenate the parts — which would draw a straight
 * connector across the unassessed gap and can misplace the rank marker — return
 * the geographically LONGEST contiguous part (not the one with the most
 * vertices — a short but dense stub must not win). Contiguous ways stay a
 * LineString, so the Multi branch is the rare case; faithful multi-part
 * rendering is tracked in #809.
 */
function geoJsonLineCoordinates(geojson: {
  type: string;
  coordinates: number[][] | number[][][];
}): number[][] {
  if (geojson.type === 'MultiLineString') {
    const parts = geojson.coordinates as number[][][];
    let best: number[][] = parts[0] ?? [];
    let bestLength = -1;
    for (const part of parts) {
      const length = polylineMeters(part);
      if (length > bestLength) {
        best = part;
        bestLength = length;
      }
    }
    return best;
  }
  return geojson.coordinates as number[][];
}

/** Geographic length of a `[lng, lat][]` polyline in metres. */
function polylineMeters(coords: number[][]): number {
  let total = 0;
  for (let i = 1; i < coords.length; i++) {
    const prev = coords[i - 1];
    const curr = coords[i];
    if (!prev || !curr) continue;
    const [aLng, aLat] = prev;
    const [bLng, bLat] = curr;
    if (
      aLng === undefined ||
      aLat === undefined ||
      bLng === undefined ||
      bLat === undefined
    ) {
      continue;
    }
    total += haversineMeters(aLat, aLng, bLat, bLng);
  }
  return total;
}

function lineStringToLatLng(
  coordinates: number[][],
): { lat: number; lng: number }[] {
  return coordinates.map((coord) => {
    const lng = coord[0];
    const lat = coord[1];
    if (lng === undefined || lat === undefined) {
      throw new Error('GeoJSON coordinate is missing lat/lng');
    }
    return { lat, lng };
  });
}

/** Convert the outer ring of a GeoJSON Polygon into `{ lat, lng }` points. */
function polygonBoundaryToLatLng(
  coordinates: number[][][],
): { lat: number; lng: number }[] {
  const ring = coordinates[0];
  if (!ring) {
    throw new Error('GeoJSON polygon has no outer ring');
  }
  return lineStringToLatLng(ring);
}
