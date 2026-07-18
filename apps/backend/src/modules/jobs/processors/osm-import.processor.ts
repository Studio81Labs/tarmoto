import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { QUEUE_NAMES } from '../jobs.constants.js';
import { OsmImportService } from '../../roads/osm-import/osm-import.service.js';
import { JobsProducer } from '../jobs.producer.js';

/**
 * Recurring worker (#781): imports every configured region's OSM extract (the
 * folder model, Sub-project B) into `road_segments`. The read+parse+upsert lives
 * in `OsmImportService`; this is just the BullMQ trigger. Skips (no file read)
 * unless `TARMOTO_OSM_ROAD_IMPORT_ENABLED=true`, so a tick is a cheap no-op when
 * the import is off — letting a read/parse error propagate so BullMQ retries.
 *
 * On a **successful** import it chains the road-quality conflation (#779) so the
 * derived GraphHopper extract is always built from a freshly-imported network,
 * never a partial or failed one. It is a success-continuation rather than an
 * independent schedule precisely so a long-running or failed import can't race a
 * fixed-time conflation cron. (The conflation processor still no-ops when
 * `TARMOTO_QUALITY_CONFLATION_ENABLED` is off.)
 */
@Processor(QUEUE_NAMES.ROAD_IMPORT)
export class OsmImportProcessor extends WorkerHost {
  private readonly logger = new Logger(OsmImportProcessor.name);

  constructor(
    private readonly osmImport: OsmImportService,
    private readonly producer: JobsProducer,
  ) {
    super();
  }

  async process(job: Job): Promise<{ skipped: true } | { upserted: number }> {
    if (!this.osmImport.enabled) {
      this.logger.debug(
        'OSM import skipped: TARMOTO_OSM_ROAD_IMPORT_ENABLED is not true',
      );
      return { skipped: true };
    }
    const result = await this.osmImport.importAll();
    // Chain the quality conflation only after a successful import, so it never
    // runs on a stale/partial snapshot of the network.
    await this.producer.enqueueQualityConflation();
    this.logger.log(
      `[${job.id ?? 'no-id'}] OSM import: upserted=${result.upserted}`,
    );
    return result;
  }
}
