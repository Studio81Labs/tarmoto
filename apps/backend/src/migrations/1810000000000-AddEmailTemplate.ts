import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * #admin-email-template-editor — versioned admin block-override table.
 * At most one `published` row per (template_tag, locale) is the active
 * override (partial unique index below); `draft` rows are unconstrained.
 * See docs/superpowers/specs/2026-07-14-admin-email-template-editor-phase1-design.md
 */
export class AddEmailTemplate1810000000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "email_template" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "template_tag" varchar(64) NOT NULL,
        "locale" varchar(10) NOT NULL,
        "subject" text NOT NULL,
        "blocks" jsonb NOT NULL,
        "status" varchar(16) NOT NULL DEFAULT 'draft',
        "version" int NOT NULL DEFAULT 1,
        "created_by" uuid,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "published_at" timestamptz,
        CONSTRAINT "pk_email_template" PRIMARY KEY ("id")
      );
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "uq_email_template_published"
      ON "email_template" ("template_tag", "locale") WHERE status = 'published';
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "uq_email_template_published";`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "email_template";`);
  }
}
