import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Persist WHEN the Stripe side of a rider's billing state was last actually
 * observed (#1191 release A, overlap machinery).
 *
 * ## Why the column exists
 *
 * The provisional-overlap machinery judges a subscription with an UNKNOWN
 * `current_period_end` as future-billing for a bounded fallback window from
 * its **last observation** — that is what stops an abandoned state from being
 * treated as live forever. The store chains carry that anchor natively
 * (`store_subscriptions.store_signed_date` is written by every event), but the
 * legacy Stripe columns on `users` carry no per-observation timestamp at all.
 *
 * Without one, every reader had to mint "observed now" — honest at a Stripe
 * settle point (the caller just processed a Stripe event or snapshot), but a
 * live regression everywhere else: the hourly deadline sweep re-reads the SAME
 * stale persisted state each pass, and with `observedAt = now` a null-period
 * Stripe subscription whose terminal webhook was lost re-arms its fallback
 * window on every read. The pair it belongs to can then never age out locally
 * (found by review on PR #1284).
 *
 * ## Write/read discipline (enforced in `StoreChainWriterService`)
 *
 * - WRITTEN monotonically (`GREATEST`) by the overlap sync whenever a reading
 *   actually carries a Stripe observation whose subscription id matches the
 *   identity being tracked. Deliberately NOT written by `claimForStripe` — the
 *   observation points that matter to the overlap machinery are exactly the
 *   settle points that run the sync, and the claim writer's heavily-reviewed
 *   transition SQL stays untouched.
 * - READ as the Stripe side's `observedAt` by every reading that did NOT
 *   itself observe Stripe (store-event settle points, the deadline sweep).
 *   Rows predating the column fall back to `users.updated_at` — an
 *   overestimate (any user write advances it), which errs toward keeping a
 *   subscription live longer, never toward retiring a live one.
 *
 * Expand-only; no backfill. A null value means "never observed through the
 * sync layer yet" and the reader's `updated_at` fallback covers it.
 */
export class AddStripeObservationStamp1838000000000 implements MigrationInterface {
  name = 'AddStripeObservationStamp1838000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_stripe_observed_at TIMESTAMPTZ;`,
    );
    await queryRunner.query(
      `COMMENT ON COLUMN users.subscription_stripe_observed_at IS
         'Last time the Stripe side was actually observed by the overlap sync (monotonic); anchors the null-period future-billing fallback. NULL = not yet observed through the sync layer (readers fall back to updated_at).';`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE users DROP COLUMN IF EXISTS subscription_stripe_observed_at;`,
    );
  }
}
