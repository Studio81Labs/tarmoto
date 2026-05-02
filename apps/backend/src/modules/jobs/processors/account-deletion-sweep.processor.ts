import { Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { DataSource, IsNull, LessThanOrEqual, Not } from 'typeorm';
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
 *
 * Multi-pod safe: the claim runs inside a transaction with
 * `SELECT … FOR UPDATE SKIP LOCKED`, so two pods sweeping at the same
 * cron tick lock disjoint slices of the due-user set instead of
 * racing to enqueue the same finalize jobs. The `JobsProducer`
 * jobId-dedup is still a backstop, but the SKIP LOCKED claim removes
 * the dedup-failure exposure entirely (#337).
 */
@Processor(QUEUE_NAMES.ACCOUNT_DELETION_SWEEP)
export class AccountDeletionSweepProcessor extends WorkerHost {
  private readonly logger = new Logger(AccountDeletionSweepProcessor.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly producer: JobsProducer,
  ) {
    super();
  }

  async process(job: Job): Promise<AccountDeletionSweepResult> {
    return this.dataSource.transaction(async (manager) => {
      // Oldest-first ordering: when the batch is smaller than the
      // backlog (mass-cancellation event), the longest-overdue users
      // get processed first. GDPR's deletion deadline is calendar
      // time from the request, so the user closest to breaching it
      // should always be first off the queue.
      //
      // FOR UPDATE SKIP LOCKED makes the claim multi-pod-safe: when
      // two pods sweep simultaneously, each locks a disjoint slice
      // of the due rows instead of both racing to enqueue the same
      // finalize jobs. Postgres applies SKIP LOCKED before LIMIT,
      // so pod B picks up rows past pod A's slice rather than
      // returning empty. Locks release at transaction commit (after
      // every enqueue below), so the next sweep tick sees an
      // unlocked table and pages through any rows neither pod
      // claimed this round.
      const due = await manager.getRepository(User).find({
        where: {
          deleted_at: Not(IsNull()),
          deletion_scheduled_at: LessThanOrEqual(new Date()),
        },
        select: { id: true },
        order: { deletion_scheduled_at: 'ASC' },
        take: SWEEP_BATCH_SIZE,
        lock: { mode: 'pessimistic_write', onLocked: 'skip_locked' },
      });

      let enqueued = 0;
      for (const user of due) {
        await this.producer.enqueueAccountDeletionFinalize({
          user_id: user.id,
        });
        enqueued += 1;
      }
      if (enqueued > 0) {
        this.logger.log(
          `[${job.id ?? 'no-id'}] enqueued ${enqueued} account-deletion finalize job(s)`,
        );
      }
      return { users_enqueued: enqueued };
    });
  }
}
