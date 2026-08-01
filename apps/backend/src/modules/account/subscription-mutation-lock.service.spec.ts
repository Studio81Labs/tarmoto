import { ServiceUnavailableException } from '@nestjs/common';
import type { Redis } from 'ioredis';
import type { DataSource, EntityManager } from 'typeorm';
import {
  SubscriptionMutationLockService,
  type SubscriptionLockLease,
} from './subscription-mutation-lock.service.js';

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
  //  - `SELECT nextval(...)`         → mints the fence token (`ctl.token`)
  //  - `UPDATE users ... fence < $1` → publishes the fence (`ctl.publishAffected`)
  //  - `SELECT 1 FROM users`         → the 0-row-publish existence recheck
  interface QueryCtl {
    token: string;
    publishAffected: number;
    rowExists: boolean;
    nextvalError: Error | null;
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
      rowExists: true,
      nextvalError: null,
    };
    const query = jest.fn().mockImplementation((sql: string) => {
      if (sql.includes('nextval')) {
        return ctl.nextvalError
          ? Promise.reject(ctl.nextvalError)
          : Promise.resolve([{ token: ctl.token }]);
      }
      if (sql.trimStart().startsWith('UPDATE users')) {
        // node-postgres UPDATE via `query` returns `[rows, affectedCount]`.
        return Promise.resolve([[], ctl.publishAffected]);
      }
      if (sql.includes('SELECT 1 FROM users')) {
        return Promise.resolve(ctl.rowExists ? [{ ok: 1 }] : []);
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

    expect(query).toHaveBeenCalledWith(expect.stringContaining('nextval'));
    // Parsed from the driver's bigint-as-string.
    expect(seenToken).toBe(7);
  });

  it('is NOT published at lock acquisition; the callback publishes it via lease.publishFence()', async () => {
    const { service, query } = setup();

    // A callback that does NOT call publishFence must not have published a fence
    // (a mutation-free reject relies on this — the row is never written).
    await service.runExclusive(USER_ID, () => Promise.resolve('ok'));
    expect(query).not.toHaveBeenCalledWith(
      expect.stringContaining('UPDATE users SET subscription_lock_fence'),
      expect.anything(),
    );

    // When the callback DOES publish, the monotonic fence bump runs.
    query.mockClear();
    await service.runExclusive(USER_ID, (_m, lease) => lease.publishFence());
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE users SET subscription_lock_fence'),
      [expect.any(Number), USER_ID],
    );
  });

  it('lease.publishFence() throws a retryable 503 when a NEWER holder already published a higher fence (stale)', async () => {
    const { service, ctl } = setup();
    // The publish bump affects 0 rows and the row still exists → a higher fence
    // is already there (a newer holder ran while our lease was lost).
    ctl.publishAffected = 0;
    ctl.rowExists = true;
    const reached = jest.fn();

    await expect(
      service.runExclusive(USER_ID, async (_m, lease) => {
        await lease.publishFence();
        reached();
      }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    // The stale flow never proceeds past the publish.
    expect(reached).not.toHaveBeenCalled();
  });

  it('lease.publishFence() proceeds when the bump affects 0 rows because the rider row is gone (deleted)', async () => {
    const { service, ctl } = setup();
    ctl.publishAffected = 0;
    ctl.rowExists = false; // deleted rider — let the callback re-read and handle it
    const fn = jest.fn(async (_m: unknown, lease: SubscriptionLockLease) => {
      await lease.publishFence();
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
            seq += 1;
            return Promise.resolve([{ token: String(seq) }]);
          }
          if (sql.trimStart().startsWith('UPDATE users')) {
            const tok = (params as [number, string])[0];
            if (row.fence < tok) {
              row.fence = tok;
              return Promise.resolve([[], 1]);
            }
            return Promise.resolve([[], 0]);
          }
          if (sql.includes('SELECT 1 FROM users')) {
            return Promise.resolve([{ ok: 1 }]);
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
        // Flow A (token 1) commits to acting and publishes fence=1. Its business
        // write is then DELAYED; its lease is LOST and a NEWER flow B runs.
        expect(leaseA.fenceToken).toBe(1);
        await leaseA.publishFence();
        redisState.delete(LOCK_KEY); // A's lease lost

        await service.runExclusive(USER_ID, async (_m2, leaseB) => {
          // Flow B (token 2) publishes fence=2, then does ONLY a no-op.
          expect(leaseB.fenceToken).toBe(2);
          await leaseB.publishFence();
          return 'B done';
        });

        // A now performs its delayed, STALE (token 1) business write.
        staleApplied = guardedActivate(leaseA.fenceToken);
        return 'A done';
      });

      expect(staleApplied).toBe(false); // fenced out → no resurrection
      expect(row.tier).toBe('free'); // B's no-op left it free; A didn't revive it
      expect(row.fence).toBe(2); // B published its fence despite doing nothing
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
});
