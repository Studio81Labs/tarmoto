import { DataSource, type QueryRunner } from 'typeorm';
import { AppDataSource } from '../src/data-source.js';
import { User } from '../src/entities/user.entity.js';
import { AddGrantEntitlementStorage1836000000000 } from '../src/migrations/1836000000000-AddGrantEntitlementStorage.js';

/**
 * Migration 1836's BACKFILL and its both-or-neither CHECK (#1132).
 *
 * ## Why a real database
 *
 * The backfill's whole risk is which rows it selects, and the CHECK is enforced
 * by PostgreSQL at write time. A mocked repository can exhibit neither. The
 * discriminator in particular is easy to get wrong in a way no unit test would
 * notice: NULL `plan_source` must be treated as a LEGACY PAID subscriber, not a
 * grant, because the column shipped without a backfill in migration 1796.
 * Copying those rows into grants would make every pre-column paid rider
 * permanently un-cancellable.
 *
 * ## Why it drives the migration class directly
 *
 * Same pattern as `reconciliation-resolution-constraint.e2e-spec.ts`: calling
 * the REAL `up()` inside an always-rolled-back transaction means the assertions
 * cannot drift from the implementation, it leaves no trace, and it does not care
 * which migration happens to be last. The columns already exist on the live
 * schema, so `up()` re-runs idempotently and only the backfill does work.
 */
describe('grant entitlement storage (#1132, migration 1836)', () => {
  let dataSource: DataSource;
  const created: string[] = [];

  beforeAll(async () => {
    dataSource = new DataSource(AppDataSource.options);
    await dataSource.initialize();
  }, 30_000);

  afterAll(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
  });

  afterEach(async () => {
    if (created.length) {
      await dataSource.getRepository(User).delete(created.splice(0));
    }
  });

  /** A rider in a given pre-migration shape, with the grant columns cleared. */
  async function seed(
    planSource: string | null,
    tier: string,
  ): Promise<string> {
    const repo = dataSource.getRepository(User);
    const tag = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
    const saved = await repo.save(
      repo.create({
        email: `grant-backfill-${tag}@tarmoto.test`,
        password_hash: 'x',
        display_name: 'GrantBackfill',
      }),
    );
    created.push(saved.id);
    await dataSource.query(
      `UPDATE users
          SET plan_source = $2,
              subscription_tier = $3,
              grant_tier = NULL,
              grant_source = NULL,
              grant_granted_at = NULL
        WHERE id = $1`,
      [saved.id, planSource, tier],
    );
    return saved.id;
  }

  async function readGrant(
    userId: string,
    runner?: QueryRunner,
  ): Promise<{
    grant_tier: string | null;
    grant_source: string | null;
    grant_granted_at: Date | null;
    subscription_tier: string;
  }> {
    const sql = `SELECT grant_tier, grant_source, grant_granted_at, subscription_tier
         FROM users WHERE id = $1`;
    const rows = (await (runner
      ? runner.query(sql, [userId])
      : dataSource.query(sql, [userId]))) as Array<{
      grant_tier: string | null;
      grant_source: string | null;
      grant_granted_at: Date | null;
      subscription_tier: string;
    }>;
    return rows[0]!;
  }

  /** Re-run the real `up()` and roll it back, so only its effects are observed. */
  async function runBackfill(
    assert: (runner: QueryRunner) => Promise<void>,
  ): Promise<void> {
    const runner: QueryRunner = dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    try {
      await new AddGrantEntitlementStorage1836000000000().up(runner);
      await assert(runner);
    } finally {
      await runner.rollbackTransaction();
      await runner.release();
    }
  }

  it('backfills founder, promo and admin grants', async () => {
    const founder = await seed('founder', 'pro');
    const promo = await seed('promo', 'premium');
    const admin = await seed('admin', 'pro');

    await runBackfill(async (runner) => {
      for (const [id, tier, source] of [
        [founder, 'pro', 'founder'],
        [promo, 'premium', 'promo'],
        [admin, 'pro', 'admin'],
      ] as const) {
        const row = await readGrant(id, runner);
        expect(row.grant_tier).toBe(tier);
        expect(row.grant_source).toBe(source);
        expect(row.grant_granted_at).not.toBeNull();
        // EXPAND-ONLY: the subscription side is untouched, which is what makes
        // `max(grant, subscription)` return the pre-migration value.
        expect(row.subscription_tier).toBe(tier);
      }
    });
  }, 30_000);

  it('does NOT treat a NULL plan_source as a grant', async () => {
    // The trap. `plan_source` shipped without a backfill (migration 1796), so
    // null means "predates the column" — a LEGACY PAID subscriber. Copying it
    // into a grant would give them an entitlement nothing can ever revoke.
    const legacyPaid = await seed(null, 'premium');

    await runBackfill(async (runner) => {
      const row = await readGrant(legacyPaid, runner);
      expect(row.grant_tier).toBeNull();
      expect(row.grant_source).toBeNull();
      expect(row.subscription_tier).toBe('premium');
    });
  }, 30_000);

  it('does not backfill paid subscribers or free grant rows', async () => {
    const paid = await seed('subscription', 'premium');
    // A grant of `free` is not a grant: its side could never win the max, so it
    // would only add rows that look granted and entitle nothing.
    const freeGrant = await seed('founder', 'free');

    await runBackfill(async (runner) => {
      for (const id of [paid, freeGrant]) {
        const row = await readGrant(id, runner);
        expect(row.grant_tier).toBeNull();
        expect(row.grant_source).toBeNull();
      }
    });
  }, 30_000);

  it('is idempotent — a second run changes nothing', async () => {
    // `up()` re-runs against a live schema on every deploy attempt, and the
    // backfill has no migration-state of its own to stop it.
    const founder = await seed('founder', 'pro');

    await runBackfill(async (runner) => {
      // Read through the SAME runner: the backfill's writes are uncommitted, so
      // a pooled connection outside this transaction cannot see them.
      const read = async () =>
        (
          (await runner.query(
            `SELECT grant_tier, grant_source FROM users WHERE id = $1`,
            [founder],
          )) as Array<{
            grant_tier: string | null;
            grant_source: string | null;
          }>
        )[0];

      const first = await read();
      await new AddGrantEntitlementStorage1836000000000().up(runner);
      expect(await read()).toEqual(first);
    });
  }, 30_000);

  it('rejects a half-written grant — and `up()` is what creates that guard', async () => {
    // Both-or-neither. A tier with no provenance cannot be audited; provenance
    // with no tier entitles nothing. Either shape means a writer got it
    // half-right, and this turns that into a failed write rather than a rider
    // with an unexplainable entitlement.
    //
    // The constraint is DROPPED first and recreated by the real `up()`. Asserting
    // against the live schema instead would pass no matter what the migration
    // says — the constraint is already there from `db:migrate`, so removing it
    // from the migration file would not fail anything.
    const rider = await seed('subscription', 'free');

    const runner: QueryRunner = dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    try {
      await runner.query(
        `ALTER TABLE users DROP CONSTRAINT IF EXISTS users_grant_complete_check;`,
      );
      // Without the guard the half-written shape is accepted — that is the state
      // `up()` has to fix, and proving it here is what makes the next assertion
      // mean something.
      await runner.query(`UPDATE users SET grant_tier = 'pro' WHERE id = $1`, [
        rider,
      ]);
      await runner.query(`UPDATE users SET grant_tier = NULL WHERE id = $1`, [
        rider,
      ]);

      await new AddGrantEntitlementStorage1836000000000().up(runner);

      // Each violation aborts the transaction (25P02), so the next statement
      // would fail with "current transaction is aborted" rather than the
      // constraint — which would assert nothing. A savepoint per attempt keeps
      // both checks meaningful.
      const expectRejected = async (sql: string): Promise<void> => {
        await runner.query(`SAVEPOINT half_write`);
        await expect(runner.query(sql, [rider])).rejects.toThrow(
          /users_grant_complete_check/i,
        );
        await runner.query(`ROLLBACK TO SAVEPOINT half_write`);
      };

      await expectRejected(`UPDATE users SET grant_tier = 'pro' WHERE id = $1`);
      await expectRejected(
        `UPDATE users SET grant_source = 'admin' WHERE id = $1`,
      );
    } finally {
      await runner.rollbackTransaction();
      await runner.release();
    }

    // The complete shape is accepted, on the live schema.
    await expect(
      dataSource.query(
        `UPDATE users SET grant_tier = 'pro', grant_source = 'admin' WHERE id = $1`,
        [rider],
      ),
    ).resolves.toBeDefined();
  }, 30_000);
});
