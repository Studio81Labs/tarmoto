import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Issue #796 — durable surface-provenance flag.
 *
 * The OSM importer must refresh the OSM `surface` seed for a segment only while
 * no rider has classified its surface, and must never clobber a rider-derived
 * surface. It cannot key that off the raw `surface_readings` (they are deleted
 * once they age past a user's `location_retention`, while the aggregate
 * `surface_type` persists) nor off `reading_count` (a reading can carry a null
 * `surface_type` — `inferSurfaceType()` returns null for many smooth rides).
 *
 * So add a durable `road_segments.surface_from_reading` flag, maintained by the
 * aggregation helper: it flips true (and stays true — sticky, so it outlives the
 * retention sweep like the aggregate it guards) the first time the segment has a
 * non-null `surface_readings.surface_type`. The importer then gates its seed
 * refresh on `NOT surface_from_reading`.
 */
export class AddSurfaceFromReading1788000000000 implements MigrationInterface {
  name = 'AddSurfaceFromReading1788000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. The durable flag. Defaults false so OSM-seeded / demo rows start
    //    "not rider-owned"; the aggregation and the backfill below flip it.
    await queryRunner.query(`
      ALTER TABLE road_segments
        ADD COLUMN IF NOT EXISTS surface_from_reading BOOLEAN NOT NULL DEFAULT false;
    `);

    // 2. Re-aggregation helper — same body as #495's
    //    (OutlierFilteredRoadQualityAggregation) with one addition: set
    //    surface_from_reading sticky-true whenever the segment has a non-null
    //    surface reading (surface_mode is non-empty).
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
          -- Sticky: once a rider classifies the surface it stays rider-owned,
          -- even after the raw readings age out under location_retention.
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

    // 3. Backfill: conservatively protect every existing surface whose OSM
    //    provenance can't be proven, so enabling OSM refresh never overwrites a
    //    legacy rider-classified surface. Mark owned when:
    //      (a) surface_type is a real classification (non-null, non-'unknown'),
    //          OR
    //      (b) a non-null surface reading is still present.
    //    (a) is the key case the reviewer flagged: a segment classified before
    //    this deploy whose raw readings were already deleted by the
    //    location_retention sweep keeps only the aggregate surface_type — the raw
    //    evidence is gone. This is safe because no OSM import has run yet (the
    //    importer this flag guards is not wired to a job), so a real surface can
    //    only be rider/seed-derived, never OSM. A NULL or 'unknown' surface stays
    //    unprotected so it still receives the OSM seed. New OSM segments
    //    created after this migration correctly start false and refresh until a
    //    rider classifies them.
    await queryRunner.query(`
      UPDATE road_segments rs
      SET surface_from_reading = true
      WHERE (rs.surface_type IS NOT NULL AND rs.surface_type <> 'unknown')
         OR EXISTS (
           SELECT 1 FROM surface_readings sr
           WHERE sr.road_segment_id = rs.id AND sr.surface_type IS NOT NULL
         );
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Restore the #495 helper (without surface_from_reading maintenance).
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

    await queryRunner.query(`
      ALTER TABLE road_segments
        DROP COLUMN IF EXISTS surface_from_reading;
    `);
  }
}
