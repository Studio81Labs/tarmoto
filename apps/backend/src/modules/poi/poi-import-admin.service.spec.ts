// Stub `node:fs/promises` so `stat()` is deterministic per test. This is the
// seam `PoiImportAdminService` uses for extract-file presence instead of a
// constructor-injected `fs` param: Nest resolves EVERY constructor parameter
// from its DI container, so an object-literal-typed param has no provider —
// Nest would inject `undefined` (silently overriding any JS default) instead
// of the real `fs/promises.stat`, crashing the service at runtime. Mocking
// the module here (mirrors the existing `node:fs` stub in
// poi-import.service.spec.ts) sidesteps that: the constructor only takes
// Nest-resolvable params, and this file drives `stat` directly.
jest.mock('node:fs/promises', () => ({ stat: jest.fn() }));

import { stat } from 'node:fs/promises';
import { PoiImportAdminService } from './poi-import-admin.service.js';
import type { PoiImportRun } from '../../entities/poi-import-run.entity.js';

const statMock = jest.mocked(stat);

/** Minimal `PoiImportService` test double — only the surface
 *  `PoiImportAdminService` reads (`source`, `regions`, `getExtractPath`). */
function makeImporter(
  over: {
    source?: string;
    regions?: { code: string; bbox: unknown }[];
    getExtractPath?: (code: string) => string;
  } = {},
) {
  return {
    source: 'osm',
    regions: [{ code: 'CZ', bbox: {} }],
    getExtractPath: (code: string) => `/extracts/${code}.osm`,
    ...over,
  };
}

describe('PoiImportAdminService', () => {
  beforeEach(() => {
    statMock.mockReset();
  });

  describe('manualJobId', () => {
    it('is deterministic and strips the reserved `:` delimiter to `_`', () => {
      const svc = new PoiImportAdminService(
        [] as never,
        {} as never,
        {} as never,
        {} as never,
      );

      expect(svc.manualJobId('osm', 'CZ')).toBe('import-region_manual_osm_CZ');
      expect(svc.manualJobId('fsq', 'CZ')).toBe('import-region_manual_fsq_CZ');
      // Deterministic — the (later) write-side enqueue must derive the exact
      // same id for `queue.getJob` here to ever find it.
      expect(svc.manualJobId('osm', 'CZ')).toBe(svc.manualJobId('osm', 'CZ'));
    });
  });

  describe('listRegionStatus', () => {
    it('assembles status per (source, region) with counts, coverage, extract, live state', async () => {
      const dataSource = {
        query: jest.fn((sql: string) => {
          if (sql.includes('poi_import_regions'))
            return [{ code: 'CZ', imported_at: '2026-07-10T00:00:00Z' }];
          if (sql.toLowerCase().includes('group by'))
            return [{ source: 'osm', import_region: 'CZ', n: '42' }];
          return [];
        }),
      };
      const runsRepo = { findOne: jest.fn().mockResolvedValue(null) };
      const queue = { getJob: jest.fn().mockResolvedValue(null) };
      statMock.mockResolvedValueOnce({
        size: 10,
        mtimeMs: 1_720_000_000_000,
      } as never);

      const svc = new PoiImportAdminService(
        [makeImporter()] as never,
        dataSource as never,
        runsRepo as never,
        queue as never,
      );

      const rows = await svc.listRegionStatus();

      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        source: 'osm',
        code: 'CZ',
        configured: true,
        poi_count: 42,
        // toISOString() always emits milliseconds, even for a millisecond-less input.
        imported_at: '2026-07-10T00:00:00.000Z',
        live_state: 'idle',
        last_run: null,
      });
      expect(rows[0]?.extract).toMatchObject({
        present: true,
        size_bytes: 10,
        modified_at: new Date(1_720_000_000_000).toISOString(),
      });
      // The two bulk queries run ONCE each, up front — not once per
      // (source, region) pair — and take no params (both scan/group across
      // every row rather than filtering to one region).
      expect(dataSource.query).toHaveBeenCalledTimes(2);
      expect(dataSource.query).toHaveBeenCalledWith(
        expect.stringContaining('poi_import_regions'),
      );
      expect(dataSource.query).toHaveBeenCalledWith(
        expect.stringContaining('GROUP BY'),
      );
    });

    it('reports live_state running when the queue has an active job, and extract: null on ENOENT', async () => {
      const dataSource = { query: jest.fn().mockResolvedValue([]) };
      const runsRepo = { findOne: jest.fn().mockResolvedValue(null) };
      const job = { getState: jest.fn().mockResolvedValue('active') };
      const queue = { getJob: jest.fn().mockResolvedValue(job) };
      statMock.mockRejectedValueOnce(
        Object.assign(new Error('nope'), { code: 'ENOENT' }),
      );

      const svc = new PoiImportAdminService(
        [makeImporter()] as never,
        dataSource as never,
        runsRepo as never,
        queue as never,
      );

      const rows = await svc.listRegionStatus();

      expect(rows[0]?.live_state).toBe('running');
      expect(rows[0]?.extract).toBeNull();
      // Probed with the SAME deterministic id `manualJobId` derives.
      expect(queue.getJob).toHaveBeenCalledWith(svc.manualJobId('osm', 'CZ'));
    });

    it('reports live_state queued when the job is waiting/delayed/prioritized', async () => {
      const dataSource = { query: jest.fn().mockResolvedValue([]) };
      const runsRepo = { findOne: jest.fn().mockResolvedValue(null) };
      const job = { getState: jest.fn().mockResolvedValue('waiting') };
      const queue = { getJob: jest.fn().mockResolvedValue(job) };
      statMock.mockRejectedValueOnce(
        Object.assign(new Error('nope'), { code: 'ENOENT' }),
      );

      const svc = new PoiImportAdminService(
        [makeImporter()] as never,
        dataSource as never,
        runsRepo as never,
        queue as never,
      );

      const rows = await svc.listRegionStatus();

      expect(rows[0]?.live_state).toBe('queued');
    });

    it('reports a completed/failed/unknown job state as idle (only active/waiting/delayed/prioritized are live)', async () => {
      const dataSource = { query: jest.fn().mockResolvedValue([]) };
      const runsRepo = { findOne: jest.fn().mockResolvedValue(null) };
      const job = { getState: jest.fn().mockResolvedValue('completed') };
      const queue = { getJob: jest.fn().mockResolvedValue(job) };
      statMock.mockRejectedValueOnce(
        Object.assign(new Error('nope'), { code: 'ENOENT' }),
      );

      const svc = new PoiImportAdminService(
        [makeImporter()] as never,
        dataSource as never,
        runsRepo as never,
        queue as never,
      );

      const rows = await svc.listRegionStatus();

      expect(rows[0]?.live_state).toBe('idle');
    });

    it('reports the most recent poi_import_runs row as last_run, ISO-serialized', async () => {
      const dataSource = { query: jest.fn().mockResolvedValue([]) };
      const runRow: Partial<PoiImportRun> = {
        id: '7',
        source: 'osm',
        region_code: 'CZ',
        status: 'success',
        trigger: 'cron',
        fetched: 10,
        upserted: 9,
        tombstoned: 1,
        skip_reason: null,
        error: null,
        started_at: new Date('2026-07-01T00:00:00Z'),
        finished_at: new Date('2026-07-01T00:05:00Z'),
      };
      const runsRepo = { findOne: jest.fn().mockResolvedValue(runRow) };
      const queue = { getJob: jest.fn().mockResolvedValue(null) };
      statMock.mockRejectedValueOnce(
        Object.assign(new Error('nope'), { code: 'ENOENT' }),
      );

      const svc = new PoiImportAdminService(
        [makeImporter()] as never,
        dataSource as never,
        runsRepo as never,
        queue as never,
      );

      const rows = await svc.listRegionStatus();

      expect(rows[0]?.last_run).toEqual({
        id: '7',
        source: 'osm',
        region_code: 'CZ',
        status: 'success',
        trigger: 'cron',
        fetched: 10,
        upserted: 9,
        tombstoned: 1,
        skip_reason: null,
        error: null,
        started_at: '2026-07-01T00:00:00.000Z',
        finished_at: '2026-07-01T00:05:00.000Z',
      });
      expect(runsRepo.findOne).toHaveBeenCalledWith({
        where: { source: 'osm', region_code: 'CZ' },
        order: { started_at: 'DESC', id: 'DESC' },
      });
    });

    it('assembles one row per (source, region) across multiple importers/regions, in registry order, scoping coverage to OSM only and counts per (source, region)', async () => {
      const dataSource = {
        query: jest.fn((sql: string) => {
          if (sql.includes('poi_import_regions'))
            return [{ code: 'CZ', imported_at: '2026-07-10T00:00:00Z' }];
          if (sql.toLowerCase().includes('group by'))
            return [
              { source: 'osm', import_region: 'CZ', n: '42' },
              { source: 'osm', import_region: 'SK', n: '7' },
              { source: 'fsq', import_region: 'CZ', n: '13' },
            ];
          return [];
        }),
      };
      const runsRepo = { findOne: jest.fn().mockResolvedValue(null) };
      const queue = { getJob: jest.fn().mockResolvedValue(null) };
      statMock.mockRejectedValue(
        Object.assign(new Error('nope'), { code: 'ENOENT' }),
      );

      const osm = makeImporter({
        source: 'osm',
        regions: [
          { code: 'CZ', bbox: {} },
          { code: 'SK', bbox: {} },
        ],
      });
      const fsq = makeImporter({
        source: 'fsq',
        regions: [{ code: 'CZ', bbox: {} }],
      });
      const svc = new PoiImportAdminService(
        [osm, fsq] as never,
        dataSource as never,
        runsRepo as never,
        queue as never,
      );

      const rows = await svc.listRegionStatus();

      expect(rows.map((r) => [r.source, r.code])).toEqual([
        ['osm', 'CZ'],
        ['osm', 'SK'],
        ['fsq', 'CZ'],
      ]);

      const [osmCz, osmSk, fsqCz] = rows;
      // OSM/CZ keeps the coverage stamp `poi_import_regions` has for CZ...
      expect(osmCz?.imported_at).toBe('2026-07-10T00:00:00.000Z');
      // ...OSM/SK has no coverage row in the mock, so it's uncovered...
      expect(osmSk?.imported_at).toBeNull();
      // ...and FSQ/CZ must NOT reuse OSM/CZ's stamp for the SAME region code
      // — `poi_import_regions` has no `source` column, so without the
      // source-scope check every non-OSM row would falsely inherit
      // whatever OSM's own coverage says (#847 review, fix 1).
      expect(fsqCz?.imported_at).toBeNull();

      // Each row's poi_count comes from the grouped (source, import_region)
      // map, not a shared/misattributed count.
      expect(osmCz?.poi_count).toBe(42);
      expect(osmSk?.poi_count).toBe(7);
      expect(fsqCz?.poi_count).toBe(13);

      // Both bulk queries run exactly once regardless of how many (source,
      // region) pairs exist — 2 calls total, not 2-per-pair (6) — proving
      // the N+1 fix (#847 review, fix 2).
      expect(dataSource.query).toHaveBeenCalledTimes(2);
    });
  });

  describe('listRuns', () => {
    function makeQb(rows: Partial<PoiImportRun>[]) {
      const qb: Record<string, jest.Mock> = {};
      for (const m of ['orderBy', 'addOrderBy', 'limit', 'andWhere']) {
        qb[m] = jest.fn().mockReturnValue(qb);
      }
      qb.getMany = jest.fn().mockResolvedValue(rows);
      return qb;
    }

    const RUN_ROW: Partial<PoiImportRun> = {
      id: '3',
      source: 'osm',
      region_code: 'CZ',
      status: 'failed',
      trigger: 'manual',
      fetched: null,
      upserted: null,
      tombstoned: null,
      skip_reason: null,
      error: 'boom',
      started_at: new Date('2026-07-05T00:00:00Z'),
      finished_at: null,
    };

    it('orders newest-first, applies the limit, and maps rows to RunSummary (finished_at null passthrough)', async () => {
      const qb = makeQb([RUN_ROW]);
      const runsRepo = { createQueryBuilder: jest.fn().mockReturnValue(qb) };
      const svc = new PoiImportAdminService(
        [] as never,
        {} as never,
        runsRepo as never,
        {} as never,
      );

      const out = await svc.listRuns({ limit: 20 });

      expect(runsRepo.createQueryBuilder).toHaveBeenCalledWith('r');
      expect(qb.orderBy).toHaveBeenCalledWith('r.started_at', 'DESC');
      expect(qb.addOrderBy).toHaveBeenCalledWith('r.id', 'DESC');
      expect(qb.limit).toHaveBeenCalledWith(20);
      expect(qb.andWhere).not.toHaveBeenCalled();
      expect(out).toEqual([
        {
          id: '3',
          source: 'osm',
          region_code: 'CZ',
          status: 'failed',
          trigger: 'manual',
          fetched: null,
          upserted: null,
          tombstoned: null,
          skip_reason: null,
          error: 'boom',
          started_at: '2026-07-05T00:00:00.000Z',
          finished_at: null,
        },
      ]);
    });

    it('applies source + code filters as separate andWhere clauses when provided', async () => {
      const qb = makeQb([]);
      const runsRepo = { createQueryBuilder: jest.fn().mockReturnValue(qb) };
      const svc = new PoiImportAdminService(
        [] as never,
        {} as never,
        runsRepo as never,
        {} as never,
      );

      await svc.listRuns({ source: 'fsq', code: 'SK', limit: 5 });

      expect(qb.andWhere).toHaveBeenCalledWith('r.source = :source', {
        source: 'fsq',
      });
      expect(qb.andWhere).toHaveBeenCalledWith('r.region_code = :code', {
        code: 'SK',
      });
    });
  });
});
