import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import { randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { open, rename, stat, unlink } from 'node:fs/promises';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { JOB_NAMES, QUEUE_NAMES } from '../jobs/jobs.constants.js';
import { DEFAULT_JOB_OPTIONS } from '../jobs/jobs.config.js';
import type { PoiImportRegionJobData } from '../jobs/jobs.producer.js';
import {
  POI_IMPORT_SOURCES,
  type PoiImportService,
} from './poi-import.service.js';
import { PoiImportRun } from '../../entities/poi-import-run.entity.js';

/** One `poi_import_runs` row, serialized for the admin API (#847). */
export interface RunSummary {
  id: string;
  source: string;
  region_code: string;
  status: string;
  trigger: string;
  fetched: number | null;
  upserted: number | null;
  tombstoned: number | null;
  skip_reason: string | null;
  error: string | null;
  started_at: string;
  finished_at: string | null;
}

/**
 * Per-`(source, region)` admin status row (#847) — everything the POI
 * Imports admin page needs to render one row of the coverage table without a
 * second round-trip.
 */
export interface RegionImportStatus {
  source: string;
  code: string;
  /** Always `true` today — every row comes from an importer's OWN configured
   *  `regions` list, so `listRegionStatus` never asks about an out-of-scope
   *  code. Kept on the wire shape for a future "known but unconfigured" row. */
  configured: boolean;
  /** Coverage stamp — OSM-only. `poi_import_regions` (the table this comes
   *  from) has no `source` column and is only ever stamped by the OSM
   *  import path (`PoiImportService.importRegionBody`, gated on `source ===
   *  'osm'`), so a non-OSM row (e.g. `fsq`) always reports `null` here
   *  instead of reusing OSM's own stamp for the same region code (design
   *  spec §11 — "coverage: OSM-only" rather than a misleading badge). */
  imported_at: string | null;
  poi_count: number;
  extract: {
    present: boolean;
    size_bytes: number;
    modified_at: string;
  } | null;
  last_run: RunSummary | null;
  live_state: 'idle' | 'queued' | 'running';
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
 * Admin surface for the POI import system (#847). Read side —
 * per-`(source, region)` coverage/count/extract-presence/last-run/
 * live-queue-state (`listRegionStatus`), plus run history (`listRuns`).
 * Write side — validated atomic extract upload (`storeExtract`) and a manual
 * region-import trigger (`triggerImport`). Both sides share `manualJobId`,
 * the deterministic id that ties them together: `listRegionStatus` probes it
 * to report `live_state`, and `triggerImport` enqueues with it so a repeated
 * manual click dedupes against the SAME BullMQ job instead of double-running
 * the import.
 */
@Injectable()
export class PoiImportAdminService {
  constructor(
    @Inject(POI_IMPORT_SOURCES)
    private readonly importers: readonly PoiImportService[],
    @InjectDataSource('poi') private readonly poi: DataSource,
    @InjectRepository(PoiImportRun, 'poi')
    private readonly runs: Repository<PoiImportRun>,
    @InjectQueue(QUEUE_NAMES.POI_IMPORT)
    private readonly queue: Queue<PoiImportRegionJobData>,
  ) {}

  /**
   * Deterministic BullMQ job id for a manual admin trigger of `(source,
   * code)`. `listRegionStatus` probes this id (via `queue.getJob`) to report
   * `live_state`; `triggerImport` (below) enqueues the region job with this
   * SAME id, so BullMQ's duplicate-jobId dedup keeps a second admin click
   * from double-running an import that's already queued or in flight. `:` is
   * BullMQ's Redis-key delimiter (mirrors
   * `JobsProducer.enqueuePoiImportRegion`'s identical convention for the
   * cron-dispatched sibling jobId), so it's stripped after building the
   * readable id. The literal `manual` segment (rather than a dispatch/run id)
   * is what keeps this permanently distinct from any cron-dispatched
   * `import-region:<dispatchId>:<source>:<code>` job for the same region —
   * `triggerImport`'s in-flight scan is what actually catches THAT job (a
   * different id entirely), by matching its payload instead of its id.
   */
  manualJobId(source: string, code: string): string {
    return `import-region:manual:${source}:${code}`.replace(/:/g, '_');
  }

  /**
   * One row per `(source, region)` across every registered importer, in
   * registry order (OSM first, then FSQ — see `POI_IMPORT_SOURCES`).
   *
   * Two bulk queries up front (#847 review) replace what used to be two
   * queries PER `(source, region)` pair — at continent scale (~34 pairs)
   * that was ~68 sequential round-trips per page load, each count query
   * re-scanning `pois` for just its own `(source, region)`. Now:
   *  - one scan of `poi_import_regions` for every region's coverage stamp, and
   *  - one `GROUP BY (source, import_region)` count over `pois`
   * cover every pair, keyed into two `Map`s the per-pair loop below just
   * reads. The remaining per-region work — an extract-file `stat`, a
   * `poi_import_runs` lookup, and a BullMQ `getJob` probe — can't be batched
   * the same way, so it runs concurrently across every pair via
   * `Promise.all` instead of the previous sequential `for` loop.
   */
  async listRegionStatus(): Promise<RegionImportStatus[]> {
    const pairs = this.importers.flatMap((importer) =>
      importer.regions.map((region) => ({ importer, code: region.code })),
    );

    const [coverageRows, countRows] = await Promise.all([
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
    ]);
    const coverageByCode = new Map(
      coverageRows.map((r) => [r.code, r.imported_at]),
    );
    const countBySourceRegion = new Map(
      countRows.map((r) => [`${r.source}:${r.import_region}`, Number(r.n)]),
    );

    return Promise.all(
      pairs.map(({ importer, code }) =>
        this.statusFor(importer, code, coverageByCode, countBySourceRegion),
      ),
    );
  }

  private async statusFor(
    importer: PoiImportService,
    code: string,
    coverageByCode: Map<string, string | null>,
    countBySourceRegion: Map<string, number>,
  ): Promise<RegionImportStatus> {
    const source = importer.source;

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
    // query. `getExtractPath` throws when this source's extractDir isn't
    // configured — same as an ENOENT stat failure, both mean "no extract
    // available yet" — so both collapse to `extract: null` here rather than
    // ever 500ing the admin page for an unconfigured/not-yet-provisioned
    // region.
    let extract: RegionImportStatus['extract'] = null;
    try {
      const s = await stat(importer.getExtractPath(code));
      extract = {
        present: true,
        size_bytes: s.size,
        modified_at: new Date(s.mtimeMs).toISOString(),
      };
    } catch {
      // ENOENT (no extract uploaded yet) or getExtractPath's own throw
      // (unconfigured extractDir) — both mean "no extract available", so
      // `extract` is left at its initial `null` rather than reassigned.
    }

    const runRow = await this.runs.findOne({
      where: { source, region_code: code },
      order: { started_at: 'DESC', id: 'DESC' },
    });

    // `live_state` reflects the ONE manual job this (source, region) can have
    // in flight — the weekly dispatcher's own per-region jobs use a different
    // (dispatch-scoped) jobId, so they're intentionally invisible here; the
    // admin page only needs to know whether an admin-triggered run is already
    // queued/running so it can disable a duplicate manual trigger.
    const job = await this.queue.getJob(this.manualJobId(source, code));
    let live_state: RegionImportStatus['live_state'] = 'idle';
    if (job) {
      const state = await job.getState();
      live_state =
        state === 'active'
          ? 'running'
          : state === 'waiting' ||
              state === 'delayed' ||
              state === 'prioritized'
            ? 'queued'
            : 'idle';
    }

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
    return (await qb.getMany()).map((r) => this.toSummary(r));
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
      error: r.error,
      started_at: r.started_at.toISOString(),
      finished_at: r.finished_at ? r.finished_at.toISOString() : null,
    };
  }

  /**
   * Resolve the importer for `source`, and confirm `code` is one of ITS
   * configured regions. Shared validation for both write-side entry points
   * below — an upload or a trigger for an unregistered source, or a region
   * outside that source's configured coverage, is a client mistake (400),
   * not a 404/500: the admin UI only ever offers configured `(source, code)`
   * pairs, so reaching here with an unknown pair means a stale page, a
   * hand-crafted request, or a typo.
   */
  private importerFor(source: string, code: string): PoiImportService {
    const importer = this.importers.find((i) => i.source === source);
    if (!importer) {
      throw new BadRequestException(`unknown source: ${source}`);
    }
    if (!importer.regions.some((r) => r.code === code)) {
      throw new BadRequestException(
        `unknown region ${code} for source ${source}`,
      );
    }
    return importer;
  }

  /**
   * Validated, atomic upload of an operator-provided extract (#847) — the
   * write-side counterpart to `listRegionStatus`'s `extract` stat. Checks run
   * cheapest-first: declared size against `POI_UPLOAD_MAX_BYTES` (no I/O), then
   * `(source, code)` (in-memory), then the filename extension — all before a
   * single byte is written.
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
    const importer = this.importerFor(source, code);
    const target = importer.getExtractPath(code);
    const expectedExt = source === 'fsq' ? '.fsq.jsonl' : '.osm';
    if (!file.originalName.toLowerCase().endsWith(expectedExt)) {
      throw new BadRequestException(
        `expected a ${expectedExt} file for ${source}`,
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
   */
  async triggerImport(
    source: string,
    code: string,
  ): Promise<{ job_id: string }> {
    this.importerFor(source, code);

    const inFlight = await this.queue.getJobs([
      'active',
      'waiting',
      'delayed',
      'prioritized',
    ]);
    const busy = inFlight.some(
      (j) => j?.data?.code === code && (j?.data?.source ?? 'osm') === source,
    );
    if (busy) {
      throw new ConflictException(
        `import for ${source}/${code} already in flight`,
      );
    }

    const jobId = this.manualJobId(source, code);
    await this.queue.add(
      JOB_NAMES.POI_IMPORT_REGION,
      { code, source, trigger: 'manual' },
      { ...DEFAULT_JOB_OPTIONS, jobId, attempts: 3 },
    );
    return { job_id: jobId };
  }
}
