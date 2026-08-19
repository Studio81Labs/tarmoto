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
import { ConfigService } from '@nestjs/config';
import {
  POI_UPLOAD_MAX_BYTES,
  PoiImportAdminService,
} from './poi-import-admin.service.js';

const statMock = jest.mocked(stat);
const openMock = jest.mocked(open);
const renameMock = jest.mocked(rename);

function fakeConfig(
  over: Record<string, string | undefined> = {},
): ConfigService {
  const values: Record<string, string | undefined> = {
    TARMOTO_INGEST_INTERNAL_URL: 'http://ingest:3005',
    TARMOTO_INTERNAL_API_TOKEN: 'tok',
    ...over,
  };
  return { get: (k: string) => values[k] } as unknown as ConfigService;
}

// ioredis double for the re-sourced upload lock (was queue.client). Same
// surface the lock methods call: set/del/exists/eval.
function makeLockRedis(over: { exists?: number } = {}) {
  return {
    set: jest.fn().mockResolvedValue('OK'),
    del: jest.fn().mockResolvedValue(1),
    exists: jest.fn().mockResolvedValue(over.exists ?? 0),
    eval: jest.fn().mockResolvedValue(1),
    quit: jest.fn().mockResolvedValue('OK'),
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
    'TARMOTO_OSM_POI_IMPORT_DIR',
    'TARMOTO_FSQ_POI_IMPORT_DIR',
  ] as const;
  const savedExtractDirEnv: Partial<
    Record<(typeof EXTRACT_DIR_ENV_KEYS)[number], string | undefined>
  > = {};

  // Hoisted so BOTH the ingest-proxy tests and the storeExtract tests share
  // one spy (#1011 review, FIX 2 — storeExtract now also calls `fetch` via
  // `importInFlight`). Reset + given a safe default — `in_flight: false` —
  // in the top-level `beforeEach` below so every storeExtract test (which
  // doesn't care about the in-flight guard) keeps behaving exactly as
  // before, deterministically, without relying on the ingest-proxy describe
  // block happening to run first. The proxy tests below still override this
  // default per-test with their own `mockResolvedValue`/`mockRejectedValue`.
  const fetchMock = jest.spyOn(global, 'fetch');

  beforeEach(() => {
    statMock.mockReset();
    fetchMock.mockReset();
    // A fresh `Response` PER CALL (not one shared instance via
    // `mockResolvedValue`) — a `Response` body can only be read once, and a
    // test that calls `storeExtract` more than once (e.g. the re-upload
    // test) would otherwise have its SECOND `importInFlight` call fail to
    // parse a body already consumed by the first, tripping the best-effort
    // catch for the wrong reason (masking a real 200 as an unreachable-ingest
    // fallback).
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ in_flight: false }), { status: 200 }),
      ),
    );
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

  describe('PoiImportAdminService (ingest proxy)', () => {
    // Uses the hoisted `fetchMock` above (shared with storeExtract, #1011
    // review FIX 2) — reset + given a default in the top-level `beforeEach`;
    // every test below overrides it with its own specific response anyway.
    const svc = () =>
      new PoiImportAdminService(fakeConfig(), makeLockRedis() as never);

    it('listRegionStatus GETs /internal/poi/regions with the internal token and returns the body', async () => {
      const body = [{ source: 'osm', code: 'CZ', configured: true }];
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify(body), { status: 200 }),
      );

      const rows = await svc().listRegionStatus();

      expect(rows).toEqual(body);
      const [url, init] = fetchMock.mock.calls[0]!;
      expect(url).toBe('http://ingest:3005/internal/poi/regions');
      expect(
        (init!.headers as Record<string, string>)['x-internal-token'],
      ).toBe('tok');
    });

    it('listRuns forwards source/code/limit as query params', async () => {
      fetchMock.mockResolvedValue(new Response('[]', { status: 200 }));
      await svc().listRuns({ source: 'fsq', code: 'SK', limit: 5 });
      const [url] = fetchMock.mock.calls[0]!;
      // `url` is typed `RequestInfo | URL` (fetch's own param type) — compared
      // directly (not via `String(url)`, which trips `no-base-to-string` on
      // that union) since our own `ingestFetch` always passes a plain string.
      expect(url).toBe(
        'http://ingest:3005/internal/poi/runs?source=fsq&code=SK&limit=5',
      );
    });

    it('triggerImport POSTs /internal/poi/import and returns the job id', async () => {
      fetchMock.mockResolvedValue(
        new Response(
          JSON.stringify({ job_id: 'import-region_manual_osm_CZ' }),
          { status: 201 },
        ),
      );

      const res = await svc().triggerImport('osm', 'CZ');

      expect(res.job_id).toBe('import-region_manual_osm_CZ');
      const [url, init] = fetchMock.mock.calls[0]!;
      expect(url).toBe('http://ingest:3005/internal/poi/import');
      expect(init!.method).toBe('POST');
      expect(JSON.parse(init!.body as string)).toEqual({
        source: 'osm',
        code: 'CZ',
        trigger: 'manual',
      });
    });

    it('propagates the ingest 400 (unconfigured pair) with the same status', async () => {
      fetchMock.mockResolvedValue(
        new Response('source fsq is not enabled for region SK', {
          status: 400,
        }),
      );
      await expect(svc().triggerImport('fsq', 'SK')).rejects.toMatchObject({
        status: 400,
      });
    });

    it('maps an upstream 401 (internal token mismatch) to 502, not 401', async () => {
      // A bare 401 here means ingest's `IngestInternalGuard` rejected our
      // `x-internal-token` — a backend<->ingest config mismatch, not an
      // expired admin session. Relaying it verbatim would make the admin
      // SPA's 401-refresh middleware treat it as the latter.
      fetchMock.mockResolvedValue(
        new Response('invalid internal token', { status: 401 }),
      );
      await expect(svc().triggerImport('osm', 'CZ')).rejects.toMatchObject({
        status: 502,
      });
    });

    it('409s locally (before calling ingest) when an upload is in progress for the pair', async () => {
      const lock = makeLockRedis({ exists: 1 });
      const s = new PoiImportAdminService(fakeConfig(), lock as never);
      await expect(s.triggerImport('osm', 'CZ')).rejects.toMatchObject({
        status: 409,
      });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('503s when TARMOTO_INGEST_INTERNAL_URL is unset', async () => {
      const s = new PoiImportAdminService(
        fakeConfig({ TARMOTO_INGEST_INTERNAL_URL: undefined }),
        makeLockRedis() as never,
      );
      await expect(s.listRegionStatus()).rejects.toMatchObject({
        status: 503,
      });
    });

    it('503s when the ingest fetch itself throws (network error)', async () => {
      fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
      await expect(svc().listRegionStatus()).rejects.toMatchObject({
        status: 503,
      });
    });

    // #1011 review FIX B: every internal call is bounded by an
    // application-level deadline so a wedged ingest (TCP accepted, nothing
    // ever sent back) can't hang the caller until the runtime's own long
    // default.
    it('bounds the internal fetch with an AbortSignal (FIX B)', async () => {
      fetchMock.mockResolvedValue(new Response('[]', { status: 200 }));
      await svc().listRegionStatus();
      const [, init] = fetchMock.mock.calls[0]!;
      expect(init!.signal).toBeInstanceOf(AbortSignal);
    });

    it('surfaces a fetch that never resolves before the configured deadline as 503, not a hang (FIX B)', async () => {
      // A `fetch` stand-in that only ever settles via its AbortSignal — the
      // same contract the real `fetch` honors once `AbortSignal.timeout(ms)`
      // fires — proves `ingestFetch`'s EXISTING network-error catch is what
      // turns a timeout into 503; FIX B only needed to wire the signal in.
      // A 5ms configured deadline exercises the REAL `AbortSignal.timeout`
      // implementation deterministically and near-instantly, instead of
      // waiting anywhere near the 5000ms default (or a real 5s test).
      fetchMock.mockImplementation(
        (_input, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(
                new DOMException('The operation was aborted', 'TimeoutError'),
              ),
            );
          }),
      );
      const s = new PoiImportAdminService(
        fakeConfig({ TARMOTO_INGEST_INTERNAL_TIMEOUT_MS: '5' }),
        makeLockRedis() as never,
      );

      await expect(s.listRegionStatus()).rejects.toMatchObject({
        status: 503,
      });
    });

    it('translates a response-body read failure (headers received, then the body stalls/aborts) to 503, not 500', async () => {
      // Headers arrive so `fetch` RESOLVES (ok:true), then the body read
      // rejects — e.g. the AbortSignal.timeout fires mid-stream, or the body
      // is non-JSON. That happens after `ingestFetch`'s fetch-level catch, so
      // without wrapping the success-body read it would escape as a 500. It
      // must collapse to the same 503 as any other unverifiable ingest reply.
      fetchMock.mockResolvedValue({
        ok: true,
        status: 200,
        json: () =>
          Promise.reject(
            new DOMException('The operation was aborted', 'AbortError'),
          ),
      } as never);

      await expect(svc().listRegionStatus()).rejects.toMatchObject({
        status: 503,
      });
    });
  });

  describe('storeExtract', () => {
    let dir: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'tarmoto-poi-admin-test-'));
      // Every test below uses source 'osm' unless noted, so default the OSM
      // extract dir to the throwaway temp dir; the one test exercising the
      // "not configured" path deletes this itself.
      process.env.TARMOTO_OSM_POI_IMPORT_DIR = dir;
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

    // `POI_UPLOAD_MAX_BYTES` is a module-level constant now shared with
    // `AdminPoiController`'s multer config (#847 review Task 6 fix 3), read
    // once at module load rather than per instance — so this test exercises
    // the real configured boundary (`+ 1`) instead of overriding
    // `TARMOTO_POI_UPLOAD_MAX_BYTES` at runtime, which would no longer have
    // any effect once the module has already been imported.
    it('rejects an oversize upload with 400 before touching the filesystem', async () => {
      const svc = new PoiImportAdminService(
        fakeConfig(),
        makeLockRedis() as never,
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
        fakeConfig(),
        makeLockRedis() as never,
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
        fakeConfig(),
        makeLockRedis() as never,
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
      // Override this block's beforeEach default: TARMOTO_OSM_POI_IMPORT_DIR
      // unset → extractDirConfigured false → getExtractPath would throw a
      // plain Error (500); storeExtract must surface a clear 503 and write
      // nothing (#847 review).
      delete process.env.TARMOTO_OSM_POI_IMPORT_DIR;
      const svc = new PoiImportAdminService(
        fakeConfig(),
        makeLockRedis() as never,
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
        fakeConfig(),
        makeLockRedis() as never,
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
        fakeConfig(),
        makeLockRedis() as never,
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
    // TARMOTO_*_POI_IMPORT_DIR is SET, not that the shared mount actually
    // attached — a volume that failed to mount leaves the configured path's
    // PARENT directory simply absent. Without this check, `createWriteStream`
    // deep inside the pipeline below would throw a raw ENOENT — AFTER the
    // multipart body has already been fully accepted — surfacing as a raw
    // 500 instead of the same 503 class as the unconfigured-dir case.
    it('returns 503 (not 500) when the extract directory is configured but the mount never attached (ENOENT)', async () => {
      const svc = new PoiImportAdminService(
        fakeConfig(),
        makeLockRedis() as never,
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
        fakeConfig(),
        makeLockRedis() as never,
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
        fakeConfig(),
        makeLockRedis() as never,
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

    it('streams the upload atomically (temp file + fsync + rename) and returns the extract stat', async () => {
      const target = extractPath('osm', 'CZ');
      const svc = new PoiImportAdminService(
        fakeConfig(),
        makeLockRedis() as never,
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
        fakeConfig(),
        makeLockRedis() as never,
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
        fakeConfig(),
        makeLockRedis() as never,
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
        fakeConfig(),
        makeLockRedis() as never,
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
        fakeConfig(),
        makeLockRedis() as never,
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
    // lock via `uploadInProgress` is covered in the ingest-proxy block above.)
    it('does not touch the upload lock itself — held upstream by the interceptor (#972)', async () => {
      const redis = makeLockRedis();
      const svc = new PoiImportAdminService(fakeConfig(), redis as never);
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

    // #1011 review (FIX 2): restores, via a cross-boundary check to
    // apps/ingest, the upload-vs-import guard that used to live here as a
    // local queue scan before Phase 3 moved the `poi.import` queue entirely
    // into apps/ingest (the two tests Task 2 deleted covered that queue scan
    // directly — these are the API-shaped equivalent).
    it('returns 409 (and writes nothing) when apps/ingest reports an import already in flight for the pair', async () => {
      const svc = new PoiImportAdminService(
        fakeConfig(),
        makeLockRedis() as never,
      );
      const target = extractPath('osm', 'CZ');
      // Parent-dir mount check must pass so the test actually reaches the
      // new in-flight guard.
      statMock.mockResolvedValueOnce({ isDirectory: () => true } as never);
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ in_flight: true }), { status: 200 }),
      );

      await expect(
        svc.storeExtract('osm', 'CZ', {
          stream: Readable.from(Buffer.from('x')),
          size: 1,
          originalName: 'cz.osm',
        }),
      ).rejects.toMatchObject({ status: 409 });

      // Queried the exact pair being uploaded — not a stand-in for scoping
      // logic (that lives in apps/ingest's own `importInFlight` scan; see
      // poi-internal.service.spec.ts), just proof this call targets the
      // right (source, code).
      const [url] = fetchMock.mock.calls[0]!;
      expect(url).toBe(
        'http://ingest:3005/internal/poi/import-status?source=osm&code=CZ',
      );
      expect(leftoverPartFiles()).toEqual([]);
      expect(existsSync(target)).toBe(false);
    });

    it('proceeds with the upload when apps/ingest reports no import in flight for the pair', async () => {
      const target = extractPath('osm', 'CZ');
      const svc = new PoiImportAdminService(
        fakeConfig(),
        makeLockRedis() as never,
      );
      statMock.mockResolvedValueOnce({ isDirectory: () => true } as never);
      statMock.mockResolvedValueOnce({ size: 5, mtimeMs: 0 } as never);
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ in_flight: false }), { status: 200 }),
      );

      const result = await svc.storeExtract('osm', 'CZ', {
        stream: Readable.from(Buffer.from('hello')),
        size: 5,
        originalName: 'cz.osm',
      });

      expect(result.present).toBe(true);
      expect(readFileSync(target, 'utf8')).toBe('hello');
    });

    // #1011 review FIX A, hardened per follow-up review: an earlier version
    // skipped this guard (proceeded) when `TARMOTO_INGEST_INTERNAL_URL` was
    // unset, reasoning "unconfigured" meant no ingest worker could possibly
    // be racing the upload. That carve-out was unsafe — apps/ingest runs its
    // own always-on worker and weekly/monthly refresh independently of
    // whether THIS BACKEND has the URL configured (see the runbook), so an
    // unset URL never proves no import is running, only that this backend
    // can't check. This test inverts the prior "unset → proceeds" behavior
    // (see git history for the version it replaces): unset must now ALSO
    // fail closed with 503, exactly like any other unverifiable state.
    it('fails closed with 503 (and writes nothing) when TARMOTO_INGEST_INTERNAL_URL is unset', async () => {
      const target = extractPath('osm', 'CZ');
      const svc = new PoiImportAdminService(
        fakeConfig({ TARMOTO_INGEST_INTERNAL_URL: undefined }),
        makeLockRedis() as never,
      );
      statMock.mockResolvedValueOnce({ isDirectory: () => true } as never);

      await expect(
        svc.storeExtract('osm', 'CZ', {
          stream: Readable.from(Buffer.from('x')),
          size: 1,
          originalName: 'cz.osm',
        }),
      ).rejects.toMatchObject({ status: 503 });

      expect(fetchMock).not.toHaveBeenCalled();
      expect(leftoverPartFiles()).toEqual([]);
      expect(existsSync(target)).toBe(false);
    });

    // #1011 review FIX A: once the integration IS configured, a network
    // error verifying import status must NOT be read as "not in flight" —
    // the ingest worker may still be reading the CURRENT extract, so
    // proceeding would reopen the exact race this guard exists to close.
    // This inverts the old best-effort behavior (see git history for the
    // prior version of this test), which is exactly the bug FIX A closes.
    it('fails closed with 503 (and writes nothing) when apps/ingest is unreachable for the in-flight check', async () => {
      const target = extractPath('osm', 'CZ');
      const svc = new PoiImportAdminService(
        fakeConfig(),
        makeLockRedis() as never,
      );
      statMock.mockResolvedValueOnce({ isDirectory: () => true } as never);
      fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));

      await expect(
        svc.storeExtract('osm', 'CZ', {
          stream: Readable.from(Buffer.from('x')),
          size: 1,
          originalName: 'cz.osm',
        }),
      ).rejects.toMatchObject({ status: 503 });

      expect(leftoverPartFiles()).toEqual([]);
      expect(existsSync(target)).toBe(false);
    });

    it('fails closed with 503 (not the raw upstream status) when apps/ingest answers with a server error', async () => {
      // A 500 is still an unverifiable answer from the upload guard's point
      // of view — it must collapse to the SAME 503, not leak ingest's own
      // status code into the upload path.
      const target = extractPath('osm', 'CZ');
      const svc = new PoiImportAdminService(
        fakeConfig(),
        makeLockRedis() as never,
      );
      statMock.mockResolvedValueOnce({ isDirectory: () => true } as never);
      fetchMock.mockResolvedValueOnce(
        new Response('internal error', { status: 500 }),
      );

      await expect(
        svc.storeExtract('osm', 'CZ', {
          stream: Readable.from(Buffer.from('x')),
          size: 1,
          originalName: 'cz.osm',
        }),
      ).rejects.toMatchObject({ status: 503 });

      expect(leftoverPartFiles()).toEqual([]);
      expect(existsSync(target)).toBe(false);
    });

    it('fails closed with 503 (not 502) when apps/ingest rejects the internal token', async () => {
      // `ingestFetch` itself remaps a bare 401/403 to 502 for the
      // trigger/regions/runs proxies (a backend<->ingest config mismatch,
      // not an admin-session concern — see the "maps an upstream 401" test
      // above). For THIS guard a token mismatch is just another
      // unverifiable state, and must still reject the upload with 503, not
      // let that 502 leak through.
      const target = extractPath('osm', 'CZ');
      const svc = new PoiImportAdminService(
        fakeConfig(),
        makeLockRedis() as never,
      );
      statMock.mockResolvedValueOnce({ isDirectory: () => true } as never);
      fetchMock.mockResolvedValueOnce(
        new Response('invalid internal token', { status: 401 }),
      );

      await expect(
        svc.storeExtract('osm', 'CZ', {
          stream: Readable.from(Buffer.from('x')),
          size: 1,
          originalName: 'cz.osm',
        }),
      ).rejects.toMatchObject({ status: 503 });

      expect(leftoverPartFiles()).toEqual([]);
      expect(existsSync(target)).toBe(false);
    });

    it('fails closed with 503 (and writes nothing) when apps/ingest returns a 200 with a malformed body (no boolean in_flight)', async () => {
      // The compile-time generic on `ingestFetch` does NO runtime validation,
      // so a 200 whose body lacks a boolean `in_flight` (e.g. `{}` from a
      // partial deployment or an intermediary) would leave `res.in_flight`
      // `undefined` — which `storeExtract` reads as falsy/idle, silently
      // failing OPEN. An unverifiable body must collapse to the same 503 as
      // any other unverifiable state.
      const target = extractPath('osm', 'CZ');
      const svc = new PoiImportAdminService(
        fakeConfig(),
        makeLockRedis() as never,
      );
      statMock.mockResolvedValueOnce({ isDirectory: () => true } as never);
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({}), { status: 200 }),
      );

      await expect(
        svc.storeExtract('osm', 'CZ', {
          stream: Readable.from(Buffer.from('x')),
          size: 1,
          originalName: 'cz.osm',
        }),
      ).rejects.toMatchObject({ status: 503 });

      expect(leftoverPartFiles()).toEqual([]);
      expect(existsSync(target)).toBe(false);
    });
  });

  describe('upload lock (acquire / renew / release, #972)', () => {
    const lockKey = 'poi:import:upload-lock:osm:CZ';
    const makeSvc = (redis: ReturnType<typeof makeLockRedis>) =>
      new PoiImportAdminService(fakeConfig(), redis as never);

    it('acquireUploadLock takes an owned NX lock with a TTL and returns the token', async () => {
      const redis = makeLockRedis();
      const token = await makeSvc(redis).acquireUploadLock('osm', 'CZ');

      expect(token).toEqual(expect.any(String));
      expect(redis.set).toHaveBeenCalledWith(lockKey, token, 'EX', 600, 'NX');
    });

    it('acquireUploadLock returns null when the lock is already held (NX fails)', async () => {
      const redis = makeLockRedis();
      redis.set.mockResolvedValue(null);

      expect(await makeSvc(redis).acquireUploadLock('osm', 'CZ')).toBeNull();
    });

    it('releaseUploadLock uses a del-if-token-matches Lua, never a blind DEL', async () => {
      const redis = makeLockRedis();
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
      const redis = makeLockRedis();
      redis.eval.mockRejectedValue(new Error('redis down'));

      await expect(
        makeSvc(redis).releaseUploadLock('osm', 'CZ', 'tok'),
      ).resolves.toBeUndefined();
    });

    it('renewUploadLock extends the TTL via a token-checked EXPIRE (keeps a slow upload from lapsing)', async () => {
      const redis = makeLockRedis();
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
      const redis = makeLockRedis();
      redis.eval.mockRejectedValue(new Error('redis down'));

      await expect(
        makeSvc(redis).renewUploadLock('osm', 'CZ', 'tok'),
      ).resolves.toBeUndefined();
    });
  });
});
