import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * DB-backed lease for the per-rider subscription mutation lock — closes the
 * acquire-to-stamp gap that step 4.75 left open (#1138).
 *
 * ## The gap
 *
 * The fence token comes from `nextval`, which is evaluated when the holder
 * STAMPS, not when it ACQUIRES. A holder that stalls between acquiring the Redis
 * lock and reaching the database — pool starvation is enough — can outlive its
 * TTL, let a successor acquire and stamp, and then stamp a LATER (higher) token.
 * That does not merely make the stale holder look current: its stamp fences out
 * the LIVE holder, whose legitimate guarded writes then match zero rows, possibly
 * after it has already committed a state transition.
 *
 * The post-mint `assertHeld` catches it for the stale flow, which aborts with a
 * 503 — but too late. The damaging write has already landed.
 *
 * ## Why the lease has to live in the database
 *
 * "Token order equals acquisition order" is only true if the token is allocated
 * by the same system that grants acquisition. Today acquisition happens in Redis
 * and allocation in PostgreSQL, so the two are measured by different clocks and
 * a stall between them reorders one against the other.
 *
 * Two ways to make them one clock, and the trade decided this one:
 *
 *  - **Allocate in Redis** (`INCR`). The window closes, but token monotonicity
 *    now depends on Redis counter DURABILITY. A restart that loses the counter
 *    reissues tokens that have already been used, and the fence's equality guard
 *    cannot tell a reissued token from a legitimate one — silent, and it corrupts
 *    ownership.
 *  - **Lease in PostgreSQL** (this migration). Monotonicity stays where it is
 *    already durable, alongside the sequence and the fence column. Cost is one
 *    extra round trip per acquisition, on a path that already makes several.
 *
 * Fail-closed beats fail-silent here, so the lease goes in the row that the
 * fence already lives on: acquisition and allocation become ONE guarded UPDATE
 * on ONE row, and there is no longer an interval between them for anything to
 * happen in.
 *
 * ## Why on `users` and not a lock table
 *
 * `subscription_lock_fence` is already here, and the whole point is that taking
 * the lease and allocating the fence are a single statement. Split across two
 * rows they would need a transaction to stay atomic, which reintroduces the
 * window this exists to remove.
 *
 * Both columns are NULLABLE with no default: an unheld lease is the absence of
 * one, and every existing row starts unheld, so no backfill and no rewrite.
 * Redis stays as the cheap contention gate; correctness now comes from here.
 */
export class AddSubscriptionLockLease1835000000000 implements MigrationInterface {
  name = 'AddSubscriptionLockLease1835000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // The acquirer's opaque token — the SAME value used for the Redis lock, so
    // both layers name one holder and a mismatch is unambiguous. VARCHAR(64)
    // fits a UUID with room to spare; not a FK, not indexed (every read is by
    // the `users` primary key).
    await queryRunner.query(
      `ALTER TABLE users
         ADD COLUMN IF NOT EXISTS subscription_lock_owner VARCHAR(64);`,
    );
    // Absolute expiry rather than an acquired-at timestamp: the takeover
    // predicate is then a plain `<= now()` comparison the database evaluates
    // itself, with no clock arithmetic in application code and no dependence on
    // the app server's clock agreeing with PostgreSQL's.
    await queryRunner.query(
      `ALTER TABLE users
         ADD COLUMN IF NOT EXISTS subscription_lock_lease_expires_at TIMESTAMPTZ;`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Faithful inverse. Dropping the lease cannot lose anything durable: it is
    // transient coordination state whose only steady value is NULL, and the
    // fence column it guards is untouched.
    await queryRunner.query(
      `ALTER TABLE users
         DROP COLUMN IF EXISTS subscription_lock_lease_expires_at;`,
    );
    await queryRunner.query(
      `ALTER TABLE users DROP COLUMN IF EXISTS subscription_lock_owner;`,
    );
  }
}
