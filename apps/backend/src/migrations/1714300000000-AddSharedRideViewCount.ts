import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * US-53 — view counter on shared rides to power the `most_popular`
 * sort on `GET /rides/community`.
 *
 * Adds an `int` column defaulting to 0 and an index on `(view_count DESC)`
 * so the sort can scan backwards without a full table sort once the feed
 * grows. `NULLS LAST` isn't needed — the column is NOT NULL.
 */
export class AddSharedRideViewCount1714300000000 implements MigrationInterface {
  name = 'AddSharedRideViewCount1714300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE shared_rides
      ADD COLUMN view_count INT NOT NULL DEFAULT 0;

      CREATE INDEX idx_shared_rides_view_count
        ON shared_rides (view_count DESC);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS idx_shared_rides_view_count;
      ALTER TABLE shared_rides DROP COLUMN IF EXISTS view_count;
    `);
  }
}
