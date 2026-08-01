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
import {
  subscriptionMutationLockKey,
  subscriptionOtidLockKey,
} from './store-reconciliation.service.js';

/**
 * How long the Redis lock lives before auto-expiring, so a holder that crashes
 * (or is OOM-killed) mid-critical-section can never wedge the rider's mutations
 * forever. Deliberately generous: comfortably longer than any realistic critical
 * section (a handful of Stripe/Apple round-trips, each ≤ their ~10s client
 * timeout), so a section finishes and releases the lease WELL before it could
 * expire even if EVERY renewal fails (a Redis partition). Renewed every
 * {@link RENEW_INTERVAL_MS} so a pathologically long section still keeps it.
 */
const LOCK_TTL_MS = 60_000;
const RENEW_INTERVAL_MS = 15_000;
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

// DURABLE monotonic fencing-token source: a PostgreSQL sequence (created in the
// fence migration). It MUST be durable + monotonic across restarts — a token
// minted BELOW the persisted `users.subscription_lock_fence` would make every
// guarded UPDATE match 0 rows and misread a valid delivery as a conflict. A
// Redis `INCR` is NOT safe here (a flush/failover can reset it); a WAL-logged
// sequence never reissues a value and lives in the same DB it fences.
const FENCE_SEQUENCE_NAME = 'subscription_lock_fence_seq';

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
 * Handle a critical section uses to FENCE a mutation whose effect can't be undone
 * or CAS-guarded at its target — above all the Stripe compensation writes
 * (`cancelSubscription` / `refundOrVoidLatestInvoice` / `setCancelAtPeriodEnd`),
 * which act on an external system with no fencing token. Call `assertHeld`
 * immediately before EACH such write (not once per group).
 *
 * `assertHeld` ATOMICALLY token-checks AND EXTENDS the lease (a single
 * `GET==token` + `PEXPIRE` Lua): a plain `GET` could observe our token while the
 * TTL is nearly exhausted, leaving too little runway for the following (bounded)
 * Stripe call, so the key could expire mid-call and another delivery acquire it.
 * Resetting the TTL to the full {@link LOCK_TTL_MS} here guarantees a fresh, full
 * window for the one op that follows — and because the Stripe client's own
 * request timeout is bounded well below the TTL, a single op cannot outlast it.
 * A unique-per-run token means a passing check also proves CONTINUOUS ownership
 * since acquisition (had the lease lapsed, another flow could have taken the key
 * and the token would differ), so the decision behind the write was made under
 * uninterrupted serialisation. A lost lease (or a Redis error on the check)
 * throws a retryable 503 and the flow re-runs under a fresh lock rather than
 * compensating on possibly-stale state. DB writes need no such fence — they are
 * already CAS-guarded (`billing_trial_used_at IS NULL`, provider/id exclusivity)
 * AND fenced by {@link SubscriptionLockLease.fenceToken} (see below).
 */
export interface SubscriptionLockLease {
  assertHeld(): Promise<void>;
  /**
   * Strictly-monotonic fencing token minted for THIS lock acquisition (a durable
   * Postgres sequence, so a later acquisition always gets a higher value). Every
   * guarded subscription-row UPDATE must stamp it (`SET subscription_lock_fence =
   * token`) and gate on it (`WHERE subscription_lock_fence <= :token`). If this
   * run's lease is lost mid-flow and a NEWER flow (higher token) writes the row
   * first, this run's later UPDATEs match 0 rows and are rejected at the DB —
   * closing the resurrection/clobber window a lost TTL lease would otherwise
   * reopen, without a Redis round-trip per DB write. Fences the DB writes;
   * `assertHeld` fences the (un-fenceable-at-source) external Stripe writes.
   */
  readonly fenceToken: number;
  /**
   * PUBLISH this holder's fence to the rider's row — call it once the flow has
   * COMMITTED to acting (i.e. AFTER its mutation-free rejects: verification,
   * account binding, foreign-ownership). It is NOT published at lock acquisition,
   * so a request that rejects mutation-free never writes the row (the ownership-
   * conflict contract). Publishing here — unconditionally, before the flow's
   * guarded writes — ensures that even a holder whose writes all end up no-ops
   * (e.g. a terminal redelivery clearing an already-cleared slot) still advances
   * the fence and locks out stale lower-token flows. If a newer holder already
   * published a higher fence (our lease was lost), this throws a retryable 503.
   */
  publishFence(): Promise<void>;
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
    fn: (manager: EntityManager, lease: SubscriptionLockLease) => Promise<T>,
  ): Promise<T> {
    const lockKey = subscriptionMutationLockKey(userId);
    const token = randomUUID();
    await this.acquire(lockKey, token, `user ${userId}`);

    let renewer: ReturnType<typeof setInterval> | undefined;
    try {
      // Start the heartbeat FIRST — before the (DB round-trip) mint below — so the
      // lease is being renewed throughout the mint. Under pool pressure the mint's
      // `SELECT nextval` can wait a long time for a connection; without the
      // heartbeat already running, a slow-enough mint could let the TTL lapse,
      // another replica acquire the key and write with a LOWER token, and this
      // call's later-minted (thus HIGHER) token then clobber it. `unref` so the
      // timer can't by itself keep the process alive.
      renewer = setInterval(() => {
        void this.renew(lockKey, token);
      }, RENEW_INTERVAL_MS);
      if (typeof renewer.unref === 'function') renewer.unref();

      // Mint the FENCING token while holding the lock — the sequence order then
      // equals the lock-acquisition order, so a later acquisition always gets a
      // strictly higher token (the invariant the DB fence relies on).
      const fenceToken = await this.mintFenceToken(userId);

      // BACKSTOP for the slow-mint window: even with the heartbeat, a Redis error
      // during the mint could drop the lease. Atomically re-verify + extend
      // ownership AFTER minting and BEFORE running `fn`; if the lease was lost
      // (another flow may have acquired and minted a lower token), abort with a
      // retryable 503 rather than run a callback whose higher token would clobber
      // the newer state.
      await this.assertHeld(lockKey, token, userId);

      // NOTE: the fence is NOT published here. `fn` calls `lease.publishFence()`
      // itself, AFTER its mutation-free rejects (verification / binding /
      // foreign-ownership), so a request that rejects mutation-free never writes
      // the row — while a committed holder still publishes before its (possibly
      // all-no-op) writes, locking out stale lower-token flows.
      const lease: SubscriptionLockLease = {
        assertHeld: () => this.assertHeld(lockKey, token, userId),
        fenceToken,
        publishFence: () => this.publishFence(userId, fenceToken),
      };

      // Run on the SHARED POOL manager — see the class doc: DB statements each
      // take and release a pooled connection, so none is held across the Stripe /
      // Apple API calls the section makes.
      return await fn(this.dataSource.manager, lease);
    } finally {
      if (renewer) clearInterval(renewer);
      await this.release(lockKey, token);
    }
  }

  /**
   * Serialise Apple `iap/validate` flows that target the SAME
   * `originalTransactionId` across DIFFERENT riders (see
   * {@link subscriptionOtidLockKey}). Taken INSIDE {@link runExclusive} (rider →
   * OTID ordering only — the Stripe flow never takes an OTID lock, so no
   * lock-ordering cycle exists), it makes two riders racing the same OTID run one
   * at a time: the second then sees the first's committed claim in its under-lock
   * ownership read and rejects mutation-free BEFORE publishing its fence.
   *
   * NO fencing token — the rider lease already fences every `users`-row write;
   * this lock only orders the cross-rider read→claim window. Same token-owned +
   * TTL + heartbeat + fail-CLOSED mechanics as the rider lock (the section makes
   * bounded Apple API round-trips, so the heartbeat keeps the lease alive across
   * them, and a Redis outage surfaces a retryable 503 rather than an unserialised
   * cross-rider claim).
   */
  async runExclusiveByOtid<T>(
    originalTransactionId: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const lockKey = subscriptionOtidLockKey(originalTransactionId);
    const token = randomUUID();
    await this.acquire(lockKey, token, 'an Apple transaction');

    let renewer: ReturnType<typeof setInterval> | undefined;
    try {
      renewer = setInterval(() => {
        void this.renew(lockKey, token);
      }, RENEW_INTERVAL_MS);
      if (typeof renewer.unref === 'function') renewer.unref();
      return await fn();
    } finally {
      if (renewer) clearInterval(renewer);
      await this.release(lockKey, token);
    }
  }

  /**
   * Mint a strictly-monotonic fencing token from the DURABLE PostgreSQL sequence
   * (`nextval`) — see {@link FENCE_SEQUENCE_NAME}. Global monotonicity implies the
   * per-rider monotonicity the DB fence needs. Called while holding the rider's
   * lock, so the token order matches the lock-acquisition order. Fail-CLOSED on
   * error: without a fence token we can't safely fence the DB writes, so we
   * surface a retryable 503 rather than mutate unfenced.
   */
  private async mintFenceToken(userId: string): Promise<number> {
    let rows: unknown;
    try {
      rows = await this.dataSource.query(
        `SELECT nextval('${FENCE_SEQUENCE_NAME}') AS token`,
      );
    } catch (err) {
      this.logger.error(
        `Subscription lock fence-token mint failed for user ${userId} (DB error); failing closed`,
        err instanceof Error ? err.stack : String(err),
      );
      throw new ServiceUnavailableException({
        message: 'Subscription service is temporarily unavailable.',
        retryable: true,
      });
    }
    // `nextval` returns bigint, which the driver surfaces as a string.
    const raw = (rows as Array<{ token: string | number }>)[0]?.token;
    const token = Number(raw);
    if (!Number.isFinite(token)) {
      this.logger.error(
        `Subscription lock fence-token mint returned a non-numeric value (${String(raw)}) for user ${userId}; failing closed`,
      );
      throw new ServiceUnavailableException({
        message: 'Subscription service is temporarily unavailable.',
        retryable: true,
      });
    }
    return token;
  }

  /**
   * PUBLISH this holder's fence token to the rider's row up front — unconditional,
   * so even a critical section that ends up doing only no-op writes still advances
   * `subscription_lock_fence`, locking every lower-token (stale) flow out for the
   * rest of this rider's timeline. The guarded bump (`WHERE subscription_lock_fence
   * < :token`) is monotonic. If it affects 0 rows and the row EXISTS, a higher
   * fence is already present — a NEWER holder ran while our lease was lost, so WE
   * are the stale flow: abort with a retryable 503 rather than run `fn`. A missing
   * row is not our concern here (a deleted rider) — `fn`'s own re-read handles it.
   *
   * NOTE: this couples the lock to the `users` table, which is correct — this lock
   * exists solely to serialise mutations of a rider's `users` subscription_* row,
   * keyed by `userId`.
   */
  private async publishFence(userId: string, token: number): Promise<void> {
    let result: unknown;
    try {
      result = await this.dataSource.query(
        `UPDATE users SET subscription_lock_fence = $1
           WHERE id = $2 AND subscription_lock_fence < $1`,
        [token, userId],
      );
    } catch (err) {
      this.logger.error(
        `Subscription lock fence publish failed for user ${userId} (DB error); failing closed`,
        err instanceof Error ? err.stack : String(err),
      );
      throw new ServiceUnavailableException({
        message: 'Subscription service is temporarily unavailable.',
        retryable: true,
      });
    }
    // node-postgres UPDATE via `query` returns `[rows, affectedCount]`.
    const affected = Array.isArray(result)
      ? Number((result as [unknown, number])[1])
      : 0;
    if (affected > 0) return; // published our (highest-so-far) fence

    // 0 rows: either the rider row is gone, or its fence is already >= our token.
    let existsRows: unknown;
    try {
      existsRows = await this.dataSource.query(
        `SELECT 1 FROM users WHERE id = $1`,
        [userId],
      );
    } catch (err) {
      this.logger.error(
        `Subscription lock fence-publish recheck failed for user ${userId} (DB error); failing closed`,
        err instanceof Error ? err.stack : String(err),
      );
      throw new ServiceUnavailableException({
        message: 'Subscription service is temporarily unavailable.',
        retryable: true,
      });
    }
    const rowExists = Array.isArray(existsRows) && existsRows.length > 0;
    if (!rowExists) return; // deleted rider — let `fn`'s re-read handle it
    // Row exists with a fence >= our token: a newer holder already published, so
    // this flow is stale (its lease was lost). Abort before running `fn`.
    this.logger.error(
      `Subscription lock for user ${userId} is stale (a newer holder already published a higher fence); aborting before the callback`,
    );
    throw new ServiceUnavailableException({
      message: 'Subscription service is busy. Please retry shortly.',
      retryable: true,
    });
  }

  /**
   * Atomically confirm this run still owns the lock AND reset its TTL to the full
   * {@link LOCK_TTL_MS}, throwing a retryable 503 if we no longer own it — the
   * fence a critical section calls before EACH unfenceable external write (see
   * {@link SubscriptionLockLease}). The token-checked `PEXPIRE` (same Lua as the
   * heartbeat) both proves ownership and guarantees a fresh full window for the
   * single bounded op that follows; returning anything but 1 means the lease was
   * lost (expired/stolen), and a Redis error means we can't confirm ownership —
   * both fail closed.
   */
  private async assertHeld(
    lockKey: string,
    token: string,
    userId: string,
  ): Promise<void> {
    let result: unknown;
    try {
      result = await this.redis.eval(
        RENEW_LOCK_LUA,
        1,
        lockKey,
        token,
        String(LOCK_TTL_MS),
      );
    } catch (err) {
      this.logger.error(
        `Subscription lock ownership check failed for '${lockKey}' (Redis error); failing closed`,
        err instanceof Error ? err.stack : String(err),
      );
      throw new ServiceUnavailableException({
        message: 'Subscription service is temporarily unavailable.',
        retryable: true,
      });
    }
    if (result !== 1) {
      this.logger.error(
        `Subscription lock for user ${userId} was LOST mid-flow (lease expired/stolen); aborting before the fenced mutation`,
      );
      throw new ServiceUnavailableException({
        message: 'Subscription service is busy. Please retry shortly.',
        retryable: true,
      });
    }
  }

  private async acquire(
    lockKey: string,
    token: string,
    // A non-sensitive display label for logs (`user <id>` for the rider lock, a
    // generic string for the OTID lock — the raw OTID is never logged).
    label: string,
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
          `Subscription lock for ${label} still contended after ${ACQUIRE_TIMEOUT_MS}ms; asking the caller to retry`,
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
