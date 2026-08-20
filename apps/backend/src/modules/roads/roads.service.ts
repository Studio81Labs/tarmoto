import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { RoadSegment } from '../../entities/road-segment.entity.js';
import { FunZone } from '../../entities/fun-zone.entity.js';
import { FeatureResolver } from '../features/feature-resolver.service.js';
import { HazardResponseDto } from '../hazards/dto/hazard-response.dto.js';
import { sanitizeHazardPhotoUrl } from '../hazards/dto/hazard-photo.dto.js';
import {
  ReviewResponseDto,
  sanitizeReviewPhotos,
} from '../reviews/dto/review.dto.js';
import {
  findRegion,
  haversineMeters,
  resolveFeatureKillSwitch,
  resolveSystemSwitch,
  type SurfaceType,
  type QualitySource,
  type HazardType,
  type HazardSeverity,
} from '@tarmoto/shared';
import { QueryNearbyDto } from './dto/query-nearby.dto.js';
import {
  RoadSegmentDto,
  RoadSegmentDetailDto,
} from './dto/road-segment.dto.js';
import {
  DEFAULT_FUN_ZONE_BBOX_RESULTS,
  QueryFunZonesDto,
} from './dto/query-fun-zones.dto.js';
import {
  CorridorFunZonesDto,
  DEFAULT_FUN_ZONE_CORRIDOR_KM,
  MAX_FUN_ZONE_CORRIDOR_RESULTS,
} from './dto/corridor-fun-zones.dto.js';
import { FunZoneDto } from './dto/fun-zone.dto.js';
import { QueryBestRoadsDto } from './dto/query-best-roads.dto.js';
import { BestRoadsResponseDto, BestRoadDto } from './dto/best-roads.dto.js';
import { FunZoneDetailDto, FunZoneRoadDto } from './dto/fun-zone-detail.dto.js';
import {
  RouteQualityRequestDto,
  RouteQualityResponseDto,
} from './dto/route-quality.dto.js';

const RECENT_REVIEW_LIMIT = 5;
const ACTIVE_HAZARD_LIMIT = 10;
const BEST_ROADS_MIN_CONFIDENCE = 3;
const BEST_ROADS_MIN_LENGTH_M = 500;
const BEST_ROADS_DEFAULT_LIMIT = 10;
const FUN_ZONE_TOP_ROADS_LIMIT = 10;

// Route-quality sampling (#862). Spacing stays below the importer's ~100 m
// `road_segments` length so a segment is never stepped over, and the accepted
// route length is bounded so that fixed spacing also bounds the sample count
// (~12.5k). A route longer than the limit can't be represented at segment
// scale, so it's rejected rather than returned with silent no-data gaps — the
// companion routes per day/leg and never approaches it.
const ROUTE_QUALITY_SAMPLE_SPACING_M = 40;
const MAX_ROUTE_QUALITY_LENGTH_M = 500_000;

@Injectable()
export class RoadsService {
  private readonly logger = new Logger(RoadsService.name);

  constructor(
    @InjectRepository(RoadSegment)
    private readonly segmentRepo: Repository<RoadSegment>,
    @InjectRepository(FunZone)
    private readonly funZoneRepo: Repository<FunZone>,
    private readonly featureResolver: FeatureResolver,
  ) {}

  /**
   * The `road_quality_overlay` OPERATOR KILL — global state only, deliberately
   * NOT `resolveForUser` (#1203; same shared resolver and reasoning as
   * `RidesService.isRoadQualityOverlayLive`, #1206). The roads endpoints are
   * public / anonymous-friendly, and every client surface gates the overlay
   * through the public `/config/flags` map, which goes false only on a global
   * `force_off` — so these endpoints and the UIs answer the same question the
   * same way. Fail SAFE (on unless `force_off`): this is a FREE-tier feature
   * kill, not a paid entitlement.
   *
   * Under a kill the roads themselves keep serving — geometry, curviness,
   * surface, hazards, reviews are not the killed data — but every quality
   * READOUT nulls, including values the killed score is recoverable from
   * (`best_score`, `contribution_score`; see the call sites).
   */
  private async isQualityOverlayLive(): Promise<boolean> {
    const globalStates = await this.featureResolver.getGlobalStates();
    return resolveFeatureKillSwitch(
      'road_quality_overlay',
      globalStates['road_quality_overlay'],
    );
  }

  /**
   * Per-segment surface quality for an already-routed polyline (#862). Returns,
   * ordered along the route, every stretch the line runs over a `road_segments`
   * row, with its quality / surface / curviness and the route-fraction span it
   * covers. The planner paints each span onto the polyline; gaps between spans
   * are genuine no-coverage stretches it renders as "no data".
   *
   * The join walks the route by sampling it at ~40 m and snapping each sample
   * to the single *nearest* live segment within `buffer_m`, then coalescing
   * contiguous same-segment runs into spans. Two properties make this the
   * right model where a plain buffer-intersection is not:
   *   - Nearest-snap (not "any segment within the buffer") means a sample
   *     picks the road the rider is actually on, so a cross street merely
   *     *crossed* at an intersection doesn't spawn its own quality span.
   *   - Each sample's position is the route parameter `idx/n`, which is
   *     unambiguous even when the route overlaps itself — so a loop or
   *     there-and-back emits one span *per pass* over the same road (the two
   *     passes fall at different sample indices and coalesce separately),
   *     which point-projection (`ST_LineLocatePoint`) cannot express.
   * Span boundaries are the sample-cell edges (±½ step), so adjacent segments
   * abut instead of leaving a gap the client would misread as "no data".
   * Spacing is fixed at ~40 m (never coarsened; the length guard above bounds
   * the sample count) so the importer's normal ~100 m segments are never
   * stepped over. A road segment shorter than the spacing that no sample lands
   * on is the deliberate cost of sampling — a rare, ≤40 m no-data stretch,
   * accepted because the alternative (an exact buffer intersection) can't
   * position self-overlapping passes unambiguously and pulls in merely-crossed
   * cross streets. The buffer stays tight (default 25 m) because the routed
   * line follows the same OSM ways the segments were cut from — a wide buffer
   * would snap to parallel roads.
   *
   * Resilience mirrors the POI read path: any DB failure yields an empty list
   * rather than a 500 (a quality overlay must never break trip planning). The
   * failure is logged (message only — never the route coordinates) so a real
   * outage/schema drift is still an operational signal, not silent "no data".
   */
  async getRouteQuality(
    dto: RouteQualityRequestDto,
  ): Promise<RouteQualityResponseDto> {
    const startedAt = Date.now();
    const bufferM = dto.buffer_m ?? 25;

    // Reject routes too long to represent at segment scale (see the constants).
    // Thrown before the try/catch so it surfaces as a 400, not swallowed into
    // an empty overlay. Length is a cheap haversine sum — no DB round-trip.
    let routeLengthM = 0;
    for (let i = 1; i < dto.geometry.length; i += 1) {
      const a = dto.geometry[i - 1];
      const b = dto.geometry[i];
      if (a && b) routeLengthM += haversineMeters(a.lat, a.lng, b.lat, b.lng);
    }
    if (routeLengthM > MAX_ROUTE_QUALITY_LENGTH_M) {
      throw new BadRequestException(
        `Route too long for per-segment quality (${Math.round(routeLengthM / 1000)} km ` +
          `> ${MAX_ROUTE_QUALITY_LENGTH_M / 1000} km); request it per day/leg.`,
      );
    }

    // Build the route LineString via positional params so no user coordinate
    // is string-interpolated into the SQL.
    const params: number[] = [];
    const pointsSql = dto.geometry
      .map((p) => {
        params.push(p.lng, p.lat);
        return `ST_MakePoint($${params.length - 1}, $${params.length})`;
      })
      .join(',');
    params.push(bufferM);
    const bufferParam = `$${params.length}`;
    // Indexable degree prefilter for the spatial predicates: a plain
    // `ST_DWithin(rs.geom, …)` in SRID-4326 degrees hits the geometry GiST
    // index (`idx_road_segments_geom`), whereas a `geom::geography` distance
    // cannot and would full-scan. `/ 111320` is metres per degree of latitude;
    // `* 2` is a generous factor so the degree box still covers `buffer_m` of
    // *longitude* up to ~lat 60° (Tarmoto's northern coverage). It only
    // *narrows* candidates — each predicate pairs it with a precise
    // `geom::geography` check on the real `buffer_m`, so the generosity never
    // loosens the actual snap/coverage distance.
    const bufferDegExpr = `(${bufferParam} / 111320.0 * 2)`;

    const sql = `
      WITH cfg AS (
        SELECT ST_SetSRID(ST_MakeLine(ARRAY[${pointsSql}]), 4326) AS line
      ),
      route AS (
        SELECT
          line,
          -- Fixed ~40 m spacing (never coarsened): the length guard above
          -- bounds this to ~12.5k samples, so a normal ~100 m segment is never
          -- stepped over regardless of route length.
          GREATEST(2, CEIL(ST_Length(line::geography) / ${ROUTE_QUALITY_SAMPLE_SPACING_M}.0)::int) AS n
        FROM cfg
      ),
      -- Cheap indexed short-circuit: if nothing is near the whole route (a
      -- backcountry / no-coverage import), skip sampling entirely rather than
      -- run the per-sample nearest lookup n times for nothing. MATERIALIZED so
      -- the GiST-indexed check runs exactly once. Routes that DO have coverage
      -- still use the per-sample KNN below, which is index-backed and fast.
      coverage AS MATERIALIZED (
        SELECT EXISTS (
          SELECT 1
          FROM road_segments rs, route
          WHERE rs.deactivated_at IS NULL
            -- Indexable degree prefilter (uses idx_road_segments_geom) narrows
            -- to candidates, then the precise metric check confirms coverage.
            AND ST_DWithin(rs.geom, route.line, ${bufferDegExpr})
            AND ST_DWithin(rs.geom::geography, route.line::geography, ${bufferParam})
        ) AS has_any
      ),
      -- Walk the route: one point every 1/n of its length (only when there is
      -- any coverage to snap to).
      samples AS (
        SELECT
          gs AS idx,
          ST_LineInterpolatePoint(route.line, gs::float / route.n) AS pt
        FROM route, generate_series(0, route.n) AS gs, coverage
        WHERE coverage.has_any
      ),
      -- Snap each sample to the single nearest live segment within the buffer.
      -- Nearest (not "any within buffer") is what keeps a merely-crossed cross
      -- street at an intersection from claiming a span of the rider's road.
      snapped AS (
        SELECT
          s.idx,
          seg.id            AS seg_id,
          seg.osm_way_id    AS osm_way_id,
          seg.segment_index AS segment_index,
          seg.quality_score AS quality_score,
          seg.curviness_score AS curviness_score,
          seg.surface_type  AS surface_type,
          seg.reading_count AS reading_count
        FROM samples s
        LEFT JOIN LATERAL (
          SELECT
            rs.id, rs.osm_way_id, rs.segment_index, rs.quality_score,
            rs.curviness_score, rs.surface_type, rs.reading_count
          FROM road_segments rs
          WHERE rs.deactivated_at IS NULL
            AND ST_GeometryType(rs.geom) = 'ST_LineString'
            -- Indexable degree prefilter bounds the KNN scan via the GiST
            -- index; the precise metric check keeps the snap within the real
            -- buffer_m so a sample can't grab an adjacent road ~30-50 m off the
            -- routed way just because the degree box is generous.
            AND ST_DWithin(rs.geom, s.pt, ${bufferDegExpr})
            AND ST_DWithin(rs.geom::geography, s.pt::geography, ${bufferParam})
          -- Rank by true metric distance, not planar degrees, so the nearest
          -- snap is correct at any latitude. The WHERE has already narrowed
          -- to the handful of segments within buffer_m, so the exact distance
          -- sort is cheap.
          ORDER BY ST_Distance(rs.geom::geography, s.pt::geography)
          LIMIT 1
        ) seg ON TRUE
      ),
      -- Gaps-and-islands: the difference of the two row numbers is constant
      -- across a contiguous run of the same segment, so a second pass over
      -- that segment (separated by other / no-coverage samples) forms its own
      -- run and its own span. NULL samples stay in the numbering so they break
      -- runs, then are dropped from the output.
      runs AS (
        SELECT
          *,
          ROW_NUMBER() OVER (ORDER BY idx)
            - ROW_NUMBER() OVER (PARTITION BY seg_id ORDER BY idx) AS grp
        FROM snapped
      )
      SELECT
        -- The road_segment UUID (group key) so the planner can open the same
        -- /roads/{id} detail drawer as the road explorer for a clicked span.
        seg_id::text          AS segment_id,
        MIN(osm_way_id)::text AS osm_way_id,
        MIN(segment_index)    AS segment_index,
        MIN(quality_score)    AS quality_score,
        MIN(curviness_score)  AS curviness_score,
        MIN(surface_type)     AS surface_type,
        MIN(reading_count)    AS reading_count,
        -- Cell edges (±½ step): adjacent runs share a boundary and abut, so a
        -- segment transition isn't reported as a no-coverage gap.
        GREATEST(0.0, (MIN(idx) - 0.5) / (SELECT n FROM route)) AS start_fraction,
        LEAST(1.0, (MAX(idx) + 0.5) / (SELECT n FROM route))    AS end_fraction
      FROM runs
      WHERE seg_id IS NOT NULL
      GROUP BY seg_id, grp
      ORDER BY start_fraction ASC
    `;

    try {
      // Operator kill (`road_quality_overlay`, #1203): spans keep their
      // surface / curviness payload — the planner still paints surface — but
      // the quality readout is the killed dimension and nulls per span.
      // Resolved inside the try so a flags-read failure degrades to the same
      // logged empty-overlay path as any other DB failure instead of 500-ing
      // trip planning.
      const qualityLive = await this.isQualityOverlayLive();
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const rows = await this.segmentRepo.query(sql, params);
      const durationMs = Date.now() - startedAt;
      if (durationMs >= 1_000) {
        this.logger.warn(
          `Planner route-quality took ${durationMs}ms ` +
            `(route_km=${(routeLengthM / 1000).toFixed(1)}, ` +
            `points=${dto.geometry.length}, spans=${(rows as unknown[]).length})`,
        );
      }

      return {
        segments: (
          rows as Array<{
            segment_id: string | null;
            osm_way_id: string | null;
            segment_index: number | null;
            quality_score: string | number | null;
            curviness_score: string | number;
            surface_type: string;
            reading_count: string | number;
            start_fraction: string | number;
            end_fraction: string | number;
          }>
        ).map((r) => ({
          segment_id: r.segment_id ?? null,
          osm_way_id: r.osm_way_id ?? null,
          segment_index: r.segment_index ?? null,
          quality_score:
            !qualityLive || r.quality_score == null
              ? null
              : Number(r.quality_score),
          curviness_score: Number(r.curviness_score),
          surface_type: r.surface_type,
          reading_count: Number(r.reading_count),
          start_fraction: Number(r.start_fraction),
          end_fraction: Number(r.end_fraction),
        })),
      };
    } catch (err) {
      // Never surface a 500 to the planner over a quality lookup — but do log
      // the failure so an outage / schema drift / bad query is a real signal
      // rather than an empty overlay indistinguishable from a no-coverage
      // route. Log the message only: the SQL carries `$n` placeholders (no
      // values) and the route coordinates are location data that must not be
      // written to logs.
      this.logger.error(
        `route-quality query failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { segments: [] };
    }
  }

  async findNearby(query: QueryNearbyDto): Promise<RoadSegmentDto[]> {
    // Operator kill (`road_quality_overlay`, #1203): resolved BEFORE the SQL
    // is built because the `min_quality` predicate is itself a quality oracle
    // — with the readouts nulled but the filter still applied, bisecting
    // `min_quality` recovers each road's killed score in a handful of
    // requests. Under `force_off` the filter is deliberately inert and the
    // quality readouts (`quality_score`, its `quality_source` provenance, the
    // `osm_quality_seed` estimate) null; the segments themselves — curviness,
    // surface, distance — are not the killed data.
    const qualityLive = await this.isQualityOverlayLive();
    const radius = query.radius ?? 5000;
    const params: (string | number)[] = [query.lng, query.lat, radius];
    let paramIdx = 4;

    let sql = `
      SELECT
        rs.id, rs.road_name, rs.road_number, rs.quality_score,
        rs.curviness_score, rs.surface_type, rs.length_m,
        rs.confidence, rs.reading_count, rs.quality_source, rs.osm_quality_seed, rs.last_updated,
        ST_Distance(
          rs.geom::geography,
          ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography
        ) AS distance_m
      FROM road_segments rs
      WHERE rs.deactivated_at IS NULL
        -- Indexable degree prefilter (uses idx_road_segments_geom) before the
        -- exact geography check — same reason as the route-quality sampling
        -- query above: a bare geom::geography distance full-scans road_segments
        -- (3.2M+ rows once the OSM import runs). $3 m / 111320 * 2 = a generous
        -- degree box that still covers the radius; geography ST_DWithin refines.
        AND ST_DWithin(
          rs.geom,
          ST_SetSRID(ST_MakePoint($1, $2), 4326),
          ($3 / 111320.0 * 2)
        )
        AND ST_DWithin(
        rs.geom::geography,
        ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography,
        $3
      )
    `;

    if (qualityLive && query.min_quality !== undefined) {
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
      quality_score: qualityLive
        ? ((row.quality_score as number) ?? null)
        : null,
      curviness_score: row.curviness_score as number,
      surface_type: row.surface_type as SurfaceType,
      length_m: row.length_m as number,
      confidence: row.confidence as number,
      reading_count: row.reading_count as number,
      quality_source: qualityLive
        ? ((row.quality_source as QualitySource) ?? null)
        : null,
      osm_quality_seed: qualityLive
        ? ((row.osm_quality_seed as number) ?? null)
        : null,
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
        (ARRAY_AGG(rs.quality_source ORDER BY rs.length_m DESC, rs.id))[1] AS quality_source,
        SUM(rs.osm_quality_seed * rs.length_m) FILTER (WHERE rs.osm_quality_seed IS NOT NULL)
          / NULLIF(SUM(rs.length_m) FILTER (WHERE rs.osm_quality_seed IS NOT NULL), 0) AS osm_quality_seed,
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

    // Operator kill switch: resolved once, up front, so both review
    // sub-queries below can be skipped together. A disable degrades the
    // embedded review block gracefully (zeroed count/rating/list) rather
    // than throwing.
    //
    // This block stays FULLY neutral while off — it is the COMMUNITY
    // aggregate, and zeroing it is the kill. The standalone
    // /roads/:id/reviews endpoint (ReviewsService.listForSegment) is
    // deliberately not symmetric: it returns the viewer's OWN review so it
    // stays deletable, since that list is the only place the clients expose
    // edit/delete from. The two are not in conflict — one is "what the
    // community said", the other is "what you wrote". Clients must keep
    // rendering counts and averages from THIS block, never from the length
    // of that list, or a one-element own-review array reads as "1 review"
    // and overwrites the neutralised total.
    // Both switches come from ONE `feature_states` read so the two gates in
    // this response can never disagree mid-flip (same single-fetch rule as
    // `FeatureResolver.resolveForUserWithStates`). `road_quality_overlay`
    // (#1203) is the operator kill for the quality dimension: under
    // `force_off` the road itself keeps serving — geometry, curviness,
    // surface, hazards, reviews, rider activity — but every quality readout
    // nulls (`quality_score`, `quality_source`, `osm_quality_seed`) and the
    // reading-derived quality sub-queries (breakdown + both trend histories)
    // are skipped the same way the review queries are below, leaving their
    // neutral no-readings shape (zeroed breakdown, empty histories).
    const globalStates = await this.featureResolver.getGlobalStates();
    const ratingsEnabled = resolveSystemSwitch(
      'sys_poi_ratings',
      globalStates['sys_poi_ratings'],
    );
    const qualityLive = resolveFeatureKillSwitch(
      'road_quality_overlay',
      globalStates['road_quality_overlay'],
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
      qualityHistoryRows,
      regionalQualityRows,
    ] = await Promise.all([
      qualityLive
        ? this.segmentRepo.query(
            `SELECT classification, COUNT(*)::int AS count
        FROM surface_readings
        WHERE road_segment_id = ANY($1)
          AND recorded_at > NOW() - INTERVAL '6 months'
        GROUP BY classification`,
            [waySegmentIds],
          )
        : [],
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
      // Operator kill switch (sys_poi_ratings): when off, skip the review
      // queries entirely rather than run them and discard the rows — the
      // assembly below already treats an empty `reviewStatsRows`/
      // `reviewRows` as "no reviews" (review_count: 0, avg_review_rating:
      // null, recent_reviews: []), so no other code path needs to change.
      ratingsEnabled
        ? this.segmentRepo.query(
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
          )
        : [],
      ratingsEnabled
        ? this.segmentRepo.query(
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
          )
        : [],
      this.segmentRepo.query(
        `SELECT COUNT(DISTINCT user_id)::int AS count
        FROM surface_readings
        WHERE road_segment_id = ANY($1)
          AND recorded_at > NOW() - INTERVAL '30 days'`,
        [waySegmentIds],
      ),
      // US-45: quality trend — monthly average IRI for the last 2 years.
      // Skipped (like the review queries above) under the
      // `road_quality_overlay` kill — the trend is quality data.
      qualityLive
        ? this.segmentRepo.query(
            `SELECT
          TO_CHAR(DATE_TRUNC('month', recorded_at), 'YYYY-MM') AS month,
          ROUND(AVG(iri_value)::numeric, 2) AS score
        FROM surface_readings
        WHERE road_segment_id = ANY($1)
          AND recorded_at > NOW() - INTERVAL '24 months'
        GROUP BY DATE_TRUNC('month', recorded_at)
        ORDER BY month`,
            [waySegmentIds],
          )
        : [],
      // US-45: regional comparison trend — average across segments within 5 km.
      qualityLive
        ? this.segmentRepo.query(
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
          )
        : [],
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
      quality_score: qualityLive
        ? ((row.quality_score as number) ?? null)
        : null,
      curviness_score: row.curviness_score as number,
      surface_type: row.surface_type as SurfaceType,
      quality_source: qualityLive
        ? ((row.quality_source as QualitySource) ?? null)
        : null,
      osm_quality_seed: qualityLive
        ? ((row.osm_quality_seed as number) ?? null)
        : null,
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
    // Operator kill (`road_quality_overlay`, #1203): /roads/best is public,
    // so the killed quality must not stay curl-readable here while every
    // client surface hides it. `quality_score` nulls directly; `best_score`
    // nulls WITH it because it is
    // `quality*2 + curviness + LEAST(length_km, 20)*0.1` and curviness +
    // length_m ride along in the same row — one line of algebra recovers the
    // killed score from a "sanitized" payload (the companion's
    // `stripRoadQuality` covers the same inversion, #1200). The roads and
    // their ORDER still serve: like a Fun Zone's `composite_score`, the
    // ranking is the curvy-road discovery feature, and a rank position does
    // not reproduce the killed values.
    const qualityLive = await this.isQualityOverlayLive();
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
          quality_score: qualityLive
            ? ((row.quality_score as number) ?? null)
            : null,
          curviness_score: row.curviness_score as number,
          surface_type: row.surface_type as SurfaceType,
          length_m: row.length_m as number,
          confidence: row.confidence as number,
          geometry: lineStringToLatLng(geoJsonLineCoordinates(geojson)),
          best_score: qualityLive ? (row.best_score as number) : null,
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
    const [west, south, east, north] = parseFunZoneBbox(query.bbox);
    const limit = query.limit ?? DEFAULT_FUN_ZONE_BBOX_RESULTS;
    // Operator kill (`road_quality_overlay`, #1203): the zones themselves
    // still serve — a Fun Zone is a curviness DISCOVERY feature
    // (`composite_score` = 0.40·curviness + 0.25·quality + 0.15·elevation +
    // 0.15·road_count, migration 1791000000000) — but `avg_quality` is the
    // killed readout and nulls in the mapper.
    const qualityLive = await this.isQualityOverlayLive();

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const rows = await this.funZoneRepo.query(
      `SELECT ${FUN_ZONE_SELECT}
      FROM fun_zones fz
      WHERE ST_Intersects(
        fz.boundary,
        ST_MakeEnvelope($1, $2, $3, $4, 4326)
      )
      ORDER BY fz.composite_score DESC
      LIMIT $5`,
      [west, south, east, north, limit],
    );

    return (rows as Record<string, unknown>[]).map((row) =>
      funZoneRowToDto(row, qualityLive),
    );
  }

  /**
   * Fun Zones whose boundary falls within `buffer_km` of a routed polyline
   * (#865 — the STOPS-tab `twisty_highlight` layer). The corridor counterpart
   * of the bbox `findFunZones`, and the fun-zone analogue of `/poi/in-corridor`,
   * best-first and capped at `MAX_FUN_ZONE_CORRIDOR_RESULTS` — the client
   * projects each returned zone against the route on its UI thread, so an
   * unbounded corridor would lock up the tab. Route coordinates are bound as
   * positional params (never interpolated) — same pattern as `getRouteQuality`,
   * whose indexable degree-prefilter it also reuses (a bare `geom::geography`
   * distance can't use `idx_fun_zones_boundary`).
   */
  async findFunZonesInCorridor(
    dto: CorridorFunZonesDto,
  ): Promise<FunZoneDto[]> {
    const bufferM = Math.round(
      (dto.buffer_km ?? DEFAULT_FUN_ZONE_CORRIDOR_KM) * 1000,
    );
    const params: number[] = [];
    const pointsSql = dto.route
      .map((p) => {
        params.push(p.lng, p.lat);
        return `ST_MakePoint($${params.length - 1}, $${params.length})`;
      })
      .join(',');
    params.push(bufferM);
    const bufferParam = `$${params.length}`;
    // Indexable degree prefilter, same pattern as getRouteQuality: the geometry
    // `ST_DWithin` hits `idx_fun_zones_boundary`; the precise `geom::geography`
    // check then enforces the real metre buffer. `/111320*2` covers `buffer_m`
    // of longitude up to ~lat 60° (Tarmoto's northern coverage) — it only
    // narrows candidates, never loosens the actual distance.
    const bufferDegExpr = `(${bufferParam} / 111320.0 * 2)`;
    // Operator kill (`road_quality_overlay`, #1203): same treatment as the
    // public bbox read — an authenticated planner surface is not exempt from
    // a GLOBAL kill (the CSV export precedent, #1206: every surface must
    // answer the same question the same way).
    const qualityLive = await this.isQualityOverlayLive();

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const rows = await this.funZoneRepo.query(
      `WITH route AS (
        SELECT ST_SetSRID(ST_MakeLine(ARRAY[${pointsSql}]), 4326) AS line
      )
      SELECT ${FUN_ZONE_SELECT}
      FROM fun_zones fz, route
      WHERE ST_DWithin(fz.boundary, route.line, ${bufferDegExpr})
        AND ST_DWithin(fz.boundary::geography, route.line::geography, ${bufferParam})
      ORDER BY fz.composite_score DESC
      LIMIT ${MAX_FUN_ZONE_CORRIDOR_RESULTS}`,
      params,
    );

    return (rows as Record<string, unknown>[]).map((row) =>
      funZoneRowToDto(row, qualityLive),
    );
  }

  async findZoneById(zoneId: string): Promise<FunZoneDetailDto> {
    // Operator kill (`road_quality_overlay`, #1203): the zone and its top
    // roads still serve — curvy-road discovery is not the killed data — but
    // the quality readouts null: the zone's `avg_quality`, each road's
    // `quality_score`, and each road's `contribution_score`. The last one is
    // NOT paranoia: contribution is multiplicative on
    // (curviness/5 · (quality-1)/4 · length/5000), and curviness + length_m
    // ride along in the same row, so one division recovers the killed score
    // (same inversion class as `best_score` in findBest). The zone's
    // `composite_score` stays: its quality input is one weighted normalized
    // term among four, and the elevation input is not served — rank, not
    // readout.
    const qualityLive = await this.isQualityOverlayLive();
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
      -- Keep a membership whose stored representative sub-segment is tombstoned
      -- ONLY when the SAME road is still there — a live sibling of the member's way
      -- within ~30 m of the (dead) member's own geometry. That preserves a road
      -- whose representative sub-segment died but whose other sub-segments live on,
      -- while dropping a membership whose way key was REUSED for a different road
      -- after a split (tombstones keep their osm_way_id, and a live row may now
      -- reuse it): without this gate the lateral would expand the dead member's key
      -- onto that replacement road and show it with the stale contribution_score.
      -- A live member always passes. The next reclustering rewrites memberships.
      INNER JOIN road_segments member ON member.id = fzr.road_segment_id
        AND (
          member.deactivated_at IS NULL
          OR EXISTS (
            SELECT 1
            FROM road_segments s
            WHERE s.deactivated_at IS NULL
              AND COALESCE(s.osm_way_id::text, s.id::text)
                = COALESCE(member.osm_way_id::text, member.id::text)
              AND ST_DWithin(s.geom::geography, member.geom::geography, 30)
          )
        )
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
        quality_score: qualityLive
          ? ((row.quality_score as number) ?? null)
          : null,
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
        contribution_score: qualityLive
          ? ((row.contribution_score as number) ?? null)
          : null,
      };
    });

    return {
      zone: {
        id: zoneRow.id as string,
        name: (zoneRow.name as string) ?? null,
        composite_score: zoneRow.composite_score as number,
        road_count: zoneRow.road_count as number,
        total_curve_km: (zoneRow.total_curve_km as number) ?? null,
        avg_quality: qualityLive
          ? ((zoneRow.avg_quality as number) ?? null)
          : null,
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
    // Operator kill (`road_quality_overlay`, #1203): the trend IS the
    // quality dimension (monthly average IRI), so under `force_off` this
    // public endpoint returns the same no-readings shape clients already
    // handle — and skips the query entirely, mirroring the `sys_poi_ratings`
    // treatment in findById.
    if (!(await this.isQualityOverlayLive())) {
      return { segment_id: segmentId, points: [] };
    }
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

function parseFunZoneBbox(
  value: string,
): [west: number, south: number, east: number, north: number] {
  const parts = value.split(',').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part))) {
    throw new BadRequestException(
      'bbox must be four finite numbers: west,south,east,north',
    );
  }
  const [west, south, east, north] = parts as [number, number, number, number];
  if (
    west < -180 ||
    east > 180 ||
    south < -90 ||
    north > 90 ||
    west >= east ||
    south >= north
  ) {
    throw new BadRequestException('bbox coordinates or ordering are invalid');
  }
  return [west, south, east, north];
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

/**
 * Columns every Fun Zone list query selects — shared by the bbox (`findFunZones`)
 * and corridor (`findFunZonesInCorridor`) reads so their row shape and mapping
 * stay identical.
 */
const FUN_ZONE_SELECT = `fz.id, fz.name, fz.composite_score, fz.road_count,
        fz.total_curve_km, fz.avg_quality, fz.best_season,
        ST_AsGeoJSON(fz.boundary)::json AS geojson`;

/**
 * Map a raw Fun Zone row (from {@link FUN_ZONE_SELECT}) to the served DTO.
 * `qualityLive` is the resolved `road_quality_overlay` kill switch (#1203):
 * under `force_off` the zone still serves — `composite_score` ranks curvy-road
 * DISCOVERY — but `avg_quality`, the killed quality readout, nulls.
 */
function funZoneRowToDto(
  row: Record<string, unknown>,
  qualityLive: boolean,
): FunZoneDto {
  const geojson = row.geojson as { coordinates: number[][][] };
  return {
    id: row.id as string,
    name: (row.name as string) ?? null,
    composite_score: row.composite_score as number,
    road_count: row.road_count as number,
    total_curve_km: (row.total_curve_km as number) ?? null,
    avg_quality: qualityLive ? ((row.avg_quality as number) ?? null) : null,
    best_season: (row.best_season as string) ?? null,
    boundary: polygonBoundaryToLatLng(geojson.coordinates),
  };
}
