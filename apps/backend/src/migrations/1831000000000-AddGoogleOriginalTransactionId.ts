import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Expand half of a SECOND expand/contract on the Google store-identity columns —
 * this time to fix WHICH RevenueCat identifier the binding stores, not just what
 * the column is called.
 *
 * Migration 1830 renamed `google_purchase_token` → `google_store_transaction_id`
 * on the (correct) finding that RevenueCat exposes no Play purchase token. But it
 * pinned the binding to the wrong field. Per RevenueCat's own field
 * documentation:
 *
 *  - `transaction_id` — "Transaction identifier from the store."
 *  - `original_transaction_id` — "`transaction_id` of the original transaction in
 *    the subscription."
 *
 * The subscriber API's per-subscription `store_transaction_id` is the CURRENT
 * period's transaction, and it ADVANCES on every renewal: RevenueCat's own
 * documented example value is a Google Play order id of the form
 * `GPA.6801-7988-0152-76034..5`, whose `..N` suffix increments per renewal.
 *
 * Binding on that value would make `claimForGoogle`'s identity guard
 * `(google_store_transaction_id IS NULL OR = :txn)` reject EVERY renewal after
 * the first — a reconciliation row per renewal and a
 * `subscription_current_period_end` that never advances. `original_transaction_id`
 * is stable for the subscription's lifetime, so the binding moves there.
 *
 * It also makes the two stores symmetric: RevenueCat's `original_transaction_id`
 * for an App Store subscription IS the Apple OTID, which
 * `apple_original_transaction_id` already stores. The columns now read alike.
 *
 * A single-step `ALTER TABLE ... RENAME COLUMN` is NOT safe here — the same
 * reason 1830 was staged rather than renamed. Coolify does a rolling update: the
 * OLD container keeps serving traffic while the new one boots and runs migrations
 * (see `.github/workflows/backend-deploy.yml`). The instant the column is
 * renamed, every `SELECT` the old image issues for a `User` still names
 * `google_store_transaction_id` and fails with PostgreSQL `42703` until traffic
 * switches — and rolling BACK to the previous image reintroduces the same failure
 * permanently. The hazard is the column NAME in TypeORM's select list, so it
 * applies even though the contents need no migration. See
 * `docs/process/typeorm-migrations.md` → "Rename a column".
 *
 * So this migration only ADDS the new columns and index. BOTH older generations —
 * `google_purchase_token` (1822) and `google_store_transaction_id` (1830) — and
 * their indexes are left exactly as they are, keeping every deployed container
 * generation queryable. Three generations of this column exist transiently; that
 * is the accepted cost of not breaking the rolling deploy, and the contract
 * migration drops the two older ones TOGETHER in a later release.
 *
 * There is deliberately NO backfill, even though the recipe calls for one:
 * neither `google_purchase_token` nor `google_store_transaction_id` has ever had
 * a writer that ran in any environment (Google IAP is not implemented and the
 * step-5 consumer that would call `claimForGoogle` does not exist yet), so both
 * are NULL in every row everywhere and there is nothing to copy. For the same
 * reason the code needs no dual-write phase — the entities map only the newest
 * column, and no generation ever populates another's.
 *
 * A follow-up contract migration drops `users.google_purchase_token`,
 * `users.google_store_transaction_id`,
 * `store_billing_reconciliations.google_purchase_token`,
 * `store_billing_reconciliations.google_store_transaction_id`,
 * `uq_users_google_purchase_token` and `uq_users_google_store_transaction_id`
 * once this release is deployed and no longer a rollback target — see open item
 * (e) in `docs/superpowers/specs/2026-08-06-mobile-iap-revenuecat-design.md`.
 */
export class AddGoogleOriginalTransactionId1831000000000 implements MigrationInterface {
  name = 'AddGoogleOriginalTransactionId1831000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE users
         ADD COLUMN google_original_transaction_id VARCHAR(1024);`,
    );
    // Mirrors `uq_users_google_store_transaction_id` /
    // `uq_users_google_purchase_token`: a partial unique index so the NULLs on
    // every existing row don't collide, while a real binding still enforces
    // one-subscription-per-rider across rows.
    await queryRunner.query(
      `CREATE UNIQUE INDEX uq_users_google_original_transaction_id
         ON users (google_original_transaction_id)
         WHERE google_original_transaction_id IS NOT NULL;`,
    );
    await queryRunner.query(
      `ALTER TABLE store_billing_reconciliations
         ADD COLUMN google_original_transaction_id VARCHAR(1024);`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Pure subtraction of what `up` added — the two older column generations and
    // their indexes were never touched, so there is nothing to restore. Drop the
    // index before its column so the statement order reads as the exact inverse
    // of `up` rather than relying on PostgreSQL's implicit cascade.
    await queryRunner.query(
      `ALTER TABLE store_billing_reconciliations
         DROP COLUMN IF EXISTS google_original_transaction_id;`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS uq_users_google_original_transaction_id;`,
    );
    await queryRunner.query(
      `ALTER TABLE users
         DROP COLUMN IF EXISTS google_original_transaction_id;`,
    );
  }
}
