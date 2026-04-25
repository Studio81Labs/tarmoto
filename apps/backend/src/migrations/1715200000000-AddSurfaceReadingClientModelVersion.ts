import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * US-3 — telemetry column: which client-side TF Lite classifier was
 * active when each batch of surface readings was uploaded.
 *
 * **Not** a description of how this row's labels were derived — the
 * backend always re-derives `classification` and `surface_type` from
 * the raw readings. The field exists so a future change that trusts
 * client window-level outputs (or a fleet rollout gated on
 * classifier version) can filter rows by classifier without a
 * backfill.
 *
 * Nullable: pre-rollout rows have no client model, and the mobile
 * client uploads `null` whenever its fallback heuristic fired.
 */
export class AddSurfaceReadingClientModelVersion1715200000000 implements MigrationInterface {
  name = 'AddSurfaceReadingClientModelVersion1715200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE surface_readings
        ADD COLUMN IF NOT EXISTS client_model_version VARCHAR(32);
    `);

    // Partial index — the vast majority of pre-rollout rows are NULL
    // and we don't want them in the btree. The typical query is
    // "rows uploaded by classifier X", which only touches non-null
    // values anyway.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_surface_readings_client_model_version
        ON surface_readings(client_model_version)
        WHERE client_model_version IS NOT NULL;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS idx_surface_readings_client_model_version;
    `);
    await queryRunner.query(`
      ALTER TABLE surface_readings DROP COLUMN IF EXISTS client_model_version;
    `);
  }
}
