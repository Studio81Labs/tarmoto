import { Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { IsNull, LessThanOrEqual, Not, Repository } from 'typeorm';
import { User } from '../../../entities/user.entity.js';
import { JobsProducer } from '../jobs.producer.js';
import { QUEUE_NAMES } from '../jobs.constants.js';

const SWEEP_BATCH_SIZE = 200;

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
    const due = await this.users.find({
      where: {
        deleted_at: Not(IsNull()),
        deletion_scheduled_at: LessThanOrEqual(new Date()),
      },
      select: { id: true },
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
