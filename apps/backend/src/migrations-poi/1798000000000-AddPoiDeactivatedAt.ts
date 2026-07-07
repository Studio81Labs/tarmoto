import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * #850 — soft-tombstone column for the continent-scale bulk POI import.
 *
 * The bulk importer parses per-country Geofabrik extracts and stale-by-absence
 * tombstones rows that are inside a region's bbox but missing from its latest
 * extract (a closed venue) — bounded by that bbox so it never touches other
 * regions. This mirrors the roads importer's `deactivated_at` contract: an
 * UPDATE, never a DELETE, so history is retained and a re-import can revive a
 * reopened venue (the upsert clears `deactivated_at`). Store read paths (#849)
 * filter `deactivated_at IS NULL`.
 *
 * Additive + nullable → a non-blocking change on the existing table.
 */
export class AddPoiDeactivatedAt1798000000000 implements MigrationInterface {
  name = 'AddPoiDeactivatedAt1798000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE pois ADD COLUMN deactivated_at TIMESTAMPTZ;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE pois DROP COLUMN IF EXISTS deactivated_at;
    `);
  }
}
