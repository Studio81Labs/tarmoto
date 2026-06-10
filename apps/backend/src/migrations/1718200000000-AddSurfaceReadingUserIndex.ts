import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds an index on `surface_readings.user_id`. The "Your contribution"
 * sidebar badge (`GET /users/me/contribution`) aggregates a rider's
 * distinct road-quality contributions by `user_id` — both the per-rider
 * total and the regional-ranking query filter on it — and the table only
 * had indexes on `road_segment_id` and `recorded_at`, so those scans would
 * grow linearly with the sensor-upload volume. `IF NOT EXISTS` keeps it
 * idempotent for environments that already added it by hand.
 */
export class AddSurfaceReadingUserIndex1718200000000 implements MigrationInterface {
  name = 'AddSurfaceReadingUserIndex1718200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_surface_readings_user" ON "surface_readings" ("user_id");`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_surface_readings_user";`,
    );
  }
}
