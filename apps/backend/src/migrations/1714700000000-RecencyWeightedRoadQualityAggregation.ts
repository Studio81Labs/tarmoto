import { MigrationInterface, QueryRunner } from 'typeorm';

export class RecencyWeightedRoadQualityAggregation1714700000000 implements MigrationInterface {
  name = 'RecencyWeightedRoadQualityAggregation1714700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
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
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION update_road_quality()
      RETURNS TRIGGER AS $$
      BEGIN
          UPDATE road_segments SET
              quality_score = (
                  SELECT AVG(
                      CASE classification
                          WHEN 'excellent' THEN 5.0
                          WHEN 'good' THEN 4.0
                          WHEN 'fair' THEN 3.0
                          WHEN 'poor' THEN 2.0
                          WHEN 'very_poor' THEN 1.0
                      END
                  )
                  FROM surface_readings
                  WHERE road_segment_id = NEW.road_segment_id
                  AND recorded_at > NOW() - INTERVAL '6 months'
              ),
              reading_count = (
                  SELECT COUNT(*) FROM surface_readings
                  WHERE road_segment_id = NEW.road_segment_id
              ),
              confidence = LEAST(100, (
                  SELECT COUNT(*) FROM surface_readings
                  WHERE road_segment_id = NEW.road_segment_id
              ) * 10),
              surface_type = COALESCE(NEW.surface_type, road_segments.surface_type),
              last_updated = NOW()
          WHERE id = NEW.road_segment_id;
          RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);
  }
}
