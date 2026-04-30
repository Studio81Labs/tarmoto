import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Mirror the `uniq_password_reset_active` partial index from
 * 1715800000000 onto `email_verification_tokens`. Two concurrent
 * `issueAndSend` calls (e.g. register + a near-simultaneous resend
 * for the same user) would otherwise both run their "invalidate
 * prior" UPDATE on rows the other hasn't committed, then both
 * INSERT a fresh active token, leaving multiple valid 24h links
 * out at once. The index makes the second INSERT fail with a
 * unique violation; `EmailVerificationService.issueAndSend`
 * catches the `23505` and treats it as "the other call already
 * issued a fresh token" — the user gets one valid email, not two.
 *
 * Pre-existing duplicate active rows are pruned first (consume the
 * older ones, keep only the newest `created_at`) so the unique
 * index can be created without conflict on systems where the older
 * code accumulated overlapping rows during the time-window between
 * the rotation fix in 59846a9 and this index.
 */
export class AddVerificationTokenUniqueIndex1715900000000 implements MigrationInterface {
  name = 'AddVerificationTokenUniqueIndex1715900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      WITH ranked AS (
        SELECT id,
               ROW_NUMBER() OVER (
                 PARTITION BY user_id
                 ORDER BY created_at DESC, id DESC
               ) AS rn
        FROM email_verification_tokens
        WHERE consumed_at IS NULL
      )
      UPDATE email_verification_tokens
        SET consumed_at = NOW()
        WHERE id IN (SELECT id FROM ranked WHERE rn > 1);
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uniq_email_verification_active
        ON email_verification_tokens(user_id)
        WHERE consumed_at IS NULL;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS uniq_email_verification_active;`,
    );
  }
}
