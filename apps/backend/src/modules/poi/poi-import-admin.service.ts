import {
  BadRequestException,
  ConflictException,
  HttpException,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Redis } from 'ioredis';
import { randomBytes, randomUUID } from 'node:crypto';
import { createWriteStream, type Stats } from 'node:fs';
import { open, rename, stat, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  DEFAULT_REGIONS,
  FsqPoiImportSource,
  OsmPoiImportSource,
  type ImportStatusResponse,
  type PoiImportRegion,
  type PoiImportSource,
  type RegionImportStatus,
  type RunSummary,
  type TriggerImportResponse,
} from '@tarmoto/ingest';
import { POI_UPLOAD_LOCK_REDIS } from './poi-upload-lock-redis.js';

/**
 * The canonical coverage list (`DEFAULT_REGIONS`) + the per-source extract
 * filename convention (`OsmPoiImportSource`/`FsqPoiImportSource`, plain
 * classes with no DB/queue dependencies of their own), keyed by the wire
 * `source` string this service already uses everywhere. Task 5
 * (POI-ingestion extraction) moved the actual import engine —
 * `PoiImportService` and the injected `POI_IMPORT_SOURCES` registry it used
 * to read this same metadata from — into `apps/ingest`. This admin
 * front-door only ever READ metadata off that registry (recon-B's key
 * finding: every public method here is already enqueue/status/upload, never
 * import logic), so it's replaced with this local, ingest-free descriptor
 * instead of reaching across app boundaries for it.
 */
const SOURCE_STRATEGIES: Record<string, PoiImportSource> = {
  osm: new OsmPoiImportSource(),
  fsq: new FsqPoiImportSource(),
};

/**
 * Look up a region's canonical bbox by ISO code. Every code this service
 * calls this with has already passed a `DEFAULT_REGIONS` membership check
 * (`importerFor`) — an unresolved code here means an internal caller
 * bypassed that validation, not a bad request from outside.
 */
function regionFor(code: string): PoiImportRegion {
  const region = DEFAULT_REGIONS.find((r) => r.code === code);
  if (!region) {
    throw new Error(`unknown POI import region: ${code}`);
  }
  return region;
}

/**
 * Streaming cap for an operator-provided extract upload (#847), configurable
 * via `TARMOTO_POI_UPLOAD_MAX_BYTES` — default 200 MB, comfortably above any
 * filtered/clipped single-country `.osm`/`.fsq.jsonl` extract (design spec
 * §11) while still bounding a runaway or mistaken upload. Read once at
 * module load (not per call) — fine in practice since this only changes via
 * a redeploy, which reloads the module anyway.
 *
 * Shared by the two enforcement points that must never desync (#847 review
 * Task 6 fix 3 — each used to compute this independently):
 *  - `AdminPoiController`'s multer `limits.fileSize`, which is what actually
 *    enforces the cap on the wire: multer aborts the STREAM mid-upload
 *    (surfaced by `@nestjs/platform-express` as a 413) once the byte count
 *    crosses it, before disk ever holds the full file.
 *  - `storeExtract` below, which re-checks the caller-declared `size` field
 *    AFTER an upload has already fully landed — a defense-in-depth backstop
 *    for any other caller of `storeExtract` (e.g. a future CLI path), not
 *    the primary guard for the upload route itself.
 */
export const POI_UPLOAD_MAX_BYTES =
  Number(process.env.TARMOTO_POI_UPLOAD_MAX_BYTES) || 200 * 1024 * 1024;

/**
 * TTL (seconds) on the per-`(source, code)` upload lock (#972). NOT sized to
 * cover a whole upload — a `POI_UPLOAD_MAX_BYTES` extract over a slow link can
 * outlast any fixed TTL (#972 review), so `PoiUploadLockInterceptor` RENEWS it
 * on an interval while the request is in flight. The TTL is therefore just the
 * crash/abort grace: once renewals stop (finalize ran, or the process died) the
 * lock frees within this long. `releaseUploadLock` is the normal release path.
 */
const UPLOAD_LOCK_TTL_SECONDS = 600;

/**
 * How often the interceptor renews the lock while an upload is in flight — a
 * third of the TTL, so even a couple of missed ticks (event-loop lag) leave
 * margin before the lock could lapse.
 */
export const UPLOAD_LOCK_RENEW_INTERVAL_MS =
  (UPLOAD_LOCK_TTL_SECONDS / 3) * 1000;

/**
 * Release the upload lock ONLY if this request still owns it (stored value ==
 * our token), so a request whose TTL lapsed mid-upload can never delete a lock
 * a later upload has since acquired. `KEYS[1]` = lock key, `ARGV[1]` = token.
 */
const RELEASE_UPLOAD_LOCK_LUA = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
end
return 0`;

/**
 * Extend the lock's TTL, but ONLY if this request still owns it (token match) —
 * so a renewal that fires after our TTL already lapsed (and another upload took
 * the lock) can't extend THAT upload's lock. `KEYS[1]` = key, `ARGV[1]` = token,
 * `ARGV[2]` = new TTL seconds.
 */
const RENEW_UPLOAD_LOCK_LUA = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("expire", KEYS[1], ARGV[2])
end
return 0`;

/**
 * Admin surface for the POI import system (#847). Phase 3 turned the read
 * side — per-`(source, region)` coverage/count/extract-presence/last-run/
 * live-queue-state (`listRegionStatus`), plus run history (`listRuns`), plus
 * the manual trigger (`triggerImport`) — into a thin HTTP proxy of
 * apps/ingest's `/internal/poi/*` API: the coverage/runs/enqueue data plane
 * (and the `poi.import` queue itself) now live entirely in apps/ingest. This
 * service keeps only what the backend itself must own: the validated atomic
 * extract upload (`storeExtract`, admin -> backend -> shared volume) and the
 * per-`(source, code)` upload lock that coordinates it with a manual trigger.
 * `storeExtract` also asks apps/ingest (`importInFlight`, #1011 review FIX
 * 2) whether an import for the same pair is currently running, restoring
 * the upload-vs-import guard that lost its local queue when Phase 3
 * relocated it. That ask SKIPS (upload proceeds) only when the integration
 * isn't configured at all; once it IS configured, any failure to get a
 * verified answer FAILS CLOSED with a 503 rather than silently proceeding
 * (#1011 review FIX A).
 */
@Injectable()
export class PoiImportAdminService {
  private readonly logger = new Logger(PoiImportAdminService.name);

  constructor(
    private readonly config: ConfigService,
    @Inject(POI_UPLOAD_LOCK_REDIS) private readonly lockRedis: Redis,
  ) {}

  private ingestUrl(path: string): string {
    const base = this.config.get<string>('TARMOTO_INGEST_INTERNAL_URL')?.trim();
    if (!base) {
      throw new ServiceUnavailableException(
        'TARMOTO_INGEST_INTERNAL_URL is not configured — the POI import admin API is unavailable',
      );
    }
    return `${base.replace(/\/$/, '')}${path}`;
  }

  private async ingestFetch<T>(path: string, init?: RequestInit): Promise<T> {
    const token = this.config.get<string>('TARMOTO_INTERNAL_API_TOKEN')?.trim();
    let res: Response;
    try {
      res = await fetch(this.ingestUrl(path), {
        ...init,
        headers: {
          'content-type': 'application/json',
          ...(token ? { 'x-internal-token': token } : {}),
          ...(init?.headers ?? {}),
        },
      });
    } catch (err) {
      throw new ServiceUnavailableException(
        `ingest internal API unreachable: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    if (!res.ok) {
      const detail = await res.text();
      // Propagate most ingest statuses verbatim so the admin UI sees the
      // same error class: 400 (unknown/disabled pair), 409 (in-flight), 503
      // (store down). 401/403 are remapped to 502 instead: those mean
      // ingest's `IngestInternalGuard` rejected our `x-internal-token` — a
      // backend<->ingest token misconfiguration, not anything about the
      // admin's OWN session. Relaying either verbatim would make the admin
      // SPA's 401-refresh middleware misread a server-to-server auth failure
      // as an expired admin session (spurious refresh/logout); 502 correctly
      // reads as "this server's upstream gateway failed."
      const status =
        res.status === 401 || res.status === 403 ? 502 : res.status;
      throw new HttpException(detail || res.statusText, status);
    }
    return (await res.json()) as T;
  }

  /** Proxy → GET /internal/poi/regions (the full coverage table). */
  listRegionStatus(): Promise<RegionImportStatus[]> {
    return this.ingestFetch<RegionImportStatus[]>('/internal/poi/regions');
  }

  /** Proxy → GET /internal/poi/runs. */
  listRuns(filter: {
    source?: string;
    code?: string;
    limit: number;
  }): Promise<RunSummary[]> {
    const params = new URLSearchParams();
    if (filter.source) params.set('source', filter.source);
    if (filter.code) params.set('code', filter.code);
    params.set('limit', String(filter.limit));
    return this.ingestFetch<RunSummary[]>(
      `/internal/poi/runs?${params.toString()}`,
    );
  }

  /**
   * Proxy → POST /internal/poi/import. The upload↔import coordination stays
   * here (the backend owns the upload lock): block a manual trigger while a
   * replacement extract for this pair is still landing. The queue-in-flight
   * 409 + the enqueue itself live in ingest.
   */
  async triggerImport(
    source: string,
    code: string,
  ): Promise<TriggerImportResponse> {
    if (await this.uploadInProgress(source, code)) {
      throw new ConflictException(
        `an extract upload is in progress for ${source}/${code}; wait for it to finish before importing`,
      );
    }
    return this.ingestFetch<TriggerImportResponse>('/internal/poi/import', {
      method: 'POST',
      body: JSON.stringify({ source, code, trigger: 'manual' }),
    });
  }

  /**
   * Whether the apps/ingest internal-API integration is configured at all
   * (`TARMOTO_INGEST_INTERNAL_URL` set) — checked directly against config,
   * mirroring `ingestUrl`'s own guard, so a caller that needs to
   * special-case "unconfigured" (namely `importInFlight`'s skip-the-guard
   * branch below, #1011 review FIX A) can do so BEFORE ever calling
   * `ingestFetch`, rather than tripping `ingestUrl`'s own unset-URL 503.
   */
  private ingestConfigured(): boolean {
    return Boolean(
      this.config.get<string>('TARMOTO_INGEST_INTERNAL_URL')?.trim(),
    );
  }

  /**
   * Proxy → GET /internal/poi/import-status (#1011 review FIX 2). Restores,
   * across the app boundary, the upload-vs-import guard `storeExtract` lost
   * when Phase 3 moved the `poi.import` queue entirely into apps/ingest (see
   * the comment at its one call site below).
   *
   * Two distinct outcomes — NOT one blanket "any failure proceeds" fallback
   * (#1011 review FIX A: the original best-effort version was unsafe. A
   * network partition, a token mismatch, or an ingest 5xx does NOT mean no
   * worker is reading the current extract — it may well still be mid-read,
   * so treating "couldn't verify" as "not in flight" reopened the exact
   * upload-vs-import race this guard exists to close):
   *
   *  - `TARMOTO_INGEST_INTERNAL_URL` UNSET → the integration isn't
   *    configured at all, so there is no ingest worker process that could
   *    possibly be racing this upload (apps/ingest is the ONLY process that
   *    ever holds the `poi.import` queue/worker, Phase 3) — "unconfigured"
   *    and "nothing could be importing" are the same fact here. Skip the
   *    guard (return `false`, i.e. proceed) WITHOUT calling ingest at all,
   *    preserving the documented degraded mode where local uploads still
   *    work without the ingest integration configured. Checked directly via
   *    `ingestConfigured()` and short-circuited before any fetch, so this
   *    never trips `ingestFetch`'s own unset-URL 503.
   *  - URL SET → a verified answer is required. A clean `{ in_flight }`
   *    response returns that value; ANYTHING else — a network error, a
   *    timed-out or unreachable connection, a token mismatch (which
   *    `ingestFetch` itself remaps to 502), any other non-OK status, or a
   *    malformed body — FAILS CLOSED: this throws
   *    `ServiceUnavailableException` (503) instead of returning `false`, so
   *    `storeExtract` rejects the upload rather than silently racing a
   *    worker it can no longer see.
   */
  private async importInFlight(source: string, code: string): Promise<boolean> {
    if (!this.ingestConfigured()) {
      return false;
    }
    const params = new URLSearchParams({ source, code });
    try {
      const res = await this.ingestFetch<ImportStatusResponse>(
        `/internal/poi/import-status?${params.toString()}`,
      );
      return res.in_flight;
    } catch (err) {
      this.logger.warn(
        `import-status check failed for ${source}/${code} — failing closed (refusing the upload) rather than risk racing a worker that may still be reading the current extract: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      throw new ServiceUnavailableException(
        'Cannot verify POI import status; refusing to replace the extract while an import may be running.',
      );
    }
  }

  /**
   * Resolve `source`'s strategy, and confirm `code` is one of the canonical
   * `DEFAULT_REGIONS`. Shared validation for the upload write-side entry
   * point below — an upload for an unregistered source, or a region outside
   * the coverage list, is a client mistake (400), not a 404/500: the admin
   * UI only ever offers configured `(source, code)` pairs, so reaching here
   * with an unknown pair means a stale page, a hand-crafted request, or a
   * typo.
   */
  private importerFor(source: string, code: string): PoiImportSource {
    const strategy = SOURCE_STRATEGIES[source];
    if (!strategy) {
      throw new BadRequestException(`unknown source: ${source}`);
    }
    if (!DEFAULT_REGIONS.some((r) => r.code === code)) {
      throw new BadRequestException(
        `unknown region ${code} for source ${source}`,
      );
    }
    return strategy;
  }

  /**
   * The operator-configured extract directory for `source` — this
   * front-door's OWN `TARMOTO_POI_IMPORT_DIR` (OSM) / `TARMOTO_FSQ_IMPORT_DIR`
   * (FSQ) env, since it's what actually receives extract uploads
   * (`storeExtract`). Read directly on every call rather than cached: this
   * only ever changes via a redeploy, which reloads the module anyway —
   * mirrors `POI_UPLOAD_MAX_BYTES`'s own module-load-time env read above.
   */
  private extractDir(source: string): string | undefined {
    const envVar =
      source === 'fsq' ? 'TARMOTO_FSQ_IMPORT_DIR' : 'TARMOTO_POI_IMPORT_DIR';
    return process.env[envVar]?.trim() || undefined;
  }

  private extractDirConfigured(source: string): boolean {
    return Boolean(this.extractDir(source));
  }

  /**
   * The extract path for `(source, code)` under this front-door's configured
   * extract dir, using the SAME `<code-lowercase>.osm` /
   * `<code-lowercase>.fsq.jsonl` naming convention
   * `OsmPoiImportSource`/`FsqPoiImportSource.extractFilename` use in
   * apps/ingest — an operator-uploaded extract lands exactly where the
   * ingest worker reads it from. Callers MUST have already confirmed
   * `extractDirConfigured(source)` — this asserts the dir is set.
   */
  private getExtractPath(source: string, code: string): string {
    const strategy = SOURCE_STRATEGIES[source];
    if (!strategy) {
      throw new Error(`unknown POI import source: ${source}`);
    }
    return join(
      this.extractDir(source)!,
      strategy.extractFilename(regionFor(code)),
    );
  }

  /**
   * Redis key for the server-side per-`(source, code)` upload lock (#847,
   * #972). Acquired by `PoiUploadLockInterceptor` BEFORE Multer drains the
   * upload body and held across the whole client→API upload + handler
   * (`acquireUploadLock`/`releaseUploadLock` below), and consulted by
   * `triggerImport` (via `uploadInProgress`) so a manual trigger can't enqueue
   * a worker while a replacement upload for the same region is still landing.
   */
  private uploadLockKey(source: string, code: string): string {
    return `poi:import:upload-lock:${source}:${code}`;
  }

  /**
   * True while an extract upload for `(source, code)` is mid-stream — i.e.
   * `PoiUploadLockInterceptor` has acquired but not yet released this pair's
   * upload lock. This is `triggerImport`'s local 409 guard, closing the gap
   * an upload that hasn't reached apps/ingest at all would otherwise leave.
   */
  private async uploadInProgress(
    source: string,
    code: string,
  ): Promise<boolean> {
    const redis = this.lockRedis;
    return (await redis.exists(this.uploadLockKey(source, code))) > 0;
  }

  /**
   * Acquire the exclusive per-`(source, code)` upload lock for the duration of
   * an extract upload (#972). `SET … NX` with a per-request token: **owned**
   * (only the holder can release it) and **exclusive** (a second overlapping
   * upload for the same region can't also take it), TTL'd so a crashed/aborted
   * upload self-heals. `PoiUploadLockInterceptor` calls this BEFORE Multer
   * drains the (up to `POI_UPLOAD_MAX_BYTES`) body — closing the window the
   * old in-`storeExtract` lock left open, where the lock wasn't held during the
   * client→API stream so `triggerImport`'s `uploadInProgress` saw nothing.
   * Returns the owner token to pass back to `releaseUploadLock`, or `null` if
   * another upload already holds the lock (the interceptor maps `null` → 409).
   */
  async acquireUploadLock(
    source: string,
    code: string,
  ): Promise<string | null> {
    const redis = this.lockRedis;
    const token = randomUUID();
    const acquired = await redis.set(
      this.uploadLockKey(source, code),
      token,
      'EX',
      UPLOAD_LOCK_TTL_SECONDS,
      'NX',
    );
    return acquired === 'OK' ? token : null;
  }

  /**
   * Extend the upload lock's TTL while the upload is still in flight, ONLY if
   * this request still owns it (token-checked `EXPIRE`) — so a slow upload that
   * outlasts `UPLOAD_LOCK_TTL_SECONDS` keeps its lock instead of letting it
   * lapse and reopening the stale-extract window (#972 review). Driven by
   * `PoiUploadLockInterceptor`'s heartbeat every
   * `UPLOAD_LOCK_RENEW_INTERVAL_MS`; best-effort, like release.
   */
  async renewUploadLock(
    source: string,
    code: string,
    token: string,
  ): Promise<void> {
    try {
      const redis = this.lockRedis;
      await redis.eval(
        RENEW_UPLOAD_LOCK_LUA,
        1,
        this.uploadLockKey(source, code),
        token,
        String(UPLOAD_LOCK_TTL_SECONDS),
      );
    } catch (err) {
      this.logger.warn(
        `upload-lock renew failed for ${source}/${code}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * Release the lock from `acquireUploadLock`, but ONLY if this request still
   * owns it — a Lua **del-if-token-matches** (never a blind `DEL`), so a
   * request whose TTL lapsed mid-upload can't delete the lock a later upload
   * has since acquired. Best-effort: a Redis hiccup here must never fail an
   * upload that already succeeded, and the TTL is the ultimate backstop.
   */
  async releaseUploadLock(
    source: string,
    code: string,
    token: string,
  ): Promise<void> {
    try {
      const redis = this.lockRedis;
      await redis.eval(
        RELEASE_UPLOAD_LOCK_LUA,
        1,
        this.uploadLockKey(source, code),
        token,
      );
    } catch (err) {
      this.logger.warn(
        `upload-lock release failed for ${source}/${code}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * Validated, atomic upload of an operator-provided extract (#847) — the
   * write-side counterpart to `listRegionStatus`'s `extract` stat. Checks run
   * cheapest-first: declared size against `POI_UPLOAD_MAX_BYTES` (no I/O), then
   * `(source, code)` (in-memory), then the filename extension, then whether
   * the extract directory is even configured — all before touching the
   * filesystem. One more check follows once a target path exists (#847
   * review): a `stat` of the target's PARENT directory (catches a mount
   * that's configured but never actually attached — `extractDirConfigured`
   * only proves the env var is SET, not that the shared volume is really
   * there). All of this runs before a single byte is written.
   *
   * Upload lock (#847, #972): the exclusive per-`(source, code)` upload lock
   * is held UPSTREAM by `PoiUploadLockInterceptor` for the whole client→API
   * upload — acquired before Multer drains the body, released after this
   * handler returns — so `triggerImport` (via `uploadInProgress`) can't queue
   * an import against the OLD target while a replacement upload for the same
   * region is still landing. This method no longer takes that lock itself: a
   * direct, non-HTTP caller is outside the concurrent-admin race #972 scopes,
   * and re-locking the same key here would self-conflict with the interceptor's
   * `SET NX`.
   *
   * Atomicity: the upload streams to a SIBLING temp file
   * (`<target>.<pid>.<random-hex>.part`, same directory as `target` so the
   * final rename is same-filesystem and therefore atomic — POSIX
   * `rename(2)` never exposes a partially-written destination), `fsync`s it
   * so the bytes are durable on disk BEFORE the rename lands (the import job
   * that reads `target` next runs in a separate process — possibly after a
   * crash — so "written" has to mean "on disk", not "sitting in this
   * process's or the OS's write buffers"), then renames onto `target`. The
   * temp name is unique PER CALL (pid + random hex, not a fixed
   * `<target>.part`) so two concurrent uploads for the same `(source, code)`
   * each stream into their OWN temp file instead of interleaving writes into
   * one shared path — only the final rename ever touches the shared
   * `target` name, and rename is atomic, so whichever call lands last simply
   * wins cleanly rather than corrupting the other's in-progress write (or
   * failing its own rename with ENOENT because the other call's cleanup
   * already unlinked the shared temp file). A failure at any step (open,
   * write, fsync, or rename) removes that call's OWN temp file best-effort
   * and rethrows the original error; `target` itself is only ever touched
   * by the final, all-or-nothing rename, so a failed upload can never
   * truncate or corrupt a previously-good extract.
   *
   * The write and the fsync use TWO separate file handles rather than one:
   * `pipeline()` (via `stream.finished` under the hood) waits for the
   * writable's `'close'` event, which a plain `fs.createWriteStream` emits
   * once it auto-closes its own fd on `'finish'`. Opening a SECOND handle
   * (`open(tmp, 'r+')`) purely to `sync()` + `close()` afterward avoids
   * fighting that lifecycle — passing `autoClose: false` to keep the first
   * handle's fd alive for a post-pipeline `sync()` sounds equivalent, but it
   * suppresses the very `'close'` event `pipeline()` is waiting for, so the
   * write never resolves at all.
   *
   * The rename itself gets the same durability treatment (#847 review): on
   * POSIX, fsyncing the renamed FILE's own fd does not guarantee the
   * directory-entry update `rename(2)` just made is durable — only fsyncing
   * the CONTAINING DIRECTORY does that. Without it, a crash right after
   * `rename()` returns can lose the new directory entry, so `target` (or, on
   * a replacement upload, the old file it replaced) may not exist after a
   * reboot even though `rename()` reported success. This is a best-effort
   * step inside the same try as everything above: a failure here still
   * unlinks this call's OWN temp file and rethrows, same as any other step.
   */
  async storeExtract(
    source: string,
    code: string,
    file: { stream: Readable; size: number; originalName: string },
  ): Promise<{ present: true; size_bytes: number; modified_at: string }> {
    if (file.size > POI_UPLOAD_MAX_BYTES) {
      throw new BadRequestException(
        `extract exceeds ${POI_UPLOAD_MAX_BYTES} bytes`,
      );
    }
    this.importerFor(source, code);
    const expectedExt = source === 'fsq' ? '.fsq.jsonl' : '.osm';
    if (!file.originalName.toLowerCase().endsWith(expectedExt)) {
      throw new BadRequestException(
        `expected a ${expectedExt} file for ${source}`,
      );
    }
    // A deployment without TARMOTO_*_IMPORT_DIR set has no upload target;
    // `getExtractPath` would throw a plain Error → 500. Surface a clear 503
    // instead (the status read collapses the same condition to `extract: null`,
    // so the UI still offers Upload) (#847 review).
    if (!this.extractDirConfigured(source)) {
      throw new ServiceUnavailableException(
        `POI extract storage is not configured for ${source} — set ${
          source === 'fsq' ? 'TARMOTO_FSQ_IMPORT_DIR' : 'TARMOTO_POI_IMPORT_DIR'
        }`,
      );
    }
    const target = this.getExtractPath(source, code);

    // `extractDirConfigured` only proves TARMOTO_*_IMPORT_DIR is SET, not
    // that the shared extract volume actually attached — a mount that failed
    // at container start (or an operator mistake leaving a plain file where
    // a directory belongs) still passes that check. Stat the PARENT
    // directory before streaming a single byte: without this,
    // `createWriteStream(tmp)` below would throw a raw ENOENT deep inside
    // the pipeline — AFTER the multipart body has already been fully
    // accepted — surfacing as a raw 500 instead of the same 503 class as the
    // unconfigured-dir case above. A non-ENOENT stat error on the parent
    // (EACCES/EIO/...) is a distinct real fault and propagates unchanged
    // (#847 review).
    const parentDir = dirname(target);
    let parentStat: Stats | undefined;
    try {
      parentStat = await stat(parentDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    if (!parentStat || !parentStat.isDirectory()) {
      throw new ServiceUnavailableException(
        `POI extract storage directory is absent for ${source} — the shared mount may not have attached`,
      );
    }

    // Defense-in-depth against a replacement upload racing a LIVE import for
    // this exact (source, code): a worker may be mid-read of the CURRENT
    // extract file while an operator's new upload is about to atomically
    // replace it out from under it. Phase 3 moved the `poi.import` queue
    // entirely into apps/ingest, so the backend can no longer answer this
    // itself — `importInFlight` above asks apps/ingest instead. It skips
    // that ask (upload proceeds) only when the integration isn't configured
    // at all; once it IS configured, any failure to get a verified answer
    // throws (503) instead of silently proceeding — see its doc comment
    // (#1011 review FIX A).
    if (await this.importInFlight(source, code)) {
      throw new ConflictException(
        `an import is in progress for ${source}/${code}; wait before replacing the extract`,
      );
    }

    // Unique per call (not a fixed `<target>.part`) — see the doc comment
    // above: this is what keeps two concurrent uploads for the same
    // (source, code) from interleaving writes into one shared temp path.
    const tmp = `${target}.${process.pid}.${randomBytes(6).toString('hex')}.part`;
    try {
      await pipeline(file.stream, createWriteStream(tmp));
      const handle = await open(tmp, 'r+');
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(tmp, target);
      // Fsync the containing directory so the rename's directory-entry
      // update is crash-durable too — see the doc comment above.
      const dir = await open(dirname(target));
      try {
        await dir.sync();
      } finally {
        await dir.close();
      }
    } catch (err) {
      await unlink(tmp).catch(() => undefined);
      throw err;
    }

    const s = await stat(target);
    return {
      present: true as const,
      size_bytes: s.size,
      modified_at: new Date(s.mtimeMs).toISOString(),
    };
  }
}
