import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Give GRANTS their own storage, separate from subscription entitlement (#1132).
 *
 * ## The problem this is the first step of
 *
 * The `users` row conflates five independent facts, and the damaging overlap is
 * that a founder/promo/admin grant and a paid subscription both live in
 * `subscription_tier`. Every Stripe writer therefore has to re-derive *"is this
 * tier mine to touch?"* — a predicate that reached THREE separate spellings in
 * PR #1131 (`preservesGrant`, `skipOwnership`, `preserveGrant`), each found by a
 * different review round. Six of that PR's eleven rounds were this one cause.
 *
 * With grants in their own columns, entitlement becomes `max(grant,
 * subscription)` and the predicate disappears: a Stripe writer can only ever
 * touch the subscription side, so a failed checkout or a terminal clear cannot
 * destroy a grant no matter what it writes.
 *
 * ## Why now
 *
 * Nothing writes `promo` or `admin` yet — the only grant writer is
 * registration's `founder`. That is why several of the #1131 bugs were latent
 * rather than live. The moment operator grants ship they all become reachable,
 * and this backfill stops being cheap.
 *
 * ## This migration is EXPAND-ONLY and changes no behaviour
 *
 * It adds columns and backfills them from existing grant rows. Those rows keep
 * their `subscription_tier` as-is, so `max(grant, subscription)` returns exactly
 * what `subscription_tier` returned before — the resolver is a no-op on every
 * existing row. Readers move over in a follow-up, and only then does a third
 * change stop writing grants into `subscription_tier` at all.
 *
 * ## The backfill's discriminator, and the trap in it
 *
 * `plan_source IN ('founder','promo','admin')` — NOT "anything that is not
 * `subscription`". Null is deliberately excluded: `PLAN_SOURCES` documents it as
 * "rows predating the column (indistinguishable from `subscription`)", and
 * migration 1796 added the column with no backfill. So a null row is a LEGACY
 * PAID subscriber, and copying it into a grant would make every one of them
 * permanently un-cancellable — an entitlement nothing can revoke.
 *
 * `subscription_tier <> 'free'` because a grant of `free` is not a grant; it
 * would create rows whose grant side can never win the max and only adds noise.
 *
 * ## `grant_granted_at`
 *
 * Included now rather than in a later migration because a grant with no
 * timestamp cannot be reasoned about operationally — "when did this rider get
 * premium, and does it predate the incident?" is the first question support
 * asks. Backfilled from `created_at`, which for the only existing grant source
 * (`founder`, written at registration) is exactly right rather than an
 * approximation; there are no `promo` or `admin` rows to be wrong about.
 */
export class AddGrantEntitlementStorage1836000000000 implements MigrationInterface {
  name = 'AddGrantEntitlementStorage1836000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS grant_tier VARCHAR(16);`,
    );
    await queryRunner.query(
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS grant_source VARCHAR(16);`,
    );
    await queryRunner.query(
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS grant_granted_at TIMESTAMPTZ;`,
    );

    // Both-or-neither. A grant with a tier and no source cannot be audited, and
    // a source with no tier entitles nothing — either shape means a writer got
    // it half-right, and the constraint turns that into a failed write rather
    // than a rider with an unexplainable entitlement.
    // PostgreSQL has no `ADD CONSTRAINT IF NOT EXISTS`, and every other statement
    // here is idempotent — a half-idempotent migration is worse than either,
    // because it fails on exactly the re-run the `IF NOT EXISTS` clauses promise
    // is safe. Guard on the catalog instead.
    await queryRunner.query(
      `DO $$
       BEGIN
         IF NOT EXISTS (
           SELECT 1 FROM pg_constraint WHERE conname = 'users_grant_complete_check'
         ) THEN
           ALTER TABLE users
             ADD CONSTRAINT users_grant_complete_check CHECK (
               (grant_tier IS NULL AND grant_source IS NULL)
               OR (grant_tier IS NOT NULL AND grant_source IS NOT NULL)
             );
         END IF;
       END $$;`,
    );

    // See the header for why NULL `plan_source` is excluded.
    await queryRunner.query(
      `UPDATE users
          SET grant_tier = subscription_tier,
              grant_source = plan_source,
              grant_granted_at = created_at
        WHERE plan_source IN ('founder', 'promo', 'admin')
          AND subscription_tier <> 'free'
          AND grant_tier IS NULL;`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Faithful and lossless: every backfilled value is still derivable from the
    // columns it was copied from, and nothing has been written that only lives
    // here — this migration ships before any writer stops maintaining
    // `subscription_tier`. Drop the constraint first so the column drops are not
    // ordered against it.
    await queryRunner.query(
      `ALTER TABLE users DROP CONSTRAINT IF EXISTS users_grant_complete_check;`,
    );
    await queryRunner.query(
      `ALTER TABLE users DROP COLUMN IF EXISTS grant_granted_at;`,
    );
    await queryRunner.query(
      `ALTER TABLE users DROP COLUMN IF EXISTS grant_source;`,
    );
    await queryRunner.query(
      `ALTER TABLE users DROP COLUMN IF EXISTS grant_tier;`,
    );
  }
}
