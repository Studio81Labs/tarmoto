import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `users.purchase_account_token` — the opaque, backend-issued identifier a
 * rider's device hands to the purchase system, so the store/provider never sees
 * a Tarmoto user id.
 *
 * WHY THIS EXISTS (security, not tidiness). Rider ids are public to other
 * authenticated riders via `PublicProfileDto.id`. If the client passed a Tarmoto
 * user id as RevenueCat's `app_user_id`, a modified client could call
 * `Purchases.logIn(<victim's id>)`, buy, and have RevenueCat emit a **genuinely
 * authentic** webhook binding that purchase to the victim's row — no webhook
 * secret required, and every ingestion guard passes because nothing is forged.
 * Consequences: the victim's own later purchase fails the identity guard (they
 * pay and get nothing), and under some provider transfer settings an active
 * subscription can be moved outright. See open item (j) in
 * `docs/superpowers/specs/2026-08-06-mobile-iap-revenuecat-design.md`.
 *
 * NAMED FOR ITS ROLE, NOT FOR A VENDOR. This column is the successor to the
 * native path's `appAccountToken` (iOS) / `obfuscatedExternalAccountId`
 * (Android) — the app's own account identifier handed to the store — which
 * RevenueCat replaces with `app_user_id`. A vendor-named column would invite a
 * third rename: `google_purchase_token` → `google_store_transaction_id` →
 * `google_original_transaction_id` already happened twice while that code sat
 * unused, and the spec cites it as a real carrying cost. A UUID satisfies both
 * RevenueCat's `app_user_id` and Apple's UUID-typed `appAccountToken`, so a
 * future native path reuses this column instead of adding its own.
 *
 * MINTED LAZILY, NOT BACKFILLED. The column stays NULL until a rider first
 * requests it. `users` is the most contended table in the schema and this runs
 * at container startup during a rolling deploy, so a backfill UPDATE across
 * every row is exactly the write this repo's migration discipline avoids. A
 * NULL therefore means "this rider has never started a purchase", which is the
 * truth and is what the ingestion resolver should see.
 *
 * EXPAND-ONLY. Adds a column and an index; touches nothing existing. The old
 * container serving during the rolling deploy neither reads nor writes it.
 */
export class AddPurchaseAccountToken1832000000000 implements MigrationInterface {
  name = 'AddPurchaseAccountToken1832000000000';

  // `CREATE INDEX CONCURRENTLY` cannot run inside a transaction, so this
  // migration opts out — same pattern as `1831000000000-AddGoogleOriginalTransactionId`.
  //
  // A plain `CREATE UNIQUE INDEX` on `users` takes a lock that blocks writes for
  // the entire build, and this runs at container startup DURING a rolling
  // deploy: registration, profile updates and subscription mutations would all
  // stall for the duration on a populated table.
  //
  // The cost is that the statements below are no longer atomic with each other,
  // so each is written to be idempotent (`IF NOT EXISTS` / `IF EXISTS`) and a
  // re-run after a partial failure converges instead of erroring.
  transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE users
         ADD COLUMN IF NOT EXISTS purchase_account_token UUID;`,
    );
    // Partial unique index: the NULLs on every existing row coexist, while a
    // minted token still enforces one-rider-per-token across rows. Uniqueness is
    // load-bearing — this is the value the ingestion resolver maps back to a
    // rider, so a duplicate would resolve one token to two accounts.
    //
    // The `DROP ... CONCURRENTLY IF EXISTS` first is not redundant with
    // `IF NOT EXISTS` below: an INTERRUPTED concurrent build leaves an INVALID
    // index behind, which `IF NOT EXISTS` treats as already-present and skips,
    // leaving a permanently unusable index that never enforces uniqueness.
    // Dropping first makes a re-run self-heal.
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY IF EXISTS uq_users_purchase_account_token;`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS uq_users_purchase_account_token
         ON users (purchase_account_token)
         WHERE purchase_account_token IS NOT NULL;`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // NOT `DROP INDEX CONCURRENTLY` here, deliberately, even though `up` builds
    // it concurrently: TypeORM's `undoLastMigration` ignores `migration.transaction`
    // and always wraps the down path in a transaction, so a `CONCURRENTLY` drop
    // would fail with 25001. A plain drop is correct here — a rollback is not
    // the latency-sensitive path a rolling deploy is.
    await queryRunner.query(
      `DROP INDEX IF EXISTS uq_users_purchase_account_token;`,
    );
    await queryRunner.query(
      `ALTER TABLE users DROP COLUMN IF EXISTS purchase_account_token;`,
    );
  }
}
