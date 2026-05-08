import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Issue #495 — server-side road-quality aggregation must drop
 * readings whose `quality_score` deviates more than 2 standard
 * deviations from the segment mean before applying recency
 * weighting and confidence scoring (per
 * `docs/ML_MODEL_SPEC.md` §8.3 step 1).
 *
 * Without this filter a single rough reading on a smooth road —
 * a phone slipping in the mount, a rider going off-road for 20 m,
 * one pothole — gets fully weighted into the segment score and
 * shows up as map noise (a generally good road painted yellow
 * because one rider had one bad reading).
 *
 * The filter is implemented inside a re-aggregation helper
 * `update_road_quality_for_segment(uuid)` so that:
 *
 *   - the trigger `trg_update_road_quality` and the one-time
 *     backfill share exactly the same SQL — there's only one
 *     definition of "the aggregation rule";
 *   - confidence (per spec §8.3 step 3) is computed against the
 *     **post-filter** reading count, not the raw count;
 *   - the count of filtered rows on the most recent run is
 *     persisted to `road_segments.last_filtered_count` so disputes
 *     and data-quality regressions are investigable without
 *     replaying readings.
 *
 * Skip rule: when a segment has fewer than 3 valid readings,
 * `stddev_samp` is undefined or trivial, so filtering is skipped
 * — all readings are kept and `last_filtered_count` is set to 0.
 * `stddev_samp` is also treated as "no spread" when it returns 0
 * (all readings produced the same quality score), which would
 * otherwise flag every reading as ≤0σ from the mean and is a
 * meaningless edge case.
 */
export class OutlierFilteredRoadQualityAggregation1717300000000 implements MigrationInterface {
  name = 'OutlierFilteredRoadQualityAggregation1717300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. New column for audit / investigation. NOT NULL with default 0
    //    so existing rows pick up a sane initial value before the
    //    backfill rewrites them.
    await queryRunner.query(`
      ALTER TABLE road_segments
        ADD COLUMN IF NOT EXISTS last_filtered_count INT NOT NULL DEFAULT 0;
    `);

    // 2. Re-aggregation helper. Both the trigger and the backfill
    //    call this so the outlier rule lives in exactly one place.
    //    Returns the number of readings filtered on this run.
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
              -- <3 readings: cannot meaningfully compute stddev; keep all
              WHEN s.total_count < 3 THEN false
              -- All readings identical: no spread, nothing is an outlier
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
          last_filtered_count = fc.filtered_count,
          last_updated = NOW()
        FROM agg, fc
        WHERE rs.id = p_segment_id
        RETURNING rs.last_filtered_count INTO v_filtered_count;

        RETURN COALESCE(v_filtered_count, 0);
      END;
      $$;
    `);

    // 3. Trigger function delegates to the helper and emits a server
    //    log when filtering occurred so dashboards / alerting can
    //    observe data-quality regressions without polling the
    //    last_filtered_count column. The log line is intentionally
    //    quiet on the common no-filtering path.
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION update_road_quality()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      AS $$
      DECLARE
        v_filtered INT;
      BEGIN
        v_filtered := update_road_quality_for_segment(NEW.road_segment_id);
        IF v_filtered > 0 THEN
          RAISE LOG 'road_quality_aggregation_filtered segment=% filtered_count=%',
            NEW.road_segment_id, v_filtered;
        END IF;
        RETURN NEW;
      END;
      $$;
    `);

    // 4. One-time backfill. Iterates one segment at a time so memory
    //    and lock footprint stay bounded regardless of fleet size,
    //    and so a partial failure rolls back cleanly inside the
    //    migration transaction. Idempotent: re-running produces the
    //    same values for the same input set.
    await queryRunner.query(`
      DO $$
      DECLARE
        rec RECORD;
        v_segments INT := 0;
        v_filtered_total INT := 0;
        v_filtered INT;
      BEGIN
        FOR rec IN
          SELECT DISTINCT road_segment_id
          FROM surface_readings
          WHERE road_segment_id IS NOT NULL
        LOOP
          v_filtered := update_road_quality_for_segment(rec.road_segment_id);
          v_filtered_total := v_filtered_total + v_filtered;
          v_segments := v_segments + 1;
        END LOOP;
        RAISE NOTICE 'road_quality_outlier_backfill: segments=% filtered_total=%',
          v_segments, v_filtered_total;
      END $$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Restore the pre-#495 trigger function (no outlier filtering).
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION update_road_quality()
      RETURNS TRIGGER AS $$
      BEGIN
          UPDATE road_segments rs
          SET
              quality_score = stats.quality_score,
              reading_count = stats.reading_count,
              confidence = CASE
                  WHEN stats.reading_count >= 20 AND stats.unique_rider_count >= 5 THEN 100
                  WHEN stats.reading_count >= 10 THEN 90
                  WHEN stats.reading_count >= 5 THEN 70
                  WHEN stats.reading_count >= 3 THEN 50
                  WHEN stats.reading_count >= 1 THEN 20
                  ELSE 0
              END,
              surface_type = COALESCE(surface_mode.surface_type, rs.surface_type),
              last_updated = NOW()
          FROM (
              SELECT
                  SUM(quality_score * recency_weight) / NULLIF(SUM(recency_weight), 0) AS quality_score,
                  COUNT(*)::int AS reading_count,
                  COUNT(DISTINCT user_id)::int AS unique_rider_count
              FROM (
                  SELECT
                      CASE classification
                          WHEN 'excellent' THEN 5.0
                          WHEN 'good' THEN 4.0
                          WHEN 'fair' THEN 3.0
                          WHEN 'poor' THEN 2.0
                          WHEN 'very_poor' THEN 1.0
                      END AS quality_score,
                      CASE
                          WHEN recorded_at >= NOW() - INTERVAL '30 days' THEN 1.0
                          WHEN recorded_at >= NOW() - INTERVAL '90 days' THEN 0.7
                          WHEN recorded_at >= NOW() - INTERVAL '180 days' THEN 0.4
                          ELSE 0.2
                      END AS recency_weight,
                      user_id
                  FROM surface_readings
                  WHERE road_segment_id = NEW.road_segment_id
              ) weighted_readings
              WHERE quality_score IS NOT NULL
          ) stats
          LEFT JOIN LATERAL (
              SELECT surface_type
              FROM surface_readings
              WHERE road_segment_id = NEW.road_segment_id
              AND surface_type IS NOT NULL
              GROUP BY surface_type
              ORDER BY COUNT(*) DESC, MAX(recorded_at) DESC, surface_type ASC
              LIMIT 1
          ) surface_mode ON TRUE
          WHERE rs.id = NEW.road_segment_id;
          RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);

    await queryRunner.query(`
      DROP FUNCTION IF EXISTS update_road_quality_for_segment(UUID);
    `);

    await queryRunner.query(`
      ALTER TABLE road_segments
        DROP COLUMN IF EXISTS last_filtered_count;
    `);
  }
}
