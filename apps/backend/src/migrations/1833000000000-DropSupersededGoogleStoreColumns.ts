import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * CONTRACT half of the Google store-identity expand/contract — open item (e) in
 * `docs/superpowers/specs/2026-08-06-mobile-iap-revenuecat-design.md`.
 *
 * Three generations of the same column shipped, each expand-only so a rolling
 * Coolify update never served a container reading a column that had been
 * renamed out from under it:
 *
 *  1. `google_purchase_token`        (migration 1822) — never held a purchase
 *     token; the name asserted something untrue about its contents.
 *  2. `google_store_transaction_id`  (migration 1830) — the CURRENT period's
 *     transaction, which advances on every renewal, so binding on it would make
 *     the identity guard reject every renewal after the first.
 *  3. `google_original_transaction_id` (migration 1831) — the identifier stable
 *     for the subscription's whole lifetime. **The only one an entity maps.**
 *
 * This drops generations 1 and 2 — six objects, unmapped and NULL in every row —
 * leaving generation 3. Each index goes before its column so the statement order
 * reads as the exact inverse of the expands rather than relying on PostgreSQL's
 * implicit cascade.
 *
 * ## Why this can run now, and why it is transactional
 *
 * (e) gated this on migration 1831's release being deployed and no longer a
 * rollback target. The app has never been deployed to staging or production, so
 * there is no release to roll back to and no old container to keep serving —
 * the gate is satisfied vacuously.
 *
 * That also lets this be an ordinary TRANSACTIONAL migration, unlike 1830/1831
 * which had to set `transaction = false` for `CREATE INDEX CONCURRENTLY` and
 * then make every statement individually idempotent to survive a partial
 * failure. Dropping an index is fast and there is no live traffic to block, so
 * atomic-all-or-nothing is strictly better here than concurrent-but-piecewise.
 * Do not copy the `transaction = false` pattern from the expand migrations into
 * contract migrations by reflex; it buys nothing without concurrent index builds
 * and costs atomicity.
 */
export class DropSupersededGoogleStoreColumns1833000000000 implements MigrationInterface {
  name = 'DropSupersededGoogleStoreColumns1833000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Generation 1 — `google_purchase_token` (1822).
    await queryRunner.query(
      `DROP INDEX IF EXISTS uq_users_google_purchase_token;`,
    );
    await queryRunner.query(
      `ALTER TABLE users DROP COLUMN IF EXISTS google_purchase_token;`,
    );
    await queryRunner.query(
      `ALTER TABLE store_billing_reconciliations
         DROP COLUMN IF EXISTS google_purchase_token;`,
    );

    // Generation 2 — `google_store_transaction_id` (1830).
    await queryRunner.query(
      `DROP INDEX IF EXISTS uq_users_google_store_transaction_id;`,
    );
    await queryRunner.query(
      `ALTER TABLE users DROP COLUMN IF EXISTS google_store_transaction_id;`,
    );
    await queryRunner.query(
      `ALTER TABLE store_billing_reconciliations
         DROP COLUMN IF EXISTS google_store_transaction_id;`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Faithful inverse: both generations were NULL in every row, so recreating
    // the nullable columns and their partial unique indexes restores the schema
    // exactly. No data is reconstructed because none existed.
    await queryRunner.query(
      `ALTER TABLE users
         ADD COLUMN IF NOT EXISTS google_store_transaction_id VARCHAR(1024);`,
    );
    await queryRunner.query(
      `ALTER TABLE store_billing_reconciliations
         ADD COLUMN IF NOT EXISTS google_store_transaction_id VARCHAR(1024);`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_users_google_store_transaction_id
         ON users (google_store_transaction_id)
         WHERE google_store_transaction_id IS NOT NULL;`,
    );

    await queryRunner.query(
      `ALTER TABLE users
         ADD COLUMN IF NOT EXISTS google_purchase_token VARCHAR(1024);`,
    );
    await queryRunner.query(
      `ALTER TABLE store_billing_reconciliations
         ADD COLUMN IF NOT EXISTS google_purchase_token VARCHAR(1024);`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_users_google_purchase_token
         ON users (google_purchase_token)
         WHERE google_purchase_token IS NOT NULL;`,
    );
  }
}
