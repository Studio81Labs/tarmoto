import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { subscriptionMutationLockKey } from './store-reconciliation.service.js';

/**
 * The subset of the underlying node-postgres `PoolClient` we rely on to DESTROY a
 * connection whose session advisory lock we could not confirm as released.
 * `release(true)` closes the client's socket and removes it from the pool
 * (instead of returning it), so PostgreSQL drops every session lock the backend
 * held. `queryRunner.connect()` resolves to this client for the pg driver.
 */
interface DestroyableConnection {
  release(destroy?: boolean): void;
}

function isDestroyableConnection(
  connection: unknown,
): connection is DestroyableConnection {
  return (
    typeof connection === 'object' &&
    connection !== null &&
    typeof (connection as DestroyableConnection).release === 'function'
  );
}

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
 *
 * RELEASE SAFETY: because the lock is SESSION-level, returning the connection to
 * the pool releases the lock ONLY if the `pg_advisory_unlock` actually ran. If
 * that unlock query is cancelled or fails (statement timeout, aborted request, a
 * transient error) the lock is STILL HELD on that backend; handing the connection
 * back to the pool would then leak the lock — a later same-rider request blocks
 * on it indefinitely, and enough such retries exhaust the pool. So we return the
 * connection to the pool only after a CONFIRMED unlock; otherwise we DESTROY the
 * connection (`release(true)`), which closes the backend and makes PostgreSQL
 * drop every session lock it held.
 */
@Injectable()
export class SubscriptionMutationLockService {
  private readonly logger = new Logger(SubscriptionMutationLockService.name);

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
    // Capture the raw driver connection so we can DESTROY it if the unlock can't
    // be confirmed (see RELEASE SAFETY in the class doc).
    const connection: unknown = await queryRunner.connect();

    let lockAcquired = false;
    let lockReleased = false;
    try {
      await queryRunner.query('SELECT pg_advisory_lock(hashtext($1))', [
        lockKey,
      ]);
      lockAcquired = true;
      // Run on the reserved connection's manager — see the class doc: the
      // winner must not need a second pool connection.
      return await fn(queryRunner.manager);
    } finally {
      if (lockAcquired) {
        try {
          await queryRunner.query('SELECT pg_advisory_unlock(hashtext($1))', [
            lockKey,
          ]);
          lockReleased = true;
        } catch (err) {
          // Do NOT rethrow from `finally` — that would mask the primary result
          // or error. Log, and fall through to destroy the connection so the
          // (still-held) session lock can't leak into the pool.
          this.logger.error(
            `Advisory unlock for '${lockKey}' failed; destroying the connection so PostgreSQL drops the session lock`,
            err instanceof Error ? err.stack : String(err),
          );
        }
      }

      if (lockAcquired && !lockReleased) {
        this.destroyConnection(connection, lockKey);
      } else {
        // Lock confirmed released (or never acquired) — safe to return the
        // connection to the pool.
        await queryRunner.release();
      }
    }
  }

  /**
   * Destroy the reserved connection instead of returning it to the pool, so a
   * session lock we could not confirm as released is dropped by PostgreSQL when
   * the backend connection closes. Best-effort: if the driver connection doesn't
   * expose a destroying `release`, log loudly rather than silently leak.
   */
  private destroyConnection(connection: unknown, lockKey: string): void {
    if (isDestroyableConnection(connection)) {
      // node-postgres: `release(true)` closes the client and removes it from the
      // pool. Deliberately do NOT also call `queryRunner.release()` — that would
      // double-release the same client.
      connection.release(true);
      return;
    }
    this.logger.error(
      `Could not destroy the connection still holding advisory lock '${lockKey}'; ` +
        'the session lock may persist until the backend connection is recycled',
    );
  }
}
