import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Issue #835 — split/merge reconciliation tombstones instead of deleting.
 *
 * When the OSM importer detects that an existing segment's way was removed, or
 * split/merged away so no incoming segment inherits it (ADR-0006), the row is
 * DEACTIVATED, not hard-deleted: the crowdsourced history (`surface_readings`,
 * `road_reviews`, `hazard_reports`, `fun_zone_roads`) still FKs to it, and a
 * delete would either violate those constraints or destroy the very history the
 * stable-identity work (#751) exists to preserve.
 *
 * `deactivated_at` NULL = live; a timestamp = tombstoned at that moment. Active
 * read paths filter `deactivated_at IS NULL`; the partial index keeps that filter
 * index-friendly and matches the predicate the live-row scans use.
 *
 * The `(osm_way_id, segment_index)` identity index is also rebuilt as **partial on
 * live rows** so a tombstone never OWNS its OSM key: otherwise a returning key
 * would conflict with the dead row (and the conflict update wouldn't revive it),
 * and a carry-over re-pointing a live row onto a formerly-tombstoned key would hit
 * a unique violation. With the partial index, tombstones are out of the
 * uniqueness scope — a returning key inserts a fresh live row (its history stays
 * on the tombstone), and a carry-over onto that key is unobstructed.
 */
export class AddRoadSegmentDeactivatedAt1791000000000 implements MigrationInterface {
  name = 'AddRoadSegmentDeactivatedAt1791000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE road_segments
        ADD COLUMN IF NOT EXISTS deactivated_at timestamptz;
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_road_segments_active
        ON road_segments (id)
        WHERE deactivated_at IS NULL;
    `);
    // Make OSM identity uniqueness live-row aware (tombstones drop out of scope).
    await queryRunner.query(
      `DROP INDEX IF EXISTS uq_road_segments_osm_identity;`,
    );
    await queryRunner.query(`
      CREATE UNIQUE INDEX uq_road_segments_osm_identity
        ON road_segments (osm_way_id, segment_index)
        WHERE deactivated_at IS NULL;
    `);
    // Keep the stored `cluster_fun_zones()` ops/restore function in sync with
    // FunZoneClusteringService: exclude tombstoned rows (#835). Otherwise an
    // operator running `SELECT cluster_fun_zones()` after an OSM import would
    // rebuild fun_zones / fun_zone_roads from dead rows, and `listFunZones` would
    // serve those materialized stale zones.
    await queryRunner.query(CLUSTER_FUN_ZONES_LIVE);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Restore the #794 aggregated function without the live-row filter.
    await queryRunner.query(CLUSTER_FUN_ZONES_NO_LIVE);
    // The partial index permits a dead row + a live row to share an OSM key, so
    // rebuilding the OLD unfiltered unique index would hit a duplicate-key error
    // once the importer has tombstoned any reused key. Live rows are unique by the
    // partial-index invariant, so strip the OSM identity from tombstones first
    // (keeping the rows + their history FKs; the identity is meaningless once this
    // feature is reverted) — then the unfiltered index rebuilds cleanly.
    await queryRunner.query(`
      UPDATE road_segments
        SET osm_way_id = NULL, segment_index = NULL
        WHERE deactivated_at IS NOT NULL;
    `);
    await queryRunner.query(
      `DROP INDEX IF EXISTS uq_road_segments_osm_identity;`,
    );
    await queryRunner.query(`
      CREATE UNIQUE INDEX uq_road_segments_osm_identity
        ON road_segments (osm_way_id, segment_index);
    `);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_road_segments_active;`);
    await queryRunner.query(
      `ALTER TABLE road_segments DROP COLUMN IF EXISTS deactivated_at;`,
    );
  }
}

/** `cluster_fun_zones()` eligibility — per-way aggregation (#794) that also
 *  excludes tombstoned rows (#835), matching FunZoneClusteringService. */
const CLUSTER_FUN_ZONES_LIVE = clusterFunZonesFn(`
        WITH assessed_ways AS (
          SELECT DISTINCT COALESCE(osm_way_id::text, id::text) AS road_key
          FROM road_segments
          WHERE quality_score IS NOT NULL
            AND deactivated_at IS NULL
        ),
        road AS (
          SELECT
            (ARRAY_AGG(rs.id ORDER BY rs.segment_index NULLS FIRST, rs.id))[1] AS id,
            ST_LineMerge(ST_Collect(rs.geom ORDER BY rs.segment_index NULLS FIRST, rs.id)
              FILTER (WHERE rs.quality_score IS NOT NULL)) AS geom,
            SUM(rs.curviness_score * rs.length_m) FILTER (WHERE rs.quality_score IS NOT NULL)
              / NULLIF(SUM(rs.length_m) FILTER (WHERE rs.quality_score IS NOT NULL), 0) AS curviness_score,
            SUM(rs.quality_score * rs.length_m) FILTER (WHERE rs.quality_score IS NOT NULL)
              / NULLIF(SUM(rs.length_m) FILTER (WHERE rs.quality_score IS NOT NULL), 0) AS quality_score,
            SUM(rs.confidence * rs.length_m) FILTER (WHERE rs.quality_score IS NOT NULL)
              / NULLIF(SUM(rs.length_m) FILTER (WHERE rs.quality_score IS NOT NULL), 0) AS confidence,
            SUM(rs.length_m) FILTER (WHERE rs.quality_score IS NOT NULL) AS length_m,
            MIN(rs.elevation_min) FILTER (WHERE rs.quality_score IS NOT NULL) AS elevation_min,
            MAX(rs.elevation_max) FILTER (WHERE rs.quality_score IS NOT NULL) AS elevation_max
          FROM road_segments rs
          JOIN assessed_ways aw
            ON aw.road_key = COALESCE(rs.osm_way_id::text, rs.id::text)
          WHERE rs.deactivated_at IS NULL
          GROUP BY COALESCE(rs.osm_way_id::text, rs.id::text)
        ),
        eligible AS (
          SELECT id, geom, curviness_score, quality_score, length_m,
                 elevation_min, elevation_max
          FROM road
          WHERE quality_score IS NOT NULL
            AND curviness_score >= p_min_curviness
            AND quality_score >= p_min_quality
            AND confidence >= p_min_confidence
            AND length_m >= p_min_segment_length_m
        ),`);

/** The #794 aggregated eligibility WITHOUT the live-row filter — restored on
 *  down(), so this migration's revert reinstates exactly the prior function. */
const CLUSTER_FUN_ZONES_NO_LIVE = clusterFunZonesFn(`
        WITH assessed_ways AS (
          SELECT DISTINCT COALESCE(osm_way_id::text, id::text) AS road_key
          FROM road_segments
          WHERE quality_score IS NOT NULL
        ),
        road AS (
          SELECT
            (ARRAY_AGG(rs.id ORDER BY rs.segment_index NULLS FIRST, rs.id))[1] AS id,
            ST_LineMerge(ST_Collect(rs.geom ORDER BY rs.segment_index NULLS FIRST, rs.id)
              FILTER (WHERE rs.quality_score IS NOT NULL)) AS geom,
            SUM(rs.curviness_score * rs.length_m) FILTER (WHERE rs.quality_score IS NOT NULL)
              / NULLIF(SUM(rs.length_m) FILTER (WHERE rs.quality_score IS NOT NULL), 0) AS curviness_score,
            SUM(rs.quality_score * rs.length_m) FILTER (WHERE rs.quality_score IS NOT NULL)
              / NULLIF(SUM(rs.length_m) FILTER (WHERE rs.quality_score IS NOT NULL), 0) AS quality_score,
            SUM(rs.confidence * rs.length_m) FILTER (WHERE rs.quality_score IS NOT NULL)
              / NULLIF(SUM(rs.length_m) FILTER (WHERE rs.quality_score IS NOT NULL), 0) AS confidence,
            SUM(rs.length_m) FILTER (WHERE rs.quality_score IS NOT NULL) AS length_m,
            MIN(rs.elevation_min) FILTER (WHERE rs.quality_score IS NOT NULL) AS elevation_min,
            MAX(rs.elevation_max) FILTER (WHERE rs.quality_score IS NOT NULL) AS elevation_max
          FROM road_segments rs
          JOIN assessed_ways aw
            ON aw.road_key = COALESCE(rs.osm_way_id::text, rs.id::text)
          GROUP BY COALESCE(rs.osm_way_id::text, rs.id::text)
        ),
        eligible AS (
          SELECT id, geom, curviness_score, quality_score, length_m,
                 elevation_min, elevation_max
          FROM road
          WHERE quality_score IS NOT NULL
            AND curviness_score >= p_min_curviness
            AND quality_score >= p_min_quality
            AND confidence >= p_min_confidence
            AND length_m >= p_min_segment_length_m
        ),`);

/**
 * The full `cluster_fun_zones()` body; only the leading eligibility CTE varies.
 * The rest (DBSCAN, scoring, persistence, zero-candidate prune guard) is
 * byte-for-byte the definition from migrations 1715300000000 / 1789000000000.
 */
function clusterFunZonesFn(eligibleCte: string): string {
  return `
    CREATE OR REPLACE FUNCTION cluster_fun_zones(
      p_min_curviness FLOAT DEFAULT 2.0,
      p_min_quality FLOAT DEFAULT 3.0,
      p_min_confidence INT DEFAULT 50,
      p_min_segment_length_m FLOAT DEFAULT 500,
      p_eps_degrees FLOAT DEFAULT 0.045,
      p_min_points INT DEFAULT 3,
      p_min_roads_per_zone INT DEFAULT 3,
      p_hull_buffer_m FLOAT DEFAULT 250
    ) RETURNS INT AS $$
    DECLARE
      v_namespace UUID := '47b1a8a9-8d67-4b28-9a1c-6cb72d6c4f01'::uuid;
      v_written INT := 0;
    BEGIN
      DROP TABLE IF EXISTS tmp_fz_clusters;
      CREATE TEMP TABLE tmp_fz_clusters AS
      ${eligibleCte}
      clustered AS (
        SELECT
          id, geom, curviness_score, quality_score, length_m,
          elevation_min, elevation_max,
          ST_ClusterDBSCAN(geom, eps := p_eps_degrees, minpoints := p_min_points)
            OVER (ORDER BY id) AS cluster_seed
        FROM eligible
      )
      SELECT
        uuid_generate_v5(
          v_namespace,
          array_to_string(array_agg(id::text ORDER BY id), ',')
        ) AS zone_id,
        array_agg(id ORDER BY id) AS member_ids,
        array_agg(curviness_score ORDER BY id) AS curviness_scores,
        array_agg(quality_score ORDER BY id) AS quality_scores,
        array_agg(length_m ORDER BY id) AS lengths_m,
        AVG(curviness_score) AS avg_curviness,
        AVG(quality_score) AS avg_quality,
        (SUM(CASE WHEN curviness_score >= 3.0 THEN length_m ELSE 0 END) / 1000.0)
          AS total_curve_km,
        COALESCE(MAX(elevation_max) - MIN(elevation_min), 0) AS elevation_range_m,
        COUNT(*) AS road_count,
        ST_ConvexHull(
          ST_Buffer(ST_Collect(geom)::geography, p_hull_buffer_m)::geometry
        ) AS boundary
      FROM clustered
      WHERE cluster_seed IS NOT NULL
      GROUP BY cluster_seed
      HAVING COUNT(*) >= p_min_roads_per_zone;

      WITH scored AS (
        SELECT
          zone_id,
          ROUND((
            (
              0.40 * LEAST(GREATEST(avg_curviness / 5.0, 0), 1)
              + 0.25 * LEAST(GREATEST((avg_quality - 1) / 4.0, 0), 1)
              + 0.15 * LEAST(GREATEST(elevation_range_m / 1500.0, 0), 1)
              + 0.15 * LEAST(GREATEST(road_count::float / 30.0, 0), 1)
            ) * 100.0
          )::numeric, 2)::float AS composite_score
        FROM tmp_fz_clusters
      ),
      seasoned AS (
        SELECT
          t.zone_id,
          CASE
            WHEN EXISTS (
              SELECT 1 FROM mountain_passes mp
              WHERE ST_Intersects(mp.location, t.boundary)
                AND NOT (mp.typical_open_month = 1 AND mp.typical_close_month = 12)
            ) THEN 'summer'
            ELSE 'year_round'
          END AS best_season
        FROM tmp_fz_clusters t
      )
      INSERT INTO fun_zones
        (id, boundary, composite_score, road_count,
         total_curve_km, avg_quality, best_season, last_calculated)
      SELECT
        t.zone_id,
        t.boundary,
        s.composite_score,
        t.road_count::int,
        t.total_curve_km,
        ROUND(t.avg_quality::numeric, 2)::float,
        se.best_season,
        NOW()
      FROM tmp_fz_clusters t
      JOIN scored s ON s.zone_id = t.zone_id
      JOIN seasoned se ON se.zone_id = t.zone_id
      ON CONFLICT (id) DO UPDATE SET
        boundary = EXCLUDED.boundary,
        composite_score = EXCLUDED.composite_score,
        road_count = EXCLUDED.road_count,
        total_curve_km = EXCLUDED.total_curve_km,
        avg_quality = EXCLUDED.avg_quality,
        best_season = EXCLUDED.best_season,
        last_calculated = NOW();

      DELETE FROM fun_zone_roads
      WHERE fun_zone_id IN (SELECT zone_id FROM tmp_fz_clusters);

      INSERT INTO fun_zone_roads (fun_zone_id, road_segment_id, contribution_score)
      SELECT
        t.zone_id,
        t.member_ids[i],
        ROUND(
          (
            LEAST(GREATEST(t.curviness_scores[i] / 5.0, 0), 1)
            * LEAST(GREATEST((COALESCE(t.quality_scores[i], 1) - 1) / 4.0, 0), 1)
            * LEAST(GREATEST(t.lengths_m[i] / 5000.0, 0), 1)
          )::numeric, 3)::float
      FROM tmp_fz_clusters t
      CROSS JOIN LATERAL generate_subscripts(t.member_ids, 1) AS i;

      IF EXISTS (SELECT 1 FROM tmp_fz_clusters) THEN
        DELETE FROM fun_zones
        WHERE id NOT IN (SELECT zone_id FROM tmp_fz_clusters);
      ELSE
        RAISE WARNING 'cluster_fun_zones produced 0 candidates; skipping prune to avoid wiping fun_zones';
      END IF;

      SELECT COUNT(*)::int INTO v_written FROM tmp_fz_clusters;
      DROP TABLE tmp_fz_clusters;
      RETURN v_written;
    END;
    $$ LANGUAGE plpgsql;
  `;
}
