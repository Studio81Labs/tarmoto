import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { subscriptionMutationLockKey } from './store-reconciliation.service.js';

/**
 * Serialises a rider's subscription-mutation flows so concurrent cross-provider
 * deliveries (an Apple `iap/validate` and a Stripe `customer.subscription.*`
 * webhook, or two webhooks) can't interleave their read→decide→write steps.
 *
 * Each flow does several statements — trial-eligibility check, exclusivity
 * claim, terminal-ordering, snapshot — that are individually guarded but not
 * atomic as a group. Concurrent flows for the SAME rider could interleave those
 * steps and, e.g., let both a Stripe and an Apple trial consume the
 * once-per-rider marker. Wrapping each flow in a per-rider SESSION-level
 * advisory lock (`pg_advisory_lock(hashtext('sub-mut:<userId>'))`) makes them
 * mutually exclusive: the second flow blocks until the first releases.
 *
 * CRITICAL — connection discipline (why `fn` receives a manager): the lock is
 * held on a dedicated reserved connection, and `fn` MUST run ALL its DB work on
 * that SAME connection via the {@link EntityManager} passed to it. If `fn`
 * instead reached for the normal pool, the lock winner would need a SECOND
 * connection while same-rider waiters sit blocked in `pg_advisory_lock` holding
 * their own reserved connections — under pool pressure that deadlocks the pool
 * and starves unrelated traffic. Running `fn`'s work on the reserved connection
 * means the winner needs NO extra connection, so it always makes progress and
 * drains the waiters one by one. A SESSION lock (not `xact`) is used so the flow
 * can hold it across its slow external calls (Apple / Stripe APIs) WITHOUT
 * keeping a DB transaction open across the network — each statement on the
 * reserved connection autocommits; the connection is merely idle (holding the
 * session lock) during an API call. Mirrors
 * `AccountDeletionService.restoreAccount`'s acquire-on-a-dedicated-connection /
 * release-in-`finally` discipline so a throw can never leak the lock.
 */
@Injectable()
export class SubscriptionMutationLockService {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async runExclusive<T>(
    userId: string,
    fn: (manager: EntityManager) => Promise<T>,
  ): Promise<T> {
    const lockKey = subscriptionMutationLockKey(userId);
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();

    let lockAcquired = false;
    try {
      await queryRunner.query('SELECT pg_advisory_lock(hashtext($1))', [
        lockKey,
      ]);
      lockAcquired = true;
      // Run on the reserved connection's manager — see the class doc: the
      // winner must not need a second pool connection.
      return await fn(queryRunner.manager);
    } finally {
      try {
        if (lockAcquired) {
          await queryRunner.query('SELECT pg_advisory_unlock(hashtext($1))', [
            lockKey,
          ]);
        }
      } finally {
        await queryRunner.release();
      }
    }
  }
}
