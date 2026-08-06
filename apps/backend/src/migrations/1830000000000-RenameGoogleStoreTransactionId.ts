import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Renames the Google store-identity columns to match what RevenueCat actually
 * provides.
 *
 * RevenueCat exposes NO Play purchase token — neither in the webhook event body
 * nor in the subscriber API. What it gives for a Play subscription is
 * `store_transaction_id`, its own transaction identifier. Keeping the old
 * `google_purchase_token` name would mean the column asserts something about its
 * contents that is false, and a future reader would reasonably assume they could
 * hand the value to the Play Developer API.
 *
 * Pure rename, no data movement: the column has no writer anywhere in the
 * backend (Google IAP was never implemented), so it is NULL in every
 * environment. `ALTER TABLE ... RENAME COLUMN` carries the partial unique index
 * with it automatically; the index is renamed separately only so its NAME stays
 * honest too.
 */
export class RenameGoogleStoreTransactionId1830000000000 implements MigrationInterface {
  name = 'RenameGoogleStoreTransactionId1830000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE users
         RENAME COLUMN google_purchase_token TO google_store_transaction_id;`,
    );
    await queryRunner.query(
      `ALTER INDEX uq_users_google_purchase_token
         RENAME TO uq_users_google_store_transaction_id;`,
    );
    await queryRunner.query(
      `ALTER TABLE store_billing_reconciliations
         RENAME COLUMN google_purchase_token TO google_store_transaction_id;`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE store_billing_reconciliations
         RENAME COLUMN google_store_transaction_id TO google_purchase_token;`,
    );
    await queryRunner.query(
      `ALTER INDEX uq_users_google_store_transaction_id
         RENAME TO uq_users_google_purchase_token;`,
    );
    await queryRunner.query(
      `ALTER TABLE users
         RENAME COLUMN google_store_transaction_id TO google_purchase_token;`,
    );
  }
}
