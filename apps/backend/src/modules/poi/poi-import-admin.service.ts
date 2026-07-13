import { Inject, Injectable } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import { stat } from 'node:fs/promises';
import { QUEUE_NAMES } from '../jobs/jobs.constants.js';
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
 * Read side of the POI import admin surface (#847): per-`(source, region)`
 * coverage/count/extract-presence/last-run/live-queue-state
 * (`listRegionStatus`), plus the run history (`listRuns`). Pure reads — the
 * write side (extract upload + manual trigger, a later task) is a separate
 * service sharing only `manualJobId`, the deterministic id both sides need to
 * agree on: this service probes it to report `live_state`, and the write
 * side enqueues with it so a repeated manual trigger dedupes against the SAME
 * BullMQ job instead of double-running the import.
 */
@Injectable()
export class PoiImportAdminService {
  constructor(
    @Inject(POI_IMPORT_SOURCES)
    private readonly importers: readonly PoiImportService[],
    @InjectDataSource('poi') private readonly poi: DataSource,
    @InjectRepository(PoiImportRun, 'poi')
    private readonly runs: Repository<PoiImportRun>,
    @InjectQueue(QUEUE_NAMES.POI_IMPORT) private readonly queue: Queue,
  ) {}

  /**
   * Deterministic BullMQ job id for a manual admin trigger of `(source,
   * code)`. `listRegionStatus` probes this id (via `queue.getJob`) to report
   * `live_state`; the write-side manual trigger (a later task) enqueues the
   * region job with this SAME id, so BullMQ's duplicate-jobId dedup keeps a
   * second admin click from double-running an import that's already queued
   * or in flight. `:` is BullMQ's Redis-key delimiter (mirrors
   * `JobsProducer.enqueuePoiImportRegion`'s identical convention for the
   * cron-dispatched sibling jobId), so it's stripped after building the
   * readable id. The literal `manual` segment (rather than a dispatch/run id)
   * is what keeps this permanently distinct from any cron-dispatched
   * `import-region:<dispatchId>:<source>:<code>` job for the same region.
   */
  manualJobId(source: string, code: string): string {
    return `import-region:manual:${source}:${code}`.replace(/:/g, '_');
  }

  /**
   * One row per `(source, region)` across every registered importer, in
   * registry order (OSM first, then FSQ — see `POI_IMPORT_SOURCES`).
   */
  async listRegionStatus(): Promise<RegionImportStatus[]> {
    const out: RegionImportStatus[] = [];
    for (const importer of this.importers) {
      for (const region of importer.regions) {
        out.push(await this.statusFor(importer, region.code));
      }
    }
    return out;
  }

  private async statusFor(
    importer: PoiImportService,
    code: string,
  ): Promise<RegionImportStatus> {
    const source = importer.source;
    const [covRows, countRows] = await Promise.all([
      this.poi.query<{ imported_at: string | null }[]>(
        `SELECT imported_at FROM poi_import_regions WHERE code = $1`,
        [code],
      ),
      this.poi.query<{ n: number | string }[]>(
        `SELECT count(*)::int AS n FROM pois
           WHERE source = $1 AND import_region = $2 AND deactivated_at IS NULL`,
        [source, code],
      ),
    ]);
    const covRow = covRows[0];
    const countRow = countRows[0];
    const imported_at = covRow?.imported_at
      ? new Date(covRow.imported_at).toISOString()
      : null;
    const poi_count = Number(countRow?.n ?? 0);

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
   * code and capped at `limit` — the admin page's run-log panel.
   */
  async listRuns(filter: {
    source?: string;
    code?: string;
    limit: number;
  }): Promise<RunSummary[]> {
    const qb = this.runs
      .createQueryBuilder('r')
      .orderBy('r.started_at', 'DESC')
      .addOrderBy('r.id', 'DESC')
      .limit(filter.limit);
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
}
