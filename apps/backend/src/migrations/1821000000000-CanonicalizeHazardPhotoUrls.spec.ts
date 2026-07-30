import { QueryRunner } from 'typeorm';
import { CanonicalizeHazardPhotoUrls1821000000000 } from './1821000000000-CanonicalizeHazardPhotoUrls.js';

/**
 * Unit test for the photo-URL backfill: a fake `QueryRunner` returns a set of
 * rows on the SELECT and records the UPDATEs the migration issues, so we can
 * assert exactly which rows were rewritten and to what canonical value.
 */
function makeQueryRunner(rows: Array<{ id: string; photo_url: string }>): {
  runner: QueryRunner;
  updates: Array<{ url: string; id: string }>;
} {
  const updates: Array<{ url: string; id: string }> = [];
  const runner = {
    query: jest.fn((sql: string, params?: unknown[]) => {
      if (sql.trim().startsWith('SELECT')) return Promise.resolve(rows);
      if (sql.trim().startsWith('UPDATE')) {
        const [url, id] = params as [string, string];
        updates.push({ url, id });
        return Promise.resolve(undefined);
      }
      return Promise.resolve(undefined);
    }),
  } as unknown as QueryRunner;
  return { runner, updates };
}

describe('CanonicalizeHazardPhotoUrls1821000000000', () => {
  const migration = new CanonicalizeHazardPhotoUrls1821000000000();

  it('rewrites query-stringed and percent-encoded managed URLs to canonical form', async () => {
    const { runner, updates } = makeQueryRunner([
      // Query string dropped.
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
      {
        id: 'a',
        url: 'http://localhost:3000/uploads/hazard-photos/user-1-1700000000000-a.jpg',
      },
      {
        id: 'b',
        url: 'http://localhost:3000/uploads/hazard-photos/user-1-1700000000000-b.jpg',
      },
    ]);
  });

  it('leaves already-canonical URLs untouched (idempotent)', async () => {
    const { runner, updates } = makeQueryRunner([
      {
        id: 'c',
        photo_url:
          'http://localhost:3000/uploads/hazard-photos/user-1-1700000000000-c.jpg',
      },
    ]);

    await migration.up(runner);

    expect(updates).toEqual([]);
  });
});
