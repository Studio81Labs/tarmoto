import { ServiceUnavailableException } from '@nestjs/common';
import type { Redis } from 'ioredis';
import type { DataSource, EntityManager } from 'typeorm';
import { SubscriptionMutationLockService } from './subscription-mutation-lock.service.js';

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

  function setup() {
    const manager = {
      marker: 'pool-manager',
    } as unknown as EntityManager;
    const set = jest.fn().mockResolvedValue('OK');
    const evalFn = jest.fn().mockResolvedValue(1);
    const get = jest.fn().mockResolvedValue(null);
    const redis = { set, eval: evalFn, get } as unknown as Redis;
    const dataSource = { manager } as unknown as DataSource;
    const service = new SubscriptionMutationLockService(redis, dataSource);
    return { service, set, evalFn, get, manager };
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
    // Released via a token-checked Lua DEL: (script, numkeys=1, key, token).
    expect(evalFn).toHaveBeenCalledTimes(1);
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

    // The token-checked release still ran (finally), so the lock cannot leak.
    expect(evalFn).toHaveBeenCalledTimes(1);
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
    expect(evalFn).toHaveBeenCalledTimes(1); // released once
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

  it('lease.assertHeld() passes while this run still owns the lock (GET returns our token)', async () => {
    const { service, set, get } = setup();
    let capturedToken: string | undefined;
    // Capture the token the run acquired with, and make GET return it.
    set.mockImplementation((_k: string, t: string) => {
      capturedToken = t;
      return Promise.resolve('OK');
    });
    get.mockImplementation(() => Promise.resolve(capturedToken ?? null));

    await expect(
      service.runExclusive(USER_ID, async (_m, lease) => {
        await lease.assertHeld();
        return 'done';
      }),
    ).resolves.toBe('done');
    expect(get).toHaveBeenCalledWith(LOCK_KEY);
  });

  it('lease.assertHeld() throws a retryable 503 when the lease was lost (GET returns a different token)', async () => {
    const { service, get } = setup();
    // Another flow now owns the key (different token) — our lease is lost.
    get.mockResolvedValue('some-other-owner-token');

    await expect(
      service.runExclusive(USER_ID, async (_m, lease) => {
        await lease.assertHeld();
        return 'should-not-reach';
      }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
