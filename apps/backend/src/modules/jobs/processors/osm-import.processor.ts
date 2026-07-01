import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { QUEUE_NAMES } from '../jobs.constants.js';
import { OsmImportService } from '../../roads/osm-import/osm-import.service.js';

/**
 * Recurring worker (#781): imports the configured OSM `.osm` extract into
 * `road_segments`. The read+parse+upsert lives in `OsmImportService`; this is
 * just the BullMQ trigger. Skips (no file read) unless
 * `TARMOTO_OSM_IMPORT_ENABLED=true`, so a tick is a cheap no-op when the import
 * is off — letting a read/parse error propagate so BullMQ retries.
 */
@Processor(QUEUE_NAMES.OSM_IMPORT)
export class OsmImportProcessor extends WorkerHost {
  private readonly logger = new Logger(OsmImportProcessor.name);

  constructor(private readonly osmImport: OsmImportService) {
    super();
  }

  async process(job: Job): Promise<{ skipped: true } | { upserted: number }> {
    if (!this.osmImport.enabled) {
      this.logger.debug(
        'OSM import skipped: TARMOTO_OSM_IMPORT_ENABLED is not true',
      );
      return { skipped: true };
    }
    const result = await this.osmImport.importFromConfiguredFile();
    this.logger.log(
      `[${job.id ?? 'no-id'}] OSM import: upserted=${result.upserted}`,
    );
    return result;
  }
}
