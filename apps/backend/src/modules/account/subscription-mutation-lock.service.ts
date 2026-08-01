import {
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { SUBSCRIPTION_LOCK_REDIS } from './subscription-lock-redis.js';
import { subscriptionMutationLockKey } from './store-reconciliation.service.js';

/**
 * How long the Redis lock lives before auto-expiring, so a holder that crashes
 * (or is OOM-killed) mid-critical-section can never wedge the rider's mutations
 * forever. Renewed every {@link RENEW_INTERVAL_MS} while the section runs, so a
 * legitimately slow section (multiple Stripe/Apple round-trips) keeps the lock.
 */
const LOCK_TTL_MS = 30_000;
const RENEW_INTERVAL_MS = 10_000;
/**
 * Max time a waiter polls for the lock before giving up with a retryable 503.
 * Same-rider subscription mutations are rare and the critical section is usually
 * fast, so real contention resolves well within this; the cap just bounds the
 * wait so a stuck holder can't hang a request indefinitely (the caller/Stripe
 * retries).
 */
const ACQUIRE_TIMEOUT_MS = 15_000;
const ACQUIRE_POLL_MIN_MS = 25;
const ACQUIRE_POLL_MAX_MS = 200;

// Extend the lock's TTL, but ONLY while we still own it (token match) — a
// token-checked PEXPIRE, never a blind one, so a renew that races the holder's
// own release (or a TTL-lapse + re-acquire by another flow) can't extend a lock
// we no longer hold.
const RENEW_LOCK_LUA = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('pexpire', KEYS[1], ARGV[2])
else
  return 0
end`;

// Release the lock, but ONLY if we still own it (del-if-token-matches, never a
// blind DEL) — so a holder whose TTL lapsed mid-section can't delete a lock a
// later flow has since acquired.
const RELEASE_LOCK_LUA = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
else
  return 0
end`;

/**
 * Serialises a rider's subscription-mutation flows so concurrent cross-provider
 * deliveries (an Apple `iap/validate` and a Stripe `customer.subscription.*`
 * webhook, or two webhooks) can't interleave their read→decide→write steps.
 *
 * Each flow does several statements — trial-eligibility check, exclusivity
 * claim, terminal-ordering, snapshot — that are individually guarded but not
 * atomic as a group. Concurrent flows for the SAME rider could interleave those
 * steps and, e.g., let both a Stripe and an Apple trial consume the
 * once-per-rider marker. Wrapping each flow in a per-rider lock makes them
 * mutually exclusive: the second flow blocks until the first releases.
 *
 * CRITICAL — why a REDIS lock, not a PostgreSQL advisory lock: the flow does
 * external I/O (Stripe / Apple API calls) INSIDE the critical section so its
 * read→decide→write is atomic against fresh store state. A PG advisory lock is
 * held on a DB connection; holding one across those network round-trips ties up
 * a pooled connection while waiting on the store, and same-rider WAITERS blocked
 * in `pg_advisory_lock` each hold their own connection too — enough concurrent
 * deliveries then exhaust the pool and stall unrelated traffic. A Redis lock
 * holds NO DB connection: waiters poll Redis holding nothing, and the winner
 * runs its DB work on the shared POOL manager (a connection acquired and
 * released per statement, none held across an API call). So the section stays
 * atomic AND never pins a DB connection.
 *
 * The lock is token-owned (`SET NX PX` with a per-run UUID), TTL'd so a crashed
 * holder self-heals, and renewed on a heartbeat while the section runs; release
 * and renew are token-checked Lua so they only ever act on a lock this run still
 * holds. Fail-CLOSED: if Redis is unreachable we surface a retryable 503 rather
 * than mutate subscription state unserialised.
 */
@Injectable()
export class SubscriptionMutationLockService {
  private readonly logger = new Logger(SubscriptionMutationLockService.name);

  constructor(
    @Inject(SUBSCRIPTION_LOCK_REDIS)
    private readonly redis: Redis,
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async runExclusive<T>(
    userId: string,
    fn: (manager: EntityManager) => Promise<T>,
  ): Promise<T> {
    const lockKey = subscriptionMutationLockKey(userId);
    const token = randomUUID();
    await this.acquire(lockKey, token, userId);

    // Heartbeat: extend the TTL while the (possibly multi-round-trip) section
    // runs, so a slow-but-live section never lapses. `unref` so the timer can't
    // by itself keep the process alive.
    const renewer = setInterval(() => {
      void this.renew(lockKey, token);
    }, RENEW_INTERVAL_MS);
    if (typeof renewer.unref === 'function') renewer.unref();

    try {
      // Run on the SHARED POOL manager — see the class doc: DB statements each
      // take and release a pooled connection, so none is held across the Stripe /
      // Apple API calls the section makes.
      return await fn(this.dataSource.manager);
    } finally {
      clearInterval(renewer);
      await this.release(lockKey, token);
    }
  }

  private async acquire(
    lockKey: string,
    token: string,
    userId: string,
  ): Promise<void> {
    const deadline = Date.now() + ACQUIRE_TIMEOUT_MS;
    for (;;) {
      let acquired: string | null;
      try {
        acquired = await this.redis.set(
          lockKey,
          token,
          'PX',
          LOCK_TTL_MS,
          'NX',
        );
      } catch (err) {
        // Fail CLOSED — without serialisation we must not mutate subscription
        // state (the once-per-rider trial marker / cross-provider exclusivity
        // could be violated). Surface a retryable 503 so the caller/Stripe
        // retries once Redis recovers.
        this.logger.error(
          `Subscription lock acquire failed for '${lockKey}' (Redis error)`,
          err instanceof Error ? err.stack : String(err),
        );
        throw new ServiceUnavailableException({
          message: 'Subscription service is temporarily unavailable.',
          retryable: true,
        });
      }
      if (acquired === 'OK') return;
      if (Date.now() >= deadline) {
        this.logger.warn(
          `Subscription lock for user ${userId} still contended after ${ACQUIRE_TIMEOUT_MS}ms; asking the caller to retry`,
        );
        throw new ServiceUnavailableException({
          message: 'Subscription service is busy. Please retry shortly.',
          retryable: true,
        });
      }
      await sleep(jitteredBackoff());
    }
  }

  private async renew(lockKey: string, token: string): Promise<void> {
    try {
      await this.redis.eval(
        RENEW_LOCK_LUA,
        1,
        lockKey,
        token,
        String(LOCK_TTL_MS),
      );
    } catch (err) {
      // Best-effort: a failed renew just risks an early TTL lapse (the section
      // may then run unprotected), which is no worse than the pre-lock behaviour
      // and self-heals; never fail the flow on a renew hiccup.
      this.logger.warn(
        `Subscription lock renew failed for '${lockKey}': ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  private async release(lockKey: string, token: string): Promise<void> {
    try {
      await this.redis.eval(RELEASE_LOCK_LUA, 1, lockKey, token);
    } catch (err) {
      // Best-effort: the TTL is the backstop if release can't reach Redis.
      this.logger.warn(
        `Subscription lock release failed for '${lockKey}': ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jitteredBackoff(): number {
  return (
    ACQUIRE_POLL_MIN_MS +
    Math.floor(Math.random() * (ACQUIRE_POLL_MAX_MS - ACQUIRE_POLL_MIN_MS))
  );
}
