import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Issue #794 — keep the stored `cluster_fun_zones()` ops escape-hatch in sync
 * with the Nest/CLI clustering path.
 *
 * `FunZoneClusteringService` now aggregates OSM-imported ~100 m sub-segments
 * into their parent way (COALESCE(osm_way_id, id)) BEFORE the 500 m length
 * filter, so imported roads can form fun zones. The stored function installed by
 * AddFunZoneClusteringSeed1715300000000 still filtered raw `road_segments`, so an
 * operator running `SELECT cluster_fun_zones()` after an OSM import/restore would
 * drop every 100 m segment and produce different zones. Replace its `eligible`
 * CTE with the same pre-aggregation `road` CTE. Everything else (scoring,
 * persistence, prune guard) is byte-for-byte the original.
 */
export class AggregateClusterFunZonesByWay1789000000000 implements MigrationInterface {
  name = 'AggregateClusterFunZonesByWay1789000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(CLUSTER_FUN_ZONES_AGGREGATED);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(CLUSTER_FUN_ZONES_RAW);
  }
}

/** cluster_fun_zones() body with per-way aggregation (this migration). */
const CLUSTER_FUN_ZONES_AGGREGATED = clusterFunZonesFn(`
        WITH assessed_ways AS (
          -- Only way keys with quality-bearing segments, so the aggregation below
          -- groups assessed roads instead of the entire imported graph (#794).
          SELECT DISTINCT COALESCE(osm_way_id::text, id::text) AS road_key
          FROM road_segments
          WHERE quality_score IS NOT NULL
        ),
        road AS (
          -- Collapse imported ~100 m sub-segments into their parent way so the
          -- length filter and DBSCAN operate on whole roads (#794). A crowd row
          -- (null osm_way_id) is a group of one, so its aggregates equal its raw
          -- values and existing clustering is unchanged. The representative id is
          -- taken over ALL siblings (stats stay quality-filtered via FILTER) so
          -- it — and the zone UUID derived from it — is stable when a sub-segment
          -- gains its first reading.
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

/** Original cluster_fun_zones() body — raw per-segment filter (for down()). */
const CLUSTER_FUN_ZONES_RAW = clusterFunZonesFn(`
        WITH eligible AS (
          SELECT id, geom, curviness_score, quality_score, length_m,
                 elevation_min, elevation_max
          FROM road_segments
          WHERE curviness_score >= p_min_curviness
            AND quality_score IS NOT NULL
            AND quality_score >= p_min_quality
            AND confidence >= p_min_confidence
            AND length_m >= p_min_segment_length_m
        ),`);

/**
 * The full `cluster_fun_zones()` definition. Only the leading eligibility CTE
 * differs between the aggregated and raw variants; the rest — DBSCAN, scoring,
 * persistence, and the zero-candidate prune guard — is identical to the original
 * in AddFunZoneClusteringSeed1715300000000.
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
