import { DataSource, type QueryRunner } from 'typeorm';
import { AppDataSource } from '../src/data-source.js';
import { User } from '../src/entities/user.entity.js';
import { StoreBillingReconciliation } from '../src/entities/store-billing-reconciliation.entity.js';
import { AddReconciliationRetirementResolutions1834000000000 } from '../src/migrations/1834000000000-AddReconciliationRetirementResolutions.js';

/**
 * `sbr_resolution_check` — the accepted-value whitelist and its lossy rollback.
 *
 * ## Why a real database
 *
 * Both properties under test are enforced by PostgreSQL at write time: a CHECK
 * constraint's whitelist, and whether a rollback survives rows that only the new
 * constraint permits. A mocked repository cannot exhibit either.
 *
 * ## Why it drives the migration class directly
 *
 * The `down()` test calls the REAL migration method rather than re-issuing its
 * SQL, so it cannot drift from the implementation, and runs inside a transaction
 * that is always rolled back — so it needs no migration-state juggling, leaves no
 * trace, and does not care which migration happens to be last. An
 * `undoLastMigration()`-based test would break the moment a later migration
 * lands, and would leave the database reverted if it failed midway.
 */
describe('sbr_resolution_check (#1138, migration 1834)', () => {
  let dataSource: DataSource;
  let userId: string;

  const ORIGINAL = [
    'rider_canceled',
    'refunded',
    'expired',
    'server_canceled',
  ] as const;
  const RETIREMENT = [
    'superseded_by_claim',
    'claimed_on_drain',
    'stale_on_drain',
    'purchase_inactive',
  ] as const;

  beforeAll(async () => {
    dataSource = new DataSource(AppDataSource.options);
    await dataSource.initialize();
  }, 30_000);

  afterAll(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
  });

  beforeEach(async () => {
    const repo = dataSource.getRepository(User);
    const tag = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
    const saved = await repo.save(
      repo.create({
        email: `sbr-resolution-${tag}@tarmoto.test`,
        password_hash: 'x',
        display_name: 'SbrTest',
      }),
    );
    userId = saved.id;
  });

  afterEach(async () => {
    if (userId) {
      // Reconciliation rows cascade with the rider.
      await dataSource.getRepository(User).delete(userId);
    }
  });

  async function insertResolved(
    runner: QueryRunner | null,
    resolution: string,
  ): Promise<void> {
    const sql = `INSERT INTO store_billing_reconciliations
        (user_id, provider, reason, status, resolution, resolved_at)
      VALUES ($1, 'apple', 'exclusivity_conflict', 'resolved', $2, now())`;
    if (runner) await runner.query(sql, [userId, resolution]);
    else await dataSource.query(sql, [userId, resolution]);
  }

  it('accepts all EIGHT resolutions after the migration', async () => {
    for (const value of [...ORIGINAL, ...RETIREMENT]) {
      await expect(insertResolved(null, value)).resolves.toBeUndefined();
    }
    const rows = await dataSource
      .getRepository(StoreBillingReconciliation)
      .find({ where: { user_id: userId } });
    expect(rows).toHaveLength(8);
  }, 30_000);

  it('rejects a value outside the whitelist', async () => {
    // The whitelist is the point of the constraint: a typo'd or invented
    // resolution must not reach the drain queue as an unrecognised state.
    await expect(insertResolved(null, 'not_a_real_value')).rejects.toThrow(
      /sbr_resolution_check/i,
    );
  }, 30_000);

  it('down() reverts a POPULATED table without error, NULLing only the new values', async () => {
    // The regression that matters: re-adding the narrow constraint errors
    // outright if any row still carries a retirement value, which would leave a
    // rollback stuck half-done.
    await insertResolved(null, 'refunded'); // original — must survive
    await insertResolved(null, 'superseded_by_claim'); // new — must become NULL

    const runner = dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    try {
      const migration =
        new AddReconciliationRetirementResolutions1834000000000();
      await migration.down(runner);

      const after = (await runner.query(
        `SELECT resolution FROM store_billing_reconciliations WHERE user_id = $1
          ORDER BY resolution NULLS LAST`,
        [userId],
      )) as Array<{ resolution: string | null }>;
      expect(after.map((r) => r.resolution)).toEqual(['refunded', null]);

      // And the constraint really did narrow — the value that was legal a moment
      // ago is now refused.
      await expect(
        insertResolved(runner, 'superseded_by_claim'),
      ).rejects.toThrow(/sbr_resolution_check/i);
    } finally {
      // Always roll back: the point is to exercise `down()`, not to leave the
      // schema reverted for whatever runs next.
      await runner.rollbackTransaction();
      await runner.release();
    }

    // Outside the transaction nothing changed — the wide constraint is intact.
    await expect(
      insertResolved(null, 'claimed_on_drain'),
    ).resolves.toBeUndefined();
  }, 30_000);

  it('down() drops the wide constraint BEFORE cleaning, so writers are locked out', async () => {
    // Statement ORDER is the concurrency fix and cannot be observed from a
    // single-threaded test any other way. `DROP CONSTRAINT` takes ACCESS
    // EXCLUSIVE, which the migration's transaction holds to commit; doing the
    // cleanup UPDATE first takes only ROW EXCLUSIVE, leaving a window in which a
    // concurrent writer can insert a retirement value that the narrow constraint
    // then rejects — rolling the whole rollback back.
    const runner = dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    const statements: string[] = [];
    const realQuery = runner.query.bind(runner);
    runner.query = ((sql: string, params?: unknown[]) => {
      statements.push(sql);
      return realQuery(sql, params);
    }) as typeof runner.query;
    try {
      await new AddReconciliationRetirementResolutions1834000000000().down(
        runner,
      );
    } finally {
      await runner.rollbackTransaction();
      await runner.release();
    }

    const dropAt = statements.findIndex((s) => /DROP CONSTRAINT/i.test(s));
    const cleanAt = statements.findIndex((s) =>
      /UPDATE store_billing/i.test(s),
    );
    const addAt = statements.findIndex((s) => /ADD CONSTRAINT/i.test(s));
    expect(dropAt).toBeGreaterThanOrEqual(0);
    expect(dropAt).toBeLessThan(cleanAt);
    expect(cleanAt).toBeLessThan(addAt);
  }, 30_000);
});
