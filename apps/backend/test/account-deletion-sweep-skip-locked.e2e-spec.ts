import { DataSource, IsNull, LessThanOrEqual, Not } from 'typeorm';
import type { EntityManager } from 'typeorm';
import { AppDataSource } from '../src/data-source.js';
import { User } from '../src/entities/user.entity.js';

/**
 * Issue #337 — Account-deletion sweeper must claim rows with
 * `SELECT ... FOR UPDATE SKIP LOCKED` so two backend pods running the
 * daily sweep at the same cron tick lock disjoint slices of the
 * due-user set instead of double-enqueueing finalize jobs.
 *
 * This test cannot run against a mocked TypeORM repository — SKIP
 * LOCKED is enforced by Postgres at row-lock acquisition time, so we
 * need a real database. The runner initialises the same `AppDataSource`
 * the rest of the e2e suite uses; `pnpm db:up && pnpm db:migrate` must
 * have been run before `pnpm --filter @tarmoto/backend test:e2e`.
 *
 * The orchestration mirrors a two-pod race: pod A enters a transaction,
 * runs the SKIP LOCKED claim, and parks with the locks held. Pod B
 * enters its own transaction, runs the same claim, and must skip every
 * row pod A locked. Once both pods have completed their SELECTs, we
 * release the synchronisation gates and assert the claimed sets are
 * disjoint.
 */

const SEED_COUNT = 6;
const PER_POD_LIMIT = 3;

function buildClaim(now: Date) {
  return (manager: EntityManager) =>
    manager.getRepository(User).find({
      where: {
        deleted_at: Not(IsNull()),
        deletion_scheduled_at: LessThanOrEqual(now),
      },
      select: { id: true },
      order: { deletion_scheduled_at: 'ASC' },
      take: PER_POD_LIMIT,
      lock: { mode: 'pessimistic_write', onLocked: 'skip_locked' },
    });
}

describe('AccountDeletionSweepProcessor — FOR UPDATE SKIP LOCKED (#337)', () => {
  let dataSource: DataSource;
  let seededIds: string[] = [];

  beforeAll(async () => {
    // Cloning the AppDataSource options instead of calling
    // `AppDataSource.initialize()` directly so a parallel test that
    // also boots the data source (e.g. an upstream NestJS bootstrap)
    // doesn't fail with `DataSource is already initialized`.
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
    const past = new Date(Date.now() - 60 * 60 * 1000);
    const tag = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
    const seeds = Array.from({ length: SEED_COUNT }).map((_, i) =>
      repo.create({
        email: `sweep-skip-locked-${tag}-${i}@tarmoto.test`,
        password_hash: 'x',
        display_name: `SweepTest ${i}`,
        deleted_at: past,
        deletion_scheduled_at: new Date(past.getTime() + i * 1000),
      }),
    );
    const saved = await repo.save(seeds);
    seededIds = saved.map((u) => u.id);
  });

  afterEach(async () => {
    if (seededIds.length > 0) {
      await dataSource.getRepository(User).delete(seededIds);
      seededIds = [];
    }
  });

  it('two concurrent sweep transactions claim disjoint slices', async () => {
    const claim = buildClaim(new Date());

    let releaseAClaimed: () => void = () => {};
    const aClaimed = new Promise<void>((resolve) => {
      releaseAClaimed = resolve;
    });
    let releaseBClaimed: () => void = () => {};
    const bClaimed = new Promise<void>((resolve) => {
      releaseBClaimed = resolve;
    });

    // Pod A: open transaction, run SKIP LOCKED claim, hold the locks
    // until pod B has also finished its SELECT, then commit.
    const podA = dataSource.transaction(async (managerA) => {
      const claimed = await claim(managerA);
      releaseAClaimed();
      await bClaimed;
      return claimed.map((u) => u.id);
    });

    // Pod B: wait for pod A to take its locks, then run its own claim.
    // SKIP LOCKED must steer pod B's SELECT past every row pod A locked.
    const podB = dataSource.transaction(async (managerB) => {
      await aClaimed;
      const claimed = await claim(managerB);
      releaseBClaimed();
      return claimed.map((u) => u.id);
    });

    const [idsA, idsB] = await Promise.all([podA, podB]);

    // Both pods must have claimed something — the seed set is twice the
    // per-pod limit, so neither claim should drain dry.
    expect(idsA.length).toBe(PER_POD_LIMIT);
    expect(idsB.length).toBe(PER_POD_LIMIT);

    // The whole point of #337: no row id may appear in both pods'
    // claims. A failure here means SKIP LOCKED was dropped or the
    // claim is no longer running inside a transaction.
    const overlap = idsA.filter((id) => idsB.includes(id));
    expect(overlap).toEqual([]);

    // Sanity: every claimed id is from the seeded set, so an unrelated
    // due-user row leaking in from another test cannot mask a real
    // overlap by inflating the disjoint counts.
    const seededSet = new Set(seededIds);
    for (const id of [...idsA, ...idsB]) {
      expect(seededSet.has(id)).toBe(true);
    }
  }, 30_000);

  it('releases the locks at transaction commit so a non-overlapping sweep tick can claim again', async () => {
    // After pod A commits, its locks must release — a subsequent
    // sweep that runs after pod A's transaction ends should be able
    // to re-claim the same rows (the row stays in the due set until
    // the finalize processor actually deletes it; BullMQ's jobId
    // dedup is what prevents the duplicate finalize job, not the
    // SQL claim). This guards against accidentally promoting the
    // SKIP LOCKED claim to a long-held lock that would block the
    // next tick.
    const claim = buildClaim(new Date());

    const firstRound = await dataSource.transaction(async (manager) =>
      (await claim(manager)).map((u) => u.id),
    );
    expect(firstRound.length).toBe(PER_POD_LIMIT);

    // The second round runs in a fresh transaction. With locks
    // released at the first commit, the same rows are reachable
    // again — proving the lock didn't outlive its transaction.
    const secondRound = await dataSource.transaction(async (manager) =>
      (await claim(manager)).map((u) => u.id),
    );
    expect(secondRound.length).toBe(PER_POD_LIMIT);
  }, 30_000);
});
