import { ServiceUnavailableException } from '@nestjs/common';
import type { Redis } from 'ioredis';
import type { DataSource, EntityManager } from 'typeorm';
import {
  SubscriptionMutationLockService,
  type SubscriptionLockLease,
} from './subscription-mutation-lock.service.js';
import { subscriptionOtidLockKey } from './store-reconciliation.service.js';

// The lock's ACTUAL cross-flow serialisation needs a live Redis and is verified
// by reasoning + the proven POI upload-lock pattern (an integration concern, not
// unit-testable here). These unit tests pin the acquire→run→release DISCIPLINE
// against a mocked Redis client + DataSource: the fn runs on the shared POOL
// manager, the lock is token-owned (`SET NX PX`), token-checked-released in
// `finally` even when the callback throws, waits then fails closed when the lock
// stays held, and fails closed on a Redis error.
describe('SubscriptionMutationLockService', () => {
  const USER_ID = '11111111-1111-1111-1111-111111111111';
  const LOCK_KEY = `sub-mut:${USER_ID}`;

  // `dataSource.query` backs three SQL shapes; the dispatcher lets each test tweak
  // one via `ctl` without re-stubbing the whole thing:
  //  - `UPDATE ... nextval(...)`     → mints AND STAMPS the fence token (`ctl.token`)
  //  - `UPDATE users ... fence < $1` → publishes the fence (`ctl.publishAffected`)
  //  - `SELECT 1 FROM users`         → `assertFenceCurrent`'s fence-ahead probe
  interface QueryCtl {
    token: string;
    publishAffected: number;
    /** The `SELECT 1 ... fence > token` probe finds a row → a newer holder. */
    fenceAhead: boolean;
    nextvalError: Error | null;
    bornExpiredAttempts: number;
  }

  function setup() {
    const manager = {
      marker: 'pool-manager',
    } as unknown as EntityManager;
    const set = jest.fn().mockResolvedValue('OK');
    // `eval` backs BOTH the token-checked release AND `assertHeld`'s atomic
    // check-and-extend (token-checked PEXPIRE): returns 1 when we own the key.
    const evalFn = jest.fn().mockResolvedValue(1);
    const redis = { set, eval: evalFn } as unknown as Redis;
    const ctl: QueryCtl = {
      token: '42',
      publishAffected: 1,
      fenceAhead: false,
      nextvalError: null,
      // How many leading acquisitions report a BORN-EXPIRED lease
      // (`lease_live: false`). Lets a unit test drive the retry path that a real
      // database cannot reach quickly: producing it for real needs the
      // acquisition to queue behind the users row lock for longer than the 60s
      // TTL.
      bornExpiredAttempts: 0,
    };
    let nextvalCalls = 0;
    const query = jest.fn().mockImplementation((sql: string) => {
      if (sql.includes('nextval')) {
        if (ctl.nextvalError) return Promise.reject(ctl.nextvalError);
        // `lease_live` is the RETURNING guard: the acquisition reports whether
        // the expiry it just wrote is actually in the future, since PostgreSQL
        // projects the new tuple BEFORE waiting on the row lock and a queued
        // statement can commit an already-past one.
        nextvalCalls += 1;
        const leaseLive = nextvalCalls > ctl.bornExpiredAttempts;
        return Promise.resolve([{ token: ctl.token, lease_live: leaseLive }]);
      }
      if (sql.trimStart().startsWith('UPDATE users')) {
        // node-postgres UPDATE via `query` returns `[rows, affectedCount]`.
        return Promise.resolve([[], ctl.publishAffected]);
      }
      if (sql.includes('SELECT 1 FROM users')) {
        // `assertFenceCurrent`'s probe: a row means a NEWER holder's fence is
        // strictly above ours.
        return Promise.resolve(ctl.fenceAhead ? [{ ok: 1 }] : []);
      }
      return Promise.resolve([]);
    });
    const dataSource = { manager, query } as unknown as DataSource;
    const service = new SubscriptionMutationLockService(redis, dataSource);
    return { service, set, evalFn, query, manager, ctl };
  }

  it('acquires the per-rider lock (SET NX PX), runs the callback on the pool manager, then token-releases', async () => {
    const { service, set, evalFn, manager } = setup();
    const fn = jest.fn().mockResolvedValue('result');

    const result = await service.runExclusive(USER_ID, fn);

    expect(result).toBe('result');
    // The callback ran on the shared pool manager (not a reserved connection),
    // and received a second arg (the lease; its `assertHeld` fence is covered by
    // the dedicated lease tests below).
    expect(fn).toHaveBeenCalledWith(manager, expect.anything());
    // Acquired with an owner token via SET NX PX on `sub-mut:<userId>`.
    expect(set).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledWith(
      LOCK_KEY,
      expect.any(String),
      'PX',
      expect.any(Number),
      'NX',
    );
    // `eval` runs twice: the post-mint ownership check-and-extend, then the
    // token-checked Lua DEL release (script, numkeys=1, key, token).
    expect(evalFn).toHaveBeenCalledTimes(2);
    expect(evalFn).toHaveBeenCalledWith(
      expect.any(String),
      1,
      LOCK_KEY,
      expect.any(String),
    );
  });

  it('releases the lock even when the callback throws, and propagates the error', async () => {
    const { service, evalFn } = setup();
    const boom = new Error('callback failed');

    await expect(
      service.runExclusive(USER_ID, () => Promise.reject(boom)),
    ).rejects.toBe(boom);

    // The token-checked release still ran (finally), so the lock cannot leak
    // (plus the post-mint ownership check-and-extend = 2 eval calls).
    expect(evalFn).toHaveBeenCalledTimes(2);
    expect(evalFn).toHaveBeenCalledWith(
      expect.any(String),
      1,
      LOCK_KEY,
      expect.any(String),
    );
  });

  it('waits while the lock is held, then acquires it and runs', async () => {
    const { service, set, evalFn } = setup();
    // First attempt: held (null). Second attempt: acquired.
    set.mockResolvedValueOnce(null).mockResolvedValueOnce('OK');
    const fn = jest.fn().mockResolvedValue('ok');

    const result = await service.runExclusive(USER_ID, fn);

    expect(result).toBe('ok');
    expect(set).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenCalledTimes(1);
    // Post-mint check-and-extend + release.
    expect(evalFn).toHaveBeenCalledTimes(2);
  });

  it('fails CLOSED with a retryable 503 when Redis is unreachable on acquire', async () => {
    const { service, set } = setup();
    set.mockRejectedValue(new Error('ECONNREFUSED'));
    const fn = jest.fn();

    await expect(service.runExclusive(USER_ID, fn)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    // Never ran the mutation without the lock.
    expect(fn).not.toHaveBeenCalled();
  });

  it('lease.assertHeld() passes (token-checked PEXPIRE returns 1) while this run still owns the lock', async () => {
    const { service, evalFn } = setup();
    // eval (check-and-extend) returns 1 = owned + TTL reset.
    await expect(
      service.runExclusive(USER_ID, async (_m, lease) => {
        await lease.assertHeld();
        return 'done';
      }),
    ).resolves.toBe('done');
    // Called for the fence (check-and-extend) AND the final release.
    expect(evalFn).toHaveBeenCalled();
  });

  it('mints the fencing token from the DURABLE Postgres sequence and exposes it on the lease', async () => {
    const { service, query, ctl } = setup();
    ctl.token = '7';

    let seenToken: number | undefined;
    await service.runExclusive(USER_ID, (_m, lease) => {
      seenToken = lease.fenceToken;
      return Promise.resolve('ok');
    });

    // Acquisition is ONE statement that takes the LEASE and allocates the fence
    // (#1138), so it carries the rider, the owner token and the TTL — no longer a
    // bare SELECT, and no longer rider-only.
    expect(query).toHaveBeenCalledWith(expect.stringContaining('nextval'), [
      USER_ID,
      expect.any(String),
      expect.stringContaining('milliseconds'),
    ]);
    // The lease predicate is what stops a stalled acquirer stamping over a live
    // holder; without it this is the pre-#1138 unguarded stamp.
    expect(query).toHaveBeenCalledWith(
      expect.stringMatching(
        /UPDATE users[\s\S]*subscription_lock_fence[\s\S]*subscription_lock_owner[\s\S]*WHERE[\s\S]*subscription_lock_lease_expires_at <= clock_timestamp\(\)/,
      ),
      expect.any(Array),
    );
    // Parsed from the driver's bigint-as-string.
    expect(seenToken).toBe(7);
  });

  it('IS stamped at lock acquisition, even when the callback writes nothing (#1138)', async () => {
    const { service, query } = setup();

    // INVERTED by #1138, deliberately. This test previously asserted the
    // opposite — that acquisition writes nothing, so a mutation-free reject
    // never touches the row.
    //
    // That contract is what made a lost lease undetectable: with nothing stamped
    // until a holder wrote, `users.subscription_lock_fence` named the last
    // holder to write rather than the current one, so a stale holder's
    // `fence <= :token` guard still passed. See
    // `test/subscription-fence-ownership.e2e-spec.ts` case (i).
    //
    // The cost is accepted and bounded: `subscription_lock_fence` is an internal
    // concurrency column, not entitlement state. What must still hold is that an
    // ownership-rejecting flow changes no ENTITLEMENT or IDENTITY column — that
    // is INV-B, asserted in the e2e harness against a real database, which is the
    // only place it is observable.
    await service.runExclusive(USER_ID, () => Promise.resolve('ok'));

    expect(query).toHaveBeenCalledWith(
      expect.stringMatching(/UPDATE users[\s\S]*subscription_lock_fence/),
      expect.arrayContaining([USER_ID]),
    );
  });

  describe('born-expired lease (RETURNING `lease_live: false`)', () => {
    /**
     * PostgreSQL projects the new tuple BEFORE waiting on the users row lock, so
     * an acquisition queued behind a slow holder writes an expiry anchored to
     * when it started QUEUEING. Blocked longer than the TTL, that expiry is
     * already past on commit — a lease nobody holds, which `runExclusive` cannot
     * notice because it only re-checks Redis afterwards.
     *
     * Producing that for real needs a row-lock wait longer than `LOCK_TTL_MS`
     * (60s), which no reasonable e2e can do. Here the driver's answer is under
     * test control, so the retry path is covered directly — the e2e covers the
     * live-lease invariant and pins the clock semantics.
     */

    it('RETRIES and proceeds when only the first attempt is born-expired', async () => {
      const { service, ctl } = setup();
      ctl.bornExpiredAttempts = 1;
      ctl.token = '9';

      let seen: number | undefined;
      await expect(
        service.runExclusive(USER_ID, (_m, lease) => {
          seen = lease.fenceToken;
          return Promise.resolve('ok');
        }),
      ).resolves.toBe('ok');

      // Ran as a real holder, on the retry's live lease.
      expect(seen).toBe(9);
    });

    it('REFUSES, retryably, when every attempt is born-expired', async () => {
      const { service, ctl } = setup();
      // More than the attempt budget, so the loop always exhausts.
      ctl.bornExpiredAttempts = 99;
      const reached = jest.fn();

      await expect(
        service.runExclusive(USER_ID, () => {
          reached();
          return Promise.resolve('ok');
        }),
      ).rejects.toMatchObject({ status: 503 });

      // Fail CLOSED: the callback must not run on a lease that is not live.
      // Falling out of the retry loop and RETURNING the last (born-expired) row
      // would reach it with a token whose lease nobody holds — the outcome the
      // guard exists to prevent, arrived at by exhausting the loop instead of by
      // skipping the check.
      expect(reached).not.toHaveBeenCalled();
    });
  });

  it('releases the DB lease on the way out, guarded on ownership', async () => {
    // Releasing lets the next acquirer in immediately instead of waiting out a
    // TTL nobody is using — but it MUST be owner-guarded, or a flow that was
    // refused (or taken over) frees the live holder's lease as it unwinds. The
    // e2e harness proves the consequence against a real database; this pins the
    // statement shape so the guard cannot be dropped unnoticed.
    const { service, query } = setup();

    await service.runExclusive(USER_ID, () => Promise.resolve('ok'));

    expect(query).toHaveBeenCalledWith(
      expect.stringMatching(
        /UPDATE users[\s\S]*subscription_lock_owner = NULL[\s\S]*WHERE id = \$1 AND subscription_lock_owner = \$2/,
      ),
      expect.arrayContaining([USER_ID]),
    );
  });

  it('lease.assertFenceCurrent() throws a retryable 503 when a NEWER holder has acquired', async () => {
    const { service, ctl } = setup();
    // Stored fence strictly above our token — only possible if another
    // acquisition happened after ours, i.e. our lease was lost.
    ctl.fenceAhead = true;
    const reached = jest.fn();

    await expect(
      service.runExclusive(USER_ID, async (_m, lease) => {
        await lease.assertFenceCurrent();
        reached();
      }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    // The stale flow never proceeds past the check — that is the point of
    // calling it before an expensive re-query.
    expect(reached).not.toHaveBeenCalled();
  });

  it('lease.assertFenceCurrent() checks REDIS first and skips the DB probe when the lease is already lost', async () => {
    const { service, evalFn, query } = setup();
    // The post-mint backstop assertHeld passes (1); the reassert inside
    // assertFenceCurrent then reports the lease lost (0).
    evalFn.mockResolvedValueOnce(1).mockResolvedValue(0);

    await expect(
      service.runExclusive(USER_ID, (_m, lease) => lease.assertFenceCurrent()),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);

    // Ordering is deliberate, not incidental: a lost Redis lease is decisive on
    // its own, so the DB round trip is skipped entirely.
    expect(query).not.toHaveBeenCalledWith(
      expect.stringContaining('subscription_lock_fence > $2'),
      expect.anything(),
    );
  });

  it('lease.assertFenceCurrent() proceeds for a DELETED rider rather than failing closed', async () => {
    const { service, ctl } = setup();
    // A missing row cannot have a fence above ours, so the probe finds nothing.
    // Deliberately NOT treated as an error: the callback's own re-read early-outs
    // on a deleted rider, and failing closed here would turn an ordinary deletion
    // into a retry loop.
    ctl.fenceAhead = false;
    const fn = jest.fn(async (_m: unknown, lease: SubscriptionLockLease) => {
      await lease.assertFenceCurrent();
      return 'ok';
    });

    await expect(service.runExclusive(USER_ID, fn)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalled();
  });

  it('fails CLOSED with a retryable 503 when the fence-token sequence read errors', async () => {
    const { service, ctl } = setup();
    ctl.nextvalError = new Error('sequence read failed');
    const fn = jest.fn();

    await expect(service.runExclusive(USER_ID, fn)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    // Never ran the mutation without a fence token.
    expect(fn).not.toHaveBeenCalled();
  });

  it('lease.assertHeld() throws a retryable 503 when the lease was lost (check-and-extend returns 0)', async () => {
    const { service, evalFn } = setup();
    // eval returns 0 = we no longer own the key (expired/stolen).
    evalFn.mockResolvedValue(0);

    await expect(
      service.runExclusive(USER_ID, async (_m, lease) => {
        await lease.assertHeld();
        return 'should-not-reach';
      }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  // Deterministic interleaving over STATEFUL fakes (a Redis-key Map + a fake
  // `users` row with a fence), exercising the central safety property end-to-end:
  // same-rider exclusion, lease loss, a NEWER holder that does only a NO-OP, and
  // rejection of the stale lower-token mutation. This is what the per-call mocks
  // above can't cover (they never let two callers contend or a lease expire).
  describe('fencing under a deterministic lease-loss interleaving', () => {
    function statefulSetup() {
      const redisState = new Map<string, string>(); // lock key → owner token
      const row = { fence: 0, tier: 'free' as 'free' | 'pro' }; // fake users row
      let seq = 0;

      const set = jest.fn(
        (
          key: string,
          tok: string,
          _px: string,
          _ttl: number,
          _nx: string,
        ): Promise<string | null> => {
          if (redisState.has(key)) return Promise.resolve(null); // held → NX fails
          redisState.set(key, tok);
          return Promise.resolve('OK');
        },
      );
      const evalFn = jest.fn(
        (
          script: string,
          _numKeys: number,
          key: string,
          tok: string,
        ): Promise<number> => {
          const owned = redisState.get(key) === tok;
          if (script.includes('del')) {
            if (owned) redisState.delete(key);
            return Promise.resolve(owned ? 1 : 0);
          }
          return Promise.resolve(owned ? 1 : 0); // renew / assertHeld
        },
      );
      const query = jest.fn(
        (sql: string, params?: unknown[]): Promise<unknown> => {
          if (sql.includes('nextval')) {
            // The mint is an UPDATE that STAMPS in the same statement (#1138),
            // so the row's fence moves here — not at some later publish. Returns
            // the driver's `[rows, affectedCount]` tuple.
            seq += 1;
            row.fence = seq;
            // `lease_live: true` — the acquisition's RETURNING guard reports the
            // expiry it just wrote is in the future. Omitting it makes every
            // acquisition look born-expired, so the retry loop burns extra
            // sequence values and the fence assertions below drift.
            return Promise.resolve([
              [{ token: String(seq), lease_live: true }],
              1,
            ]);
          }
          if (sql.trimStart().startsWith('UPDATE users')) {
            const tok = (params as [number, string])[0];
            if (row.fence <= tok) {
              row.fence = tok;
              return Promise.resolve([[], 1]);
            }
            return Promise.resolve([[], 0]);
          }
          if (sql.includes('SELECT 1 FROM users')) {
            // `assertFenceCurrent`'s probe: a row iff a NEWER holder's fence is
            // strictly above the caller's token.
            const tok = (params as [string, number])[1];
            return Promise.resolve(row.fence > tok ? [{ ok: 1 }] : []);
          }
          return Promise.resolve([]);
        },
      );

      const redis = { set, eval: evalFn } as unknown as Redis;
      const dataSource = {
        manager: {} as EntityManager,
        query,
      } as unknown as DataSource;
      const service = new SubscriptionMutationLockService(redis, dataSource);
      // Models a provider-claim guarded activation: applies only if this token is
      // still >= the row's fence (the `subscription_lock_fence <= :token` guard).
      const guardedActivate = (tok: number): boolean => {
        if (row.fence <= tok) {
          row.tier = 'pro';
          return true;
        }
        return false;
      };
      return { service, redisState, row, guardedActivate };
    }

    it('a newer NO-OP holder still fences out a stale lower-token mutation (no resurrection)', async () => {
      const { service, redisState, row, guardedActivate } = statefulSetup();
      let staleApplied: boolean | undefined;

      await service.runExclusive(USER_ID, async (_m, leaseA) => {
        // Flow A (token 1) — its ACQUISITION already stamped fence=1 (#1138).
        // Its business write is then DELAYED; its lease is LOST and a NEWER
        // flow B runs.
        expect(leaseA.fenceToken).toBe(1);
        await leaseA.assertFenceCurrent();
        redisState.delete(LOCK_KEY); // A's lease lost

        await service.runExclusive(USER_ID, async (_m2, leaseB) => {
          // Flow B (token 2) — acquisition stamped fence=2 — then does ONLY a
          // no-op. This is the case the old mechanism could not cover: B writes
          // nothing, yet must still fence A out.
          expect(leaseB.fenceToken).toBe(2);
          await leaseB.assertFenceCurrent();
          return 'B done';
        });

        // A now performs its delayed, STALE (token 1) business write.
        staleApplied = guardedActivate(leaseA.fenceToken);
        return 'A done';
      });

      expect(staleApplied).toBe(false); // fenced out → no resurrection
      expect(row.tier).toBe('free'); // B's no-op left it free; A didn't revive it
      expect(row.fence).toBe(2); // B's ACQUISITION stamped it, despite B writing nothing
    });

    it('serialises two concurrent same-rider callers (the second waits for the first)', async () => {
      const { service } = statefulSetup();
      const order: string[] = [];

      // A holds the lock and yields once before releasing; B, launched
      // concurrently, must block on the held lock and run only after A releases.
      const a = service.runExclusive(USER_ID, async () => {
        order.push('A-start');
        await new Promise((resolve) => setImmediate(resolve));
        order.push('A-end');
        return 'A';
      });
      const b = service.runExclusive(USER_ID, () => {
        order.push('B');
        return Promise.resolve('B');
      });

      await Promise.all([a, b]);

      // Mutual exclusion: B's whole section runs strictly after A's completes.
      expect(order).toEqual(['A-start', 'A-end', 'B']);
    });
  });

  // The OTID-scoped lock serialises the CROSS-rider same-OTID race (a different
  // rider validating the same original transaction). It reuses the same
  // acquire→heartbeat→release discipline as the rider lock, but carries NO fence
  // token (the rider lease already fences the users-row writes) — so it never
  // touches `dataSource.query`.
  describe('runExclusiveByOtid', () => {
    const OTID = 'apple-otid-abc';
    const OTID_LOCK_KEY = subscriptionOtidLockKey(OTID);

    it('hashes the OTID into the key so the raw OTID never appears in it', () => {
      expect(OTID_LOCK_KEY).toMatch(/^sub-otid:[0-9a-f]{64}$/);
      expect(OTID_LOCK_KEY).not.toContain(OTID);
    });

    it('acquires the OTID lock (SET NX PX), runs the callback, then token-releases — no DB fence work', async () => {
      const { service, set, evalFn, query } = setup();
      const fn = jest.fn().mockResolvedValue('result');

      const result = await service.runExclusiveByOtid(OTID, fn);

      expect(result).toBe('result');
      expect(fn).toHaveBeenCalledTimes(1);
      expect(set).toHaveBeenCalledTimes(1);
      expect(set).toHaveBeenCalledWith(
        OTID_LOCK_KEY,
        expect.any(String),
        'PX',
        expect.any(Number),
        'NX',
      );
      // Only the token-checked Lua DEL release runs (no fence mint / publish /
      // post-mint check), so a single eval and NO SQL.
      expect(evalFn).toHaveBeenCalledTimes(1);
      expect(evalFn).toHaveBeenCalledWith(
        expect.any(String),
        1,
        OTID_LOCK_KEY,
        expect.any(String),
      );
      expect(query).not.toHaveBeenCalled();
    });

    it('releases the OTID lock even when the callback throws, and propagates the error', async () => {
      const { service, evalFn } = setup();
      const boom = new Error('callback failed');

      await expect(
        service.runExclusiveByOtid(OTID, () => Promise.reject(boom)),
      ).rejects.toBe(boom);

      // The token-checked release still ran in `finally`, so the lock can't leak.
      expect(evalFn).toHaveBeenCalledTimes(1);
      expect(evalFn).toHaveBeenCalledWith(
        expect.any(String),
        1,
        OTID_LOCK_KEY,
        expect.any(String),
      );
    });

    it('fails CLOSED with a retryable 503 when Redis is unreachable on acquire', async () => {
      const { service, set } = setup();
      set.mockRejectedValue(new Error('ECONNREFUSED'));
      const fn = jest.fn();

      await expect(service.runExclusiveByOtid(OTID, fn)).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      // Never ran the cross-rider claim without the lock.
      expect(fn).not.toHaveBeenCalled();
    });

    it('lease.assertHeld() token-checks-and-extends the OTID lock while this run still owns it', async () => {
      const { service, evalFn } = setup();
      // eval returns 1 (owned) for both the assertHeld check-and-extend and the
      // final release; no fence mint/publish, so no SQL.
      await expect(
        service.runExclusiveByOtid(OTID, async (lease) => {
          await lease.assertHeld();
          return 'done';
        }),
      ).resolves.toBe('done');
      expect(evalFn).toHaveBeenCalledTimes(2);
    });

    it('lease.assertHeld() throws a retryable 503 when the OTID lease was lost (another rider took the lock)', async () => {
      const { service, evalFn } = setup();
      // The token-checked PEXPIRE returns 0 = we no longer own the OTID key.
      evalFn.mockResolvedValue(0);
      await expect(
        service.runExclusiveByOtid(OTID, (lease) => lease.assertHeld()),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
    });

    it('serialises two concurrent SAME-OTID callers (the second waits for the first)', async () => {
      // A stateful Redis mock: NX fails while the key is held; token-checked DEL
      // frees it. Distinct rider locks would NOT serialise these two flows — only
      // the shared OTID key does.
      const redisState = new Map<string, string>();
      const set = jest.fn(
        (key: string, tok: string): Promise<string | null> => {
          if (redisState.has(key)) return Promise.resolve(null);
          redisState.set(key, tok);
          return Promise.resolve('OK');
        },
      );
      const evalFn = jest.fn(
        (
          script: string,
          _numKeys: number,
          key: string,
          tok: string,
        ): Promise<number> => {
          const owned = redisState.get(key) === tok;
          if (script.includes('del') && owned) redisState.delete(key);
          return Promise.resolve(owned ? 1 : 0);
        },
      );
      const redis = { set, eval: evalFn } as unknown as Redis;
      const dataSource = {
        manager: {} as EntityManager,
        query: jest.fn(),
      } as unknown as DataSource;
      const service = new SubscriptionMutationLockService(redis, dataSource);
      const order: string[] = [];

      const a = service.runExclusiveByOtid(OTID, async () => {
        order.push('A-start');
        await new Promise((resolve) => setImmediate(resolve));
        order.push('A-end');
        return 'A';
      });
      const b = service.runExclusiveByOtid(OTID, () => {
        order.push('B');
        return Promise.resolve('B');
      });

      await Promise.all([a, b]);

      // Mutual exclusion on the shared OTID key: B runs strictly after A releases.
      expect(order).toEqual(['A-start', 'A-end', 'B']);
    });
  });
});
