import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Issue #493 — telemetry column: which client-side preprocessing
 * pipeline produced this batch's `ax/ay/az` values.
 *
 * Why we need it: #493 introduced an on-device 4th-order Butterworth
 * low-pass at 22 Hz that filters every accelerometer / gyroscope axis
 * before the sample lands in the upload payload. Pre-#493 clients
 * upload **raw** axes; post-#493 clients upload **filtered** axes.
 * The same `ax/ay/az` fields silently mean two different things across
 * the rolling client release, which would skew RMS / spectral
 * comparisons in any aggregate that mixes the two regimes (training
 * exports, server-side classifier re-derivation, cross-rider stats).
 *
 * Marker rather than schema split: the preprocessing change is
 * additive (filtered axes still represent acceleration in m/s²) and
 * the backend's segment-level features tolerate either input. The
 * marker lets training queries filter or weight by preprocessing
 * version without forcing a column-level split, and a future v2
 * preprocessing change can bump the value rather than the schema.
 *
 * Nullable: pre-rollout rows have no marker, and a future client
 * profile (e.g. low-power mode) might disable the filter and upload
 * raw axes again — null cleanly represents "raw".
 */
export class AddSurfaceReadingClientPreprocessingVersion1717200000000 implements MigrationInterface {
  name = 'AddSurfaceReadingClientPreprocessingVersion1717200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE surface_readings
        ADD COLUMN IF NOT EXISTS client_preprocessing_version VARCHAR(32);
    `);

    // Partial index — pre-rollout rows are NULL and shouldn't pollute
    // the btree. The typical query is "rows captured under
    // preprocessing X", which only touches non-null values.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_surface_readings_client_preprocessing_version
        ON surface_readings(client_preprocessing_version)
        WHERE client_preprocessing_version IS NOT NULL;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS idx_surface_readings_client_preprocessing_version;
    `);
    await queryRunner.query(`
      ALTER TABLE surface_readings
        DROP COLUMN IF EXISTS client_preprocessing_version;
    `);
  }
}
