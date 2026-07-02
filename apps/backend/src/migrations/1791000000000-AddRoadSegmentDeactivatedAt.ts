import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Issue #835 — split/merge reconciliation tombstones instead of deleting.
 *
 * When the OSM importer detects that an existing segment's way was removed, or
 * split/merged away so no incoming segment inherits it (ADR-0006), the row is
 * DEACTIVATED, not hard-deleted: the crowdsourced history (`surface_readings`,
 * `road_reviews`, `hazard_reports`, `fun_zone_roads`) still FKs to it, and a
 * delete would either violate those constraints or destroy the very history the
 * stable-identity work (#751) exists to preserve.
 *
 * `deactivated_at` NULL = live; a timestamp = tombstoned at that moment. Active
 * read paths filter `deactivated_at IS NULL`; the partial index keeps that filter
 * index-friendly and matches the predicate the live-row scans use.
 */
export class AddRoadSegmentDeactivatedAt1791000000000 implements MigrationInterface {
  name = 'AddRoadSegmentDeactivatedAt1791000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE road_segments
        ADD COLUMN IF NOT EXISTS deactivated_at timestamptz;
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_road_segments_active
        ON road_segments (id)
        WHERE deactivated_at IS NULL;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS idx_road_segments_active;`);
    await queryRunner.query(
      `ALTER TABLE road_segments DROP COLUMN IF EXISTS deactivated_at;`,
    );
  }
}
