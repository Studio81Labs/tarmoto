import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * US-3 — track which on-device classifier produced each batch of
 * surface readings so a future deprecation can ignore retired model
 * outputs without dropping the rows.
 *
 * Nullable column: existing rows pre-date the field and the mobile
 * client still uploads with `null` when its v0 RMS heuristic fires.
 */
export class AddSurfaceReadingModelVersion1715200000000 implements MigrationInterface {
  name = 'AddSurfaceReadingModelVersion1715200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE surface_readings
        ADD COLUMN IF NOT EXISTS model_version VARCHAR(32);
    `);

    // Aggregations that filter / weight by classifier need an index
    // for the typical "ignore deprecated outputs" sweep. The index is
    // partial because the vast majority of pre-rollout rows are NULL
    // and we don't want them in the btree.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_surface_readings_model_version
        ON surface_readings(model_version)
        WHERE model_version IS NOT NULL;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS idx_surface_readings_model_version;
    `);
    await queryRunner.query(`
      ALTER TABLE surface_readings DROP COLUMN IF EXISTS model_version;
    `);
  }
}
