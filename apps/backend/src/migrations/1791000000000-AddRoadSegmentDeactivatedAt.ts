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
 *
 * The `(osm_way_id, segment_index)` identity index is also rebuilt as **partial on
 * live rows** so a tombstone never OWNS its OSM key: otherwise a returning key
 * would conflict with the dead row (and the conflict update wouldn't revive it),
 * and a carry-over re-pointing a live row onto a formerly-tombstoned key would hit
 * a unique violation. With the partial index, tombstones are out of the
 * uniqueness scope — a returning key inserts a fresh live row (its history stays
 * on the tombstone), and a carry-over onto that key is unobstructed.
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
    // Make OSM identity uniqueness live-row aware (tombstones drop out of scope).
    await queryRunner.query(
      `DROP INDEX IF EXISTS uq_road_segments_osm_identity;`,
    );
    await queryRunner.query(`
      CREATE UNIQUE INDEX uq_road_segments_osm_identity
        ON road_segments (osm_way_id, segment_index)
        WHERE deactivated_at IS NULL;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // The partial index permits a dead row + a live row to share an OSM key, so
    // rebuilding the OLD unfiltered unique index would hit a duplicate-key error
    // once the importer has tombstoned any reused key. Live rows are unique by the
    // partial-index invariant, so strip the OSM identity from tombstones first
    // (keeping the rows + their history FKs; the identity is meaningless once this
    // feature is reverted) — then the unfiltered index rebuilds cleanly.
    await queryRunner.query(`
      UPDATE road_segments
        SET osm_way_id = NULL, segment_index = NULL
        WHERE deactivated_at IS NOT NULL;
    `);
    await queryRunner.query(
      `DROP INDEX IF EXISTS uq_road_segments_osm_identity;`,
    );
    await queryRunner.query(`
      CREATE UNIQUE INDEX uq_road_segments_osm_identity
        ON road_segments (osm_way_id, segment_index);
    `);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_road_segments_active;`);
    await queryRunner.query(
      `ALTER TABLE road_segments DROP COLUMN IF EXISTS deactivated_at;`,
    );
  }
}
