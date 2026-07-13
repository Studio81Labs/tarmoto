import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * #847 — supporting index for the POI import admin status read
 * (`PoiImportAdminService.listRegionStatus`), which issues ONE grouped count
 * query across every `(source, region)` pair instead of one count query per
 * pair:
 *
 *   SELECT source, import_region, count(*)::int AS n FROM pois
 *     WHERE deactivated_at IS NULL AND import_region IS NOT NULL
 *     GROUP BY source, import_region
 *
 * Partial (`WHERE "deactivated_at" IS NULL`) — only live rows matter for this
 * read, which keeps the index smaller than an unconditional `(source,
 * import_region)` index would be, at country/continent scale.
 *
 * Built `CONCURRENTLY` so it never holds a write-blocking lock — same
 * reasoning as the sibling `AddPoiGeographyIndex` migration: this runs at
 * boot via `migrationsRun`, and at continent scale a plain `CREATE INDEX`
 * would stall other instances + any in-flight import for minutes while it
 * locks `pois`. `CONCURRENTLY` cannot run in a transaction, so the POI
 * datasource sets `migrationsTransactionMode: 'none'` (see
 * `poi-database.module.ts`) — safe, as every POI migration is a single
 * Postgres-atomic multi-statement query.
 */
export class AddPoisSourceRegionIndex1802000000000 implements MigrationInterface {
  name = 'AddPoisSourceRegionIndex1802000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_pois_source_region_live"
        ON "pois" ("source", "import_region") WHERE "deactivated_at" IS NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY IF EXISTS "idx_pois_source_region_live"`,
    );
  }
}
