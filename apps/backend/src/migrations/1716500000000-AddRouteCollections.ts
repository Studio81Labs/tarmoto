import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * US-56 — cloud-synced route collections plus shareable slug-based links.
 *
 * `route_collections` owns metadata; `route_collection_items` is the join row
 * to either a trip (planner) or a ride (recorded GPS). The CHECK constraint
 * forces exactly one of `trip_id`/`ride_id` to be populated so the row can't
 * silently drift into an ambiguous state — no application-level guard would
 * survive a hand-written INSERT.
 *
 * No FK from items → trips/rides on purpose: the trips table doesn't always
 * exist at migrate time in test environments and a stale member tile already
 * renders as "unavailable" in the UI; we'd rather keep a tombstone than
 * cascade-delete the user's curated metadata when a single trip is removed.
 */
export class AddRouteCollections1716500000000 implements MigrationInterface {
  name = 'AddRouteCollections1716500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE route_collections (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        title VARCHAR(80) NOT NULL,
        description VARCHAR(500),
        visibility VARCHAR(16) NOT NULL DEFAULT 'private',
        slug VARCHAR(24) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT chk_route_collections_visibility
          CHECK (visibility IN ('private', 'unlisted', 'public'))
      );
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX idx_route_collections_slug
        ON route_collections(slug);
    `);

    await queryRunner.query(`
      CREATE INDEX idx_route_collections_owner
        ON route_collections(owner_id);
    `);

    await queryRunner.query(`
      CREATE INDEX idx_route_collections_visibility
        ON route_collections(visibility);
    `);

    await queryRunner.query(`
      CREATE TABLE route_collection_items (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        collection_id UUID NOT NULL REFERENCES route_collections(id) ON DELETE CASCADE,
        trip_id UUID,
        ride_id UUID,
        position INT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT chk_route_collection_items_target
          CHECK ((trip_id IS NULL) <> (ride_id IS NULL))
      );
    `);

    await queryRunner.query(`
      CREATE INDEX idx_route_collection_items_collection
        ON route_collection_items(collection_id, position);
    `);

    await queryRunner.query(`
      CREATE INDEX idx_route_collection_items_trip
        ON route_collection_items(trip_id);
    `);

    await queryRunner.query(`
      CREATE INDEX idx_route_collection_items_ride
        ON route_collection_items(ride_id);
    `);

    // Per-collection uniqueness for the same target so a duplicate add is a
    // no-op rather than a drift in the membership list. Partial uniques avoid
    // collisions between the trip and ride columns that would otherwise need
    // a coalesced expression index.
    await queryRunner.query(`
      CREATE UNIQUE INDEX uq_route_collection_items_trip
        ON route_collection_items(collection_id, trip_id)
        WHERE trip_id IS NOT NULL;
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX uq_route_collection_items_ride
        ON route_collection_items(collection_id, ride_id)
        WHERE ride_id IS NOT NULL;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'DROP TABLE IF EXISTS route_collection_items CASCADE;',
    );
    await queryRunner.query('DROP TABLE IF EXISTS route_collections CASCADE;');
  }
}
