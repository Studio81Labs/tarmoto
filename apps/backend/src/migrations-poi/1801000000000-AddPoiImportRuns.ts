import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * #847 — durable run-history store for POI import admin management.
 *
 * Every import execution (cron AND manual) writes one row here, from start
 * through terminal status, so the admin surface can show run history and
 * current status without scraping logs. `region_code` + `source` +
 * `started_at` is indexed (DESC on the timestamp) for the "latest runs per
 * region/source" read the admin status view needs.
 *
 * Untransacted POI DB (see `poi-database.module.ts`'s
 * `migrationsTransactionMode: 'none'`) — CREATE TABLE and CREATE INDEX are
 * two separate statements/queries rather than one multi-statement query.
 */
export class AddPoiImportRuns1801000000000 implements MigrationInterface {
  name = 'AddPoiImportRuns1801000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "poi_import_runs" (
        "id" BIGSERIAL PRIMARY KEY,
        "source" varchar(32) NOT NULL,
        "region_code" varchar(2) NOT NULL,
        "status" varchar(16) NOT NULL,
        "trigger" varchar(16) NOT NULL,
        "fetched" integer,
        "upserted" integer,
        "tombstoned" integer,
        "skip_reason" text,
        "error" text,
        "job_id" varchar(200),
        "started_at" timestamptz NOT NULL DEFAULT now(),
        "finished_at" timestamptz
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_poi_import_runs_region_source_started"
        ON "poi_import_runs" ("region_code", "source", "started_at" DESC)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "poi_import_runs"`);
  }
}
