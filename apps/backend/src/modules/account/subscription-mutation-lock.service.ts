import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
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
 * mutually exclusive: the second flow blocks until the first releases, so their
 * statements can no longer interleave. The lock is a coarse mutex around the
 * whole flow — the flow's own queries still run on pooled connections; the lock
 * only gates concurrent ENTRY — so it needs no transactional-manager threading
 * through the shared claim/reconciliation services.
 *
 * Mirrors the session-lock acquire/release discipline of
 * `AccountDeletionService.restoreAccount`: a dedicated connection holds the lock
 * for the whole flow and releases it in `finally` (before releasing the runner)
 * so a throw can never leak the lock.
 */
@Injectable()
export class SubscriptionMutationLockService {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async runExclusive<T>(userId: string, fn: () => Promise<T>): Promise<T> {
    const lockKey = subscriptionMutationLockKey(userId);
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();

    let lockAcquired = false;
    try {
      await queryRunner.query('SELECT pg_advisory_lock(hashtext($1))', [
        lockKey,
      ]);
      lockAcquired = true;
      return await fn();
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
