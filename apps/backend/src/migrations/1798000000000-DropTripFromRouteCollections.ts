import { MigrationInterface, QueryRunner } from 'typeorm';

// Trips are private/collaborator-only and are no longer surfaced through
// route-collections — collections now hold rides exclusively. Delete any
// existing trip-backed items, drop the trip column and its check/index/unique
// constraints, and enforce ride-only at the DB level (`ride_id NOT NULL`).
// One-way cutover: `down` is a no-op because the trip surface is retired.
export class DropTripFromRouteCollections1798000000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'DELETE FROM route_collection_items WHERE trip_id IS NOT NULL',
    );
    await queryRunner.query(
      'ALTER TABLE route_collection_items DROP CONSTRAINT IF EXISTS chk_route_collection_items_target',
    );
    await queryRunner.query(
      'DROP INDEX IF EXISTS uq_route_collection_items_trip',
    );
    await queryRunner.query(
      'DROP INDEX IF EXISTS idx_route_collection_items_trip',
    );
    await queryRunner.query(
      'ALTER TABLE route_collection_items DROP COLUMN IF EXISTS trip_id',
    );
    await queryRunner.query(
      'ALTER TABLE route_collection_items ALTER COLUMN ride_id SET NOT NULL',
    );
  }

  public async down(): Promise<void> {
    // no-op: trips are intentionally retired from route-collections.
  }
}
