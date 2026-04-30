import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Two follow-ups from the email-pipeline review (#262):
 *
 *   1. `users.password_changed_at` — stamped by the password-reset
 *      flow so the JWT refresh path can invalidate any session
 *      issued before the reset. Without it, an attacker who already
 *      stole a refresh token keeps minting access tokens for the
 *      full 90-day refresh-token lifetime even after the legitimate
 *      owner changes their password.
 *
 *      The check is implemented as a timestamp comparison rather
 *      than a per-user token-version counter so we don't have to
 *      bump a counter on every login. The 1-hour access-token TTL
 *      bounds how long a stolen access token still works after
 *      reset; tighter invalidation would require checking the DB
 *      on every protected request.
 *
 *   2. `password_reset_tokens` partial unique index on `user_id`
 *      where `consumed_at IS NULL` — guarantees at most one active
 *      reset token per user at any time. Two concurrent
 *      `requestReset` calls would otherwise both run their
 *      "invalidate prior" UPDATE on rows the other hasn't committed
 *      yet, then both INSERT a fresh row, leaving multiple valid
 *      reset links emailed to (potentially compromised) inboxes.
 *      The index makes the second INSERT fail with a unique
 *      violation; the service catches it and treats the request as
 *      a no-op (the first send already covered the user).
 */
export class AddPasswordChangedAtAndUniqueResetToken1715800000000 implements MigrationInterface {
  name = 'AddPasswordChangedAtAndUniqueResetToken1715800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE users
        ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMPTZ;
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uniq_password_reset_active
        ON password_reset_tokens(user_id)
        WHERE consumed_at IS NULL;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS uniq_password_reset_active;`);
    await queryRunner.query(`
      ALTER TABLE users
        DROP COLUMN IF EXISTS password_changed_at;
    `);
  }
}
