import { DataSource } from 'typeorm';
import { AppDataSource } from '../src/data-source.js';
import { User } from '../src/entities/user.entity.js';

/**
 * #1123 — `users.subscription_notify_generation` MONOTONICITY, enforced by a
 * Postgres `BEFORE UPDATE` trigger (migration 1829); the sibling of the
 * `subscription_lock_fence` trigger.
 *
 * This cannot be covered by a mocked repository: the invariant is enforced by
 * Postgres at write time, so it needs a real database. `pnpm db:up && pnpm
 * db:migrate` must have run before `pnpm --filter @tarmoto/backend test:e2e`.
 *
 * Notification-delivery correctness depends on this: a stale whole-entity save
 * (a profile/avatar request that loaded generation N) must never regress the
 * generation after a Stripe transition advanced it to N+1, or the worker would
 * drop the valid N+1 notification and an older N job could re-qualify.
 */
describe('subscription_notify_generation monotonic trigger (#1123)', () => {
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
        email: `notify-gen-monotonic-${tag}@tarmoto.test`,
        password_hash: 'x',
        display_name: 'GenTest',
      }),
    );
    userId = saved.id;
  });

  afterEach(async () => {
    if (userId) {
      await dataSource.getRepository(User).delete(userId);
    }
  });

  async function readGeneration(): Promise<number | undefined> {
    const row = await dataSource.getRepository(User).findOne({
      where: { id: userId },
      select: { id: true, subscription_notify_generation: true },
    });
    return row?.subscription_notify_generation;
  }

  it('clamps an UPDATE that would LOWER the generation back to the stored value', async () => {
    await dataSource.query(
      `UPDATE users SET subscription_notify_generation = $1 WHERE id = $2`,
      [5, userId],
    );
    await dataSource.query(
      `UPDATE users SET subscription_notify_generation = $1 WHERE id = $2`,
      [2, userId],
    );
    expect(await readGeneration()).toBe(5);
  });

  it('allows a HIGHER UPDATE (the transition advancing N → N+1)', async () => {
    await dataSource.query(
      `UPDATE users SET subscription_notify_generation = $1 WHERE id = $2`,
      [5, userId],
    );
    await dataSource.query(
      `UPDATE users SET subscription_notify_generation = $1 WHERE id = $2`,
      [9, userId],
    );
    expect(await readGeneration()).toBe(9);
  });

  it('a stale whole-entity save() cannot regress the generation (the actual bug)', async () => {
    const repo = dataSource.getRepository(User);
    // Load the rider while the generation is 0 (a profile/avatar request would).
    const stale = await repo.findOne({ where: { id: userId } });
    // A Stripe transition advances the generation to 7 in the meantime.
    await dataSource.query(
      `UPDATE users SET subscription_notify_generation = $1 WHERE id = $2`,
      [7, userId],
    );
    // The stale in-memory entity (generation 0) is saved back with an edit.
    stale!.display_name = 'Renamed';
    await repo.save(stale!);

    const row = await repo.findOne({
      where: { id: userId },
      select: {
        id: true,
        subscription_notify_generation: true,
        display_name: true,
      },
    });
    // The generation is NOT regressed to 0 (trigger clamped it)...
    expect(row?.subscription_notify_generation).toBe(7);
    // ...while the intended, unrelated column change still applied.
    expect(row?.display_name).toBe('Renamed');
  });
});
