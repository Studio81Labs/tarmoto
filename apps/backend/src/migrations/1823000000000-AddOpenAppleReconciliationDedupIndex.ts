import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Race-safe dedup for OPEN Apple store-billing reconciliations.
 *
 * The synchronous validation path opens a reconciliation work item when it
 * rejects an ineligible trial or a cross-provider exclusivity conflict, guarded
 * by a `findOpen` check-then-insert. That check-then-insert has a TOCTOU: two
 * concurrent validations rejecting the SAME Apple transaction can both see no
 * open row and insert duplicate `open` rows. This partial unique index enforces
 * the promised transaction-id idempotency at the database, so the loser of the
 * race fails with a `23505` the service treats as a dedup no-op.
 *
 * The index is Apple-specific and partial (only `open` rows with a non-null
 * `apple_original_transaction_id`), so the Stripe reconciliation path is
 * unaffected. The IAP feature ships dark — there are no Apple reconciliations in
 * any environment yet — so no existing row can violate the new constraint.
 */
export class AddOpenAppleReconciliationDedupIndex1823000000000 implements MigrationInterface {
  name = 'AddOpenAppleReconciliationDedupIndex1823000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_sbr_open_apple_otid_reason"
         ON store_billing_reconciliations (apple_original_transaction_id, reason)
         WHERE status = 'open' AND apple_original_transaction_id IS NOT NULL;`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "uq_sbr_open_apple_otid_reason";`,
    );
  }
}
