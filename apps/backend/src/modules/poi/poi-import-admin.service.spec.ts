// Stub `stat` from `node:fs/promises` so extract-file presence is
// deterministic per test — the seam `PoiImportAdminService` uses instead of a
// constructor-injected `fs` param: Nest resolves EVERY constructor parameter
// from its DI container, so an object-literal-typed param has no provider —
// Nest would inject `undefined` (silently overriding any JS default) instead
// of the real `fs/promises.stat`, crashing the service at runtime. Mocking
// the module here (mirrors the existing `node:fs` stub in
// poi-import.service.spec.ts) sidesteps that: the constructor only takes
// Nest-resolvable params, and this file drives `stat` directly.
//
// `open` and `rename` are ALSO wrapped (`jest.fn(actual.X)`, not left as bare
// `actual.X`) rather than passed through untouched: by default they still
// call straight through to the real implementation, so every existing test
// below keeps exercising a REAL temp directory (`storeExtract`'s
// atomic-upload tests cover write → fsync → atomic rename, cleanup on
// failure — a genuine filesystem property, not something a mock can stand
// in for) — but wrapping makes them individually spy-able so ONE test
// (the fsync-ordering regression test, #847 review Task 5 fix 1) can swap in
// a fake handle / assert call order without disturbing that real-filesystem
// behavior everywhere else. `unlink` is left unwrapped since no test needs
// to spy on it.
//
// Everything else in the module is passed through via `requireActual`
// (given an explicit generic so `actual` keeps the real module's types
// instead of `any`).
jest.mock('node:fs/promises', () => {
  const actual =
    jest.requireActual<typeof import('node:fs/promises')>('node:fs/promises');
  return {
    ...actual,
    stat: jest.fn(),
    open: jest.fn(actual.open),
    rename: jest.fn(actual.rename),
  };
});

import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { open, rename, stat } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { DEFAULT_REGIONS } from '@tarmoto/ingest';
import {
  POI_UPLOAD_MAX_BYTES,
  PoiImportAdminService,
} from './poi-import-admin.service.js';
import type { PoiImportRun } from '@tarmoto/poi-db';

const statMock = jest.mocked(stat);
const openMock = jest.mocked(open);
const renameMock = jest.mocked(rename);

/**
 * Fake ioredis client double for the queue's own Redis connection
 * (`this.queue.client`, #847 review) — the seam both `storeExtract`'s
 * per-`(source, code)` upload lock and `triggerImport`'s `uploadInProgress`
 * 409 guard go through. `exists` defaults to `0` (no upload in progress) so
 * every queue mock across `triggerImport`/`storeExtract` that doesn't care
 * about the lock stays green without individually overriding it. Shared at
 * module scope (not nested in either `describe` block) since both
 * `triggerImport` and `storeExtract` tests are siblings under the same
 * top-level `describe` and both need it.
 */
function makeFakeRedis(over: { exists?: number } = {}) {
  return {
    // `set` returns 'OK' on a successful `… NX` acquire; a test overrides it to
    // `null` to simulate the lock already being held. `eval` runs the
    // del-if-token-matches release Lua (returns 1 = released).
    set: jest.fn().mockResolvedValue('OK'),
    del: jest.fn().mockResolvedValue(1),
    exists: jest.fn().mockResolvedValue(over.exists ?? 0),
    eval: jest.fn().mockResolvedValue(1),
  };
}

describe('PoiImportAdminService', () => {
  // `PoiImportAdminService` now resolves its source/region metadata straight
  // off `@tarmoto/ingest`'s real `DEFAULT_REGIONS` + a fixed osm/fsq strategy
  // map (Task 5 rework — no more injected `POI_IMPORT_SOURCES` fake), so the
  // per-source extract dir is this front-door's OWN env. Clear both before
  // every test (most tests below want NEITHER source "configured" — extract
  // dir tests opt in explicitly) and restore whatever was already set
  // afterward, so no test leaks its env into another.
  const EXTRACT_DIR_ENV_KEYS = [
    'TARMOTO_POI_IMPORT_DIR',
    'TARMOTO_FSQ_IMPORT_DIR',
  ] as const;
  const savedExtractDirEnv: Partial<
    Record<(typeof EXTRACT_DIR_ENV_KEYS)[number], string>
  > = {};

  beforeEach(() => {
    statMock.mockReset();
    for (const key of EXTRACT_DIR_ENV_KEYS) {
      savedExtractDirEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of EXTRACT_DIR_ENV_KEYS) {
      const value = savedExtractDirEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  describe('manualJobId', () => {
    it('is deterministic and strips the reserved `:` delimiter to `_`', () => {
      const svc = new PoiImportAdminService(
        {} as never,
        {} as never,
        {} as never,
      );

      expect(svc.manualJobId('osm', 'CZ')).toBe('import-region_manual_osm_CZ');
      expect(svc.manualJobId('fsq', 'CZ')).toBe('import-region_manual_fsq_CZ');
      // Deterministic — `triggerImport` (below) must derive the exact same
      // id on a later call for BullMQ's own jobId dedup to recognize a
      // repeat manual click as the SAME job.
      expect(svc.manualJobId('osm', 'CZ')).toBe(svc.manualJobId('osm', 'CZ'));
    });
  });

  describe('listRegionStatus', () => {
    // `listRegionStatus` now fans out over EVERY (source, region) pair in
    // the real `SOURCE_STRATEGIES` (osm, fsq) × `DEFAULT_REGIONS` (17 codes)
    // — 34 rows on every call, regardless of what the mocked DB/queue return.
    // Below, "osm/CZ" etc. are found via `.find()` rather than assumed at a
    // fixed array index, though osm's pairs (in `DEFAULT_REGIONS` order)
    // always precede fsq's.
    const PAIR_COUNT = DEFAULT_REGIONS.length * 2;

    it('assembles status per (source, region) with counts, coverage, extract, live state', async () => {
      process.env.TARMOTO_POI_IMPORT_DIR = '/extracts';
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
      const queue = { getJobs: jest.fn().mockResolvedValue([]) };
      // `statusFor` is invoked once per pair, synchronously in `pairs` order,
      // up to its own first `await` — so with only OSM's extract dir
      // configured, the FIRST `stat()` call is osm/CZ (DEFAULT_REGIONS[0]);
      // the once-value below lands there, and osm's other 16 regions fall
      // through to the persistent ENOENT default (no extract for them).
      statMock.mockResolvedValueOnce({
        size: 10,
        mtimeMs: 1_720_000_000_000,
        isFile: () => true,
      } as never);
      statMock.mockRejectedValue(
        Object.assign(new Error('nope'), { code: 'ENOENT' }),
      );

      const svc = new PoiImportAdminService(
        dataSource as never,
        runsRepo as never,
        queue as never,
      );

      const rows = await svc.listRegionStatus();

      expect(rows).toHaveLength(PAIR_COUNT);
      const osmCz = rows.find((r) => r.source === 'osm' && r.code === 'CZ');
      expect(osmCz).toMatchObject({
        source: 'osm',
        code: 'CZ',
        configured: true,
        poi_count: 42,
        // toISOString() always emits milliseconds, even for a millisecond-less input.
        imported_at: '2026-07-10T00:00:00.000Z',
        live_state: 'idle',
        last_run: null,
      });
      expect(osmCz?.extract).toMatchObject({
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

    // #847 review Fix C: a directory / FIFO / other non-regular node left at
    // the expected extract path (broken mount, manual mistake) still resolves
    // `stat` successfully, so without an explicit `isFile()` check it would
    // read as a ready extract — the worker would then error or hang trying to
    // `createReadStream` it. Must surface as a fault (thrown, same as any
    // other non-ENOENT stat error), never as `present: true`.
    it('surfaces a fault (does not report present) when the extract path stats successfully but is not a regular file', async () => {
      process.env.TARMOTO_POI_IMPORT_DIR = '/extracts';
      process.env.TARMOTO_FSQ_IMPORT_DIR = '/extracts';
      const dataSource = { query: jest.fn().mockResolvedValue([]) };
      const runsRepo = { findOne: jest.fn() };
      const queue = { getJobs: jest.fn().mockResolvedValue([]) };
      // EVERY pair's stat() (both sources configured) resolves to a
      // non-regular file, so every one of the 34 pairs faults before ever
      // reaching `runs.findOne` — not just a single pair.
      statMock.mockResolvedValue({
        size: 4096,
        mtimeMs: 1_720_000_000_000,
        isFile: () => false,
      } as never);

      const svc = new PoiImportAdminService(
        dataSource as never,
        runsRepo as never,
        queue as never,
      );

      await expect(svc.listRegionStatus()).rejects.toThrow(
        /not a regular file/,
      );
      expect(runsRepo.findOne).not.toHaveBeenCalled();
    });

    it('reports live_state running when the queue has an active job, and extract: null on ENOENT', async () => {
      process.env.TARMOTO_POI_IMPORT_DIR = '/extracts';
      const dataSource = { query: jest.fn().mockResolvedValue([]) };
      const runsRepo = { findOne: jest.fn().mockResolvedValue(null) };
      const queue = {
        getJobs: jest.fn().mockResolvedValue([
          {
            data: { code: 'CZ', source: 'osm' },
            getState: jest.fn().mockResolvedValue('active'),
          },
        ]),
      };
      // Every osm pair's stat() rejects ENOENT — no extract uploaded yet for
      // any of them, a graceful null rather than a thrown fault.
      statMock.mockRejectedValue(
        Object.assign(new Error('nope'), { code: 'ENOENT' }),
      );

      const svc = new PoiImportAdminService(
        dataSource as never,
        runsRepo as never,
        queue as never,
      );

      const rows = await svc.listRegionStatus();

      const osmCz = rows.find((r) => r.source === 'osm' && r.code === 'CZ');
      expect(osmCz?.live_state).toBe('running');
      expect(osmCz?.extract).toBeNull();
      // live_state now reflects ANY in-flight job matching (source, code)
      // from a single `getJobs` scan (Fix A), not a `getJob(manualJobId)`
      // probe — this job's id is irrelevant, only its `data` payload matters.
    });

    it('reports live_state queued when the job is waiting/delayed/prioritized', async () => {
      const dataSource = { query: jest.fn().mockResolvedValue([]) };
      const runsRepo = { findOne: jest.fn().mockResolvedValue(null) };
      const queue = {
        getJobs: jest.fn().mockResolvedValue([
          {
            data: { code: 'CZ', source: 'osm' },
            getState: jest.fn().mockResolvedValue('waiting'),
          },
        ]),
      };
      // Neither extract dir env is set (outer beforeEach default), so no
      // pair's stat() is ever invoked — nothing to mock.

      const svc = new PoiImportAdminService(
        dataSource as never,
        runsRepo as never,
        queue as never,
      );

      const rows = await svc.listRegionStatus();

      const osmCz = rows.find((r) => r.source === 'osm' && r.code === 'CZ');
      expect(osmCz?.live_state).toBe('queued');
    });

    it('reports a completed/failed/unknown job state as idle (only active/waiting/delayed/prioritized are live)', async () => {
      const dataSource = { query: jest.fn().mockResolvedValue([]) };
      const runsRepo = { findOne: jest.fn().mockResolvedValue(null) };
      const queue = {
        getJobs: jest.fn().mockResolvedValue([
          {
            data: { code: 'CZ', source: 'osm' },
            getState: jest.fn().mockResolvedValue('completed'),
          },
        ]),
      };

      const svc = new PoiImportAdminService(
        dataSource as never,
        runsRepo as never,
        queue as never,
      );

      const rows = await svc.listRegionStatus();

      const osmCz = rows.find((r) => r.source === 'osm' && r.code === 'CZ');
      expect(osmCz?.live_state).toBe('idle');
    });

    it('reports the most recent poi_import_runs row as last_run, ISO-serialized, including a non-null warning', async () => {
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
        // Non-null (rather than the more common null) so this test proves
        // `toSummary` maps a REAL wipe-guard partial-accept advisory through
        // `last_run`, not just that a null passes through unchanged.
        warning:
          'extract looks incomplete — tombstone + coverage stamp withheld (wipe-guard); rebuild the extract',
        error: null,
        started_at: new Date('2026-07-01T00:00:00Z'),
        finished_at: new Date('2026-07-01T00:05:00Z'),
      };
      // Every pair's runs.findOne resolves to this SAME fake row — only the
      // osm/CZ assertion below (and the call-args check) is what matters.
      const runsRepo = { findOne: jest.fn().mockResolvedValue(runRow) };
      const queue = { getJobs: jest.fn().mockResolvedValue([]) };

      const svc = new PoiImportAdminService(
        dataSource as never,
        runsRepo as never,
        queue as never,
      );

      const rows = await svc.listRegionStatus();

      const osmCz = rows.find((r) => r.source === 'osm' && r.code === 'CZ');
      expect(osmCz?.last_run).toEqual({
        id: '7',
        source: 'osm',
        region_code: 'CZ',
        status: 'success',
        trigger: 'cron',
        fetched: 10,
        upserted: 9,
        tombstoned: 1,
        skip_reason: null,
        warning:
          'extract looks incomplete — tombstone + coverage stamp withheld (wipe-guard); rebuild the extract',
        error: null,
        started_at: '2026-07-01T00:00:00.000Z',
        finished_at: '2026-07-01T00:05:00.000Z',
      });
      expect(runsRepo.findOne).toHaveBeenCalledWith({
        where: { source: 'osm', region_code: 'CZ' },
        order: { started_at: 'DESC', id: 'DESC' },
      });
    });

    it('assembles a row per (source, region) across the full DEFAULT_REGIONS coverage list, scoping coverage to OSM only and counts per (source, region)', async () => {
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
      const queue = { getJobs: jest.fn().mockResolvedValue([]) };

      const svc = new PoiImportAdminService(
        dataSource as never,
        runsRepo as never,
        queue as never,
      );

      const rows = await svc.listRegionStatus();

      // 2 sources (osm, fsq) × the full 17-region DEFAULT_REGIONS list —
      // every pair gets a row regardless of whether it has any DB data.
      expect(rows).toHaveLength(PAIR_COUNT);
      // osm's pairs (DEFAULT_REGIONS order) precede fsq's (SOURCE_STRATEGIES
      // insertion order).
      expect(rows[0]).toMatchObject({ source: 'osm', code: 'CZ' });
      expect(rows[DEFAULT_REGIONS.length]).toMatchObject({
        source: 'fsq',
        code: 'CZ',
      });

      const bySourceCode = new Map(
        rows.map((r) => [`${r.source}:${r.code}`, r]),
      );
      // OSM/CZ keeps the coverage stamp `poi_import_regions` has for CZ...
      expect(bySourceCode.get('osm:CZ')?.imported_at).toBe(
        '2026-07-10T00:00:00.000Z',
      );
      // ...OSM/SK has no coverage row in the mock, so it's uncovered...
      expect(bySourceCode.get('osm:SK')?.imported_at).toBeNull();
      // ...and FSQ/CZ must NOT reuse OSM/CZ's stamp for the SAME region code
      // — `poi_import_regions` has no `source` column, so without the
      // source-scope check every non-OSM row would falsely inherit
      // whatever OSM's own coverage says (#847 review, fix 1).
      expect(bySourceCode.get('fsq:CZ')?.imported_at).toBeNull();

      // Each row's poi_count comes from the grouped (source, import_region)
      // map, not a shared/misattributed count. A pair absent from the mocked
      // GROUP BY rows (e.g. fsq/SK) defaults to 0.
      expect(bySourceCode.get('osm:CZ')?.poi_count).toBe(42);
      expect(bySourceCode.get('osm:SK')?.poi_count).toBe(7);
      expect(bySourceCode.get('fsq:CZ')?.poi_count).toBe(13);
      expect(bySourceCode.get('fsq:SK')?.poi_count).toBe(0);

      // Both bulk queries run exactly once regardless of how many (source,
      // region) pairs exist — 2 calls total, not 2-per-pair — proving the
      // N+1 fix (#847 review, fix 2) still holds at the full 34-pair scale.
      expect(dataSource.query).toHaveBeenCalledTimes(2);
    });

    // #847 review Fix A: a CRON-dispatched `import-region` job uses a
    // DIFFERENT jobId (the enqueue producer's
    // `import-region_<dispatchId>_<source>_<code>`, not `manualJobId`) and
    // never sets `trigger` on the wire (the processor defaults an absent
    // `trigger` to `'cron'`) — this simulates that exact payload shape to
    // prove `live_state` reflects it anyway: the scan matches by
    // `data.source`/`data.code`, never by job id.
    it('reports live_state running for a CRON-style job (different jobId, no trigger field) — not just the manual job', async () => {
      const dataSource = { query: jest.fn().mockResolvedValue([]) };
      const runsRepo = { findOne: jest.fn().mockResolvedValue(null) };
      const queue = {
        getJobs: jest.fn().mockResolvedValue([
          {
            id: 'import-region_wk42_osm_CZ',
            data: { code: 'CZ', source: 'osm' },
            getState: jest.fn().mockResolvedValue('active'),
          },
        ]),
      };

      const svc = new PoiImportAdminService(
        dataSource as never,
        runsRepo as never,
        queue as never,
      );

      const rows = await svc.listRegionStatus();

      const osmCz = rows.find((r) => r.source === 'osm' && r.code === 'CZ');
      expect(osmCz?.live_state).toBe('running');
    });

    // #847 review Fix B: a stat error that ISN'T ENOENT (e.g. EACCES/ENOTDIR/
    // EIO — a broken mount or bad permissions on the shared extract volume)
    // must not be swallowed into `extract: null`, which would make a real
    // infrastructure fault look identical to "no extract uploaded yet". Only
    // ENOENT collapses to null; every other stat error propagates.
    it('propagates a non-ENOENT stat error (e.g. EACCES) instead of reporting extract: null', async () => {
      process.env.TARMOTO_POI_IMPORT_DIR = '/extracts';
      process.env.TARMOTO_FSQ_IMPORT_DIR = '/extracts';
      const dataSource = { query: jest.fn().mockResolvedValue([]) };
      const runsRepo = { findOne: jest.fn() };
      const queue = { getJobs: jest.fn().mockResolvedValue([]) };
      // Every pair's stat() (both sources configured) hits the same fault.
      statMock.mockRejectedValue(
        Object.assign(new Error('denied'), { code: 'EACCES' }),
      );

      const svc = new PoiImportAdminService(
        dataSource as never,
        runsRepo as never,
        queue as never,
      );

      await expect(svc.listRegionStatus()).rejects.toThrow(/denied/);
      expect(runsRepo.findOne).not.toHaveBeenCalled();
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
      warning: null,
      error: 'boom',
      started_at: new Date('2026-07-05T00:00:00Z'),
      finished_at: null,
    };

    it('orders newest-first, applies the limit, and maps rows to RunSummary (finished_at null passthrough)', async () => {
      const qb = makeQb([RUN_ROW]);
      const runsRepo = { createQueryBuilder: jest.fn().mockReturnValue(qb) };
      const svc = new PoiImportAdminService(
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
          warning: null,
          error: 'boom',
          started_at: '2026-07-05T00:00:00.000Z',
          finished_at: null,
        },
      ]);
    });

    // #847 review (this fix): a run row can be a `success` that still carries
    // a non-null `warning` (the tombstone wipe-guard's partial-accept path) —
    // `toSummary` must map it through to `RunSummary` verbatim, not just the
    // more common null.
    it('passes a non-null warning through to RunSummary verbatim (wipe-guard partial-accept advisory)', async () => {
      const qb = makeQb([
        {
          ...RUN_ROW,
          status: 'success',
          error: null,
          warning:
            'extract looks incomplete — tombstone + coverage stamp withheld (wipe-guard); rebuild the extract',
        },
      ]);
      const runsRepo = { createQueryBuilder: jest.fn().mockReturnValue(qb) };
      const svc = new PoiImportAdminService(
        {} as never,
        runsRepo as never,
        {} as never,
      );

      const out = await svc.listRuns({ limit: 20 });

      expect(out[0]?.warning).toBe(
        'extract looks incomplete — tombstone + coverage stamp withheld (wipe-guard); rebuild the extract',
      );
    });

    it('applies source + code filters as separate andWhere clauses when provided', async () => {
      const qb = makeQb([]);
      const runsRepo = { createQueryBuilder: jest.fn().mockReturnValue(qb) };
      const svc = new PoiImportAdminService(
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

  describe('triggerImport', () => {
    const inFlightStates = ['active', 'waiting', 'delayed', 'prioritized'];

    it('enqueues a manual region job and returns its id', async () => {
      const add = jest.fn(() => ({ id: 'x' }));
      const queue = {
        getJobs: jest.fn(() => []),
        add,
        client: Promise.resolve(makeFakeRedis()),
      };
      const svc = new PoiImportAdminService(
        {} as never,
        {} as never,
        queue as never,
      );

      const res = await svc.triggerImport('osm', 'CZ');

      expect(res.job_id).toBe('import-region_manual_osm_CZ');
      expect(queue.getJobs).toHaveBeenCalledWith(inFlightStates);
      expect(add).toHaveBeenCalledWith(
        'import-region',
        { code: 'CZ', source: 'osm', trigger: 'manual' },
        expect.objectContaining({
          jobId: 'import-region_manual_osm_CZ',
          attempts: 3,
        }),
      );
    });

    // #847 final-review fix F1: this job's jobId is STABLE
    // (`manualJobId`), and BullMQ's `add()` dedupes against ANY existing
    // job with that id — including a completed/failed one still retained
    // in Redis. `DEFAULT_JOB_OPTIONS`'s shared count/age-based retention
    // (`removeOnComplete: { count: 1000 }`, `removeOnFail: { age: 24h }`)
    // is fine for high-volume queues, but on this low-volume manual-import
    // queue it would keep the terminal job around long enough that a
    // re-import (fresh extract upload → click Import again) silently
    // dedupes against the stale job and never re-enqueues, even though the
    // endpoint reports success. Asserting the override here directly (not
    // just via the id/attempts fields above) pins the fix so a future edit
    // can't silently reintroduce count/age retention on this job.
    it('frees the stable manual jobId immediately on completion/failure so a re-import is never deduped away', async () => {
      const add = jest.fn(() => ({ id: 'x' }));
      const queue = {
        getJobs: jest.fn(() => []),
        add,
        client: Promise.resolve(makeFakeRedis()),
      };
      const svc = new PoiImportAdminService(
        {} as never,
        {} as never,
        queue as never,
      );

      await svc.triggerImport('osm', 'CZ');

      expect(add).toHaveBeenCalledWith(
        'import-region',
        { code: 'CZ', source: 'osm', trigger: 'manual' },
        expect.objectContaining({
          removeOnComplete: true,
          removeOnFail: true,
        }),
      );
    });

    it('rejects with 409 when a MANUAL job for the same (source, code) is already in flight', async () => {
      const add = jest.fn();
      const queue = {
        getJobs: jest.fn(() => [
          { data: { code: 'CZ', source: 'osm', trigger: 'manual' } },
        ]),
        add,
        client: Promise.resolve(makeFakeRedis()),
      };
      const svc = new PoiImportAdminService(
        {} as never,
        {} as never,
        queue as never,
      );

      await expect(svc.triggerImport('osm', 'CZ')).rejects.toMatchObject({
        status: 409,
      });
      expect(add).not.toHaveBeenCalled();
    });

    // #847 review (Task 3): `importRegion` holds a non-blocking PostgreSQL
    // advisory lock per (source, code), so a manual trigger racing an
    // in-progress CRON import doesn't queue behind it — it FAILS, after
    // burning through `attempts: 3` (30s/60s exponential backoff, ~90s
    // total). A country-scale import can run for minutes, so a
    // `getJob(manualJobId)`-only check (which only ever sees the MANUAL
    // jobId) would miss a live cron job entirely — it enqueues under a
    // DIFFERENT id (`import-region_<dispatchId>_<source>_<code>`, apps/ingest's
    // `PoiImportProducer.enqueuePoiImportRegion`) and never sets `trigger` on the
    // wire (the processor defaults an absent `trigger` to `'cron'`). This
    // job simulates exactly that real payload shape to prove the scan
    // catches it by payload, not by id.
    it('rejects with 409 when a CRON-style job (different jobId, matching data.code/data.source) is in flight', async () => {
      const add = jest.fn();
      const queue = {
        getJobs: jest.fn(() => [
          {
            id: 'import-region_wk42_osm_CZ',
            data: { code: 'CZ', source: 'osm' },
          },
        ]),
        add,
        client: Promise.resolve(makeFakeRedis()),
      };
      const svc = new PoiImportAdminService(
        {} as never,
        {} as never,
        queue as never,
      );

      await expect(svc.triggerImport('osm', 'CZ')).rejects.toMatchObject({
        status: 409,
      });
      expect(add).not.toHaveBeenCalled();
    });

    it('does not block on an in-flight job for a different region code or a different source', async () => {
      const add = jest.fn(() => ({ id: 'x' }));
      const queue = {
        getJobs: jest.fn(() => [
          { data: { code: 'SK', source: 'osm' } },
          { data: { code: 'CZ', source: 'fsq' } },
        ]),
        add,
        client: Promise.resolve(makeFakeRedis()),
      };
      const svc = new PoiImportAdminService(
        {} as never,
        {} as never,
        queue as never,
      );

      const res = await svc.triggerImport('osm', 'CZ');

      expect(res.job_id).toBe('import-region_manual_osm_CZ');
      expect(add).toHaveBeenCalled();
    });

    it('defaults an in-flight job with an absent `source` field to osm when matching', async () => {
      const legacyJob = { data: { code: 'CZ' } }; // pre-#869 payload, no `source`

      const blockedQueue = {
        getJobs: jest.fn(() => [legacyJob]),
        add: jest.fn(),
        client: Promise.resolve(makeFakeRedis()),
      };
      const svcOsm = new PoiImportAdminService(
        {} as never,
        {} as never,
        blockedQueue as never,
      );
      await expect(svcOsm.triggerImport('osm', 'CZ')).rejects.toMatchObject({
        status: 409,
      });

      // The SAME legacy job must NOT block a different source — proves the
      // fallback is `?? 'osm'`, not "an absent source matches anything".
      const openQueue = {
        getJobs: jest.fn(() => [legacyJob]),
        add: jest.fn(() => ({ id: 'x' })),
        client: Promise.resolve(makeFakeRedis()),
      };
      const svcFsq = new PoiImportAdminService(
        {} as never,
        {} as never,
        openQueue as never,
      );
      await expect(svcFsq.triggerImport('fsq', 'CZ')).resolves.toMatchObject({
        job_id: 'import-region_manual_fsq_CZ',
      });
    });

    it('rejects an unknown (source, code) with 400 before ever scanning the queue', async () => {
      const getJobs = jest.fn();
      const queue = {
        getJobs,
        add: jest.fn(),
        client: Promise.resolve(makeFakeRedis()),
      };
      const svc = new PoiImportAdminService(
        {} as never,
        {} as never,
        queue as never,
      );

      await expect(svc.triggerImport('osm', 'ZZ')).rejects.toMatchObject({
        status: 400,
      });
      expect(getJobs).not.toHaveBeenCalled();
    });

    // #847 review (this fix): `importInFlight` only has visibility into
    // BullMQ jobs, so a replacement upload that hasn't reached the queue
    // yet (still streaming inside `storeExtract`) is invisible to it. This
    // proves the SECOND, independent guard (`uploadInProgress`) catches
    // exactly that case: no BullMQ job at all, but the upload lock key
    // exists (`exists` → 1) because `storeExtract` set it.
    it('rejects with 409 when an extract upload is in progress for (source, code), even with no BullMQ job in flight', async () => {
      const add = jest.fn();
      const queue = {
        getJobs: jest.fn(() => []),
        add,
        client: Promise.resolve(makeFakeRedis({ exists: 1 })),
      };
      const svc = new PoiImportAdminService(
        {} as never,
        {} as never,
        queue as never,
      );

      await expect(svc.triggerImport('osm', 'CZ')).rejects.toMatchObject({
        status: 409,
      });
      expect(add).not.toHaveBeenCalled();
    });
  });

  describe('POI store resilience (#847 review)', () => {
    it('listRegionStatus returns 503 when the POI datasource is uninitialized', async () => {
      // POI DB down at boot → datasource never initialized. Must surface a clear
      // "store unavailable" (503, spec §7), not a raw TypeORM 500.
      const svc = new PoiImportAdminService(
        { isInitialized: false, query: jest.fn() } as never,
        {} as never,
        {} as never,
      );
      await expect(svc.listRegionStatus()).rejects.toMatchObject({
        status: 503,
      });
    });

    it('listRuns returns 503 when the POI datasource is uninitialized', async () => {
      const qb = {
        orderBy: jest.fn().mockReturnThis(),
        addOrderBy: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getMany: jest.fn(),
      };
      const createQueryBuilder = jest.fn().mockReturnValue(qb);
      const svc = new PoiImportAdminService(
        { isInitialized: false } as never,
        { createQueryBuilder } as never,
        {} as never,
      );
      await expect(svc.listRuns({ limit: 10 })).rejects.toMatchObject({
        status: 503,
      });
      // The guard gates the ENTIRE build+run: even createQueryBuilder (which can
      // throw EntityMetadataNotFoundError on a cold-start datasource) is never
      // reached when the store is unavailable (#847 review).
      expect(createQueryBuilder).not.toHaveBeenCalled();
      expect(qb.getMany).not.toHaveBeenCalled();
    });
  });

  describe('storeExtract', () => {
    let dir: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'tarmoto-poi-admin-test-'));
      // Every test below uses source 'osm' unless noted, so default the OSM
      // extract dir to the throwaway temp dir; the one test exercising the
      // "not configured" path deletes this itself.
      process.env.TARMOTO_POI_IMPORT_DIR = dir;
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    /** The extract path `getExtractPath` computes for `(source, code)` once
     *  its extract dir env points at `dir` — mirrors the real
     *  `OsmPoiImportSource`/`FsqPoiImportSource.extractFilename` naming
     *  (`<code-lowercase>.osm` / `<code-lowercase>.fsq.jsonl`). */
    function extractPath(source: string, code: string): string {
      const ext = source === 'fsq' ? '.fsq.jsonl' : '.osm';
      return join(dir, `${code.toLowerCase()}${ext}`);
    }

    /** Any leftover `*.part` staging file left in `dir`. The atomic-write
     *  temp name is unique PER CALL (`<target>.<pid>.<random-hex>.part`,
     *  #847 review Task 5 fix 2 — see `storeExtract`), so a literal
     *  `` `${target}.part` `` string no longer names a real path; scanning
     *  the directory for the shared `.part` SUFFIX is what actually proves
     *  no temp file was left behind, regardless of the random component. */
    function leftoverPartFiles(): string[] {
      return readdirSync(dir).filter((f) => f.endsWith('.part'));
    }

    /** Queue double whose `getJobs` resolves empty — the common case for any
     *  test below that isn't specifically exercising the in-flight 409 guard
     *  (#847 review, this fix). `storeExtract` didn't touch `this.queue` at
     *  all before this fix, so every pre-existing happy-path test's bare `{}`
     *  queue mock needs a real `getJobs` now that `importInFlight` runs on
     *  every call that gets this far. `client` (a fresh `makeFakeRedis()` per
     *  call, #847 review, this fix) is likewise required now that a
     *  happy-path upload also sets + releases the server-side upload lock. */
    function idleQueue() {
      return {
        getJobs: jest.fn().mockResolvedValue([]),
        client: Promise.resolve(makeFakeRedis()),
      };
    }

    // `POI_UPLOAD_MAX_BYTES` is a module-level constant now shared with
    // `AdminPoiController`'s multer config (#847 review Task 6 fix 3), read
    // once at module load rather than per instance — so this test exercises
    // the real configured boundary (`+ 1`) instead of overriding
    // `TARMOTO_POI_UPLOAD_MAX_BYTES` at runtime, which would no longer have
    // any effect once the module has already been imported.
    it('rejects an oversize upload with 400 before touching the filesystem', async () => {
      const svc = new PoiImportAdminService(
        {} as never,
        {} as never,
        {} as never,
      );

      await expect(
        svc.storeExtract('osm', 'CZ', {
          stream: Readable.from(Buffer.from('irrelevant')),
          size: POI_UPLOAD_MAX_BYTES + 1,
          originalName: 'cz.osm',
        }),
      ).rejects.toMatchObject({ status: 400 });

      expect(leftoverPartFiles()).toEqual([]);
    });

    it('rejects an unknown source with 400', async () => {
      const svc = new PoiImportAdminService(
        {} as never,
        {} as never,
        {} as never,
      );

      await expect(
        svc.storeExtract('bogus', 'CZ', {
          stream: Readable.from(Buffer.from('x')),
          size: 1,
          originalName: 'cz.osm',
        }),
      ).rejects.toMatchObject({ status: 400 });
    });

    it('rejects an unknown region code for a known source with 400', async () => {
      const svc = new PoiImportAdminService(
        {} as never,
        {} as never,
        {} as never,
      );

      await expect(
        svc.storeExtract('osm', 'ZZ', {
          stream: Readable.from(Buffer.from('x')),
          size: 1,
          originalName: 'zz.osm',
        }),
      ).rejects.toMatchObject({ status: 400 });
    });

    it('returns 503 (not 500) when the source has no configured extract dir', async () => {
      // Override this block's beforeEach default: TARMOTO_POI_IMPORT_DIR
      // unset → extractDirConfigured false → getExtractPath would throw a
      // plain Error (500); storeExtract must surface a clear 503 and write
      // nothing (#847 review).
      delete process.env.TARMOTO_POI_IMPORT_DIR;
      const svc = new PoiImportAdminService(
        {} as never,
        {} as never,
        {} as never,
      );

      await expect(
        svc.storeExtract('osm', 'CZ', {
          stream: Readable.from(Buffer.from('x')),
          size: 1,
          originalName: 'cz.osm',
        }),
      ).rejects.toMatchObject({ status: 503 });

      expect(leftoverPartFiles()).toEqual([]);
    });

    it('rejects a filename whose extension does not match the source (fsq name against osm)', async () => {
      const svc = new PoiImportAdminService(
        {} as never,
        {} as never,
        {} as never,
      );

      await expect(
        svc.storeExtract('osm', 'CZ', {
          stream: Readable.from(Buffer.from('x')),
          size: 1,
          originalName: 'cz.fsq.jsonl',
        }),
      ).rejects.toMatchObject({ status: 400 });
    });

    it('rejects a filename whose extension does not match the source (osm name against fsq)', async () => {
      const svc = new PoiImportAdminService(
        {} as never,
        {} as never,
        {} as never,
      );

      await expect(
        svc.storeExtract('fsq', 'CZ', {
          stream: Readable.from(Buffer.from('x')),
          size: 1,
          originalName: 'cz.osm',
        }),
      ).rejects.toMatchObject({ status: 400 });
    });

    // #847 review (this fix): `extractDirConfigured` only proves
    // TARMOTO_*_IMPORT_DIR is SET, not that the shared mount actually
    // attached — a volume that failed to mount leaves the configured path's
    // PARENT directory simply absent. Without this check, `createWriteStream`
    // deep inside the pipeline below would throw a raw ENOENT — AFTER the
    // multipart body has already been fully accepted — surfacing as a raw
    // 500 instead of the same 503 class as the unconfigured-dir case.
    it('returns 503 (not 500) when the extract directory is configured but the mount never attached (ENOENT)', async () => {
      const svc = new PoiImportAdminService(
        {} as never,
        {} as never,
        idleQueue() as never,
      );
      statMock.mockRejectedValueOnce(
        Object.assign(new Error('nope'), { code: 'ENOENT' }),
      );

      await expect(
        svc.storeExtract('osm', 'CZ', {
          stream: Readable.from(Buffer.from('x')),
          size: 1,
          originalName: 'cz.osm',
        }),
      ).rejects.toMatchObject({ status: 503 });

      expect(leftoverPartFiles()).toEqual([]);
    });

    it('returns 503 when the parent directory stats successfully but is not a directory', async () => {
      const svc = new PoiImportAdminService(
        {} as never,
        {} as never,
        idleQueue() as never,
      );
      statMock.mockResolvedValueOnce({ isDirectory: () => false } as never);

      await expect(
        svc.storeExtract('osm', 'CZ', {
          stream: Readable.from(Buffer.from('x')),
          size: 1,
          originalName: 'cz.osm',
        }),
      ).rejects.toMatchObject({ status: 503 });

      expect(leftoverPartFiles()).toEqual([]);
    });

    it('propagates a non-ENOENT parent-dir stat error (e.g. EACCES) instead of collapsing to 503', async () => {
      const svc = new PoiImportAdminService(
        {} as never,
        {} as never,
        idleQueue() as never,
      );
      statMock.mockRejectedValueOnce(
        Object.assign(new Error('denied'), { code: 'EACCES' }),
      );

      await expect(
        svc.storeExtract('osm', 'CZ', {
          stream: Readable.from(Buffer.from('x')),
          size: 1,
          originalName: 'cz.osm',
        }),
      ).rejects.toThrow(/denied/);

      expect(leftoverPartFiles()).toEqual([]);
    });

    // #847 review (this fix): defense-in-depth against a replacement upload
    // racing a LIVE import for this exact (source, code) — a worker may be
    // mid-read of the CURRENT extract file while an operator's new upload is
    // about to atomically replace it out from under it. Same in-flight
    // criteria as `triggerImport`'s own 409 guard, shared via the new
    // `importInFlight` helper so the two checks can never desync.
    it('rejects with 409 when an import is already in flight for (source, code), and writes nothing', async () => {
      const queue = {
        getJobs: jest
          .fn()
          .mockResolvedValue([{ data: { code: 'CZ', source: 'osm' } }]),
        client: Promise.resolve(makeFakeRedis()),
      };
      const svc = new PoiImportAdminService(
        {} as never,
        {} as never,
        queue as never,
      );
      statMock.mockResolvedValueOnce({ isDirectory: () => true } as never);

      await expect(
        svc.storeExtract('osm', 'CZ', {
          stream: Readable.from(Buffer.from('x')),
          size: 1,
          originalName: 'cz.osm',
        }),
      ).rejects.toMatchObject({ status: 409 });

      expect(leftoverPartFiles()).toEqual([]);
    });

    it('does not block a storeExtract upload on an in-flight job for a different region or source', async () => {
      const target = extractPath('osm', 'CZ');
      const queue = {
        getJobs: jest
          .fn()
          .mockResolvedValue([
            { data: { code: 'SK', source: 'osm' } },
            { data: { code: 'CZ', source: 'fsq' } },
          ]),
        client: Promise.resolve(makeFakeRedis()),
      };
      const svc = new PoiImportAdminService(
        {} as never,
        {} as never,
        queue as never,
      );
      statMock.mockResolvedValueOnce({ isDirectory: () => true } as never);
      statMock.mockResolvedValueOnce({ size: 1, mtimeMs: 0 } as never);

      await svc.storeExtract('osm', 'CZ', {
        stream: Readable.from(Buffer.from('x')),
        size: 1,
        originalName: 'cz.osm',
      });

      expect(readFileSync(target, 'utf8')).toBe('x');
    });

    it('streams the upload atomically (temp file + fsync + rename) and returns the extract stat', async () => {
      const target = extractPath('osm', 'CZ');
      const svc = new PoiImportAdminService(
        {} as never,
        {} as never,
        idleQueue() as never,
      );
      // First call is the new parent-dir mount check (#847 review, this
      // fix); second is the existing post-rename result stat.
      statMock.mockResolvedValueOnce({ isDirectory: () => true } as never);
      statMock.mockResolvedValueOnce({
        size: 13,
        mtimeMs: 1_720_000_000_000,
      } as never);

      const result = await svc.storeExtract('osm', 'CZ', {
        // Uppercase extension proves the extension match is case-insensitive.
        stream: Readable.from(Buffer.from('<osm-extract>')),
        size: 13,
        originalName: 'CZ.OSM',
      });

      expect(result).toEqual({
        present: true,
        size_bytes: 13,
        modified_at: new Date(1_720_000_000_000).toISOString(),
      });
      // Real filesystem effects: the target exists with the streamed bytes,
      // and the `.part` staging file is gone.
      expect(readFileSync(target, 'utf8')).toBe('<osm-extract>');
      expect(leftoverPartFiles()).toEqual([]);
    });

    // #847 review (Task 5 fix 1): the steps above (`pipeline` → `open` →
    // `sync` (fsync) → `close` → `rename`) previously had ONLY end-state
    // coverage (content correct, `.part` gone) — that would still pass even
    // if the `sync()` call were deleted outright, since neither the
    // temp file's bytes nor the renamed target change either way. This test
    // swaps in a bare `{ sync, close }` double for `open`'s return value
    // (the real bytes already land via the untouched `createWriteStream`
    // pipeline that runs before `open` — this second handle exists ONLY for
    // the fsync step, see the method's doc comment) so `sync`/`close` are
    // directly spyable, then asserts `sync()` actually runs, and runs
    // BEFORE the atomic `rename` — the durability guarantee the docstring
    // promises (bytes durable on disk before the rename makes them visible
    // to the import job that reads `target` next, possibly from a separate
    // process after a crash).
    it('fsyncs the temp file handle before the atomic rename', async () => {
      openMock.mockClear();
      renameMock.mockClear();
      const svc = new PoiImportAdminService(
        {} as never,
        {} as never,
        idleQueue() as never,
      );
      // First call is the new parent-dir mount check (#847 review, this
      // fix); second is the existing post-rename result stat.
      statMock.mockResolvedValueOnce({ isDirectory: () => true } as never);
      statMock.mockResolvedValueOnce({ size: 5, mtimeMs: 0 } as never);

      let openedPath: string | undefined;
      const sync = jest.fn().mockResolvedValue(undefined);
      const close = jest.fn().mockResolvedValue(undefined);
      openMock.mockImplementationOnce((path) => {
        openedPath = String(path);
        return Promise.resolve({ sync, close } as unknown as FileHandle);
      });

      await svc.storeExtract('osm', 'CZ', {
        stream: Readable.from(Buffer.from('hello')),
        size: 5,
        originalName: 'cz.osm',
      });

      // Opened against the temp staging file, never the final target.
      expect(openedPath).toMatch(/\.part$/);
      expect(sync).toHaveBeenCalledTimes(1);
      expect(close).toHaveBeenCalledTimes(1);
      expect(renameMock).toHaveBeenCalledTimes(1);
      expect(sync.mock.invocationCallOrder[0]).toBeLessThan(
        renameMock.mock.invocationCallOrder[0]!,
      );
    });

    // #847 review (this fix): fsyncing the renamed file's own fd does not make
    // the rename's DIRECTORY-entry update durable on POSIX — only fsyncing the
    // containing directory does. Mirrors the temp-file fsync test above, but
    // targets the SECOND `open()` call (the directory), which runs after the
    // rename.
    it('fsyncs the containing directory after the atomic rename', async () => {
      openMock.mockClear();
      renameMock.mockClear();
      const svc = new PoiImportAdminService(
        {} as never,
        {} as never,
        idleQueue() as never,
      );
      // First call is the new parent-dir mount check (#847 review, this
      // fix); second is the existing post-rename result stat.
      statMock.mockResolvedValueOnce({ isDirectory: () => true } as never);
      statMock.mockResolvedValueOnce({ size: 5, mtimeMs: 0 } as never);

      const tmpSync = jest.fn().mockResolvedValue(undefined);
      const tmpClose = jest.fn().mockResolvedValue(undefined);
      const dirSync = jest.fn().mockResolvedValue(undefined);
      const dirClose = jest.fn().mockResolvedValue(undefined);
      let dirOpenedPath: string | undefined;
      openMock
        .mockImplementationOnce(
          () =>
            Promise.resolve({
              sync: tmpSync,
              close: tmpClose,
            }) as unknown as Promise<FileHandle>,
        )
        .mockImplementationOnce((path) => {
          dirOpenedPath = String(path);
          return Promise.resolve({
            sync: dirSync,
            close: dirClose,
          } as unknown as FileHandle);
        });

      await svc.storeExtract('osm', 'CZ', {
        stream: Readable.from(Buffer.from('hello')),
        size: 5,
        originalName: 'cz.osm',
      });

      // The second open() targets the extract's containing directory — the
      // directory ENTRY the rename just updated, not the file itself.
      expect(dirOpenedPath).toBe(dir);
      expect(dirSync).toHaveBeenCalledTimes(1);
      expect(dirClose).toHaveBeenCalledTimes(1);
      // Fsyncing the directory before the rename lands would be meaningless —
      // there'd be no new directory entry yet to make durable.
      expect(renameMock.mock.invocationCallOrder[0]).toBeLessThan(
        dirSync.mock.invocationCallOrder[0]!,
      );
    });

    it('replaces an existing extract in place on re-upload', async () => {
      const target = extractPath('osm', 'CZ');
      const svc = new PoiImportAdminService(
        {} as never,
        {} as never,
        idleQueue() as never,
      );
      // One value satisfies EVERY stat call across both uploads (parent-dir
      // check + final result stat, twice each, #847 review this fix) —
      // `isDirectory` is simply ignored by the final-stat read, which only
      // looks at size/mtimeMs.
      statMock.mockResolvedValue({
        size: 0,
        mtimeMs: 0,
        isDirectory: () => true,
      } as never);

      await svc.storeExtract('osm', 'CZ', {
        stream: Readable.from(Buffer.from('first')),
        size: 5,
        originalName: 'cz.osm',
      });
      await svc.storeExtract('osm', 'CZ', {
        stream: Readable.from(Buffer.from('second-upload')),
        size: 13,
        originalName: 'cz.osm',
      });

      expect(readFileSync(target, 'utf8')).toBe('second-upload');
    });

    it('cleans up the .part file and rethrows when the source stream errors mid-write', async () => {
      const target = extractPath('osm', 'CZ');
      const svc = new PoiImportAdminService(
        {} as never,
        {} as never,
        idleQueue() as never,
      );
      // Parent-dir mount check (#847 review, this fix) must pass so the test
      // actually reaches the streaming pipeline the erroring source exercises.
      statMock.mockResolvedValueOnce({ isDirectory: () => true } as never);
      const erroring = new Readable({
        read() {
          this.push(Buffer.from('partial'));
          process.nextTick(() => this.destroy(new Error('stream interrupted')));
        },
      });

      await expect(
        svc.storeExtract('osm', 'CZ', {
          stream: erroring,
          size: 100,
          originalName: 'cz.osm',
        }),
      ).rejects.toThrow(/stream interrupted/);

      expect(leftoverPartFiles()).toEqual([]);
      expect(existsSync(target)).toBe(false);
    });

    // #972: `storeExtract` no longer takes the upload lock itself — it's held
    // UPSTREAM by `PoiUploadLockInterceptor` for the whole client→API upload
    // (acquire before Multer drains, release after the handler). This pins that
    // `storeExtract` doesn't SET/DEL it — re-locking the same key here would
    // self-conflict with the interceptor's `SET NX`. The acquire/release
    // primitives are covered below; the interceptor in
    // `poi-upload-lock.interceptor.spec`. (`triggerImport`'s consumption of the
    // lock via `uploadInProgress` is covered in the `triggerImport` block.)
    it('does not touch the upload lock itself — held upstream by the interceptor (#972)', async () => {
      const redis = makeFakeRedis();
      const queue = {
        getJobs: jest.fn().mockResolvedValue([]),
        client: Promise.resolve(redis),
      };
      const svc = new PoiImportAdminService(
        {} as never,
        {} as never,
        queue as never,
      );
      statMock.mockResolvedValueOnce({ isDirectory: () => true } as never);
      statMock.mockResolvedValueOnce({ size: 5, mtimeMs: 0 } as never);

      await svc.storeExtract('osm', 'CZ', {
        stream: Readable.from(Buffer.from('hello')),
        size: 5,
        originalName: 'cz.osm',
      });

      expect(redis.set).not.toHaveBeenCalled();
      expect(redis.del).not.toHaveBeenCalled();
    });
  });

  describe('upload lock (acquire / renew / release, #972)', () => {
    const lockKey = 'poi:import:upload-lock:osm:CZ';
    const makeSvc = (redis: ReturnType<typeof makeFakeRedis>) =>
      new PoiImportAdminService(
        {} as never,
        {} as never,
        { client: Promise.resolve(redis) } as never,
      );

    it('acquireUploadLock takes an owned NX lock with a TTL and returns the token', async () => {
      const redis = makeFakeRedis();
      const token = await makeSvc(redis).acquireUploadLock('osm', 'CZ');

      expect(token).toEqual(expect.any(String));
      expect(redis.set).toHaveBeenCalledWith(lockKey, token, 'EX', 600, 'NX');
    });

    it('acquireUploadLock returns null when the lock is already held (NX fails)', async () => {
      const redis = makeFakeRedis();
      redis.set.mockResolvedValue(null);

      expect(await makeSvc(redis).acquireUploadLock('osm', 'CZ')).toBeNull();
    });

    it('releaseUploadLock uses a del-if-token-matches Lua, never a blind DEL', async () => {
      const redis = makeFakeRedis();
      await makeSvc(redis).releaseUploadLock('osm', 'CZ', 'tok-123');

      expect(redis.eval).toHaveBeenCalledWith(
        expect.stringContaining('redis.call("del", KEYS[1])'),
        1,
        lockKey,
        'tok-123',
      );
      expect(redis.del).not.toHaveBeenCalled();
    });

    it('releaseUploadLock swallows a Redis error (best-effort; TTL is the backstop)', async () => {
      const redis = makeFakeRedis();
      redis.eval.mockRejectedValue(new Error('redis down'));

      await expect(
        makeSvc(redis).releaseUploadLock('osm', 'CZ', 'tok'),
      ).resolves.toBeUndefined();
    });

    it('renewUploadLock extends the TTL via a token-checked EXPIRE (keeps a slow upload from lapsing)', async () => {
      const redis = makeFakeRedis();
      await makeSvc(redis).renewUploadLock('osm', 'CZ', 'tok-123');

      expect(redis.eval).toHaveBeenCalledWith(
        expect.stringContaining('redis.call("expire", KEYS[1], ARGV[2])'),
        1,
        lockKey,
        'tok-123',
        '600',
      );
      expect(redis.del).not.toHaveBeenCalled();
    });

    it('renewUploadLock swallows a Redis error (best-effort)', async () => {
      const redis = makeFakeRedis();
      redis.eval.mockRejectedValue(new Error('redis down'));

      await expect(
        makeSvc(redis).renewUploadLock('osm', 'CZ', 'tok'),
      ).resolves.toBeUndefined();
    });
  });
});
