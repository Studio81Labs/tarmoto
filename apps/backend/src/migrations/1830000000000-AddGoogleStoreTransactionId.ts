import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Expand half of an expand/contract for the Google store-identity columns.
 *
 * RevenueCat exposes NO Play purchase token — neither in the webhook event body
 * nor in the subscriber API. What it gives for a Play subscription is
 * `store_transaction_id`, its own transaction identifier. Keeping the old
 * `google_purchase_token` name would mean the column asserts something about its
 * contents that is false, and a future reader would reasonably assume they could
 * hand the value to the Play Developer API.
 *
 * A single-step `ALTER TABLE ... RENAME COLUMN` is NOT safe here. Coolify does a
 * rolling update: the OLD container keeps serving traffic while the new one
 * boots and runs migrations (see `.github/workflows/backend-deploy.yml`). The
 * instant the column is renamed, every `SELECT` the old image issues for a
 * `User` still names `google_purchase_token` and fails with PostgreSQL `42703`
 * until traffic switches — and rolling BACK to the previous image reintroduces
 * the same failure permanently. That hazard is about the column NAME in
 * TypeORM's select list, so it applies even though the contents need no
 * migration. See `docs/process/typeorm-migrations.md` → "Rename a column".
 *
 * So this migration only ADDS the new columns and index; the old
 * `google_purchase_token` columns and `uq_users_google_purchase_token` are left
 * exactly as they are, keeping both container generations queryable.
 *
 * There is deliberately NO backfill, even though the recipe calls for one:
 * `google_purchase_token` has no writer anywhere in the backend (Google IAP was
 * never implemented), so it is NULL in every row of every environment and there
 * is nothing to copy. For the same reason the code needs no dual-write phase —
 * the entities map only the new column, and neither generation ever populates
 * the other's.
 *
 * A follow-up migration drops `users.google_purchase_token`,
 * `store_billing_reconciliations.google_purchase_token`, and
 * `uq_users_google_purchase_token` once this release is deployed and no longer
 * a rollback target.
 */
export class AddGoogleStoreTransactionId1830000000000 implements MigrationInterface {
  name = 'AddGoogleStoreTransactionId1830000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE users
         ADD COLUMN google_store_transaction_id VARCHAR(1024);`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX uq_users_google_store_transaction_id
         ON users (google_store_transaction_id)
         WHERE google_store_transaction_id IS NOT NULL;`,
    );
    await queryRunner.query(
      `ALTER TABLE store_billing_reconciliations
         ADD COLUMN google_store_transaction_id VARCHAR(1024);`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Pure subtraction of what `up` added — the old `google_purchase_token`
    // columns and their index were never touched, so there is nothing to
    // restore. Drop the index before its column so the statement order reads
    // as the exact inverse of `up` rather than relying on PostgreSQL's
    // implicit cascade.
    await queryRunner.query(
      `ALTER TABLE store_billing_reconciliations
         DROP COLUMN IF EXISTS google_store_transaction_id;`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS uq_users_google_store_transaction_id;`,
    );
    await queryRunner.query(
      `ALTER TABLE users
         DROP COLUMN IF EXISTS google_store_transaction_id;`,
    );
  }
}
