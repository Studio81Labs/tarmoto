import { DataSource, EntityManager, QueryRunner } from 'typeorm';
import { SubscriptionMutationLockService } from './subscription-mutation-lock.service.js';

// The lock's ACTUAL cross-flow serialisation needs a live Postgres advisory
// lock and is verified by reasoning + the proven `AccountDeletionService`
// session-lock pattern (an integration concern, not unit-testable here). These
// unit tests pin the acquire→run→release DISCIPLINE against a mocked query
// runner: the fn runs on the reserved connection's manager, and the lock is
// unlocked + the runner released in `finally` — even when the callback throws,
// so a lock can never leak.
describe('SubscriptionMutationLockService', () => {
  const USER_ID = '11111111-1111-1111-1111-111111111111';
  const LOCK_SQL = 'SELECT pg_advisory_lock(hashtext($1))';
  const UNLOCK_SQL = 'SELECT pg_advisory_unlock(hashtext($1))';

  function setup() {
    const manager = {
      marker: 'reserved-connection-manager',
    } as unknown as EntityManager;
    const query = jest.fn().mockResolvedValue(undefined);
    const connect = jest.fn().mockResolvedValue(undefined);
    const release = jest.fn().mockResolvedValue(undefined);
    const queryRunner = {
      connect,
      query,
      release,
      manager,
    } as unknown as QueryRunner;
    const dataSource = {
      createQueryRunner: jest.fn().mockReturnValue(queryRunner),
    } as unknown as DataSource;
    const service = new SubscriptionMutationLockService(dataSource);
    return { service, connect, query, release, manager };
  }

  it('acquires the per-rider lock, runs the callback on the reserved manager, then unlocks and releases', async () => {
    const { service, connect, query, release, manager } = setup();
    const fn = jest.fn().mockResolvedValue('result');

    const result = await service.runExclusive(USER_ID, fn);

    expect(result).toBe('result');
    expect(connect).toHaveBeenCalledTimes(1);
    // The callback ran on the reserved connection's manager (not a pooled repo).
    expect(fn).toHaveBeenCalledWith(manager);
    // Lock acquired before, released after — both keyed on `sub-mut:<userId>`.
    expect(query).toHaveBeenNthCalledWith(1, LOCK_SQL, [`sub-mut:${USER_ID}`]);
    expect(query).toHaveBeenNthCalledWith(2, UNLOCK_SQL, [
      `sub-mut:${USER_ID}`,
    ]);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('unlocks and releases even when the callback throws, and propagates the error', async () => {
    const { service, query, release } = setup();
    const boom = new Error('callback failed');

    await expect(
      service.runExclusive(USER_ID, () => Promise.reject(boom)),
    ).rejects.toBe(boom);

    // The advisory unlock still ran (finally), so the lock cannot leak...
    expect(query).toHaveBeenCalledWith(UNLOCK_SQL, [`sub-mut:${USER_ID}`]);
    // ...and the reserved connection is always returned to the pool.
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('still releases the connection when acquiring the lock fails (no unlock attempted)', async () => {
    const { service, query, release } = setup();
    query.mockRejectedValueOnce(new Error('acquire failed'));

    await expect(
      service.runExclusive(USER_ID, () => Promise.resolve('unused')),
    ).rejects.toThrow('acquire failed');

    // Lock was never acquired, so no unlock is attempted; the runner is still
    // released so the connection is not leaked.
    expect(query).toHaveBeenCalledTimes(1); // only the failed acquire
    expect(release).toHaveBeenCalledTimes(1);
  });
});
