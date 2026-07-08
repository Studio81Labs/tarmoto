import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { JOB_NAMES, QUEUE_NAMES } from '../jobs.constants.js';
import {
  PoiImportService,
  type PoiImportResult,
} from '../../poi/poi-import.service.js';
import { JobsProducer } from '../jobs.producer.js';

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
 *   `dispatch` (weekly): if the import is enabled, fans out one staggered
 *      `import-region` child per configured region so a 17-country run spreads
 *      its heavy per-country imports across hours instead of one giant job. A
 *      tick is a cheap no-op (no enqueues) while `TARMOTO_POI_IMPORT_ENABLED`
 *      is off.
 *
 *   `import-region` (per-region): resolves the region by code from the
 *      configured coverage list and runs `PoiImportService.importRegion`, which
 *      parses that country's `.osm` extract and upserts + bbox-bounded-tombstones
 *      the `pois` table. A read/parse/store error propagates so BullMQ retries.
 *
 * The region job does not re-check the enabled flag: it only exists because the
 * dispatcher enqueued it while enabled, and manual/on-demand imports go through
 * the CLI, not this queue.
 */
@Processor(QUEUE_NAMES.POI_IMPORT)
export class PoiImportProcessor extends WorkerHost {
  private readonly logger = new Logger(PoiImportProcessor.name);

  constructor(
    private readonly poiImport: PoiImportService,
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
    if (!this.poiImport.enabled) {
      this.logger.debug(
        'POI import skipped: TARMOTO_POI_IMPORT_ENABLED is not true',
      );
      return { skipped: true };
    }
    const regions = this.poiImport.regions;
    let enqueued = 0;
    for (const [index, region] of regions.entries()) {
      // The Nth region's job is delayed N * stagger so the fan-out spreads out.
      await this.producer.enqueuePoiImportRegion(region.code, index);
      enqueued += 1;
    }
    this.logger.log(
      `[${job.id ?? 'no-id'}] dispatched POI import for ${enqueued} region(s)`,
    );
    return { regions_enqueued: enqueued };
  }

  private async importRegion(job: Job): Promise<PoiImportResult> {
    const data = job.data as { code?: string };
    if (!data.code) {
      throw new Error('poi-import region job missing code');
    }
    const region = this.poiImport.regions.find((r) => r.code === data.code);
    if (!region) {
      // A code that isn't in the configured coverage list — surface it rather
      // than silently no-op'ing, so a stale/mistyped enqueue is visible.
      throw new Error(`poi-import region job unknown code: ${data.code}`);
    }
    const result = await this.poiImport.importRegion(region);
    this.logger.log(
      `[${job.id ?? 'no-id'}] POI import (${result.region}): ` +
        `fetched=${result.fetched} upserted=${result.upserted} ` +
        `tombstoned=${result.tombstoned}${result.skipped ? ' (skipped)' : ''}`,
    );
    return result;
  }
}
