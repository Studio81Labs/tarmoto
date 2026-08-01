import { DataSource } from 'typeorm';
import { AppDataSource } from '../src/data-source.js';
import { User } from '../src/entities/user.entity.js';

/**
 * #1123 — `users.subscription_lock_fence` MONOTONICITY, enforced by a Postgres
 * `BEFORE UPDATE` trigger (migration 1827).
 *
 * This cannot be covered by a mocked repository: the invariant is enforced by
 * Postgres at write time, so it needs a real database. The runner initialises
 * the same `AppDataSource` the rest of the e2e suite uses; `pnpm db:up && pnpm
 * db:migrate` must have run before `pnpm --filter @tarmoto/backend test:e2e`.
 *
 * Lease-loss safety depends on this DB-boundary invariant (a stale whole-entity
 * save must never regress the fence and reopen the resurrection window), so we
 * assert the trigger DDL actually clamps a lowering write.
 */
describe('subscription_lock_fence monotonic trigger (#1123)', () => {
  let dataSource: DataSource;
  let userId: string;

  beforeAll(async () => {
    dataSource = new DataSource(AppDataSource.options);
    await dataSource.initialize();
  }, 30_000);

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
  });

  beforeEach(async () => {
    const repo = dataSource.getRepository(User);
    const tag = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
    const saved = await repo.save(
      repo.create({
        email: `fence-monotonic-${tag}@tarmoto.test`,
        password_hash: 'x',
        display_name: 'FenceTest',
      }),
    );
    userId = saved.id;
  });

  afterEach(async () => {
    if (userId) {
      await dataSource.getRepository(User).delete(userId);
    }
  });

  async function readFence(): Promise<number | undefined> {
    const row = await dataSource.getRepository(User).findOne({
      where: { id: userId },
      select: { id: true, subscription_lock_fence: true },
    });
    return row?.subscription_lock_fence;
  }

  it('clamps an UPDATE that would LOWER the fence back to the stored value', async () => {
    await dataSource.query(
      `UPDATE users SET subscription_lock_fence = $1 WHERE id = $2`,
      [5, userId],
    );
    // A stale writer tries to set it back to 2 — the trigger must clamp to 5.
    await dataSource.query(
      `UPDATE users SET subscription_lock_fence = $1 WHERE id = $2`,
      [2, userId],
    );
    expect(await readFence()).toBe(5);
  });

  it('allows a HIGHER UPDATE (the lock advancing N → N+1)', async () => {
    await dataSource.query(
      `UPDATE users SET subscription_lock_fence = $1 WHERE id = $2`,
      [5, userId],
    );
    await dataSource.query(
      `UPDATE users SET subscription_lock_fence = $1 WHERE id = $2`,
      [9, userId],
    );
    expect(await readFence()).toBe(9);
  });

  it('a stale whole-entity save() cannot regress the fence (the actual bug)', async () => {
    const repo = dataSource.getRepository(User);
    // Load the rider while the fence is 0 (a profile/avatar request would).
    const stale = await repo.findOne({ where: { id: userId } });
    // A newer lock holder advances the fence to 7 in the meantime.
    await dataSource.query(
      `UPDATE users SET subscription_lock_fence = $1 WHERE id = $2`,
      [7, userId],
    );
    // The stale in-memory entity (fence 0) is saved back with an unrelated edit.
    stale!.display_name = 'Renamed';
    await repo.save(stale!);

    const row = await repo.findOne({
      where: { id: userId },
      select: { id: true, subscription_lock_fence: true, display_name: true },
    });
    // The fence is NOT regressed to 0 (trigger clamped it)...
    expect(row?.subscription_lock_fence).toBe(7);
    // ...while the intended, unrelated column change still applied.
    expect(row?.display_name).toBe('Renamed');
  });
});
