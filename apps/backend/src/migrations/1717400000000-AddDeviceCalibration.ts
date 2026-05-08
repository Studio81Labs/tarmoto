import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Issue #494 — device calibration (idle baseline + device_family).
 *
 * Adds:
 *   - `rides.calibration_*` columns. The mobile client captures ~30 s
 *     of stationary samples at ride start and uploads the per-axis
 *     mean/std on every batch. Backend persists them on the ride row
 *     so the training pipeline can subtract per-axis bias per-rider.
 *   - `surface_readings.device_family` — coarse five-bucket encoding
 *     of `device_model`. Stored alongside the raw model string so
 *     training queries don't have to re-run the encoder over years of
 *     history. Partial index keeps the btree small (most recent rows
 *     are populated; legacy rows are NULL).
 *   - `surface_readings.calibration_quality` — `'good'` / `'poor'` tag
 *     produced by the server when validating the upload's calibration
 *     block. Aggregation pipelines can down-weight or drop rows
 *     tagged `'poor'`.
 *
 * All columns nullable: pre-rollout rows have no calibration data, and
 * the mobile fallback path (calibration window dropped before the
 * minimum sample count) uploads without a calibration block at all.
 */
export class AddDeviceCalibration1717400000000 implements MigrationInterface {
  name = 'AddDeviceCalibration1717400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE rides
        ADD COLUMN IF NOT EXISTS calibration_axis_mean_x DOUBLE PRECISION,
        ADD COLUMN IF NOT EXISTS calibration_axis_mean_y DOUBLE PRECISION,
        ADD COLUMN IF NOT EXISTS calibration_axis_mean_z DOUBLE PRECISION,
        ADD COLUMN IF NOT EXISTS calibration_axis_std_x DOUBLE PRECISION,
        ADD COLUMN IF NOT EXISTS calibration_axis_std_y DOUBLE PRECISION,
        ADD COLUMN IF NOT EXISTS calibration_axis_std_z DOUBLE PRECISION,
        ADD COLUMN IF NOT EXISTS calibration_sample_count INT,
        ADD COLUMN IF NOT EXISTS calibration_truncated BOOLEAN,
        ADD COLUMN IF NOT EXISTS calibration_quality VARCHAR(8)
    `);

    await queryRunner.query(`
      ALTER TABLE surface_readings
        ADD COLUMN IF NOT EXISTS device_family VARCHAR(32),
        ADD COLUMN IF NOT EXISTS calibration_quality VARCHAR(8)
    `);

    // Partial indexes keep the btree small — pre-rollout rows are NULL
    // and the typical training query is "rows of family X" / "rows
    // tagged poor", which only touches non-null values.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_surface_readings_device_family
        ON surface_readings(device_family)
        WHERE device_family IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_surface_readings_calibration_quality
        ON surface_readings(calibration_quality)
        WHERE calibration_quality IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS idx_surface_readings_calibration_quality`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS idx_surface_readings_device_family`,
    );
    await queryRunner.query(`
      ALTER TABLE surface_readings
        DROP COLUMN IF EXISTS calibration_quality,
        DROP COLUMN IF EXISTS device_family
    `);
    await queryRunner.query(`
      ALTER TABLE rides
        DROP COLUMN IF EXISTS calibration_quality,
        DROP COLUMN IF EXISTS calibration_truncated,
        DROP COLUMN IF EXISTS calibration_sample_count,
        DROP COLUMN IF EXISTS calibration_axis_std_z,
        DROP COLUMN IF EXISTS calibration_axis_std_y,
        DROP COLUMN IF EXISTS calibration_axis_std_x,
        DROP COLUMN IF EXISTS calibration_axis_mean_z,
        DROP COLUMN IF EXISTS calibration_axis_mean_y,
        DROP COLUMN IF EXISTS calibration_axis_mean_x
    `);
  }
}
