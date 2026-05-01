import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * US-19 — capture lean angle from gyroscope during ride.
 *
 * Adds `lean_distribution_json` to `ride_stats` so the ride-detail
 * screen can render a per-bucket histogram of how long the rider
 * spent at each lean magnitude. The bucket boundaries (0–10°, 10–20°,
 * 20–30°, 30°+) are owned by `@tarmoto/shared` so a future change to
 * the buckets only touches code, not the schema.
 *
 * The column is JSONB and nullable: rides recorded before US-19
 * shipped (and rides whose riders never let the orientation filter
 * calibrate) have no lean data, and `null` is more honest there than
 * an empty histogram that implies "all samples were at 0°".
 */
export class AddRideStatsLeanDistribution1716200000000 implements MigrationInterface {
  name = 'AddRideStatsLeanDistribution1716200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE ride_stats ADD COLUMN lean_distribution_json JSONB`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE ride_stats DROP COLUMN IF EXISTS lean_distribution_json`,
    );
  }
}
