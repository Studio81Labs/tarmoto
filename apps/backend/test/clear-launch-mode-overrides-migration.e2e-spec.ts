import { DataSource } from 'typeorm';
import { AppDataSource } from '../src/data-source.js';
import { ClearLaunchModeOverrides1839000000000 } from '../src/migrations/1839000000000-ClearLaunchModeOverrides.js';

/**
 * Behavioral proof of migration 1839's operator-override scoping (#1104,
 * Codex review on PR #1287).
 *
 * The migration's own unit spec (`1839000000000-ClearLaunchModeOverrides.
 * spec.ts`) only text-matches the SQL against a mocked `queryRunner` — it
 * cannot prove the WHERE clause actually discriminates an untouched launch
 * seed from an operator-modified row, since the mock never evaluates SQL.
 * That distinction is exactly what the Codex review flagged as unverified:
 * a DELETE scoped by feature name alone would silently destroy a live
 * incident `force_off` or a deliberate operator limit. This suite proves it
 * against real Postgres CHECK/UNIQUE constraints and real WHERE-clause
 * evaluation.
 *
 * ## Why this calls `up()` directly rather than reverting/re-running the chain
 *
 * By the time this suite runs, migration 1839 has already executed once as
 * part of `pnpm db:migrate` building the from-zero database (see the
 * `store-subscription-chains-schema.e2e-spec.ts` header for why that's the
 * shape of this CI job) — so the nine seeded rows are already gone. Rather
 * than reverting and replaying the whole migration chain, each test inserts
 * the exact fixture shape it needs (an untouched launch seed, or an
 * operator-modified row) and calls the migration's `up()` directly against
 * a real `QueryRunner`. `up()` is a plain idempotent DELETE, so calling it
 * again after the chain has already run is exactly what the migration
 * itself guarantees is safe.
 *
 * Running it: `pnpm db:up && pnpm db:migrate && pnpm --filter @tarmoto/backend test:e2e -- clear-launch-mode-overrides-migration`
 */
describe('ClearLaunchModeOverrides migration — operator-override scoping (e2e, real Postgres, #1104)', () => {
  let dataSource: DataSource;

  beforeAll(async () => {
    dataSource = new DataSource(AppDataSource.options);
    await dataSource.initialize();
  }, 30_000);

  afterAll(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
  });

  afterEach(async () => {
    // Leave the from-zero database exactly as migration 1839 itself left
    // it — the other e2e specs in the same CI job run against this same
    // database and must not see leftover fixture rows.
    await dataSource.query(
      `DELETE FROM feature_states WHERE feature IN ('gpx_export', 'group_rides')`,
    );
    await dataSource.query(
      `DELETE FROM limit_states WHERE feature IN ('max_active_trips', 'max_trip_collaborators')`,
    );
  });

  it('deletes an untouched seeded feature_states row but preserves an operator-modified one', async () => {
    const queryRunner = dataSource.createQueryRunner();
    try {
      // Untouched launch seed — exact shape migration 1795 wrote, no
      // operator actor.
      await queryRunner.query(
        `INSERT INTO feature_states (feature, state, reason)
         VALUES ('gpx_export', 'force_on', 'Launch mode: keep pre-entitlement access open until tier enforcement goes live.')
         ON CONFLICT (feature) DO UPDATE SET
           state = EXCLUDED.state, reason = EXCLUDED.reason, updated_by = NULL`,
      );
      // Operator-modified row — same feature an admin `setGlobalState`
      // write updates IN PLACE: an incident force_off, with an actor
      // stamped, exactly like AdminFlagsService.setGlobalState does.
      await queryRunner.query(
        `INSERT INTO feature_states (feature, state, reason, updated_by)
         VALUES ('group_rides', 'force_off', 'incident: abuse wave', gen_random_uuid())
         ON CONFLICT (feature) DO UPDATE SET
           state = EXCLUDED.state, reason = EXCLUDED.reason, updated_by = EXCLUDED.updated_by`,
      );

      await new ClearLaunchModeOverrides1839000000000().up(queryRunner);

      const rows = await dataSource.query<
        { feature: string; state: string; reason: string }[]
      >(
        `SELECT feature, state, reason FROM feature_states
         WHERE feature IN ('gpx_export', 'group_rides')`,
      );
      expect(rows.map((r) => r.feature)).toEqual(['group_rides']);
      expect(rows[0]).toMatchObject({
        state: 'force_off',
        reason: 'incident: abuse wave',
      });
    } finally {
      await queryRunner.release();
    }
  });

  it('deletes an untouched seeded limit_states row but preserves an operator-modified one', async () => {
    const queryRunner = dataSource.createQueryRunner();
    try {
      // Untouched launch seed — exact shape migration 1813 wrote.
      await queryRunner.query(
        `INSERT INTO limit_states (feature, value, reason)
         VALUES ('max_active_trips', NULL, 'Launch mode: unlimited for everyone until tier enforcement goes live.')
         ON CONFLICT (feature) DO UPDATE SET
           value = EXCLUDED.value, reason = EXCLUDED.reason, updated_by = NULL`,
      );
      // Operator-modified row — a deliberate finite cap set through
      // AdminLimitsService.setGlobalValue, actor stamped.
      await queryRunner.query(
        `INSERT INTO limit_states (feature, value, reason, updated_by)
         VALUES ('max_trip_collaborators', 3, 'operator: temporary cap', gen_random_uuid())
         ON CONFLICT (feature) DO UPDATE SET
           value = EXCLUDED.value, reason = EXCLUDED.reason, updated_by = EXCLUDED.updated_by`,
      );

      await new ClearLaunchModeOverrides1839000000000().up(queryRunner);

      const rows = await dataSource.query<
        { feature: string; value: number | null; reason: string }[]
      >(
        `SELECT feature, value, reason FROM limit_states
         WHERE feature IN ('max_active_trips', 'max_trip_collaborators')`,
      );
      expect(rows.map((r) => r.feature)).toEqual(['max_trip_collaborators']);
      expect(rows[0]).toMatchObject({
        value: 3,
        reason: 'operator: temporary cap',
      });
    } finally {
      await queryRunner.release();
    }
  });

  it('is safe to re-run against an already-cleared database (idempotent, matches the from-zero chain)', async () => {
    const queryRunner = dataSource.createQueryRunner();
    try {
      // By this point in the job, the chain already ran 1839 once and
      // these keys carry no rows — up() must not error on an empty match.
      await expect(
        new ClearLaunchModeOverrides1839000000000().up(queryRunner),
      ).resolves.toBeUndefined();
    } finally {
      await queryRunner.release();
    }
  });
});
