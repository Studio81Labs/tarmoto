import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the `unrecognized_product` reconciliation reason.
 *
 * When Apple verifies an ACTIVE (still-charging) subscription for a rider but
 * its product is absent from `IAP_PRODUCTS`, the synchronous validation rejects
 * it with a terminal 400 — yet the subscription keeps renewing and Apple has no
 * server-side cancel API, so a rider can stay charged without entitlement and
 * ops has no durable trace. The validation path now opens a deduplicated
 * reconciliation work item with this reason; the `sbr_reason_check` constraint
 * must accept it.
 *
 * Mirrors the check-constraint ALTER style of the original constraint in
 * migration 1822 (`sbr_reason_check`). No data change — the IAP feature ships
 * dark, so no existing row carries this reason.
 */
export class AddUnrecognizedProductReconciliationReason1825000000000 implements MigrationInterface {
  name = 'AddUnrecognizedProductReconciliationReason1825000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE store_billing_reconciliations
         DROP CONSTRAINT sbr_reason_check;`,
    );
    await queryRunner.query(
      `ALTER TABLE store_billing_reconciliations
         ADD CONSTRAINT sbr_reason_check CHECK (reason IN
           ('ineligible_trial_rejected','exclusivity_conflict','deletion_cancel_failed','unrecognized_product'));`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE store_billing_reconciliations
         DROP CONSTRAINT sbr_reason_check;`,
    );
    await queryRunner.query(
      `ALTER TABLE store_billing_reconciliations
         ADD CONSTRAINT sbr_reason_check CHECK (reason IN
           ('ineligible_trial_rejected','exclusivity_conflict','deletion_cancel_failed'));`,
    );
  }
}
