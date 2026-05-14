import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * #528 — durable in-app notification feed for the companion bell.
 */
export class AddInAppNotifications1717800000000 implements MigrationInterface {
  name = 'AddInAppNotifications1717800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE user_notifications (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        category VARCHAR(64) NOT NULL,
        title VARCHAR(160) NOT NULL,
        body TEXT NOT NULL,
        data JSONB NOT NULL DEFAULT '{}'::jsonb,
        read_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await queryRunner.query(`
      CREATE INDEX idx_user_notifications_user_created
        ON user_notifications(user_id, created_at DESC);
    `);

    await queryRunner.query(`
      CREATE INDEX idx_user_notifications_user_unread
        ON user_notifications(user_id, read_at);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS user_notifications CASCADE;');
  }
}
