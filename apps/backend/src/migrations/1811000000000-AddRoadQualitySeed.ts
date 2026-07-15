import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Design 2026-07-15 — OSM road-quality seed + confidence blend.
 *
 * Adds `osm_quality_seed` (OSM prior [1,5]) + `quality_source` provenance, and
 * re-declares `update_road_quality_for_segment` so the aggregated `quality_score`
 * is a Bayesian blend of the rider mean and the OSM seed weighted by rider count:
 *   quality_score = (rider_mean·n + seed·k) / (n + k),  k = 4.
 * `n = 0` or no valid readings → pure seed; seed NULL → pure rider mean.
 *
 * The function body is otherwise identical to 1788000000000-AddSurfaceFromReading
 * (the live version, which maintains `surface_from_reading`). `road_segments` is
 * empty in prod (road subsystem dormant), so no backfill is needed.
 */
export class AddRoadQualitySeed1811000000000 implements MigrationInterface {
  name = 'AddRoadQualitySeed1811000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE road_segments
        ADD COLUMN IF NOT EXISTS osm_quality_seed FLOAT,
        ADD COLUMN IF NOT EXISTS quality_source VARCHAR(20);
    `);

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION update_road_quality_for_segment(p_segment_id UUID)
      RETURNS INT
      LANGUAGE plpgsql
      AS $$
      DECLARE
        v_filtered_count INT := 0;
      BEGIN
        WITH scored AS (
          SELECT
            sr.id,
            sr.user_id,
            sr.recorded_at,
            CASE sr.classification
              WHEN 'excellent' THEN 5.0
              WHEN 'good'      THEN 4.0
              WHEN 'fair'      THEN 3.0
              WHEN 'poor'      THEN 2.0
              WHEN 'very_poor' THEN 1.0
            END AS quality_score
          FROM surface_readings sr
          WHERE sr.road_segment_id = p_segment_id
        ),
        valid AS (
          SELECT * FROM scored WHERE quality_score IS NOT NULL
        ),
        stats AS (
          SELECT
            COUNT(*)::int        AS total_count,
            AVG(quality_score)   AS mean_q,
            stddev_samp(quality_score) AS std_q
          FROM valid
        ),
        flagged AS (
          SELECT
            v.id,
            v.user_id,
            v.recorded_at,
            v.quality_score,
            CASE
              WHEN s.total_count < 3 THEN false
              WHEN s.std_q IS NULL OR s.std_q = 0 THEN false
              WHEN ABS(v.quality_score - s.mean_q) > 2 * s.std_q THEN true
              ELSE false
            END AS is_outlier
          FROM valid v
          CROSS JOIN stats s
        ),
        kept AS (
          SELECT
            quality_score,
            user_id,
            CASE
              WHEN recorded_at >= NOW() - INTERVAL '30 days'  THEN 1.0
              WHEN recorded_at >= NOW() - INTERVAL '90 days'  THEN 0.7
              WHEN recorded_at >= NOW() - INTERVAL '180 days' THEN 0.4
              ELSE 0.2
            END AS recency_weight
          FROM flagged
          WHERE NOT is_outlier
        ),
        agg AS (
          SELECT
            SUM(quality_score * recency_weight) / NULLIF(SUM(recency_weight), 0) AS quality_score,
            COUNT(*)::int                AS reading_count,
            COUNT(DISTINCT user_id)::int AS unique_rider_count
          FROM kept
        ),
        fc AS (
          SELECT COUNT(*)::int AS filtered_count FROM flagged WHERE is_outlier
        ),
        surface_mode AS (
          SELECT surface_type
          FROM surface_readings
          WHERE road_segment_id = p_segment_id
            AND surface_type IS NOT NULL
          GROUP BY surface_type
          ORDER BY COUNT(*) DESC, MAX(recorded_at) DESC, surface_type ASC
          LIMIT 1
        )
        UPDATE road_segments rs
        SET
          -- Blend the rider mean with the OSM seed by rider count (k = 4).
          -- No valid readings → pure seed; no seed → pure rider mean.
          quality_score = CASE
            WHEN agg.reading_count = 0 OR agg.quality_score IS NULL
              THEN rs.osm_quality_seed
            WHEN rs.osm_quality_seed IS NULL
              THEN agg.quality_score
            ELSE (agg.quality_score * agg.reading_count + rs.osm_quality_seed * 4)
                 / (agg.reading_count + 4)
          END,
          reading_count = agg.reading_count,
          confidence = CASE
            WHEN agg.reading_count >= 20 AND agg.unique_rider_count >= 5 THEN 100
            WHEN agg.reading_count >= 10 THEN 90
            WHEN agg.reading_count >= 5  THEN 70
            WHEN agg.reading_count >= 3  THEN 50
            WHEN agg.reading_count >= 1  THEN 20
            ELSE 0
          END,
          surface_type = COALESCE((SELECT surface_type FROM surface_mode), rs.surface_type),
          surface_from_reading = rs.surface_from_reading
            OR (SELECT surface_type FROM surface_mode) IS NOT NULL,
          last_filtered_count = fc.filtered_count,
          last_updated = NOW()
        FROM agg, fc
        WHERE rs.id = p_segment_id
        RETURNING rs.last_filtered_count INTO v_filtered_count;

        RETURN COALESCE(v_filtered_count, 0);
      END;
      $$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Restore the 1788000000000 body (rider-only quality_score, no blend).
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION update_road_quality_for_segment(p_segment_id UUID)
      RETURNS INT
      LANGUAGE plpgsql
      AS $$
      DECLARE
        v_filtered_count INT := 0;
      BEGIN
        WITH scored AS (
          SELECT
            sr.id, sr.user_id, sr.recorded_at,
            CASE sr.classification
              WHEN 'excellent' THEN 5.0 WHEN 'good' THEN 4.0 WHEN 'fair' THEN 3.0
              WHEN 'poor' THEN 2.0 WHEN 'very_poor' THEN 1.0
            END AS quality_score
          FROM surface_readings sr WHERE sr.road_segment_id = p_segment_id
        ),
        valid AS (SELECT * FROM scored WHERE quality_score IS NOT NULL),
        stats AS (
          SELECT COUNT(*)::int AS total_count, AVG(quality_score) AS mean_q,
                 stddev_samp(quality_score) AS std_q
          FROM valid
        ),
        flagged AS (
          SELECT v.id, v.user_id, v.recorded_at, v.quality_score,
            CASE
              WHEN s.total_count < 3 THEN false
              WHEN s.std_q IS NULL OR s.std_q = 0 THEN false
              WHEN ABS(v.quality_score - s.mean_q) > 2 * s.std_q THEN true
              ELSE false
            END AS is_outlier
          FROM valid v CROSS JOIN stats s
        ),
        kept AS (
          SELECT quality_score, user_id,
            CASE
              WHEN recorded_at >= NOW() - INTERVAL '30 days'  THEN 1.0
              WHEN recorded_at >= NOW() - INTERVAL '90 days'  THEN 0.7
              WHEN recorded_at >= NOW() - INTERVAL '180 days' THEN 0.4
              ELSE 0.2
            END AS recency_weight
          FROM flagged WHERE NOT is_outlier
        ),
        agg AS (
          SELECT SUM(quality_score * recency_weight) / NULLIF(SUM(recency_weight), 0) AS quality_score,
                 COUNT(*)::int AS reading_count, COUNT(DISTINCT user_id)::int AS unique_rider_count
          FROM kept
        ),
        fc AS (SELECT COUNT(*)::int AS filtered_count FROM flagged WHERE is_outlier),
        surface_mode AS (
          SELECT surface_type FROM surface_readings
          WHERE road_segment_id = p_segment_id AND surface_type IS NOT NULL
          GROUP BY surface_type
          ORDER BY COUNT(*) DESC, MAX(recorded_at) DESC, surface_type ASC LIMIT 1
        )
        UPDATE road_segments rs
        SET
          quality_score = agg.quality_score,
          reading_count = agg.reading_count,
          confidence = CASE
            WHEN agg.reading_count >= 20 AND agg.unique_rider_count >= 5 THEN 100
            WHEN agg.reading_count >= 10 THEN 90
            WHEN agg.reading_count >= 5  THEN 70
            WHEN agg.reading_count >= 3  THEN 50
            WHEN agg.reading_count >= 1  THEN 20
            ELSE 0
          END,
          surface_type = COALESCE((SELECT surface_type FROM surface_mode), rs.surface_type),
          surface_from_reading = rs.surface_from_reading
            OR (SELECT surface_type FROM surface_mode) IS NOT NULL,
          last_filtered_count = fc.filtered_count,
          last_updated = NOW()
        FROM agg, fc
        WHERE rs.id = p_segment_id
        RETURNING rs.last_filtered_count INTO v_filtered_count;
        RETURN COALESCE(v_filtered_count, 0);
      END;
      $$;
    `);

    await queryRunner.query(`
      ALTER TABLE road_segments
        DROP COLUMN IF EXISTS quality_source,
        DROP COLUMN IF EXISTS osm_quality_seed;
    `);
  }
}
