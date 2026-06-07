import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Community v2 engagement: per-rider likes on shared rides, a clone counter
 * and an optional caption on `shared_rides`. The feed's `like_count`/
 * `clone_count` are surfaced from these.
 */
export class AddCommunityEngagement1718100000000 implements MigrationInterface {
  name = 'AddCommunityEngagement1718100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE ride_likes (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        ride_id UUID NOT NULL REFERENCES rides(id) ON DELETE CASCADE,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT idx_ride_likes_ride_user UNIQUE (ride_id, user_id)
      );
    `);

    await queryRunner.query(`
      CREATE INDEX idx_ride_likes_ride ON ride_likes(ride_id);
    `);

    await queryRunner.query(`
      ALTER TABLE shared_rides
        ADD COLUMN IF NOT EXISTS clone_count INT NOT NULL DEFAULT 0;
    `);

    await queryRunner.query(`
      ALTER TABLE shared_rides
        ADD COLUMN IF NOT EXISTS caption VARCHAR(280);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE shared_rides DROP COLUMN IF EXISTS caption;',
    );
    await queryRunner.query(
      'ALTER TABLE shared_rides DROP COLUMN IF EXISTS clone_count;',
    );
    await queryRunner.query('DROP TABLE IF EXISTS ride_likes CASCADE;');
  }
}
