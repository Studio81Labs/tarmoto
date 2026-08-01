import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Monotonic FENCING TOKEN for per-rider subscription mutations.
 *
 * The subscription-mutation lock (`SubscriptionMutationLockService`) serialises a
 * rider's cross-provider flows, but a TTL-based distributed lock can lose its
 * lease under a Redis partition that outlasts the TTL while a critical section is
 * still running — after which another delivery can acquire the key and the stale
 * flow's guarded UPDATEs can still land. The provider/id claim guards do NOT
 * catch this: a newer delivery that CLEARS the row (terminal `deleted`) leaves
 * `subscription_provider`/`stripe_subscription_id` null, which the stale flow's
 * activation UPDATE guard then accepts — resurrecting paid entitlement.
 *
 * This column is the fence: every lock acquisition takes a strictly-monotonic
 * token (a Redis `INCR`), stamps it here on every guarded write, and gates each
 * write on `subscription_lock_fence <= :token`. Once a newer flow (higher token)
 * writes, an older flow's writes match 0 rows and are rejected — so a lease lost
 * mid-flow can never let a stale flow clobber/resurrect a newer flow's state.
 *
 * `NOT NULL DEFAULT 0` so every existing row starts below the first minted token
 * (Redis `INCR` starts at 1); the IAP/lock feature ships dark, so no live flow
 * depends on a backfill.
 */
export class AddSubscriptionLockFence1826000000000 implements MigrationInterface {
  name = 'AddSubscriptionLockFence1826000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE users
         ADD COLUMN subscription_lock_fence BIGINT NOT NULL DEFAULT 0;`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE users
         DROP COLUMN IF EXISTS subscription_lock_fence;`,
    );
  }
}
