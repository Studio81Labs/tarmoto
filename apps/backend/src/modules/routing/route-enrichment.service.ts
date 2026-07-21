import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import {
  ConcurrencyLimiter,
  positiveInteger,
} from '../../common/concurrency-limiter.js';

export interface RouteMetrics {
  avgQuality: number | null;
  curvinessScore: number | null;
  scenicScore: number | null;
  elevationGain: number;
  elevationLoss: number;
  hazardCount: number;
  /** Road-segment lengths grouped by `surface_type`, in **metres**. */
  surfaceMixMetres: Record<string, number>;
}

/**
 * Buffer (metres) for snapping route samples to `road_segments`. 100m matches
 * the `commute` module's quality lookup — narrow enough to avoid most parallel
 * roads but wide enough to catch offsets between routed geometry and our
 * segment table.
 */
const ROAD_BUFFER_M = 100;

/**
 * Aggregate cards do not need the segment-by-segment resolution used by the
 * route-quality overlay. Keep 40 m fidelity for normal routes, but cap the
 * total samples so a cross-country line costs roughly the same as a day ride.
 * The detailed segment overlay remains on `/roads/route-quality`; this bounded
 * query only computes the summary metrics returned with route planning.
 */
const AGGREGATE_SAMPLE_SPACING_M = 40;
const MAX_AGGREGATE_SAMPLES = 2_500;

/**
 * Same buffer rule as the commute module — half a kilometre captures
 * hazards that are visible from the road without flagging stuff several
 * blocks away.
 */
const HAZARD_BUFFER_M = 500;

/**
 * Buffer (km) for fun-zone overlap. Zones are polygons rather than
 * lines, so we measure overlap of the route with the zone's boundary
 * rather than a perpendicular distance.
 */
const SCENIC_OVERLAP_BUFFER_KM = 0.5;

function geometryToWkt(
  geometry: ReadonlyArray<{ lat: number; lng: number }>,
): string {
  const coords = geometry
    .map((p) => `${Number(p.lng)} ${Number(p.lat)}`)
    .join(',');
  return `LINESTRING(${coords})`;
}

@Injectable()
export class RouteEnrichmentService {
  private readonly logger = new Logger(RouteEnrichmentService.name);
  private readonly limiter: ConcurrencyLimiter;

  constructor(
    private readonly dataSource: DataSource,
    @Optional() config?: ConfigService,
  ) {
    // Each aggregate runs three SQL statements concurrently. Three aggregates
    // therefore occupy at most nine connections, staying within the pg
    // driver's usual ten-connection pool while leaving one slot for ordinary
    // API work. Operators with a deliberately larger pool can tune this.
    this.limiter = new ConcurrencyLimiter(
      positiveInteger(
        config?.get<string>('TARMOTO_ROUTE_ENRICHMENT_MAX_CONCURRENCY'),
        3,
        16,
      ),
    );
  }

  async aggregate(
    geometry: ReadonlyArray<{ lat: number; lng: number }>,
    signal?: AbortSignal,
  ): Promise<RouteMetrics> {
    return this.limiter.run(
      () => this.aggregateUnbounded(geometry, signal),
      signal,
    );
  }

  private async aggregateUnbounded(
    geometry: ReadonlyArray<{ lat: number; lng: number }>,
    signal?: AbortSignal,
  ): Promise<RouteMetrics> {
    // Guard against degenerate/malformed geometry (snap-collapsed identical
    // points, NaN/Inf coords, or fewer than 2 points): geometryToWkt would
    // otherwise emit invalid WKT (`LINESTRING()` / `LINESTRING(NaN NaN)`) and
    // the PostGIS ST_DWithin queries would 500. Degrade to empty metrics so the
    // live-route + save paths return a clean no-enrichment result instead.
    const finite = geometry.filter(
      (p) => Number.isFinite(p.lat) && Number.isFinite(p.lng),
    );
    if (finite.length < 2) {
      return {
        avgQuality: null,
        curvinessScore: null,
        scenicScore: null,
        elevationGain: 0,
        elevationLoss: 0,
        hazardCount: 0,
        surfaceMixMetres: {},
      };
    }
    const wkt = geometryToWkt(finite);

    type RoadMetricRow = {
      avg_quality: number | null;
      avg_curviness: number | null;
      elevation_span: number | null;
      total_length_m: number | null;
      surface_mix: unknown;
    };
    type HazardRow = { count: number };
    type ScenicRow = { avg_scenic: number | null; zone_count: number };

    const queryDurations = new Map<string, number>();
    const timedQuery = async <T>(
      label: string,
      sql: string,
      params: unknown[],
    ): Promise<T> => {
      const startedAt = Date.now();
      try {
        return await this.query(sql, params, signal);
      } finally {
        queryDurations.set(label, Date.now() - startedAt);
      }
    };

    const aggregateStartedAt = Date.now();
    const roadQuery = timedQuery<RoadMetricRow[]>(
      'roads',
      `WITH route AS MATERIALIZED (
             SELECT
               ST_GeomFromText($1, 4326) AS line,
               ST_Length(ST_GeomFromText($1, 4326)::geography) AS length_m
           ),
           sampling AS MATERIALIZED (
             SELECT
               line,
               length_m,
               LEAST(
                 $3::int,
                 GREATEST(2, CEIL(length_m / $4::float)::int)
               ) AS sample_count
             FROM route
           ),
           samples AS MATERIALIZED (
             SELECT
               series.idx,
               sampling.length_m / sampling.sample_count AS step_m,
               ST_LineInterpolatePoint(
                 sampling.line,
                 (series.idx + 0.5)::float / sampling.sample_count
               ) AS point
             FROM sampling
             CROSS JOIN LATERAL generate_series(
               0,
               sampling.sample_count - 1
             ) AS series(idx)
           ),
           snapped AS MATERIALIZED (
             SELECT
               samples.idx,
               samples.step_m,
               nearest.id AS segment_id,
               nearest.quality_score,
               nearest.curviness_score,
               nearest.surface_type
             FROM samples
             LEFT JOIN LATERAL (
               SELECT
                 rs.id,
                 rs.quality_score,
                 rs.curviness_score,
                 rs.surface_type
               FROM road_segments rs
               WHERE rs.deactivated_at IS NULL
                 -- Every lookup is a small point-local GiST search. Unlike a
                 -- whole-route predicate, its bounding box does not grow from
                 -- a few km to half a continent as route length increases.
                 AND ST_DWithin(
                   rs.geom,
                   samples.point,
                   ($2 / 111320.0 * 2)
                 )
                 AND ST_DWithin(
                   rs.geom::geography,
                   samples.point::geography,
                   $2
                 )
               ORDER BY ST_Distance(
                 rs.geom::geography,
                 samples.point::geography
               )
               LIMIT 1
             ) nearest ON TRUE
           ),
           metrics AS (
             SELECT
               AVG(quality_score)::float AS avg_quality,
               AVG(curviness_score)::float AS avg_curviness,
               SUM(step_m) FILTER (WHERE segment_id IS NOT NULL)::float
                 AS total_length_m
             FROM snapped
           ),
           elevation AS (
             SELECT
               SUM(
                 GREATEST(rs.elevation_max - rs.elevation_min, 0)
               )::float AS elevation_span
             FROM road_segments rs
             INNER JOIN (
               SELECT DISTINCT segment_id
               FROM snapped
               WHERE segment_id IS NOT NULL
             ) matched ON matched.segment_id = rs.id
           ),
           surface_lengths AS (
             SELECT
               COALESCE(surface_type, 'unknown') AS surface_type,
               SUM(step_m)::float AS length_m
             FROM snapped
             WHERE segment_id IS NOT NULL
             GROUP BY COALESCE(surface_type, 'unknown')
           ),
           surfaces AS (
             SELECT COALESCE(
               jsonb_object_agg(surface_type, length_m),
               '{}'::jsonb
             ) AS surface_mix
             FROM surface_lengths
           )
           SELECT
             metrics.avg_quality,
             metrics.avg_curviness,
             elevation.elevation_span,
             metrics.total_length_m,
             surfaces.surface_mix
           FROM metrics
           CROSS JOIN elevation
           CROSS JOIN surfaces`,
      [wkt, ROAD_BUFFER_M, MAX_AGGREGATE_SAMPLES, AGGREGATE_SAMPLE_SPACING_M],
    );
    const hazardQuery = timedQuery<HazardRow[]>(
      'hazards',
      `SELECT COUNT(*)::int AS count
           FROM hazard_reports h
           WHERE h.is_active = true AND h.expires_at > NOW()
             AND h.moderation_status = 'visible'
             AND ST_DWithin(
               h.location,
               ST_GeomFromText($1, 4326),
               ($2 / 111320.0 * 2)
             )
             AND ST_DWithin(
               h.location::geography,
               ST_GeomFromText($1, 4326)::geography,
               $2
             )`,
      [wkt, HAZARD_BUFFER_M],
    );
    const scenicQuery = timedQuery<ScenicRow[]>(
      'scenic',
      `SELECT
             AVG(fz.composite_score)::float AS avg_scenic,
             COUNT(*)::int AS zone_count
           FROM fun_zones fz
           WHERE ST_DWithin(
             fz.boundary,
             ST_GeomFromText($1, 4326),
             ($2 / 111320.0 * 2)
           )
             AND ST_DWithin(
             fz.boundary::geography,
             ST_GeomFromText($1, 4326)::geography,
             $2
           )`,
      [wkt, SCENIC_OVERLAP_BUFFER_KM * 1000],
    );
    const queries = [roadQuery, hazardQuery, scenicQuery] as const;
    let roadRows: RoadMetricRow[];
    let hazardRows: HazardRow[];
    let scenicRows: ScenicRow[];
    try {
      [roadRows, hazardRows, scenicRows] = await Promise.all(queries);
    } catch (err: unknown) {
      if (signal?.aborted) {
        // Do not release the aggregate limiter slot after only the first
        // cancellation response: all three runners must finish cancelling and
        // return their connections before another aggregate can enter.
        await Promise.allSettled(queries);
      }
      throw err;
    }

    const q: RoadMetricRow | undefined = roadRows[0];
    const s: ScenicRow | undefined = scenicRows[0];
    const h: HazardRow | undefined = hazardRows[0];
    const surfaceMixMetres = parseSurfaceMix(q?.surface_mix);

    const totalDurationMs = Date.now() - aggregateStartedAt;
    if (totalDurationMs >= 1_000) {
      this.logger.warn(
        `Route enrichment took ${totalDurationMs}ms ` +
          `(roads=${queryDurations.get('roads') ?? -1}ms, ` +
          `hazards=${queryDurations.get('hazards') ?? -1}ms, ` +
          `scenic=${queryDurations.get('scenic') ?? -1}ms)`,
      );
    }

    // Elevation gain/loss: we don't have a pre-aggregated profile per
    // route, so use the sum of segment elevation spans as an upper-bound
    // proxy — plenty good for a day card and consistent with what the
    // road-segment elevation columns already report. For a loop trip
    // total descent equals total ascent so this is exact; for a one-way
    // day it's an over-estimate. The contract is documented on
    // `TripDayDto.elevation_loss` so mobile/companion consumers know
    // the value mirrors `elevation_gain` until a real elevation profile
    // API lands.
    const elevationSpan = q?.elevation_span ?? 0;
    const elevationGain = elevationSpan;
    const elevationLoss = elevationSpan;

    const avgQuality = q?.avg_quality ?? null;
    const curvinessScore = q?.avg_curviness ?? null;
    const zoneCount = s?.zone_count ?? 0;
    const scenicAvg = s?.avg_scenic ?? null;
    // Map fun-zone aggregate into a 0..100 scenic score with a real
    // gradient. The previous `avgScore * min(count, 4) * 25` formula
    // saturated at 100 for any zone with composite_score >= 4 (US-6
    // produces scores in roughly the 1..10 range), so an option that
    // overlapped one good zone could not be distinguished from one
    // overlapping five great zones — defeating the "scenic sweep"
    // preset's whole job. Split the score into:
    //   • up to 70 points from the *quality* of zones touched
    //     (composite_score normalised against an expected ~10 ceiling)
    //   • up to 30 points from the *count* of distinct zones touched
    //     (capped at 5 so a single high-density region can't dominate)
    // The sum is still clamped to 100 so the value stays comparable to
    // `quality_score`/`curviness_score` in the same weight bands.
    const scenicScore =
      scenicAvg !== null && zoneCount > 0
        ? Math.min(
            100,
            Math.min(scenicAvg, 10) * 7 + Math.min(zoneCount, 5) * 6,
          )
        : 0;
    const hazardCount = h?.count ?? 0;

    return {
      avgQuality,
      curvinessScore,
      scenicScore,
      elevationGain,
      elevationLoss,
      hazardCount,
      surfaceMixMetres,
    };
  }

  /**
   * TypeORM's PostgreSQL query API does not accept AbortSignal. When the
   * request has one, pin the statement to a QueryRunner connection and cancel
   * that backend from a spare pool connection on abort. This releases both
   * Postgres CPU and the enrichment limiter slot instead of merely abandoning
   * the HTTP response while the spatial statement keeps running.
   */
  private async query<T>(
    sql: string,
    params: unknown[],
    signal?: AbortSignal,
  ): Promise<T> {
    if (!signal) return this.dataSource.query<T>(sql, params);

    signal.throwIfAborted();
    const runner = this.dataSource.createQueryRunner();
    await runner.connect();

    let backendPid: number | undefined;
    let settled = false;
    let cancellation: Promise<void> | undefined;
    const cancel = () => {
      if (settled || backendPid === undefined) return;
      cancellation ??= this.cancelBackend(backendPid);
    };

    try {
      signal.throwIfAborted();
      const pidRows = (await runner.query(
        'SELECT pg_backend_pid()::int AS pid',
      )) as Array<{ pid: number }>;
      backendPid = pidRows[0]?.pid;
      signal.addEventListener('abort', cancel, { once: true });
      signal.throwIfAborted();
      const result: unknown = await runner.query(sql, params);
      return result as T;
    } finally {
      settled = true;
      signal.removeEventListener('abort', cancel);
      // Keep ownership of this backend PID until the cancellation request has
      // completed. Releasing it earlier could let the pool reuse the same
      // connection and a delayed pg_cancel_backend call could then terminate
      // an unrelated query.
      await cancellation;
      await runner.release();
    }
  }

  private async cancelBackend(backendPid: number): Promise<void> {
    try {
      await this.dataSource.query('SELECT pg_cancel_backend($1)', [backendPid]);
    } catch (err: unknown) {
      this.logger.warn(
        `Failed to cancel route enrichment query: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}

function parseSurfaceMix(value: unknown): Record<string, number> {
  let parsed = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value) as unknown;
    } catch {
      return {};
    }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {};
  }
  const result: Record<string, number> = {};
  for (const [surface, metres] of Object.entries(parsed)) {
    const numeric = typeof metres === 'number' ? metres : Number(metres);
    if (Number.isFinite(numeric)) result[surface] = numeric;
  }
  return result;
}
