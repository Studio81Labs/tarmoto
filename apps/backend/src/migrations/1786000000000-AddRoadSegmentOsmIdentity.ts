import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * #751 — stable identity for OSM re-imports.
 *
 * `road_segments` had only a generated UUID, so a weekly/monthly OSM
 * re-import had no deterministic key to upsert against and would either
 * mint fresh UUIDs (orphaning every `surface_readings`, `road_reviews`,
 * `hazard_reports`, and `fun_zone_road` row that references the segment)
 * or fall back to brittle geometry matching.
 *
 * Adds `osm_way_id` (the source OSM way) + `segment_index` (the segment's
 * ordinal within that way) with a unique index on the pair. A re-importer
 * upserts `ON CONFLICT (osm_way_id, segment_index)`, preserving the
 * segment's UUID and all dependent FKs across imports.
 *
 * Both columns are nullable: rows seeded before the first OSM import (and
 * demo data) carry no OSM identity. The unique index is NOT partial — a
 * plain unique index already lets those NULL rows coexist (Postgres treats
 * NULLs as distinct), while every imported pair stays unique, and a plain
 * `ON CONFLICT (osm_way_id, segment_index)` upsert resolves it without
 * needing a matching index predicate.
 *
 * A CHECK enforces both-NULL-or-both-set. Without it a half-populated
 * identity (e.g. `(123, NULL)`) would slip past the unique index — NULLs
 * don't conflict — so a re-import upsert on that partial key would INSERT
 * a duplicate row instead of preserving the segment's UUID. The CHECK
 * makes the upsert key all-or-nothing, so it always identifies the row.
 */
export class AddRoadSegmentOsmIdentity1786000000000 implements MigrationInterface {
  name = 'AddRoadSegmentOsmIdentity1786000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE road_segments
        ADD COLUMN osm_way_id BIGINT,
        ADD COLUMN segment_index INTEGER,
        ADD CONSTRAINT chk_road_segments_osm_identity
          CHECK ((osm_way_id IS NULL) = (segment_index IS NULL));

      CREATE UNIQUE INDEX uq_road_segments_osm_identity
        ON road_segments (osm_way_id, segment_index);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS uq_road_segments_osm_identity;
      ALTER TABLE road_segments
        DROP CONSTRAINT IF EXISTS chk_road_segments_osm_identity,
        DROP COLUMN IF EXISTS segment_index,
        DROP COLUMN IF EXISTS osm_way_id;
    `);
  }
}
