import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Issue #496 — online ML evaluation pipeline.
 *
 * `model_eval_samples` holds a fraction of incoming
 * `surface_readings` rows so we can compare the per-rider on-device
 * prediction (`predicted_*`) against the recency-weighted aggregate
 * road-quality (`aggregate_*`) once the segment has accumulated
 * enough confirmations from other riders. The reconciliation
 * processor fills in the aggregate columns when the segment's
 * confidence reaches the spec §8.3 threshold (≥70 with ≥5 readings),
 * and the metrics endpoint reads from this table to expose the
 * dangerous-misclass / adjacent-accuracy / MAE gauges that gate the
 * model for launch (spec §7).
 *
 * Design notes:
 *
 *   - `model_version` is the client classifier version that
 *     produced this batch's per-window predictions
 *     (`surface_readings.client_model_version`). Null when the
 *     mobile fallback heuristic ran. Indexed because every metric
 *     query is segmented by version.
 *
 *   - `bike_id` is captured at sample-creation time (joined through
 *     `rides`) so the weekly cross-bike agreement job can compare
 *     predictions for the same segment across different bikes
 *     without re-walking the join.
 *
 *   - `dangerous_misclassification` is precomputed at reconciliation
 *     so the alert gauge is a count over a partial index instead of
 *     a CASE-on-classification scan over a 24h window.
 *
 *   - Foreign keys cascade-delete with the source rows: surface
 *     readings, road segments, rides, users, and bikes can all be
 *     swept by the privacy retention job, and the eval samples are
 *     telemetry that must not pin those rows alive.
 */
export class AddModelEvalSamples1717300000000 implements MigrationInterface {
  name = 'AddModelEvalSamples1717300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS model_eval_samples (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        surface_reading_id UUID NOT NULL
          REFERENCES surface_readings(id) ON DELETE CASCADE,
        road_segment_id UUID NOT NULL
          REFERENCES road_segments(id) ON DELETE CASCADE,
        ride_id UUID NULL
          REFERENCES rides(id) ON DELETE SET NULL,
        user_id UUID NULL
          REFERENCES users(id) ON DELETE SET NULL,
        bike_id UUID NULL
          REFERENCES bikes(id) ON DELETE SET NULL,
        model_version VARCHAR(32) NULL,
        device_model VARCHAR(100) NULL,
        predicted_classification VARCHAR(20) NOT NULL,
        predicted_score SMALLINT NOT NULL,
        aggregate_classification VARCHAR(20) NULL,
        aggregate_score REAL NULL,
        aggregate_confidence SMALLINT NULL,
        aggregate_reading_count INT NULL,
        dangerous_misclassification BOOLEAN NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        reconciled_at TIMESTAMPTZ NULL
      );
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_model_eval_samples_created_at
        ON model_eval_samples(created_at);
    `);

    // Pending-reconciliation lookup — partial so the index stays
    // small as samples accumulate (most rows eventually have a
    // non-null reconciled_at).
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_model_eval_samples_pending
        ON model_eval_samples(road_segment_id)
        WHERE reconciled_at IS NULL;
    `);

    // Metric queries always group by model_version + reconciled
    // time. The composite index covers the dangerous-misclass
    // 24h-rolling aggregation.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_model_eval_samples_version_recon
        ON model_eval_samples(model_version, reconciled_at)
        WHERE reconciled_at IS NOT NULL;
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_model_eval_samples_segment
        ON model_eval_samples(road_segment_id);
    `);

    // Index the cascading FK target. Postgres does NOT auto-index
    // referencing columns, and the daily location-retention sweep
    // bulk-deletes old `surface_readings` rows. Without this index
    // each cascade would table-scan `model_eval_samples` and turn a
    // privacy sweep into lock-heavy work as the eval table grows.
    // Unique because `maybeSample` creates exactly one sample per
    // surface reading — the constraint also catches a double-write
    // bug at the DB level instead of letting it skew the metrics.
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_model_eval_samples_surface_reading_id
        ON model_eval_samples(surface_reading_id);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS idx_model_eval_samples_surface_reading_id`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS idx_model_eval_samples_segment`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS idx_model_eval_samples_version_recon`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS idx_model_eval_samples_pending`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS idx_model_eval_samples_created_at`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS model_eval_samples`);
  }
}
