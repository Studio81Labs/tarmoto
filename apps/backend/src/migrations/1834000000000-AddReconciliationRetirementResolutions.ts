import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Widens `sbr_resolution_check` for the four RETIREMENT resolutions.
 *
 * A `store_billing_reconciliations` row records a point-in-time judgement about
 * mutable state, so it is stale the instant it commits: the slot it lost to can
 * be cleared, or claimed by the very purchase the row was filed against. The
 * design therefore requires losing rows to be RETIRED rather than left for an
 * operator to drain — otherwise an ops action refunds or revokes a subscription
 * that has since become valid. See §4 step 6 in
 * `docs/superpowers/specs/2026-08-06-mobile-iap-revenuecat-design.md`.
 *
 * The four outcomes, each a distinct operational signal rather than a synonym:
 *
 *  - `superseded_by_claim` — a later WEBHOOK claim made the conflict moot.
 *  - `claimed_on_drain`    — the DRAIN itself re-queried and claimed it. A rising
 *                            rate here means webhooks are failing to land, which
 *                            `superseded_by_claim` would hide.
 *  - `stale_on_drain`      — at drain time the row's subject already owns the
 *                            slot, so there was nothing to do.
 *  - `purchase_inactive`   — the slot is empty AND the purchase has expired
 *                            upstream. The only empty-slot case where closing the
 *                            row is correct; otherwise the drain must re-claim,
 *                            or a still-billing rider is left on `free`.
 *
 * ## Why this is its own migration and blocks the code
 *
 * `superseded_by_claim` is written INSIDE the claim transaction. Without the
 * constraint widened first, that insert raises a CHECK violation which rolls back
 * the **successful claim** — turning a schema oversight into a rider losing
 * entitlement they paid for. The constraint has to land before any code emits
 * these values.
 *
 * Longest value is `superseded_by_claim` (19 chars); `purchase_inactive` is 17.
 * Both are inside the existing `VARCHAR(32)`, so no column widening.
 *
 * Naming deliberately carries no `resolved_` prefix, matching the original four:
 * `status` already says `resolved`, so the prefix would be redundant on a column
 * that is only ever non-NULL on resolved rows.
 */
export class AddReconciliationRetirementResolutions1834000000000 implements MigrationInterface {
  name = 'AddReconciliationRetirementResolutions1834000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE store_billing_reconciliations
         DROP CONSTRAINT IF EXISTS sbr_resolution_check;`,
    );
    await queryRunner.query(
      `ALTER TABLE store_billing_reconciliations
         ADD CONSTRAINT sbr_resolution_check CHECK (resolution IN (
           'rider_canceled',
           'refunded',
           'expired',
           'server_canceled',
           'superseded_by_claim',
           'claimed_on_drain',
           'stale_on_drain',
           'purchase_inactive'
         ));`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // LOSSY BY NECESSITY, and deliberately so rather than refusing.
    //
    // Re-adding the narrow constraint fails outright if any row already carries
    // one of the four new values, so a naive `down` is not merely imperfect — it
    // errors on a populated table and leaves the rollback stuck half-done.
    //
    // None of the new values maps onto an old one (`superseded_by_claim` is not
    // `server_canceled`; a drain-claimed row is not `refunded`), so there is no
    // faithful translation. NULLing is the honest option: `status` stays
    // `resolved` and `resolved_at` is preserved, so the row still reads as
    // closed and when — only *why* is lost, and only for rows that could not
    // have existed before this migration.
    await queryRunner.query(
      `UPDATE store_billing_reconciliations
          SET resolution = NULL
        WHERE resolution IN (
          'superseded_by_claim',
          'claimed_on_drain',
          'stale_on_drain',
          'purchase_inactive'
        );`,
    );
    await queryRunner.query(
      `ALTER TABLE store_billing_reconciliations
         DROP CONSTRAINT IF EXISTS sbr_resolution_check;`,
    );
    await queryRunner.query(
      `ALTER TABLE store_billing_reconciliations
         ADD CONSTRAINT sbr_resolution_check CHECK (resolution IN (
           'rider_canceled',
           'refunded',
           'expired',
           'server_canceled'
         ));`,
    );
  }
}
