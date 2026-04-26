import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * US-62 — GDPR account deletion (Art. 17 right to erasure).
 *
 * Three concerns rolled into one migration:
 *
 * 1. **Soft-delete columns on `users`.** A delete request flips
 *    `deleted_at` immediately (locks login, hides the account from
 *    feeds and profiles) and stamps `deletion_scheduled_at` 30 days
 *    out. The sweeper hard-deletes once the schedule passes; until
 *    then the account is restorable by a human via support tooling.
 *
 * 2. **Tightening legacy FKs.** Pre-community tables (`rides`,
 *    `hazard_reports`, `road_reviews`, `trips`, `trip_members`,
 *    `commute_routes`) reference `users(id)` with no `ON DELETE`
 *    clause — that defaults to NO ACTION and would block the hard
 *    delete with a foreign-key violation. Switch them to CASCADE so
 *    the user-row delete chain-cleans personal data without the
 *    sweeper having to enumerate every table.
 *
 *    `surface_readings.user_id` is the one exception: the user-facing
 *    delete copy promises that anonymized road-quality contributions
 *    stay in the community dataset, so its FK becomes ON DELETE SET
 *    NULL. The hard-delete service also nulls `user_id` explicitly
 *    before the user row goes (defensive — if the FK ever changes
 *    again, the anonymization step still runs).
 *
 * 3. **`account_deletion_log` audit table.** Append-only audit row
 *    per deletion event (`requested`, `restored`, `purged`).
 *    `user_id` is intentionally a plain UUID with no FK so the row
 *    survives the hard delete it's auditing. We store the email at
 *    request time so support can correlate without joining a table
 *    that no longer has the row.
 */
export class AddAccountDeletion1715500000000 implements MigrationInterface {
  name = 'AddAccountDeletion1715500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. Soft-delete columns on users
    await queryRunner.query(`
      ALTER TABLE users
        ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS deletion_scheduled_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS deletion_reason VARCHAR(255);
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_users_deletion_scheduled
        ON users(deletion_scheduled_at)
        WHERE deletion_scheduled_at IS NOT NULL;
    `);

    // 2a. Re-create legacy FKs as ON DELETE CASCADE.
    //
    // The pre-community schema named these constraints by Postgres
    // convention (`<table>_<column>_fkey`). Drop-if-exists by that
    // name and add the new constraint with the desired behaviour. If
    // the constraint name ever drifts from the convention, the
    // IF EXISTS keeps this migration idempotent.
    const cascadeFks: Array<{ table: string; column: string }> = [
      { table: 'rides', column: 'user_id' },
      { table: 'hazard_reports', column: 'user_id' },
      { table: 'road_reviews', column: 'user_id' },
      { table: 'trips', column: 'owner_id' },
      { table: 'trip_members', column: 'user_id' },
      { table: 'commute_routes', column: 'user_id' },
    ];

    for (const { table, column } of cascadeFks) {
      await queryRunner.query(
        `ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${table}_${column}_fkey;`,
      );
      await queryRunner.query(`
        ALTER TABLE ${table}
          ADD CONSTRAINT ${table}_${column}_fkey
          FOREIGN KEY (${column}) REFERENCES users(id) ON DELETE CASCADE;
      `);
    }

    // 2b. surface_readings.user_id → ON DELETE SET NULL (anonymized
    //     contributions stay in the dataset).
    await queryRunner.query(
      `ALTER TABLE surface_readings DROP CONSTRAINT IF EXISTS surface_readings_user_id_fkey;`,
    );
    await queryRunner.query(`
      ALTER TABLE surface_readings
        ADD CONSTRAINT surface_readings_user_id_fkey
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL;
    `);

    // 3. Audit log table.
    await queryRunner.query(`
      CREATE TABLE account_deletion_log (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL,
        email VARCHAR(255) NOT NULL,
        event VARCHAR(20) NOT NULL,
        scheduled_for TIMESTAMPTZ,
        stripe_customer_id VARCHAR(255),
        stripe_subscription_id VARCHAR(255),
        details JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await queryRunner.query(`
      CREATE INDEX idx_account_deletion_log_user
        ON account_deletion_log(user_id, created_at DESC);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TABLE IF EXISTS account_deletion_log CASCADE;`,
    );

    // Revert FK changes back to no-cascade defaults to match the
    // original schema. We recreate the constraint without an
    // ON DELETE clause to mirror the pre-migration behaviour.
    await queryRunner.query(
      `ALTER TABLE surface_readings DROP CONSTRAINT IF EXISTS surface_readings_user_id_fkey;`,
    );
    await queryRunner.query(`
      ALTER TABLE surface_readings
        ADD CONSTRAINT surface_readings_user_id_fkey
        FOREIGN KEY (user_id) REFERENCES users(id);
    `);

    const restoreFks: Array<{ table: string; column: string }> = [
      { table: 'commute_routes', column: 'user_id' },
      { table: 'trip_members', column: 'user_id' },
      { table: 'trips', column: 'owner_id' },
      { table: 'road_reviews', column: 'user_id' },
      { table: 'hazard_reports', column: 'user_id' },
      { table: 'rides', column: 'user_id' },
    ];

    for (const { table, column } of restoreFks) {
      await queryRunner.query(
        `ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${table}_${column}_fkey;`,
      );
      await queryRunner.query(`
        ALTER TABLE ${table}
          ADD CONSTRAINT ${table}_${column}_fkey
          FOREIGN KEY (${column}) REFERENCES users(id);
      `);
    }

    await queryRunner.query(
      `DROP INDEX IF EXISTS idx_users_deletion_scheduled;`,
    );
    await queryRunner.query(`
      ALTER TABLE users
        DROP COLUMN IF EXISTS deletion_reason,
        DROP COLUMN IF EXISTS deletion_scheduled_at,
        DROP COLUMN IF EXISTS deleted_at;
    `);
  }
}
