import { Test } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import { LocationRetentionSweepProcessor } from './location-retention-sweep.processor.js';
import { JOB_NAMES } from '../jobs.constants.js';

function fakeJob<T = unknown>(
  name: string,
  data: T,
): { id: string; name: string; data: T } {
  return { id: 'job-test', name, data };
}

describe('LocationRetentionSweepProcessor', () => {
  let dataSource: { query: jest.Mock };
  let processor: LocationRetentionSweepProcessor;

  beforeEach(async () => {
    dataSource = { query: jest.fn() };
    const moduleRef = await Test.createTestingModule({
      providers: [
        LocationRetentionSweepProcessor,
        { provide: getDataSourceToken(), useValue: dataSource },
      ],
    }).compile();
    processor = moduleRef.get(LocationRetentionSweepProcessor);
  });

  it('skips users on the `forever` retention bucket', async () => {
    // Every call returns empty so we just exercise the iteration.
    dataSource.query.mockResolvedValue([]);

    await processor.process(
      fakeJob(JOB_NAMES.LOCATION_RETENTION_SWEEP_RUN, {}) as never,
    );

    // The first query for each non-forever bucket selects user_ids by
    // retention. We expect 4 such SELECTs (3months, 6months, 1year,
    // 2years) — but NOT one for `forever`. Then the default-users
    // sweep does its own DELETE/UPDATE. That's 4 SELECTs + 2 statements
    // = 6 calls. The exact number can drift if we add buckets; what
    // matters is that no SELECT mentions `forever`.
    const allCalls = dataSource.query.mock.calls.map(
      (c) => c as [string, unknown[]],
    );
    const userSelects = allCalls.filter(([sql]) =>
      sql.includes('FROM privacy_preferences'),
    );
    expect(userSelects.length).toBeGreaterThanOrEqual(4);
    for (const [, params] of userSelects) {
      expect(params).not.toContain('forever');
    }
  });

  it('purges surface_readings and rides for users on each retention bucket', async () => {
    // 3months bucket: returns one user (`u-3m`).
    // 6months bucket: returns one user (`u-6m`).
    // 1year, 2years: empty.
    // Default-users SELECT/DELETE: empty.
    dataSource.query.mockImplementation((sql: string, params: unknown[]) => {
      if (sql.includes('FROM privacy_preferences WHERE')) {
        if ((params[0] as string) === '3months') {
          return Promise.resolve([{ user_id: 'u-3m' }]);
        }
        if ((params[0] as string) === '6months') {
          return Promise.resolve([{ user_id: 'u-6m' }]);
        }
        return Promise.resolve([]);
      }
      if (sql.includes('DELETE FROM surface_readings')) {
        // Default-user branch (LEFT JOIN privacy_preferences pp, no
        // user_id array param) — empty for this test.
        if (sql.includes('LEFT JOIN privacy_preferences')) {
          return Promise.resolve([]);
        }
        // The 3m bucket returns 5 rows, the 6m bucket returns 2 rows.
        const userIds = params[0] as string[];
        if (Array.isArray(userIds) && userIds.includes('u-3m')) {
          return Promise.resolve([
            { user_id: 'u-3m' },
            { user_id: 'u-3m' },
            { user_id: 'u-3m' },
            { user_id: 'u-3m' },
            { user_id: 'u-3m' },
          ]);
        }
        if (Array.isArray(userIds) && userIds.includes('u-6m')) {
          return Promise.resolve([{ user_id: 'u-6m' }, { user_id: 'u-6m' }]);
        }
        return Promise.resolve([]);
      }
      if (sql.includes('UPDATE rides')) {
        if (sql.includes('LEFT JOIN privacy_preferences')) {
          return Promise.resolve([]);
        }
        const userIds = params[0] as string[];
        if (Array.isArray(userIds) && userIds.includes('u-3m')) {
          return Promise.resolve([{ user_id: 'u-3m' }]);
        }
        return Promise.resolve([]);
      }
      return Promise.resolve([]);
    });

    const result = await processor.process(
      fakeJob(JOB_NAMES.LOCATION_RETENTION_SWEEP_RUN, {}) as never,
    );

    expect(result.surface_readings_deleted).toBe(7);
    expect(result.ride_geoms_cleared).toBe(1);
    expect(result.users_swept).toBe(2);
  });

  it('uses date arithmetic that produces a cutoff in the past for a 90-day window', async () => {
    // We can't easily mock `new Date()` without timefreeze, so instead
    // assert that the cutoff parameter passed to the DELETE is a Date
    // that is at least 89 days in the past — this catches a regression
    // where someone accidentally adds days instead of subtracts.
    dataSource.query.mockImplementation((sql: string, params: unknown[]) => {
      if (sql.includes('FROM privacy_preferences WHERE')) {
        return (params[0] as string) === '3months'
          ? Promise.resolve([{ user_id: 'u-1' }])
          : Promise.resolve([]);
      }
      return Promise.resolve([]);
    });

    await processor.process(
      fakeJob(JOB_NAMES.LOCATION_RETENTION_SWEEP_RUN, {}) as never,
    );

    const calls = dataSource.query.mock.calls as Array<[string, unknown[]]>;
    const deleteCall = calls.find((c) =>
      c[0].includes('DELETE FROM surface_readings'),
    );
    expect(deleteCall).toBeDefined();
    const cutoff = deleteCall![1][1] as Date;
    const ageMs = Date.now() - cutoff.getTime();
    expect(ageMs).toBeGreaterThan(89 * 24 * 60 * 60 * 1000);
    expect(ageMs).toBeLessThan(91 * 24 * 60 * 60 * 1000);
  });

  it('falls back to the default 1-year window for users with no privacy_preferences row', async () => {
    dataSource.query.mockImplementation((sql: string) => {
      if (sql.includes('FROM privacy_preferences WHERE')) {
        return Promise.resolve([]);
      }
      if (
        sql.includes('DELETE FROM surface_readings sr') &&
        sql.includes('LEFT JOIN privacy_preferences pp')
      ) {
        return Promise.resolve([
          { user_id: 'default-1' },
          { user_id: 'default-2' },
        ]);
      }
      return Promise.resolve([]);
    });

    const result = await processor.process(
      fakeJob(JOB_NAMES.LOCATION_RETENTION_SWEEP_RUN, {}) as never,
    );

    expect(result.surface_readings_deleted).toBe(2);
    expect(result.users_swept).toBe(2);
  });
});
