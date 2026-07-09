import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { JOB_NAMES, QUEUE_NAMES } from '../jobs.constants.js';
import {
  POI_IMPORT_SOURCES,
  PoiImportService,
  type PoiImportResult,
} from '../../poi/poi-import.service.js';
import { JobsProducer } from '../jobs.producer.js';

/**
 * The source a region job defaults to when its `source` field is absent — a job
 * enqueued before the multi-source registry (#869) existed. OSM was the only
 * source then, so it's the correct fallback for an in-flight legacy job.
 */
const LEGACY_REGION_SOURCE = 'osm';

export interface PoiImportDispatchResult {
  regions_enqueued: number;
}

/**
 * The pre-#850 weekly job name (single-bbox import). It was renamed to
 * `dispatch`; the scheduler removes its old repeatable on boot, but a `run` job
 * already queued before that — or a scheduler not yet reconciled — must not
 * crash the worker, so it's tolerated here as a `dispatch` alias.
 */
const LEGACY_POI_IMPORT_RUN = 'run';

/**
 * Two-stage offline POI import (#850), continent-scaled from the single-bbox
 * #745 job.
 *
 *   `dispatch` (weekly): fans out one staggered `import-region` child per
 *      (source, region) across every ENABLED source in the registry (#869), so a
 *      two-source, 17-country run spreads its heavy per-country imports across
 *      hours instead of one giant job. A tick is a cheap no-op (no enqueues)
 *      while no source's `TARMOTO_*_IMPORT_ENABLED` is set.
 *
 *   `import-region` (per-region): routes the job to its source's importer, then
 *      runs `PoiImportService.importRegion`, which parses that country's extract
 *      and upserts + bbox-bounded-tombstones the `pois` table. A read/parse/store
 *      error propagates so BullMQ retries.
 *
 * The region job does not re-check the enabled flag: it only exists because the
 * dispatcher enqueued it while enabled, and manual/on-demand imports go through
 * the CLI, not this queue.
 */
@Processor(QUEUE_NAMES.POI_IMPORT)
export class PoiImportProcessor extends WorkerHost {
  private readonly logger = new Logger(PoiImportProcessor.name);

  constructor(
    @Inject(POI_IMPORT_SOURCES)
    private readonly importers: readonly PoiImportService[],
    private readonly producer: JobsProducer,
  ) {
    super();
  }

  async process(
    job: Job,
  ): Promise<{ skipped: true } | PoiImportDispatchResult | PoiImportResult> {
    if (
      job.name === JOB_NAMES.POI_IMPORT_DISPATCH ||
      job.name === LEGACY_POI_IMPORT_RUN
    ) {
      return this.dispatch(job);
    }
    if (job.name === JOB_NAMES.POI_IMPORT_REGION) {
      return this.importRegion(job);
    }
    throw new Error(`Unknown poi.import job name: ${job.name}`);
  }

  private async dispatch(
    job: Job,
  ): Promise<{ skipped: true } | PoiImportDispatchResult> {
    const enabled = this.importers.filter((importer) => importer.enabled);
    if (enabled.length === 0) {
      this.logger.debug(
        'POI import skipped: no source has TARMOTO_*_IMPORT_ENABLED=true',
      );
      return { skipped: true };
    }
    // Scope the child jobIds to THIS dispatch occurrence (stable across the
    // dispatch's own retries, fresh each week) so a mid-loop retry re-enqueues
    // regions idempotently instead of doubling the imports.
    const dispatchId = job.id ?? String(job.timestamp);
    // One global stagger index across every (source, region) pair, so OSM-CZ and
    // FSQ-CZ don't both fire at delay 0 — the whole fan-out spreads across hours.
    let enqueued = 0;
    for (const importer of enabled) {
      for (const region of importer.regions) {
        await this.producer.enqueuePoiImportRegion(
          importer.source,
          region.code,
          enqueued,
          dispatchId,
        );
        enqueued += 1;
      }
    }
    this.logger.log(
      `[${job.id ?? 'no-id'}] dispatched POI import for ${enqueued} region(s) ` +
        `across source(s): ${enabled.map((i) => i.source).join(', ')}`,
    );
    return { regions_enqueued: enqueued };
  }

  private async importRegion(job: Job): Promise<PoiImportResult> {
    const data = job.data as { code?: string; source?: string };
    if (!data.code) {
      throw new Error('poi-import region job missing code');
    }
    const source = data.source ?? LEGACY_REGION_SOURCE;
    const importer = this.importers.find((i) => i.source === source);
    if (!importer) {
      // A source not in the registry — surface it rather than silently
      // no-op'ing, so a stale/mistyped enqueue is visible.
      throw new Error(`poi-import region job unknown source: ${source}`);
    }
    const region = importer.regions.find((r) => r.code === data.code);
    if (!region) {
      // A code that isn't in this source's coverage list — surface it too.
      throw new Error(
        `poi-import region job unknown code: ${data.code} (source ${source})`,
      );
    }
    const result = await importer.importRegion(region);
    this.logger.log(
      `[${job.id ?? 'no-id'}] POI import (${source}/${result.region}): ` +
        `fetched=${result.fetched} upserted=${result.upserted} ` +
        `tombstoned=${result.tombstoned}${result.skipped ? ' (skipped)' : ''}`,
    );
    return result;
  }
}
