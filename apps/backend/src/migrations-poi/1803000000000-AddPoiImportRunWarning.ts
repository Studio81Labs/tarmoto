import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * #847 review — advisory channel for a `poi_import_runs` row that completed
 * as a genuine `success` but withheld part of its normal work: today, the
 * only producer is the tombstone wipe-guard's partial-accept path
 * (`PoiImportService.importRegionBody`'s `wouldWipeTooMuch` branch) — the
 * incoming rows were upserted, but tombstoning (and, for OSM, the coverage
 * stamp) were withheld because the extract looks incomplete. Without this
 * column that run recorded as an indistinguishable clean `success`, so the
 * admin Runs panel had no way to flag it as anything other than a plain "✓
 * upserted N" — hiding that the extract likely needs a rebuild.
 *
 * Nullable, additive — every existing row, and every `running`/`failed` run
 * going forward, simply leaves it null (see `PoiImportRunRecorder.finish` /
 * `.fail`).
 *
 * Untransacted POI DB (see `poi-database.module.ts`'s
 * `migrationsTransactionMode: 'none'`) — mirrors the single-statement style
 * of the sibling `1801000000000-AddPoiImportRuns`/`1802000000000-
 * AddPoisSourceRegionIndex` migrations.
 */
export class AddPoiImportRunWarning1803000000000 implements MigrationInterface {
  name = 'AddPoiImportRunWarning1803000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "poi_import_runs"
        ADD COLUMN IF NOT EXISTS "warning" text
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "poi_import_runs"
        DROP COLUMN IF EXISTS "warning"
    `);
  }
}
