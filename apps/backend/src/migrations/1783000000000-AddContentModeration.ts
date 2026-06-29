import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddContentModeration1783000000000 implements MigrationInterface {
  name = 'AddContentModeration1783000000000';

  private readonly tables = ['hazard_reports', 'road_reviews', 'trip_messages'];

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const table of this.tables) {
      await queryRunner.query(`
        ALTER TABLE ${table}
          ADD COLUMN moderation_status VARCHAR(16) NOT NULL DEFAULT 'visible',
          ADD COLUMN moderation_reason VARCHAR(500),
          ADD COLUMN moderated_by UUID,
          ADD COLUMN moderated_at TIMESTAMPTZ;
        ALTER TABLE ${table}
          ADD CONSTRAINT ${table}_moderated_by_fkey
          FOREIGN KEY (moderated_by) REFERENCES admin_users(id) ON DELETE SET NULL;
        CREATE INDEX idx_${table}_moderation ON ${table} (moderation_status, created_at);
      `);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const table of this.tables) {
      await queryRunner.query(`
        DROP INDEX IF EXISTS idx_${table}_moderation;
        ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${table}_moderated_by_fkey;
        ALTER TABLE ${table}
          DROP COLUMN IF EXISTS moderation_status,
          DROP COLUMN IF EXISTS moderation_reason,
          DROP COLUMN IF EXISTS moderated_by,
          DROP COLUMN IF EXISTS moderated_at;
      `);
    }
  }
}
