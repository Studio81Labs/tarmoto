import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';

/**
 * US-6 — discovers Fun Zones by clustering road segments and writes the
 * result into `fun_zones` and `fun_zone_roads`.
 *
 * Algorithm:
 *   1. Filter `road_segments` to eligible candidates (curvy enough, quality
 *      established, long enough, optionally inside a bbox).
 *   2. Cluster eligible segments with PostGIS `ST_ClusterDBSCAN` using
 *      degree-based `eps` and a min-points threshold.
 *   3. For each cluster, aggregate per-zone stats (avg curviness/quality,
 *      elevation range, total length, total curve-km, road count) and
 *      compute the boundary as the buffered convex hull of the union of
 *      member geometries.
 *   4. Score the cluster with a documented composite formula (see
 *      `docs/reference/fun-zone-clustering.md`).
 *   5. Derive `best_season` from contained mountain passes — any pass
 *      whose typical window is narrower than year-round flips the zone to
 *      summer-only.
 *   6. Upsert zones into `fun_zones` with deterministic UUIDs derived
 *      from member-segment IDs (so re-runs on the same input return the
 *      same row IDs and avoid churning the API surface).
 *
 * The whole pipeline is wrapped in a single transaction so partial
 * failures don't leave orphan zones or members behind.
 */

export type FunZoneSeason = 'spring' | 'summer' | 'autumn' | 'year_round';

export interface FunZoneClusteringOptions {
  /** Optional bounding box [west, south, east, north] in WGS84 to restrict clustering to a region. */
  bbox?: [number, number, number, number];
  /** Minimum curviness score for a segment to be eligible. */
  minCurviness?: number;
  /** Minimum aggregated quality score for a segment to be eligible. */
  minQuality?: number;
  /** Minimum confidence (reading-coverage proxy) for a segment to be eligible. */
  minConfidence?: number;
  /** Minimum segment length in meters. */
  minSegmentLengthM?: number;
  /** DBSCAN epsilon in degrees of arc — roughly the cluster radius. */
  epsDegrees?: number;
  /** DBSCAN min-points — fewer neighbours and a segment is treated as noise. */
  minPoints?: number;
  /** Drop clusters smaller than this many segments. */
  minRoadsPerZone?: number;
  /** Hull buffer in meters — pads the polygon so it visibly contains the roads. */
  hullBufferM?: number;
  /** Replace ALL fun zones in scope (default true). When false, only inserts new zones and leaves stale ones. */
  pruneStaleZones?: boolean;
}

export interface FunZoneClusteringResult {
  zones_written: number;
  zones_pruned: number;
  members_written: number;
  duration_ms: number;
}

export interface CompositeScoreInput {
  avg_curviness: number;
  avg_quality: number;
  elevation_range_m: number;
  road_count: number;
  scenic_factor?: number;
}

export interface CompositeScoreWeights {
  curviness: number;
  quality: number;
  elevation: number;
  density: number;
  scenic: number;
}

/**
 * Composite score weights — sum to 1.0. Bumped curviness highest because
 * "fun" is dominated by twisty riding for the target persona; quality
 * second because a fun-but-broken road still gets ridden once; elevation
 * variance third as a proxy for scenery/altitude. Density fills in
 * "dense network" preference. Scenic stays small until a real source is
 * wired (PRD 3.2 lists it but doesn't yet supply data).
 */
export const FUN_ZONE_SCORE_WEIGHTS: CompositeScoreWeights = {
  curviness: 0.4,
  quality: 0.25,
  elevation: 0.15,
  density: 0.15,
  scenic: 0.05,
};

/**
 * Reference values used to map raw stats into the 0..1 range. A zone at
 * or above these values saturates that component to 1.
 */
export const FUN_ZONE_SCORE_REFERENCES = {
  /** Curviness score uses a 0..5 scale already. */
  maxCurviness: 5,
  /** Quality is a 1..5 average — anchor below to (5 - 1) range. */
  qualityMin: 1,
  qualityMax: 5,
  /** Pretty alpine zones tend to span ~1500m of vertical. */
  maxElevationRangeM: 1500,
  /** ~30 segments in a region is "dense" for our cluster sizes. */
  maxRoadCount: 30,
} as const;

const DEFAULTS: Required<
  Omit<FunZoneClusteringOptions, 'bbox' | 'pruneStaleZones'>
> & {
  pruneStaleZones: boolean;
} = {
  minCurviness: 2.0,
  minQuality: 3.0,
  minConfidence: 50,
  minSegmentLengthM: 500,
  // ~0.045° at 50°N is roughly 3.2km E/W and 5.0km N/S — a good fun-zone
  // radius without merging the whole Beskydy ridge into one mega-zone.
  epsDegrees: 0.045,
  minPoints: 3,
  minRoadsPerZone: 3,
  hullBufferM: 250,
  pruneStaleZones: true,
};

/**
 * Stable UUID namespace for fun zones — combined with the sorted list of
 * member segment IDs to derive each zone's primary key. Generated once
 * and pinned as a constant so deployments never produce different IDs
 * from the same input.
 */
export const FUN_ZONE_UUID_NAMESPACE = '47b1a8a9-8d67-4b28-9a1c-6cb72d6c4f01';

@Injectable()
export class FunZoneClusteringService {
  private readonly logger = new Logger(FunZoneClusteringService.name);

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /**
   * Clamp a value to the 0..1 range. Pulled out so the score formula
   * doesn't depend on Math.min/Math.max being read in two places.
   */
  static clamp01(value: number): number {
    if (Number.isNaN(value)) return 0;
    if (value <= 0) return 0;
    if (value >= 1) return 1;
    return value;
  }

  /**
   * Pure scoring formula — exposed for unit tests and documentation. Returns
   * a value in 0..100. Inputs come from the per-cluster aggregate stats.
   */
  static computeCompositeScore(
    input: CompositeScoreInput,
    weights: CompositeScoreWeights = FUN_ZONE_SCORE_WEIGHTS,
  ): number {
    const refs = FUN_ZONE_SCORE_REFERENCES;
    const curviness = this.clamp01(input.avg_curviness / refs.maxCurviness);
    const quality = this.clamp01(
      (input.avg_quality - refs.qualityMin) /
        (refs.qualityMax - refs.qualityMin),
    );
    const elevation = this.clamp01(
      input.elevation_range_m / refs.maxElevationRangeM,
    );
    const density = this.clamp01(input.road_count / refs.maxRoadCount);
    const scenic = this.clamp01(input.scenic_factor ?? 0);

    const score =
      weights.curviness * curviness +
      weights.quality * quality +
      weights.elevation * elevation +
      weights.density * density +
      weights.scenic * scenic;

    // 0..100, two-decimal precision so JSON payloads stay compact and
    // sorts behave predictably.
    return Math.round(score * 100 * 100) / 100;
  }

  /**
   * Per-segment contribution to its zone — used to surface "best roads
   * in this zone" in the detail view. Multiplicative on (curviness ×
   * quality × length) so a long curvy smooth segment ranks above a short
   * one of similar profile.
   */
  static computeContributionScore(
    curviness: number,
    quality: number | null,
    lengthM: number,
  ): number {
    const refs = FUN_ZONE_SCORE_REFERENCES;
    const c = this.clamp01(curviness / refs.maxCurviness);
    const q = this.clamp01(
      ((quality ?? refs.qualityMin) - refs.qualityMin) /
        (refs.qualityMax - refs.qualityMin),
    );
    const l = this.clamp01(lengthM / 5000);
    return Math.round(c * q * l * 1000) / 1000;
  }

  /**
   * Decide a zone's best riding season. Closures are not yet wired into
   * the seasonal model — passes are the strongest signal we have today,
   * and any pass with a non-year-round window flips the zone to
   * summer-only.
   */
  static deriveBestSeason(
    passes: Array<{ typical_open_month: number; typical_close_month: number }>,
  ): FunZoneSeason {
    if (passes.length === 0) return 'year_round';
    const seasonal = passes.some(
      (p) => !(p.typical_open_month === 1 && p.typical_close_month === 12),
    );
    return seasonal ? 'summer' : 'year_round';
  }

  /**
   * Run the full clustering pipeline and persist results. Idempotent
   * for a given option set — re-running on the same data yields the same
   * fun-zone IDs.
   */
  async runClustering(
    options: FunZoneClusteringOptions = {},
  ): Promise<FunZoneClusteringResult> {
    const opts = { ...DEFAULTS, ...options };
    const startedAt = Date.now();

    return this.dataSource.transaction(async (tx) => {
      const aggregateRows = await this.clusterAndAggregate(tx, opts);
      this.logger.log(
        `Clustering produced ${aggregateRows.length} zone candidates`,
      );

      const persisted = await this.persistZones(tx, aggregateRows, {
        pruneStaleZones: opts.pruneStaleZones,
        bbox: opts.bbox,
      });

      return {
        zones_written: persisted.zonesWritten,
        zones_pruned: persisted.zonesPruned,
        members_written: persisted.membersWritten,
        duration_ms: Date.now() - startedAt,
      };
    });
  }

  /**
   * Run the clustering SQL and return one row per candidate zone with its
   * member segment IDs and aggregate stats. Geometry-side work
   * (DBSCAN, hull, buffer, centroid) is done by PostGIS; the TS layer
   * handles scoring and persistence.
   */
  private async clusterAndAggregate(
    tx: EntityManager,
    opts: Required<Omit<FunZoneClusteringOptions, 'bbox'>> & {
      bbox?: [number, number, number, number];
    },
  ): Promise<ClusterRow[]> {
    const params: (string | number)[] = [
      opts.minCurviness,
      opts.minQuality,
      opts.minConfidence,
      opts.minSegmentLengthM,
      opts.epsDegrees,
      opts.minPoints,
      opts.hullBufferM,
      opts.minRoadsPerZone,
    ];

    let bboxClause = '';
    if (opts.bbox) {
      const [w, s, e, n] = opts.bbox;
      bboxClause = `AND ST_Intersects(geom, ST_MakeEnvelope($9, $10, $11, $12, 4326))`;
      params.push(w, s, e, n);
    }

    const sql = `
      WITH eligible AS (
        SELECT
          id, geom, curviness_score, quality_score, length_m,
          elevation_min, elevation_max
        FROM road_segments
        WHERE curviness_score >= $1
          AND quality_score IS NOT NULL
          AND quality_score >= $2
          AND confidence >= $3
          AND length_m >= $4
          ${bboxClause}
      ),
      clustered AS (
        SELECT
          id, geom, curviness_score, quality_score, length_m,
          elevation_min, elevation_max,
          ST_ClusterDBSCAN(geom, eps := $5, minpoints := $6) OVER (ORDER BY id) AS cluster_seed
        FROM eligible
      )
      SELECT
        ARRAY_AGG(id::text ORDER BY id) AS member_ids,
        ARRAY_AGG(curviness_score ORDER BY id) AS curviness_scores,
        ARRAY_AGG(quality_score ORDER BY id) AS quality_scores,
        ARRAY_AGG(length_m ORDER BY id) AS lengths_m,
        AVG(curviness_score)::float AS avg_curviness,
        AVG(quality_score)::float AS avg_quality,
        (SUM(CASE WHEN curviness_score >= 3.0 THEN length_m ELSE 0 END) / 1000.0)::float
          AS total_curve_km,
        COALESCE(MAX(elevation_max) - MIN(elevation_min), 0)::float AS elevation_range_m,
        COUNT(*)::int AS road_count,
        ST_AsGeoJSON(
          ST_ConvexHull(
            ST_Buffer(ST_Collect(geom)::geography, $7)::geometry
          )
        ) AS boundary_geojson
      FROM clustered
      WHERE cluster_seed IS NOT NULL
      GROUP BY cluster_seed
      HAVING COUNT(*) >= $8
      ORDER BY ST_X(ST_Centroid(ST_Collect(geom))),
               ST_Y(ST_Centroid(ST_Collect(geom)))
    `;

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const rawRows = await tx.query(sql, params);
    const rows = rawRows as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      member_ids: row.member_ids as string[],
      curviness_scores: (row.curviness_scores as Array<number | string>).map(
        Number,
      ),
      quality_scores: (row.quality_scores as Array<number | string>).map(
        Number,
      ),
      lengths_m: (row.lengths_m as Array<number | string>).map(Number),
      avg_curviness: Number(row.avg_curviness),
      avg_quality: Number(row.avg_quality),
      total_curve_km: Number(row.total_curve_km),
      elevation_range_m: Number(row.elevation_range_m),
      road_count: Number(row.road_count),
      boundary_geojson: row.boundary_geojson as string,
    }));
  }

  /**
   * Persist a batch of cluster candidates as `fun_zones` + `fun_zone_roads`
   * rows. Uses deterministic UUIDs, a single UPSERT, and a final DELETE
   * pass to remove zones that no longer exist in the candidate set so
   * the table stays in sync with the latest run.
   */
  private async persistZones(
    tx: EntityManager,
    candidates: ClusterRow[],
    opts: {
      pruneStaleZones: boolean;
      bbox?: [number, number, number, number];
    },
  ): Promise<{
    zonesWritten: number;
    zonesPruned: number;
    membersWritten: number;
  }> {
    const writtenIds: string[] = [];
    let membersWritten = 0;

    for (const cand of candidates) {
      const memberKey = cand.member_ids.join(',');
      // Resolve the deterministic id via uuid_generate_v5 in SQL so the
      // server-side function is the single source of truth and we never
      // disagree with another caller of the same function.
      const idRows: Array<{ id: string }> = await tx.query(
        `SELECT uuid_generate_v5($1::uuid, $2::text)::text AS id`,
        [FUN_ZONE_UUID_NAMESPACE, memberKey],
      );
      const zoneId = idRows[0].id;

      const passes: Array<{
        typical_open_month: number;
        typical_close_month: number;
      }> = await tx.query(
        `SELECT typical_open_month, typical_close_month
         FROM mountain_passes
         WHERE ST_Intersects(
           location,
           ST_GeomFromGeoJSON($1::text)
         )`,
        [cand.boundary_geojson],
      );
      const bestSeason = FunZoneClusteringService.deriveBestSeason(passes);

      const compositeScore = FunZoneClusteringService.computeCompositeScore({
        avg_curviness: cand.avg_curviness,
        avg_quality: cand.avg_quality,
        elevation_range_m: cand.elevation_range_m,
        road_count: cand.road_count,
      });

      // Note: `name` is intentionally omitted from both the INSERT
      // column list and the ON CONFLICT SET clause. Names are
      // operator-curated (and currently always NULL on first insert),
      // so re-clustering MUST NOT overwrite them. The new-row default
      // is the column default (NULL); existing rows keep whatever
      // name they were given. This matches `cluster_fun_zones()` in
      // migration 1715300000000.
      await tx.query(
        `INSERT INTO fun_zones
           (id, boundary, composite_score, road_count,
            total_curve_km, avg_quality, best_season, last_calculated)
         VALUES (
           $1::uuid,
           ST_GeomFromGeoJSON($2::text),
           $3, $4, $5, $6, $7, NOW()
         )
         ON CONFLICT (id) DO UPDATE SET
           boundary = EXCLUDED.boundary,
           composite_score = EXCLUDED.composite_score,
           road_count = EXCLUDED.road_count,
           total_curve_km = EXCLUDED.total_curve_km,
           avg_quality = EXCLUDED.avg_quality,
           best_season = EXCLUDED.best_season,
           last_calculated = NOW()`,
        [
          zoneId,
          cand.boundary_geojson,
          compositeScore,
          cand.road_count,
          cand.total_curve_km,
          Math.round(cand.avg_quality * 100) / 100,
          bestSeason,
        ],
      );

      // Wipe and rewrite member rows. The unique constraint plus this
      // delete-then-insert pattern keeps the membership consistent with
      // the latest clustering — and matches the issue's idempotency
      // requirement (re-runs don't accumulate stale members).
      await tx.query(
        `DELETE FROM fun_zone_roads WHERE fun_zone_id = $1::uuid`,
        [zoneId],
      );

      // Batch insert all members for this zone in a single query.
      // The previous per-member INSERT loop produced N round-trips per
      // zone, which on a Tyrol-sized cluster (thousands of segments)
      // dominated runtime and increased the chance of lock/timeout
      // pressure under heavy contention. UNNEST + multi-values keeps
      // the write cost bounded to one statement per zone.
      const contributionScores = cand.member_ids.map((_, i) =>
        FunZoneClusteringService.computeContributionScore(
          cand.curviness_scores[i],
          cand.quality_scores[i] ?? null,
          cand.lengths_m[i],
        ),
      );
      if (cand.member_ids.length > 0) {
        await tx.query(
          `INSERT INTO fun_zone_roads (fun_zone_id, road_segment_id, contribution_score)
           SELECT $1::uuid, sid::uuid, score
           FROM UNNEST($2::text[], $3::float[]) AS t(sid, score)`,
          [zoneId, cand.member_ids, contributionScores],
        );
        membersWritten += cand.member_ids.length;
      }

      writtenIds.push(zoneId);
    }

    let zonesPruned = 0;
    if (opts.pruneStaleZones) {
      // Scope pruning to the bbox the run actually clustered. Without
      // this, a regional re-cluster (with `bbox`) would delete every
      // zone outside the bbox as collateral, since `writtenIds` only
      // covers in-scope zones.
      const conditions: string[] = [];
      const params: (string | number)[] = [];
      if (opts.bbox) {
        const [w, s, e, n] = opts.bbox;
        conditions.push(
          `ST_Intersects(boundary, ST_MakeEnvelope($${params.length + 1}, $${params.length + 2}, $${params.length + 3}, $${params.length + 4}, 4326))`,
        );
        params.push(w, s, e, n);
      }
      if (writtenIds.length > 0) {
        const placeholders = writtenIds
          .map((_, i) => `$${params.length + i + 1}::uuid`)
          .join(',');
        conditions.push(`id NOT IN (${placeholders})`);
        params.push(...writtenIds);
      }
      // Guard against an empty-conditions DELETE — that would resolve
      // to `DELETE FROM fun_zones` with no WHERE and nuke the whole
      // table. This happens when the run produced zero candidates AND
      // no bbox was supplied (e.g. a misconfigured threshold). The
      // safe behaviour is to skip the prune, not to silently wipe
      // everything. Operators who actually want a global reset can
      // pass an empty bbox via `--bbox=...` or wipe manually.
      if (conditions.length === 0) {
        this.logger.warn(
          'Skipping prune: clustering produced 0 candidates and no bbox was supplied. ' +
            'This guards against a runaway DELETE — review your thresholds or pass --bbox.',
        );
      } else {
        // Use RETURNING id so the row count is correct regardless of
        // driver. `tx.query` with the pg driver returns the raw row
        // array; for a plain DELETE that's empty (no `affected`
        // metadata is exposed), so the previous `(result).affected`
        // read always saw `undefined` and reported `zonesPruned = 0`
        // even when rows were deleted.
        const sql = `DELETE FROM fun_zones WHERE ${conditions.join(' AND ')} RETURNING id`;
        const deletedRows: Array<{ id: string }> = await tx.query(sql, params);
        zonesPruned = deletedRows.length;
      }
    }

    return {
      zonesWritten: writtenIds.length,
      zonesPruned,
      membersWritten,
    };
  }
}

interface ClusterRow {
  member_ids: string[];
  curviness_scores: number[];
  quality_scores: number[];
  lengths_m: number[];
  avg_curviness: number;
  avg_quality: number;
  total_curve_km: number;
  elevation_range_m: number;
  road_count: number;
  boundary_geojson: string;
}
