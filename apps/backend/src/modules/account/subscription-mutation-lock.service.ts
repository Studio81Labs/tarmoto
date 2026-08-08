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
import { firstReturnedRow } from './provider-claim.service.js';
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
   * Assert this holder is STILL current — both leases — and abort with a
   * retryable 503 if not. Call it before doing expensive work (an external
   * re-query) or before a sequence of guarded writes, so a holder that already
   * lost its lease stops early instead of doing the work and failing at its
   * first write.
   *
   * Checks the Redis lease (token-checked PEXPIRE, which also resets the TTL for
   * the window that follows) and then the DB fence: a strictly higher stored
   * fence means a newer holder has acquired, which only happens if this lease
   * was lost.
   *
   * **This replaced `publishFence()` (#1138).** That method also STAMPED the
   * fence, which is now done at lock acquisition — so publishing had become a
   * no-op rewrite of the row's existing value, and its `< token` guard rejected
   * the legitimate holder until it was relaxed. What remains worth calling is
   * the check, so only the check survives. Nothing here writes.
   */
  assertFenceCurrent(): Promise<void>;
}

/**
 * Handle for the OTID-scoped lock (see {@link
 * SubscriptionMutationLockService.runExclusiveByOtid}). Unlike the rider lease it
 * carries NO fence token — the rider lease fences every `users`-row write; this
 * lock ORDERS the cross-rider read→claim window.
 *
 * Call `assertHeld` immediately before the OTID claim, so a flow whose lease
 * lapsed mid-critical-section (renewals silently failing until the TTL expired
 * during a slow store API call, letting ANOTHER rider acquire this same OTID
 * lock) aborts with a retryable 503 rather than losing the unique-index race
 * after mutating — the mutation-before-ownership-409 window this lock exists to
 * close. A unique-per-run token means a passing check proves continuous ownership
 * *up to that instant*: had the lease lapsed, another rider's token would be
 * present, so the under-lock ownership read that preceded it was made under the
 * same uninterrupted serialisation.
 *
 * ⚠️ But `assertHeld` is a PRE-FLIGHT CHECK, NOT THE GUARANTEE, and an earlier
 * revision of this comment called it "the only guard it needs". It is not: the
 * check says nothing about the interval AFTER it returns. The lease can lapse
 * between the assertion and the claim — a stalled statement is enough — after
 * which a stale callback can still reach its transaction first and bind the
 * identity to the wrong rider. A second assertion afterwards does not help
 * either; it would detect the loss only once the write had happened. No number
 * of TTL checks makes a multi-statement sequence atomic.
 *
 * The guarantee has to be continuously valid, which means the database. The
 * mechanism is deliberately NOT fixed here: see §4's OTID-ordering correction in
 * `docs/superpowers/specs/2026-08-06-mobile-iap-revenuecat-design.md`, which
 * carries two candidates (a durable per-OTID generation, or exclusion-only with
 * the loser re-deriving) and assigns the choice to step 4.75's real-Postgres
 * concurrency harness rather than to prose. Do not build the store consumer's
 * claim against this lease check alone.
 */
export interface SubscriptionOtidLockLease {
  assertHeld(): Promise<void>;
}

/**
 * Serialises a rider's subscription-mutation flows so concurrent cross-provider
 * deliveries (a store-ingestion flow landing an Apple/Google purchase and a
 * Stripe `customer.subscription.*` webhook, or two webhooks) can't interleave
 * their read→decide→write steps.
 *
 * Each flow does several statements — trial-eligibility check, exclusivity
 * claim, terminal-ordering, snapshot — that are individually guarded but not
 * atomic as a group. Concurrent flows for the SAME rider could interleave those
 * steps and, e.g., let both a Stripe and a store trial consume the
 * once-per-rider marker. Wrapping each flow in a per-rider lock makes them
 * mutually exclusive: the second flow blocks until the first releases.
 *
 * CRITICAL — why a REDIS lock, not a PostgreSQL advisory lock: the flow does
 * external I/O (Stripe / store API calls) INSIDE the critical section so its
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
      // Start the heartbeat FIRST, before the DB round trip below, so BOTH leases
      // are being renewed throughout it. Under pool pressure the acquisition
      // statement can wait a long time for a connection, and a slow-enough one
      // would otherwise let the TTL lapse mid-acquisition. `unref` so the timer
      // can't by itself keep the process alive.
      renewer = setInterval(() => {
        void this.renew(lockKey, token);
        void this.renewLease(userId, token);
      }, RENEW_INTERVAL_MS);
      if (typeof renewer.unref === 'function') renewer.unref();

      // Take the DB LEASE and allocate the FENCING token in one guarded
      // statement. Because one system decides both, sequence order equals
      // acquisition order by construction — a later acquisition always gets a
      // strictly higher token, and a STALLED acquirer resuming while a live
      // successor holds the lease matches zero rows and throws instead of
      // stamping. That last part is what the pre-#1138 split could not do.
      const fenceToken = await this.mintFenceToken(userId, token);

      // BACKSTOP for the slow-acquisition window: a Redis error during it could
      // drop the Redis half of the lease even though the DB half was taken.
      // Atomically re-verify + extend ownership BEFORE running `fn`; if it was
      // lost, abort with a retryable 503 rather than run the callback.
      await this.assertHeld(lockKey, token, `user ${userId}`);

      // The fence is already stamped — `mintFenceToken` above did it as part of
      // acquisition (#1138), so the row names this holder from the moment the
      // lease exists. Callbacks no longer publish; they assert.
      const lease: SubscriptionLockLease = {
        assertHeld: () => this.assertHeld(lockKey, token, `user ${userId}`),
        fenceToken,
        assertFenceCurrent: async () => {
          // Redis first: the token-checked PEXPIRE proves CONTINUOUS ownership
          // since acquisition (a lapsed lease would show another run's token) and
          // resets the TTL for the window that follows.
          await this.assertHeld(lockKey, token, `user ${userId}`);
          // Then the DB, which catches the case Redis cannot: a newer holder has
          // acquired and stamped, so our lease is gone even if the key still
          // looks like ours.
          await this.assertFenceCurrent(userId, fenceToken);
        },
      };

      // Run on the SHARED POOL manager — see the class doc: DB statements each
      // take and release a pooled connection, so none is held across the Stripe /
      // Apple API calls the section makes.
      return await fn(this.dataSource.manager, lease);
    } finally {
      if (renewer) clearInterval(renewer);
      // Release BOTH halves. The DB lease is released even when acquisition threw
      // (a stalled acquirer refused by the guard), which is safe precisely because
      // both statements are owner-guarded: if we never held it, or were taken
      // over, they match nothing and the live holder is untouched.
      await this.release(lockKey, token);
      await this.releaseLease(userId, token);
    }
  }

  /**
   * Serialise store-ingestion flows that claim the SAME store
   * `original_transaction_id` for DIFFERENT riders (see
   * {@link subscriptionOtidLockKey}).
   *
   * **Provider-neutral: Apple AND Google claims must both take this.** The doc
   * said "Apple" until 2026-08-07 — true of the deleted native path, and a trap
   * now that `google_original_transaction_id` has its own partial unique index and
   * the identical cross-rider race. Omitting it on the Google claim reintroduces
   * exactly the race this method exists to close.
   *
   * Taken INSIDE {@link runExclusive} (rider →
   * OTID ordering only — the Stripe flow never takes an OTID lock, so no
   * lock-ordering cycle exists), it makes two riders racing the same OTID run one
   * at a time **while both leases hold**: the second then sees the first's
   * committed claim in its under-lock ownership read and rejects mutation-free.
   *
   * ⚠️ PREFLIGHT EXCLUSION, NOT DURABLE ORDERING — and this comment asserted the
   * latter until 2026-08-07. A TTL lease can lapse between the ownership read and
   * the claim, letting a stale callback reach its transaction ahead of the live
   * holder and bind the identity to the wrong rider; {@link
   * SubscriptionOtidLockLease} carries the full argument. The durable mechanism is
   * chosen by step 4.75's concurrency harness, not here — see the OTID-ordering
   * correction in `docs/superpowers/specs/2026-08-06-mobile-iap-revenuecat-design.md`.
   *
   * NO fencing token — the rider lease already fences every `users`-row write;
   * this lock only orders the cross-rider read→claim window. Same token-owned +
   * TTL + heartbeat + fail-CLOSED mechanics as the rider lock (the section makes
   * bounded store API round-trips, so the heartbeat keeps the lease alive across
   * them, and a Redis outage surfaces a retryable 503 rather than an unserialised
   * cross-rider claim).
   *
   * NO CALLER TODAY — see {@link subscriptionOtidLockKey}'s note: the native
   * Apple validate flow that took this lock is deleted, and its replacement will
   * need the same ordering.
   */
  async runExclusiveByOtid<T>(
    originalTransactionId: string,
    fn: (lease: SubscriptionOtidLockLease) => Promise<T>,
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
      const lease: SubscriptionOtidLockLease = {
        assertHeld: () =>
          this.assertHeld(lockKey, token, 'an Apple transaction'),
      };
      return await fn(lease);
    } finally {
      if (renewer) clearInterval(renewer);
      await this.release(lockKey, token);
    }
  }

  /**
   * Mint a strictly-monotonic fencing token from the DURABLE PostgreSQL sequence
   * (`nextval`) — see {@link FENCE_SEQUENCE_NAME} — **and STAMP it on the rider's
   * row in the same statement**. Fail-CLOSED on error: without a fence token we
   * can't safely fence the DB writes, so we surface a retryable 503 rather than
   * mutate unfenced.
   *
   * ## Why the stamp is here and not at first write (#1138)
   *
   * This used to be a bare `SELECT nextval(...)`, which minted a token without
   * touching the row. `users.subscription_lock_fence` therefore named *the last
   * holder that got as far as writing*, not the current one — so a holder whose
   * lease lapsed could still commit, because nothing had raised the stored fence
   * above its token.
   *
   * {@link assertSubscriptionFenceCurrent} could not catch it either. Its premise
   * is that `fence > token` implies a lost lease "because only the lock holder
   * ever publishes a fence" — true, but a successor that has not written yet has
   * published nothing, so the lost lease was undetectable in exactly that window.
   * Stamping at acquisition closes it: from the moment a new holder has its
   * lease, the row already carries that holder's token, and the prior holder's
   * `fence <= :token` guard fails on every subsequent write.
   *
   * Covered by `test/subscription-fence-ownership.e2e-spec.ts` case (i), against
   * real PostgreSQL and Redis — the only place this is observable.
   *
   * ## What this does NOT close, deliberately recorded
   *
   * Redis acquisition and this UPDATE are two systems and cannot be made atomic.
   * A holder that stalls BETWEEN acquiring and stamping, long enough to lose its
   * lease, will stamp a LATER (higher) token than its successor and so appear
   * current. The window is one DB round trip with the heartbeat already running,
   * versus the previous window which spanned the flow's entire external I/O — but
   * it is not zero, and closing it would mean making PostgreSQL the ownership
   * authority instead of Redis, which the class doc explains this design rejects
   * on connection-pool grounds. See §4's acquisition-stamping correction in
   * `docs/superpowers/specs/2026-08-06-mobile-iap-revenuecat-design.md`.
   */
  /**
   * Is the rider's lease held by a LIVE holder that is not us?
   *
   * Only called when the acquisition UPDATE matched nothing, to separate its two
   * causes: a live foreign lease (refuse, retryably) from a deleted rider (let
   * the caller's own early-out handle it). Getting that backwards would either
   * turn every ordinary deletion into a retry loop, or let a stalled acquirer
   * treat a live successor as a missing rider.
   */
  private async leaseHeldByAnother(
    userId: string,
    owner: string,
  ): Promise<boolean> {
    const rows: unknown = await this.dataSource.query(
      `SELECT 1
         FROM users
        WHERE id = $1
          AND subscription_lock_owner IS NOT NULL
          AND subscription_lock_owner <> $2
          AND subscription_lock_lease_expires_at > now()
        LIMIT 1`,
      [userId, owner],
    );
    return firstReturnedRow<unknown>(rows) !== undefined;
  }

  /**
   * Extend our lease, from the same heartbeat that renews the Redis lock.
   *
   * Guarded on ownership, so a flow whose lease has already been taken over
   * cannot resurrect it. Best-effort by design: a failure here is not fatal
   * because the lease simply lapses, which is the safe direction — the same
   * reason {@link renew} swallows its errors.
   */
  private async renewLease(userId: string, owner: string): Promise<void> {
    try {
      await this.dataSource.query(
        `UPDATE users
            SET subscription_lock_lease_expires_at = now() + ($3::text)::interval
          WHERE id = $1 AND subscription_lock_owner = $2`,
        [userId, owner, `${LOCK_TTL_MS} milliseconds`],
      );
    } catch (err) {
      this.logger.warn(
        `Subscription lock lease renewal failed for user ${userId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Release our lease so the next acquirer does not have to wait out a TTL that
   * nobody is using.
   *
   * Guarded on ownership: if we were taken over, the clause matches nothing and
   * we leave the new holder's lease alone. The FENCE is deliberately NOT reset —
   * it is the high-water mark that keeps a later flow from being clobbered by an
   * earlier one, and clearing it would undo exactly what it is for.
   */
  private async releaseLease(userId: string, owner: string): Promise<void> {
    try {
      await this.dataSource.query(
        `UPDATE users
            SET subscription_lock_owner = NULL,
                subscription_lock_lease_expires_at = NULL
          WHERE id = $1 AND subscription_lock_owner = $2`,
        [userId, owner],
      );
    } catch (err) {
      this.logger.warn(
        `Subscription lock lease release failed for user ${userId} (it will lapse): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async mintFenceToken(userId: string, owner: string): Promise<number> {
    let rows: unknown;
    try {
      // ONE statement takes the LEASE and allocates the FENCE. That is the whole
      // point: "token order equals acquisition order" only holds if one system
      // decides both, and before #1138 acquisition was Redis while allocation was
      // PostgreSQL. A holder stalling between them could outlive its TTL and then
      // allocate a HIGHER token than its successor, fencing out the live holder.
      // Here there is no between.
      //
      // The WHERE takes the lease only when it is genuinely available:
      //   - nobody holds it, or
      //   - we already do (re-entry / retry after a partial failure), or
      //   - the previous holder's lease has lapsed.
      // A stalled acquirer resuming while a live successor holds the lease
      // matches ZERO rows and therefore never stamps.
      //
      // Zero rows now has TWO causes, so the caller must not read it as "rider
      // deleted" the way it could before: `leaseHeldByAnother` disambiguates.
      rows = await this.dataSource.query(
        `UPDATE users
            SET subscription_lock_fence = nextval('${FENCE_SEQUENCE_NAME}'),
                subscription_lock_owner = $2,
                subscription_lock_lease_expires_at = now() + ($3::text)::interval
          WHERE id = $1
            AND (subscription_lock_owner IS NULL
              OR subscription_lock_owner = $2
              OR subscription_lock_lease_expires_at IS NULL
              OR subscription_lock_lease_expires_at <= now())
      RETURNING subscription_lock_fence AS token`,
        [userId, owner, `${LOCK_TTL_MS} milliseconds`],
      );
      // `UPDATE ... RETURNING` comes back as `[rows, affectedCount]`; normalise
      // before deciding why it matched nothing.
      if (firstReturnedRow<{ token: string | number }>(rows) === undefined) {
        if (await this.leaseHeldByAnother(userId, owner)) {
          // Someone else holds a LIVE lease. We are the stalled acquirer this
          // guard exists for: refuse, retryably, having written nothing.
          this.logger.warn(
            `Subscription lock lease for user ${userId} is held by another flow; refusing to stamp a stale fence`,
          );
          throw new ServiceUnavailableException({
            message: 'Subscription service is temporarily unavailable.',
            retryable: true,
          });
        }
        // No live lease and still no row: the rider was deleted mid-flow. Yield a
        // bare token so the caller's own early-out reports the deletion, rather
        // than failing closed on a rider that no longer exists.
        rows = await this.dataSource.query(
          `SELECT nextval('${FENCE_SEQUENCE_NAME}') AS token`,
        );
      }
    } catch (err) {
      // Already the right answer — do not relabel it as a DB failure below.
      if (err instanceof ServiceUnavailableException) throw err;
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
    const raw = firstReturnedRow<{ token: string | number }>(rows)?.token;
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
   * Throw a retryable 503 if a NEWER holder has acquired the rider's lock.
   *
   * Replaces the old `publishFence`, which did an `UPDATE ... SET
   * subscription_lock_fence` plus an existence recheck. Since #1138 stamps the
   * fence at acquisition, that write had become a no-op rewrite of the row's own
   * value — and its `< token` guard rejected the legitimate holder until it was
   * relaxed to `<=`. The only part still worth doing is the check, so this reads
   * and never writes.
   *
   * A strictly higher stored fence can only mean another acquisition happened
   * after ours, i.e. our lease was lost. A missing row is NOT our concern: the
   * caller's own logic early-outs on a deleted rider, and failing closed here
   * would turn an ordinary deletion into a retry loop.
   */
  private async assertFenceCurrent(
    userId: string,
    token: number,
  ): Promise<void> {
    let rows: unknown;
    try {
      rows = await this.dataSource.query(
        `SELECT 1 FROM users WHERE id = $1 AND subscription_lock_fence > $2`,
        [userId, token],
      );
    } catch (err) {
      this.logger.error(
        `Subscription lock fence check failed for user ${userId} (DB error); failing closed`,
        err instanceof Error ? err.stack : String(err),
      );
      throw new ServiceUnavailableException({
        message: 'Subscription service is temporarily unavailable.',
        retryable: true,
      });
    }
    if (Array.isArray(rows) && rows.length > 0) {
      this.logger.warn(
        `Subscription lock fence for user ${userId} is ahead of token ${token}; a newer holder acquired — aborting as retryable`,
      );
      throw new ServiceUnavailableException({
        message: 'Subscription service is busy. Please retry shortly.',
        retryable: true,
      });
    }
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
    // A non-sensitive display label for logs (`user <id>` for the rider lock, a
    // generic string for the OTID lock — the raw OTID is never logged).
    label: string,
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
        `Subscription lock for ${label} was LOST mid-flow (lease expired/stolen); aborting before the fenced mutation`,
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
