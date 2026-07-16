import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import { randomBytes, randomUUID } from 'node:crypto';
import { createWriteStream, type Stats } from 'node:fs';
import { open, rename, stat, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { JOB_NAMES, QUEUE_NAMES } from '../jobs/jobs.constants.js';
import { DEFAULT_JOB_OPTIONS } from '../jobs/jobs.config.js';
import {
  DEFAULT_REGIONS,
  FsqPoiImportSource,
  OsmPoiImportSource,
  type PoiImportRegion,
  type PoiImportRegionJobData,
  type PoiImportSource,
  type RegionImportStatus,
  type RunSummary,
} from '@tarmoto/ingest';
import { PoiImportRun } from '@tarmoto/poi-db';
import { isPoiConnectionError } from './poi-repo.js';

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
 * (`importerFor`, or `listRegionStatus`'s own pairs, which are DERIVED from
 * `DEFAULT_REGIONS` in the first place) — an unresolved code here means an
 * internal caller bypassed that validation, not a bad request from outside.
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
 * Admin surface for the POI import system (#847). Read side —
 * per-`(source, region)` coverage/count/extract-presence/last-run/
 * live-queue-state (`listRegionStatus`), plus run history (`listRuns`).
 * Write side — validated atomic extract upload (`storeExtract`) and a manual
 * region-import trigger (`triggerImport`). `triggerImport` enqueues with the
 * deterministic `manualJobId`, so a repeated manual click dedupes against the
 * SAME BullMQ job instead of double-running the import. `listRegionStatus`'s
 * `live_state` is derived separately — a broader in-flight scan matching
 * payload `(source, code)` across active/waiting/delayed/prioritized jobs
 * (cron-dispatched or manual alike), mirroring `triggerImport`'s own 409
 * guard, rather than a `manualJobId` probe (#847 review — a `manualJobId`-only
 * probe missed the weekly dispatcher's own in-flight jobs).
 */
@Injectable()
export class PoiImportAdminService {
  private readonly logger = new Logger(PoiImportAdminService.name);

  constructor(
    @InjectDataSource('poi') private readonly poi: DataSource,
    @InjectRepository(PoiImportRun, 'poi')
    private readonly runs: Repository<PoiImportRun>,
    @InjectQueue(QUEUE_NAMES.POI_IMPORT)
    private readonly queue: Queue<PoiImportRegionJobData>,
  ) {}

  /**
   * Deterministic BullMQ job id for a manual admin trigger of `(source,
   * code)`. `triggerImport` (below) enqueues the region job with this id, so
   * BullMQ's duplicate-jobId dedup keeps a second admin click from
   * double-running an import that's already queued or in flight. `:` is
   * BullMQ's Redis-key delimiter (mirrors apps/ingest's
   * `PoiImportProducer.enqueuePoiImportRegion`'s identical convention for the
   * cron-dispatched sibling jobId), so it's stripped after building the
   * readable id. The literal `manual` segment (rather than a dispatch/run id)
   * is what keeps this permanently distinct from any cron-dispatched
   * `import-region:<dispatchId>:<source>:<code>` job for the same region.
   * Neither `triggerImport`'s in-flight guard nor `listRegionStatus`'s
   * `live_state` probes this id directly — both match a job's payload
   * (`data.source`/`data.code`) instead, which is what lets them also catch
   * that differently-id'd cron job for the same region (#847 review).
   */
  manualJobId(source: string, code: string): string {
    return `import-region:manual:${source}:${code}`.replace(/:/g, '_');
  }

  /**
   * One row per `(source, region)` across every configured source, in
   * `SOURCE_STRATEGIES` order (OSM first, then FSQ) × `DEFAULT_REGIONS` (the
   * canonical coverage list, #850) — 34 rows today (2 sources × 17 regions).
   *
   * Two bulk queries up front (#847 review) replace what used to be two
   * queries PER `(source, region)` pair — at continent scale (~34 pairs)
   * that was ~68 sequential round-trips per page load, each count query
   * re-scanning `pois` for just its own `(source, region)`. Now:
   *  - one scan of `poi_import_regions` for every region's coverage stamp,
   *  - one `GROUP BY (source, import_region)` count over `pois`, and
   *  - one BullMQ `getJobs` scan for every in-flight (active/waiting/
   *    delayed/prioritized) import, cron-dispatched or manual (#847 review
   *    — `live_state` used to probe `getJob(manualJobId)` per pair, which
   *    only ever sees a manual admin trigger and misses the weekly
   *    dispatcher's own jobs entirely; see `statusFor`)
   * cover every pair, keyed into `Map`s the per-pair loop below just reads.
   * The remaining per-region work — an extract-file `stat` and a
   * `poi_import_runs` lookup — can't be batched the same way, so it runs
   * concurrently across every pair via `Promise.all` instead of the
   * previous sequential `for` loop.
   */
  async listRegionStatus(): Promise<RegionImportStatus[]> {
    const pairs = Object.keys(SOURCE_STRATEGIES).flatMap((source) =>
      DEFAULT_REGIONS.map((region) => ({ source, code: region.code })),
    );

    const [coverageRows, countRows] = await this.withPoiStore(() =>
      Promise.all([
        this.poi.query<{ code: string; imported_at: string | null }[]>(
          `SELECT code, imported_at FROM poi_import_regions`,
        ),
        this.poi.query<
          { source: string; import_region: string; n: number | string }[]
        >(
          `SELECT source, import_region, count(*)::int AS n
             FROM pois
             WHERE deactivated_at IS NULL AND import_region IS NOT NULL
             GROUP BY source, import_region`,
        ),
      ]),
    );
    const coverageByCode = new Map(
      coverageRows.map((r) => [r.code, r.imported_at]),
    );
    const countBySourceRegion = new Map(
      countRows.map((r) => [`${r.source}:${r.import_region}`, Number(r.n)]),
    );

    // Same in-flight criteria as `triggerImport`'s 409 guard, scanned ONCE
    // here (not once per pair) rather than a per-pair `getJob(manualJobId)`
    // probe — see the docstring above and `statusFor`'s `live_state` below.
    const inFlight = await this.queue.getJobs([
      'active',
      'waiting',
      'delayed',
      'prioritized',
    ]);
    const liveBySourceRegion = new Map<string, 'running' | 'queued'>();
    for (const job of inFlight) {
      const data = job?.data as PoiImportRegionJobData | undefined;
      if (!data?.code) continue;
      const key = `${data.source ?? 'osm'}:${data.code}`;
      const state = await job.getState();
      if (state === 'active') {
        liveBySourceRegion.set(key, 'running');
      } else if (
        (state === 'waiting' ||
          state === 'delayed' ||
          state === 'prioritized') &&
        !liveBySourceRegion.has(key)
      ) {
        liveBySourceRegion.set(key, 'queued');
      }
      // Otherwise (completed/failed/unknown — raced between the scan above
      // and this job's `getState()`) leave the key unset so the pair below
      // falls back to 'idle'.
    }

    return Promise.all(
      pairs.map(({ source, code }) =>
        this.statusFor(
          source,
          code,
          coverageByCode,
          countBySourceRegion,
          liveBySourceRegion,
        ),
      ),
    );
  }

  /**
   * Run a POI-DB read with the same resilience the store uses (poi-repo's
   * `withPoiRepo`): an uninitialized datasource (POI DB down at boot) or a
   * connection-level error surfaces as a 503 "store unavailable" (spec §7),
   * not a raw 500; a real (non-connection) error still propagates (#847 review).
   * `=== false` (not `!isInitialized`) so a real DataSource's boolean is the only
   * thing that trips it — a partial test mock without the field still reads.
   */
  private async withPoiStore<T>(op: () => Promise<T>): Promise<T> {
    if (this.poi.isInitialized === false) {
      throw new ServiceUnavailableException('POI store is unavailable');
    }
    try {
      return await op();
    } catch (err) {
      if (err instanceof ServiceUnavailableException) throw err;
      if (isPoiConnectionError(err)) {
        throw new ServiceUnavailableException('POI store is unavailable');
      }
      throw err;
    }
  }

  private async statusFor(
    source: string,
    code: string,
    coverageByCode: Map<string, string | null>,
    countBySourceRegion: Map<string, number>,
    liveBySourceRegion: Map<string, 'running' | 'queued'>,
  ): Promise<RegionImportStatus> {
    // OSM-only (design spec §11): `poi_import_regions` has no `source`
    // column and is only ever stamped by the OSM import path, so reading
    // the coverage map for a non-OSM source would silently surface OSM's
    // own stamp under e.g. the `fsq` row for the same region code. Every
    // non-OSM source gets `imported_at: null` without even consulting the
    // map.
    const coverageAt =
      source === 'osm' ? (coverageByCode.get(code) ?? null) : null;
    const imported_at = coverageAt ? new Date(coverageAt).toISOString() : null;
    const poi_count = countBySourceRegion.get(`${source}:${code}`) ?? 0;

    // The extract file lives outside the DB (an operator-uploaded blob under
    // TARMOTO_*_IMPORT_DIR), so its presence is a filesystem stat, not a
    // query. Guarded on `extractDirConfigured` FIRST: an unconfigured extract
    // dir means "no extract available" without ever calling `getExtractPath`
    // or touching the filesystem. Once configured, only ENOENT (no extract
    // uploaded yet) collapses to `extract: null` — any OTHER stat error
    // (EACCES/ENOTDIR/EIO — a broken mount or permissions problem on the
    // shared extract volume) is a real operational fault, not "no extract
    // yet", so it's rethrown rather than silently reported as missing (#847
    // review). A stat that SUCCEEDS but resolves to a non-regular node
    // (directory / FIFO / other — a broken mount or a manual mistake left at
    // `<code>.osm`) is treated the same way: thrown from inside the `try` so
    // it falls into the same non-ENOENT rethrow below, rather than reporting
    // `present: true` for something the worker would later error or hang on
    // trying to `createReadStream` (#847 review).
    let extract: RegionImportStatus['extract'] = null;
    if (this.extractDirConfigured(source)) {
      try {
        const path = this.getExtractPath(source, code);
        const s = await stat(path);
        if (!s.isFile()) {
          throw new Error(`POI extract path is not a regular file: ${path}`);
        }
        extract = {
          present: true,
          size_bytes: s.size,
          modified_at: new Date(s.mtimeMs).toISOString(),
        };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
    }

    const runRow = await this.withPoiStore(() =>
      this.runs.findOne({
        where: { source, region_code: code },
        order: { started_at: 'DESC', id: 'DESC' },
      }),
    );

    // `live_state` reflects ANY in-flight import for this (source, region)
    // — cron-dispatched or manual alike — matching `triggerImport`'s own 409
    // guard (active/waiting/delayed/prioritized, keyed by payload
    // `data.source`/`data.code`, not a specific jobId). Derived once, up
    // front, by `listRegionStatus`'s single queue scan (`liveBySourceRegion`
    // — the caller passes it in) rather than a per-pair `getJob(manualJobId)`
    // probe: probing only the manual jobId would miss the weekly
    // dispatcher's own `import-region` jobs (a different id), reporting
    // `idle` mid-cron-import and letting an admin's Import click 409 (#847
    // review).
    const live_state: RegionImportStatus['live_state'] =
      liveBySourceRegion.get(`${source}:${code}`) ?? 'idle';

    return {
      source,
      code,
      configured: true,
      imported_at,
      poi_count,
      extract,
      last_run: runRow ? this.toSummary(runRow) : null,
      live_state,
    };
  }

  /**
   * Run history, newest first, optionally scoped to a source and/or region
   * code and capped at `limit` (clamped to `[1, 200]`, default `50` — see
   * below) — the admin page's run-log panel.
   */
  async listRuns(filter: {
    source?: string;
    code?: string;
    limit: number;
  }): Promise<RunSummary[]> {
    // Clamp caller-supplied limit: a 0/negative/NaN value falls back to the
    // 50 default (`Math.trunc(...) || 50` — `||` only catches falsy, so a
    // genuine negative int isn't redirected to the default; it's caught by
    // the `Math.max(1, ...)` floor instead), and anything above 200 is
    // capped — an untrusted huge value would otherwise over-fetch.
    const limit = Math.min(Math.max(1, Math.trunc(filter.limit) || 50), 200);
    // Build AND run inside the store guard: on a cold-start outage the `poi`
    // datasource is returned uninitialized, so even `createQueryBuilder`
    // (entity-metadata access) can throw before any query runs — the whole thing
    // must sit behind withPoiStore's isInitialized check so the outage surfaces
    // as 503, not a raw 500 (#847 review).
    const rows = await this.withPoiStore(() => {
      const qb = this.runs
        .createQueryBuilder('r')
        .orderBy('r.started_at', 'DESC')
        .addOrderBy('r.id', 'DESC')
        .limit(limit);
      if (filter.source) {
        qb.andWhere('r.source = :source', { source: filter.source });
      }
      if (filter.code) {
        qb.andWhere('r.region_code = :code', { code: filter.code });
      }
      return qb.getMany();
    });
    return rows.map((r) => this.toSummary(r));
  }

  private toSummary(r: PoiImportRun): RunSummary {
    return {
      id: r.id,
      source: r.source,
      region_code: r.region_code,
      status: r.status,
      trigger: r.trigger,
      fetched: r.fetched,
      upserted: r.upserted,
      tombstoned: r.tombstoned,
      skip_reason: r.skip_reason,
      warning: r.warning,
      error: r.error,
      started_at: r.started_at.toISOString(),
      finished_at: r.finished_at ? r.finished_at.toISOString() : null,
    };
  }

  /**
   * Resolve `source`'s strategy, and confirm `code` is one of the canonical
   * `DEFAULT_REGIONS`. Shared validation for both write-side entry points
   * below — an upload or a trigger for an unregistered source, or a region
   * outside the coverage list, is a client mistake (400), not a 404/500: the
   * admin UI only ever offers configured `(source, code)` pairs, so reaching
   * here with an unknown pair means a stale page, a hand-crafted request, or
   * a typo.
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
   * True when a job already targets this exact `(source, code)` across every
   * LIVE BullMQ state — active, waiting, delayed, or prioritized — whether
   * cron-dispatched or manual. Shared by `triggerImport`'s 409 guard and
   * `storeExtract`'s own defense-in-depth 409 guard (#847 review) so the two
   * checks can never desync; extracted here rather than left duplicated
   * inline in each call site. Defaults an absent `data.source` to `osm`
   * (mirroring the processor's own legacy fallback for a pre-#869 payload).
   */
  private async importInFlight(source: string, code: string): Promise<boolean> {
    const inFlight = await this.queue.getJobs([
      'active',
      'waiting',
      'delayed',
      'prioritized',
    ]);
    return inFlight.some(
      (j) => j?.data?.code === code && (j?.data?.source ?? 'osm') === source,
    );
  }

  /**
   * Redis key for the server-side per-`(source, code)` upload lock (#847,
   * #972). Acquired by `PoiUploadLockInterceptor` BEFORE Multer drains the
   * upload body and held across the whole client→API upload + handler
   * (`acquireUploadLock`/`releaseUploadLock` below), and consulted by
   * `triggerImport` (via `uploadInProgress`) so a manual trigger can't enqueue
   * a worker while a replacement upload for the same region is still landing.
   * Reuses the queue's own Redis connection (`this.queue.client`) rather than
   * any new DI wiring; BullMQ prefixes its OWN keys with the queue name
   * (`bull:<queue>:*`), so this `poi:import:` namespace can never collide
   * with a BullMQ-managed key on the same connection.
   */
  private uploadLockKey(source: string, code: string): string {
    return `poi:import:upload-lock:${source}:${code}`;
  }

  /**
   * True while an extract upload for `(source, code)` is mid-stream — i.e.
   * `PoiUploadLockInterceptor` has acquired but not yet released this pair's
   * upload lock. `importInFlight` (above) only knows about BullMQ jobs, so it
   * has no visibility into an upload that hasn't reached the queue at all; this
   * is `triggerImport`'s other 409 guard, closing that gap.
   */
  private async uploadInProgress(
    source: string,
    code: string,
  ): Promise<boolean> {
    const redis = await this.queue.client;
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
    const redis = await this.queue.client;
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
      const redis = await this.queue.client;
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
      const redis = await this.queue.client;
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
   * filesystem. Two more checks follow once a target path exists (#847
   * review): a `stat` of the target's PARENT directory (catches a mount
   * that's configured but never actually attached — `extractDirConfigured`
   * only proves the env var is SET, not that the shared volume is really
   * there) and an in-flight scan (`importInFlight`, shared with
   * `triggerImport`'s own 409 guard) that rejects a replacement upload while
   * a worker may be mid-read of the CURRENT extract. All of this runs before
   * a single byte is written.
   *
   * Upload lock (#847, #972): the exclusive per-`(source, code)` upload lock
   * is held UPSTREAM by `PoiUploadLockInterceptor` for the whole client→API
   * upload — acquired before Multer drains the body, released after this
   * handler returns — so `triggerImport` (via `uploadInProgress`) can't queue
   * a worker against the OLD target while a replacement upload for the same
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
   * that reads `target` next runs in a separate worker process — possibly
   * after a crash — so "written" has to mean "on disk", not "sitting in this
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
    // replace it out from under it. Same in-flight criteria as
    // `triggerImport`'s own 409 guard, shared via `importInFlight` so the two
    // checks can never desync (#847 review).
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

  /**
   * Enqueue a manual admin-triggered import for `(source, code)` (#847).
   *
   * The in-flight check scans EVERY live job on this queue — active,
   * waiting, delayed, or prioritized — for one whose payload already targets
   * this `(source, code)`, rather than only probing `manualJobId`. Probing
   * just the manual jobId would catch a duplicate manual click (same id) but
   * miss the weekly dispatcher's own in-flight job for the SAME region: the
   * cron path enqueues under a DIFFERENT id
   * (`import-region_<dispatchId>_<source>_<code>`), so it's invisible to a
   * `getJob(manualJobId)` probe. That gap matters because `importRegion`
   * holds a non-blocking PostgreSQL advisory lock per `(source, code)` — the
   * loser doesn't queue behind the winner, it FAILS after burning through
   * its retry budget (`attempts: 3`, 30s/60s exponential backoff — ~90s
   * total) — so an admin trigger racing an in-progress cron import (which
   * can run for minutes on a country-sized extract) would enqueue a job
   * that's certain to exhaust its retries and land in `failed`, polluting
   * run history with a false failure instead of just telling the admin to
   * wait. Scanning every in-flight job's `data.code`/`data.source`
   * (defaulting an absent `source` to `osm`, mirroring the processor's own
   * legacy fallback) closes that gap for both directions — cron-vs-manual
   * AND manual-vs-manual — with one check.
   *
   * On a clear queue, enqueues with `manualJobId` as the BullMQ `jobId` so a
   * second click before this one is even picked up still dedupes to the
   * same job (BullMQ rejects a duplicate id rather than double-enqueuing).
   *
   * The in-flight scan itself lives in `importInFlight` (#847 review) — also
   * called from `storeExtract`'s own defense-in-depth 409 guard against a
   * replacement upload racing this same live-import condition — so both
   * call sites share one definition of "in flight" that can't drift apart.
   *
   * A second, independent 409 guard (`uploadInProgress`, #847 review) checks
   * the server-side upload lock `storeExtract` holds for the duration of its
   * own streaming + atomic rename. `importInFlight` only has visibility into
   * BullMQ jobs, so on its own it can't see a replacement upload that hasn't
   * reached the queue yet — without this second guard, a trigger fired
   * while that upload is still mid-stream would enqueue a worker that reads
   * the OLD target right before the new upload's rename replaces it.
   */
  async triggerImport(
    source: string,
    code: string,
  ): Promise<{ job_id: string }> {
    this.importerFor(source, code);

    if (await this.importInFlight(source, code)) {
      throw new ConflictException(
        `import for ${source}/${code} already in flight`,
      );
    }
    // Server-side upload lock (#847 review): `importInFlight` only sees
    // BullMQ jobs, so it's blind to a replacement upload that's still
    // mid-stream (`storeExtract`'s `.part` write, before the atomic rename
    // lands) and hasn't reached the queue yet. Without this, a trigger
    // fired during that window would queue a worker that could read the
    // OLD target before the new upload replaces it — a run tied to stale
    // input that still reports success. See `uploadInProgress`.
    if (await this.uploadInProgress(source, code)) {
      throw new ConflictException(
        `an extract upload is in progress for ${source}/${code}; wait for it to finish before importing`,
      );
    }

    const jobId = this.manualJobId(source, code);
    await this.queue.add(
      JOB_NAMES.POI_IMPORT_REGION,
      { code, source, trigger: 'manual' },
      {
        ...DEFAULT_JOB_OPTIONS,
        jobId,
        attempts: 3,
        // Override DEFAULT_JOB_OPTIONS's count/age-based retention
        // (`removeOnComplete: { count: 1000 }`, `removeOnFail: { age: 24h }`)
        // with immediate removal. This job uses the STABLE `manualJobId`
        // above, and BullMQ's `add()` dedupes against ANY existing job with
        // that id — including a completed/failed one still retained in
        // Redis. On a low-volume queue like manual admin imports, the
        // shared retention would keep the terminal job around for a very
        // long time, so re-importing (upload a fresh extract → click Import
        // again) would silently dedupe against the stale terminal job and
        // never actually enqueue, even though the endpoint reports success.
        // Freeing the id the instant the job terminates is safe here:
        // durable run history lives in `poi_import_runs` (not the BullMQ
        // job record), `live_state` above maps a missing job to `idle`, and
        // the in-flight scan only inspects active/waiting/delayed/
        // prioritized — never completed/failed.
        removeOnComplete: true,
        removeOnFail: true,
      },
    );
    return { job_id: jobId };
  }
}
