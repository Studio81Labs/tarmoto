import { Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { IsNull, LessThanOrEqual, Not, Repository } from 'typeorm';
import { User } from '../../../entities/user.entity.js';
import { JobsProducer } from '../jobs.producer.js';
import { QUEUE_NAMES } from '../jobs.constants.js';

// Sized to match (and exceed) the previous `@Cron(EVERY_HOUR)` sweeper's
// effective ceiling of 50 users/hour × 24 = 1,200 users/day. The new
// daily cadence means a single tick must drain a full day's backlog;
// 1,500 gives ~25% headroom for spike days (mass-cancellation events,
// e.g. after a privacy incident or pricing change). Each finalize job
// runs in its own worker slot under the `account-deletion-finalize`
// queue's concurrency cap, so the batch size is effectively the
// in-Redis enqueue ceiling — actual purge throughput is still gated
// by the worker pool downstream.
const SWEEP_BATCH_SIZE = 1500;

export interface AccountDeletionSweepResult {
  users_enqueued: number;
}

/**
 * Daily recurring job. Finds every user whose `deletion_scheduled_at`
 * has passed and enqueues a per-user finalize job. The actual purge
 * (Stripe cancel, DB cascade, audit log) lives in the finalize
 * processor so per-user failures don't block the rest of the batch
 * and so each user gets its own retry chain.
 *
 * Replaces the previous `@Cron(EVERY_HOUR)` sweeper that ran the
 * purge inline on a single shared timer. The split (sweep enqueues,
 * finalize purges) gives each user its own attempts/backoff and
 * makes failure modes visible in the queue health endpoint.
 */
@Processor(QUEUE_NAMES.ACCOUNT_DELETION_SWEEP)
export class AccountDeletionSweepProcessor extends WorkerHost {
  private readonly logger = new Logger(AccountDeletionSweepProcessor.name);

  constructor(
    @InjectRepository(User)
    private readonly users: Repository<User>,
    private readonly producer: JobsProducer,
  ) {
    super();
  }

  async process(job: Job): Promise<AccountDeletionSweepResult> {
    // Oldest-first ordering: when the batch is smaller than the
    // backlog (mass-cancellation event), the longest-overdue users
    // get processed first. GDPR's deletion deadline is calendar
    // time from the request, so the user closest to breaching it
    // should always be first off the queue.
    const due = await this.users.find({
      where: {
        deleted_at: Not(IsNull()),
        deletion_scheduled_at: LessThanOrEqual(new Date()),
      },
      select: { id: true },
      order: { deletion_scheduled_at: 'ASC' },
      take: SWEEP_BATCH_SIZE,
    });

    let enqueued = 0;
    for (const user of due) {
      await this.producer.enqueueAccountDeletionFinalize({ user_id: user.id });
      enqueued += 1;
    }
    if (enqueued > 0) {
      this.logger.log(
        `[${job.id ?? 'no-id'}] enqueued ${enqueued} account-deletion finalize job(s)`,
      );
    }
    return { users_enqueued: enqueued };
  }
}
