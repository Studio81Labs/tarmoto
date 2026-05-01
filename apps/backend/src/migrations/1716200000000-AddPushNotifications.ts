import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * #275 — push notification system (FCM + APN).
 *
 * `device_tokens` keys (user_id, token) so a user can register multiple
 * devices and a device can rotate its token without us having to
 * delete/insert. `deleted_at` carries the soft-delete signal — a
 * provider response of "this token is gone" (FCM `UNREGISTERED`,
 * APN `Unregistered`) sets the column instead of deleting, so the
 * dispatch path can fail closed on a returning row that already had
 * its push permissions stripped.
 *
 * `notification_preferences` is created lazily — there's no row for
 * a user until they first save preferences, so the dispatch path
 * MUST fall back to the canonical defaults from `@tarmoto/shared`.
 * Doing it the other way (seed-on-register) would leave us with
 * stale rows the day we add a new category.
 */
export class AddPushNotifications1716200000000 implements MigrationInterface {
  name = 'AddPushNotifications1716200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE device_tokens (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        platform VARCHAR(16) NOT NULL,
        token TEXT NOT NULL,
        app_version VARCHAR(64),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        deleted_at TIMESTAMPTZ
      );
    `);

    await queryRunner.query(`
      CREATE INDEX idx_device_tokens_user ON device_tokens(user_id);
    `);

    // Unique on (user_id, token) so the same device re-registering with
    // the same token is a no-op upsert, but two distinct devices for
    // one user (or two users sharing a device, which can happen on
    // family iPads) coexist cleanly.
    await queryRunner.query(`
      CREATE UNIQUE INDEX uq_device_tokens_user_token
        ON device_tokens(user_id, token);
    `);

    await queryRunner.query(`
      CREATE TABLE notification_preferences (
        user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        email_digest VARCHAR(16) NOT NULL DEFAULT 'weekly',
        marketing_emails BOOLEAN NOT NULL DEFAULT FALSE,
        quiet_hours_start INTEGER NOT NULL DEFAULT 0,
        quiet_hours_end INTEGER NOT NULL DEFAULT 0,
        quiet_hours_timezone VARCHAR(64) NOT NULL DEFAULT 'UTC',
        categories JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'DROP TABLE IF EXISTS notification_preferences CASCADE;',
    );
    await queryRunner.query('DROP TABLE IF EXISTS device_tokens CASCADE;');
  }
}
