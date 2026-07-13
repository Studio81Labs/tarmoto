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
import {
  POI_UPLOAD_MAX_BYTES,
  PoiImportAdminService,
} from './poi-import-admin.service.js';
import type { PoiImportRun } from '../../entities/poi-import-run.entity.js';

const statMock = jest.mocked(stat);
const openMock = jest.mocked(open);
const renameMock = jest.mocked(rename);

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

  describe('triggerImport', () => {
    const inFlightStates = ['active', 'waiting', 'delayed', 'prioritized'];

    it('enqueues a manual region job and returns its id', async () => {
      const add = jest.fn(() => ({ id: 'x' }));
      const queue = { getJobs: jest.fn(() => []), add };
      const svc = new PoiImportAdminService(
        [makeImporter()] as never,
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
      const queue = { getJobs: jest.fn(() => []), add };
      const svc = new PoiImportAdminService(
        [makeImporter()] as never,
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
      };
      const svc = new PoiImportAdminService(
        [makeImporter()] as never,
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
    // DIFFERENT id (`import-region_<dispatchId>_<source>_<code>`,
    // `JobsProducer.enqueuePoiImportRegion`) and never sets `trigger` on the
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
      };
      const svc = new PoiImportAdminService(
        [makeImporter()] as never,
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
      };
      const svc = new PoiImportAdminService(
        [makeImporter()] as never,
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
      };
      const svcOsm = new PoiImportAdminService(
        [makeImporter({ source: 'osm' })] as never,
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
      };
      const svcFsq = new PoiImportAdminService(
        [makeImporter({ source: 'fsq' })] as never,
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
      const queue = { getJobs, add: jest.fn() };
      const svc = new PoiImportAdminService(
        [makeImporter()] as never,
        {} as never,
        {} as never,
        queue as never,
      );

      await expect(svc.triggerImport('osm', 'ZZ')).rejects.toMatchObject({
        status: 400,
      });
      expect(getJobs).not.toHaveBeenCalled();
    });
  });

  describe('storeExtract', () => {
    let dir: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'tarmoto-poi-admin-test-'));
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    /** Importer whose `getExtractPath` resolves INSIDE the throwaway temp
     *  dir, mirroring the real `<code>.osm` / `<code>.fsq.jsonl` naming
     *  (`OsmPoiImportSource`/`FsqPoiImportSource.extractFilename`) closely
     *  enough for the extension-validation tests below to be meaningful. */
    function makeStoreImporter(
      over: {
        source?: string;
        regions?: { code: string; bbox: unknown }[];
        extractDirConfigured?: boolean;
      } = {},
    ) {
      const source = over.source ?? 'osm';
      const ext = source === 'fsq' ? '.fsq.jsonl' : '.osm';
      return {
        source,
        regions: over.regions ?? [{ code: 'CZ', bbox: {} }],
        extractDirConfigured: over.extractDirConfigured ?? true,
        getExtractPath: (code: string) =>
          join(dir, `${code.toLowerCase()}${ext}`),
      };
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

    // `POI_UPLOAD_MAX_BYTES` is a module-level constant now shared with
    // `AdminPoiController`'s multer config (#847 review Task 6 fix 3), read
    // once at module load rather than per instance — so this test exercises
    // the real configured boundary (`+ 1`) instead of overriding
    // `TARMOTO_POI_UPLOAD_MAX_BYTES` at runtime, which would no longer have
    // any effect once the module has already been imported.
    it('rejects an oversize upload with 400 before touching the filesystem', async () => {
      const importer = makeStoreImporter();
      const svc = new PoiImportAdminService(
        [importer] as never,
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
        [makeStoreImporter()] as never,
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
        [makeStoreImporter()] as never,
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
      // TARMOTO_POI_IMPORT_DIR unset → extractDirConfigured false → getExtractPath
      // would throw a plain Error (500); storeExtract must surface a clear 503
      // and write nothing (#847 review).
      const svc = new PoiImportAdminService(
        [makeStoreImporter({ extractDirConfigured: false })] as never,
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
        [makeStoreImporter({ source: 'osm' })] as never,
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
        [makeStoreImporter({ source: 'fsq' })] as never,
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

    it('streams the upload atomically (temp file + fsync + rename) and returns the extract stat', async () => {
      const importer = makeStoreImporter();
      const target = importer.getExtractPath('CZ');
      const svc = new PoiImportAdminService(
        [importer] as never,
        {} as never,
        {} as never,
        {} as never,
      );
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
      const importer = makeStoreImporter();
      const svc = new PoiImportAdminService(
        [importer] as never,
        {} as never,
        {} as never,
        {} as never,
      );
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

    it('replaces an existing extract in place on re-upload', async () => {
      const importer = makeStoreImporter();
      const target = importer.getExtractPath('CZ');
      const svc = new PoiImportAdminService(
        [importer] as never,
        {} as never,
        {} as never,
        {} as never,
      );
      statMock.mockResolvedValue({ size: 0, mtimeMs: 0 } as never);

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
      const importer = makeStoreImporter();
      const target = importer.getExtractPath('CZ');
      const svc = new PoiImportAdminService(
        [importer] as never,
        {} as never,
        {} as never,
        {} as never,
      );
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
  });
});
