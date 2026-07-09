import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * #email-log — append-only outbound-email delivery log (metadata only, no
 * body). No FK to `users`: it's keyed on `recipient` (some recipients aren't
 * users, and the row must survive an account purge only as long as the purge
 * itself decides — see `account-deletion.service`).
 */
export class AddEmailLog1799000000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "email_log" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "recipient" varchar(255) NOT NULL,
        "tag" varchar(64) NOT NULL,
        "subject" varchar(255) NOT NULL,
        "status" varchar(16) NOT NULL,
        "provider" varchar(32),
        "provider_message_id" varchar(255),
        "error_class" varchar(255),
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_email_log" PRIMARY KEY ("id")
      );
    `);
    await queryRunner.query(
      `CREATE INDEX "idx_email_log_recipient_created" ON "email_log" ("recipient", "created_at");`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_email_log_created" ON "email_log" ("created_at");`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_email_log_created";`);
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_email_log_recipient_created";`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "email_log";`);
  }
}
