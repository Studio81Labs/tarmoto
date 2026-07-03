import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { QUEUE_NAMES } from '../jobs.constants.js';
import { QualityConflationService } from '../../roads/quality-conflation/quality-conflation.service.js';

/**
 * Recurring worker (#779): conflates `road_segments` quality into a derived
 * `.osm` extract (injecting a `smoothness` tag per way, ADR-0005) that
 * GraphHopper re-imports for quality-aware routing. The build+inject lives in
 * `QualityConflationService`; this is just the BullMQ trigger. Skips (no file
 * read/write) unless `TARMOTO_QUALITY_CONFLATION_ENABLED=true`, so a tick is a
 * cheap no-op when off — letting a read/parse/write error propagate so BullMQ
 * retries.
 */
@Processor(QUEUE_NAMES.QUALITY_CONFLATION)
export class QualityConflationProcessor extends WorkerHost {
  private readonly logger = new Logger(QualityConflationProcessor.name);

  constructor(private readonly conflation: QualityConflationService) {
    super();
  }

  async process(
    job: Job,
  ): Promise<{ skipped: true } | { waysTagged: number; assignments: number }> {
    if (!this.conflation.enabled) {
      this.logger.debug(
        'Quality conflation skipped: TARMOTO_QUALITY_CONFLATION_ENABLED is not true',
      );
      return { skipped: true };
    }
    const result = await this.conflation.runConflation();
    this.logger.log(
      `[${job.id ?? 'no-id'}] Quality conflation: waysTagged=${result.waysTagged} ` +
        `assignments=${result.assignments}`,
    );
    return result;
  }
}
