import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddCommunityTables1713400000000 implements MigrationInterface {
  name = 'AddCommunityTables1713400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE shared_rides (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        ride_id UUID NOT NULL REFERENCES rides(id) ON DELETE CASCADE,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        share_token VARCHAR(32) NOT NULL,
        is_public BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT idx_shared_rides_ride UNIQUE (ride_id)
      );

      CREATE UNIQUE INDEX idx_shared_rides_token ON shared_rides (share_token);
      CREATE INDEX idx_shared_rides_user ON shared_rides (user_id);
    `);

    await queryRunner.query(`
      CREATE TABLE user_follows (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        follower_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        following_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT idx_user_follows_unique UNIQUE (follower_id, following_id)
      );

      CREATE INDEX idx_user_follows_follower ON user_follows (follower_id);
      CREATE INDEX idx_user_follows_following ON user_follows (following_id);
    `);

    await queryRunner.query(`
      CREATE TABLE user_badges (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        badge_key VARCHAR(50) NOT NULL,
        tier VARCHAR(10) NOT NULL,
        earned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT idx_user_badges_unique UNIQUE (user_id, badge_key)
      );

      CREATE INDEX idx_user_badges_user ON user_badges (user_id);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS user_badges CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS user_follows CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS shared_rides CASCADE`);
  }
}
