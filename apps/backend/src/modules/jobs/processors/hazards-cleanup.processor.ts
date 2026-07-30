import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { HazardsService } from '../../hazards/hazards.service.js';
import { QUEUE_NAMES } from '../jobs.constants.js';

export interface HazardsCleanupResult {
  expired_marked: number;
  orphan_photos_removed: number;
}

/**
 * Hourly recurring job. Two independent, idempotent steps:
 *
 *  1. Flips `is_active = false` on every hazard report whose `expires_at`
 *     has passed. Read-side queries currently also check `expires_at > NOW()`
 *     (defense in depth); once this sweep has been running long enough that
 *     the legacy backlog is fully drained, callers can drop the predicate.
 *  2. Reclaims managed photo files stranded by a cap-rejected or abandoned
 *     submission (uploaded via `POST /hazards/photos` but never attached to a
 *     report), older than the grace window. Off-request so it can't race a
 *     concurrent create still attaching the file.
 *
 * A failure in the photo sweep is logged but does not fail the job, so it
 * never blocks the expiry step (or vice versa).
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

    let orphansRemoved = 0;
    try {
      orphansRemoved = await this.hazards.sweepOrphanedPhotos();
      if (orphansRemoved > 0) {
        this.logger.log(
          `[${job.id ?? 'no-id'}] reclaimed ${orphansRemoved} orphaned hazard photo(s)`,
        );
      }
    } catch (error) {
      this.logger.error(
        `[${job.id ?? 'no-id'}] orphan photo sweep failed: ${String(error)}`,
      );
    }

    return { expired_marked: expired, orphan_photos_removed: orphansRemoved };
  }
}
