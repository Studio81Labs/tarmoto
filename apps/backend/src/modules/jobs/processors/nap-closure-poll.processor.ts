import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { QUEUE_NAMES } from '../jobs.constants.js';
import { NapService } from '../../nap/nap.service.js';

/**
 * Recurring worker (#743): drives one NAP (NDIC) closure poll cycle. The
 * actual fetch→parse→reconcile lives in `NapService`; this processor is
 * just the BullMQ trigger. `NapService.poll()` is overlap-guarded and
 * gated on `TARMOTO_NAP_POLL_ENABLED`, so a tick is a cheap no-op when
 * the feed is unconfigured.
 */
@Processor(QUEUE_NAMES.NAP_CLOSURE_POLL)
export class NapClosurePollProcessor extends WorkerHost {
  private readonly logger = new Logger(NapClosurePollProcessor.name);

  constructor(private readonly nap: NapService) {
    super();
  }

  async process(
    job: Job,
  ): Promise<{ skipped: true } | { inserted: number; updated: number }> {
    const result = await this.nap.poll();
    if (!result) {
      return { skipped: true };
    }
    this.logger.log(
      `[${job.id ?? 'no-id'}] NAP poll: parsed=${result.parsed} ` +
        `inserted=${result.inserted} updated=${result.updated} ` +
        `deactivated=${result.deactivated} needsDecoding=${result.needsDecoding}`,
    );
    return { inserted: result.inserted, updated: result.updated };
  }
}
