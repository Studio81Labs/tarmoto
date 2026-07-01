import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Issue #794 — index the aggregation "road key" so per-way lookups are
 * index-backed.
 *
 * The read-time aggregation groups/matches road segments by
 * `COALESCE(osm_way_id::text, id::text)` (a way's imported sub-segments, or a
 * crowd-sourced row's own id). Wrapping both keys in a COALESCE-of-casts means
 * neither the primary key nor `uq_road_segments_osm_identity` can satisfy the
 * predicate, so `findZoneById`'s per-member LATERAL — and the clustering
 * `assessed_ways` join — fall back to scans; on a large imported region
 * `GET /roads/fun-zones/:id` degrades toward `zone_members × road_segments`.
 *
 * A matching expression index makes each per-way lookup an index scan.
 */
export class AddRoadSegmentWayKeyIndex1790000000000 implements MigrationInterface {
  name = 'AddRoadSegmentWayKeyIndex1790000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_road_segments_way_key
        ON road_segments ((COALESCE(osm_way_id::text, id::text)));
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS idx_road_segments_way_key;`);
  }
}
