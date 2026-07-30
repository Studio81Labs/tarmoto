import { QueryRunner } from 'typeorm';
import { CanonicalizeHazardPhotoUrls1821000000000 } from './1821000000000-CanonicalizeHazardPhotoUrls.js';

/**
 * Unit test for the `photo_filename` backfill: a fake `QueryRunner` returns a
 * set of rows on the keyset SELECT and records the `photo_filename` UPDATEs the
 * migration issues, so we can assert exactly which rows were populated and with
 * what filename. DDL (ADD COLUMN / CREATE INDEX) is a no-op here.
 */
function makeQueryRunner(rows: Array<{ id: string; photo_url: string }>): {
  runner: QueryRunner;
  updates: Array<{ filename: string; id: string }>;
} {
  const updates: Array<{ filename: string; id: string }> = [];
  const runner = {
    query: jest.fn((sql: string, params?: unknown[]) => {
      const trimmed = sql.trim();
      if (trimmed.startsWith('SELECT')) {
        // Keyset paging: first param is `afterId`; return everything after it.
        const afterId = (params as [string, number])[0];
        return Promise.resolve(rows.filter((r) => r.id > afterId));
      }
      if (trimmed.startsWith('UPDATE')) {
        const [filename, id] = params as [string, string];
        updates.push({ filename, id });
        return Promise.resolve(undefined);
      }
      // ALTER TABLE / CREATE INDEX
      return Promise.resolve(undefined);
    }),
  } as unknown as QueryRunner;
  return { runner, updates };
}

describe('CanonicalizeHazardPhotoUrls1821000000000', () => {
  const migration = new CanonicalizeHazardPhotoUrls1821000000000();

  it('backfills the decoded filename for managed rows (query string / encoding independent)', async () => {
    const { runner, updates } = makeQueryRunner([
      // Query string is ignored — the filename is what matters.
      {
        id: 'a',
        photo_url:
          'http://localhost:3000/uploads/hazard-photos/user-1-1700000000000-a.jpg?v=2',
      },
      // Percent-encoded hyphen decoded.
      {
        id: 'b',
        photo_url:
          'http://localhost:3000/uploads/hazard-photos/user%2D1-1700000000000-b.jpg',
      },
    ]);

    await migration.up(runner);

    expect(updates).toEqual([
      { id: 'a', filename: 'user-1-1700000000000-a.jpg' },
      { id: 'b', filename: 'user-1-1700000000000-b.jpg' },
    ]);
  });

  it('never derives a filename from a third-party URL sharing the managed path', async () => {
    // A signed CDN URL whose origin is NOT ours stays photo_filename = NULL and
    // its photo_url is never read into an identity — no UPDATE issued.
    const { runner, updates } = makeQueryRunner([
      {
        id: 'c',
        photo_url:
          'https://cdn.example.com/uploads/hazard-photos/asset%2Ekey.jpg?signature=abc123&exp=999',
      },
    ]);

    await migration.up(runner);

    expect(updates).toEqual([]);
  });

  it('creates the partial index and adds the column', async () => {
    const { runner } = makeQueryRunner([]);
    await migration.up(runner);

    const calls = (runner.query as jest.Mock).mock.calls as Array<[string]>;
    const statements = calls.map((c) => c[0].replace(/\s+/g, ' ').trim());
    expect(
      statements.some((s) =>
        s.includes('ADD COLUMN IF NOT EXISTS photo_filename'),
      ),
    ).toBe(true);
    expect(
      statements.some((s) =>
        s.includes(
          'CREATE INDEX IF NOT EXISTS idx_hazard_reports_photo_filename',
        ),
      ),
    ).toBe(true);
  });
});
