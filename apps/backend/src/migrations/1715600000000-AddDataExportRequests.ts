import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddDataExportRequests1715600000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "data_export_requests" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "user_id" uuid NOT NULL,
        "status" varchar(20) NOT NULL DEFAULT 'queued',
        "storage_key" varchar(500),
        "byte_size" bigint,
        "expires_at" timestamptz NOT NULL,
        "completed_at" timestamptz,
        "error_message" text,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_data_export_requests" PRIMARY KEY ("id"),
        CONSTRAINT "fk_data_export_requests_user"
          FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
      );
    `);
    await queryRunner.query(
      `CREATE INDEX "idx_data_export_requests_user" ON "data_export_requests" ("user_id");`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_data_export_requests_user_status" ON "data_export_requests" ("user_id", "status");`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_data_export_requests_user_status";`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_data_export_requests_user";`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "data_export_requests";`);
  }
}
