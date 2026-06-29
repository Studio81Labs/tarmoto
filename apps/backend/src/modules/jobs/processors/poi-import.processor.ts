import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { QUEUE_NAMES } from '../jobs.constants.js';
import { PoiImportService } from '../../poi/poi-import.service.js';

/**
 * Recurring worker (#745): mirrors POIs into the `pois` table for offline
 * use. The fetch+upsert lives in `PoiImportService`; this is just the
 * BullMQ trigger. Skips (no Overpass call) unless
 * `TARMOTO_POI_IMPORT_ENABLED=true`, so a tick is a cheap no-op when the
 * import is off — letting a fetch error propagate so BullMQ retries.
 */
@Processor(QUEUE_NAMES.POI_IMPORT)
export class PoiImportProcessor extends WorkerHost {
  private readonly logger = new Logger(PoiImportProcessor.name);

  constructor(private readonly poiImport: PoiImportService) {
    super();
  }

  async process(
    job: Job,
  ): Promise<{ skipped: true } | { fetched: number; upserted: number }> {
    if (!this.poiImport.enabled) {
      this.logger.debug(
        'POI import skipped: TARMOTO_POI_IMPORT_ENABLED is not true',
      );
      return { skipped: true };
    }
    const result = await this.poiImport.import();
    this.logger.log(
      `[${job.id ?? 'no-id'}] POI import: fetched=${result.fetched} ` +
        `upserted=${result.upserted}`,
    );
    return result;
  }
}
