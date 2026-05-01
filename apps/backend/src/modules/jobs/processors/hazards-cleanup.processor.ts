import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { HazardsService } from '../../hazards/hazards.service.js';
import { QUEUE_NAMES } from '../jobs.constants.js';

export interface HazardsCleanupResult {
  expired_marked: number;
}

/**
 * Hourly recurring job. Flips `is_active = false` on every hazard
 * report whose `expires_at` has passed. Read-side queries currently
 * also check `expires_at > NOW()` (defense in depth); once this sweep
 * has been running long enough that the legacy backlog is fully
 * drained, callers can drop the redundant predicate.
 *
 * Idempotent — running twice in the same hour just touches zero rows
 * the second time.
 */
@Processor(QUEUE_NAMES.HAZARDS_CLEANUP)
export class HazardsCleanupProcessor extends WorkerHost {
  private readonly logger = new Logger(HazardsCleanupProcessor.name);

  constructor(private readonly hazards: HazardsService) {
    super();
  }

  async process(job: Job): Promise<HazardsCleanupResult> {
    const expired = await this.hazards.expireOld();
    if (expired > 0) {
      this.logger.log(
        `[${job.id ?? 'no-id'}] deactivated ${expired} expired hazard(s)`,
      );
    }
    return { expired_marked: expired };
  }
}
