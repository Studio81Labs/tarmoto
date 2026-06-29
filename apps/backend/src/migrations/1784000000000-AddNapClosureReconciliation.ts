import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * #743 — let an external feed (Czech NAP / NDIC) reconcile into
 * `road_closures` alongside operator-entered rows.
 *
 * Adds the reconciliation columns the poller needs (`external_id` +
 * partial unique `(source, external_id)`, `last_seen_at`,
 * `first_seen_at`, `is_active`, `validity_status`) and the decoding
 * columns for Alert-C (TMC) / OpenLR linear closures that arrive with no
 * coordinates (`needs_location_decoding`, `raw_location_ref`), and makes
 * `geom` nullable so those undecoded rows can be stored rather than
 * dropped.
 *
 * The unique index is partial (`WHERE external_id IS NOT NULL`) so the
 * many operator rows — which have no `external_id` — are unaffected,
 * while each feed situation upserts on `(source, external_id)`.
 */
export class AddNapClosureReconciliation1784000000000 implements MigrationInterface {
  name = 'AddNapClosureReconciliation1784000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE road_closures
        ALTER COLUMN geom DROP NOT NULL,
        ADD COLUMN external_id VARCHAR(256),
        ADD COLUMN last_seen_at TIMESTAMPTZ,
        ADD COLUMN first_seen_at TIMESTAMPTZ,
        ADD COLUMN is_active BOOLEAN NOT NULL DEFAULT true,
        ADD COLUMN validity_status VARCHAR(32),
        ADD COLUMN needs_location_decoding BOOLEAN NOT NULL DEFAULT false,
        ADD COLUMN raw_location_ref JSONB;

      CREATE UNIQUE INDEX uq_road_closures_source_external
        ON road_closures (source, external_id)
        WHERE external_id IS NOT NULL;

      CREATE INDEX idx_road_closures_source_active
        ON road_closures (source, is_active);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS idx_road_closures_source_active;
      DROP INDEX IF EXISTS uq_road_closures_source_external;

      ALTER TABLE road_closures
        DROP COLUMN IF EXISTS raw_location_ref,
        DROP COLUMN IF EXISTS needs_location_decoding,
        DROP COLUMN IF EXISTS validity_status,
        DROP COLUMN IF EXISTS is_active,
        DROP COLUMN IF EXISTS first_seen_at,
        DROP COLUMN IF EXISTS last_seen_at,
        DROP COLUMN IF EXISTS external_id;
    `);

    // Restore the NOT NULL constraint only if no undecoded rows exist;
    // otherwise leave geom nullable so the down migration can't fail on
    // feed-imported rows. Operator rows always have geometry.
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM road_closures WHERE geom IS NULL) THEN
          ALTER TABLE road_closures ALTER COLUMN geom SET NOT NULL;
        END IF;
      END $$;
    `);
  }
}
