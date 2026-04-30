import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * INFRA: transactional email pipeline (#262).
 *
 *   1. `users.email_verified_at` — nullable timestamptz. NULL means
 *      the address has not been confirmed via the post-register
 *      verification email. Existing users are backfilled to NOW()
 *      because they predate the verification flow and gating them
 *      would lock real customers out of the billing pages they were
 *      using yesterday.
 *
 *   2. `email_verification_tokens` — single-use, hash-stored,
 *      24-hour-TTL token issued on register and on resend. Plain-text
 *      token never persists — only the SHA-256 of the URL-safe value
 *      we email out lives in the table, so a leaked DB dump cannot be
 *      used to verify accounts.
 *
 *   3. `password_reset_tokens` — same shape as verification tokens
 *      but with a 15-minute TTL (per the AC). One un-consumed token
 *      per user at any given time: re-requesting a reset
 *      invalidates the prior token via `consumed_at = NOW()` so a
 *      stolen prior link cannot be replayed after the user requests
 *      a fresh one.
 */
export class AddEmailVerificationAndPasswordReset1715700000000 implements MigrationInterface {
  name = 'AddEmailVerificationAndPasswordReset1715700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE users
        ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ;
    `);

    // Backfill: every account that exists right now is treated as
    // verified. New rows insert with NULL via the column default and
    // are gated until they consume a verification token.
    await queryRunner.query(`
      UPDATE users
        SET email_verified_at = NOW()
        WHERE email_verified_at IS NULL;
    `);

    await queryRunner.query(`
      CREATE TABLE email_verification_tokens (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash VARCHAR(128) NOT NULL UNIQUE,
        expires_at TIMESTAMPTZ NOT NULL,
        consumed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await queryRunner.query(`
      CREATE INDEX idx_email_verification_tokens_user
        ON email_verification_tokens(user_id, created_at DESC);
    `);

    await queryRunner.query(`
      CREATE TABLE password_reset_tokens (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash VARCHAR(128) NOT NULL UNIQUE,
        expires_at TIMESTAMPTZ NOT NULL,
        consumed_at TIMESTAMPTZ,
        requested_ip VARCHAR(45),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await queryRunner.query(`
      CREATE INDEX idx_password_reset_tokens_user
        ON password_reset_tokens(user_id, created_at DESC);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS idx_password_reset_tokens_user;`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS password_reset_tokens;`);

    await queryRunner.query(
      `DROP INDEX IF EXISTS idx_email_verification_tokens_user;`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS email_verification_tokens;`);

    await queryRunner.query(`
      ALTER TABLE users
        DROP COLUMN IF EXISTS email_verified_at;
    `);
  }
}
