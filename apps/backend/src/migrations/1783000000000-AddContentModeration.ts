import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddContentModeration1783000000000 implements MigrationInterface {
  name = 'AddContentModeration1783000000000';

  private readonly tables = ['hazard_reports', 'road_reviews', 'trip_messages'];

  // Written idempotently because `docs/database/schema.sql` — executed as the baseline by
  // `InitSchema1713000000000` — is maintained as CURRENT state and already carries these
  // four columns and this index on all three tables. Existing databases ran this migration
  // BEFORE that drift, so they are unaffected; a from-zero build finds everything already
  // present and used to fail here. See #1193.
  //
  // The FOREIGN KEY is the one thing the baseline no longer carries: it referenced
  // `admin_users`, which migration 1751 creates 38 migrations later, so the baseline could
  // not build at all. That inline reference has been removed from schema.sql, and this
  // migration is now the single place the constraint is created — drop-then-add so a
  // database that already has it converges rather than erroring.
  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const table of this.tables) {
      await queryRunner.query(`
        ALTER TABLE ${table}
          ADD COLUMN IF NOT EXISTS moderation_status VARCHAR(16) NOT NULL DEFAULT 'visible',
          ADD COLUMN IF NOT EXISTS moderation_reason VARCHAR(500),
          ADD COLUMN IF NOT EXISTS moderated_by UUID,
          ADD COLUMN IF NOT EXISTS moderated_at TIMESTAMPTZ;
        ALTER TABLE ${table}
          DROP CONSTRAINT IF EXISTS ${table}_moderated_by_fkey;
        ALTER TABLE ${table}
          ADD CONSTRAINT ${table}_moderated_by_fkey
          FOREIGN KEY (moderated_by) REFERENCES admin_users(id) ON DELETE SET NULL;
        CREATE INDEX IF NOT EXISTS idx_${table}_moderation
          ON ${table} (moderation_status, created_at);
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
