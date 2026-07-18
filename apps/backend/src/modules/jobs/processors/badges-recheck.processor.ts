import { Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import type { DataSource } from 'typeorm';
import { BadgesService } from '../../badges/badges.service.js';
import { FeatureResolver } from '../../features/feature-resolver.service.js';
import { JobsProducer } from '../jobs.producer.js';
import { JOB_NAMES, QUEUE_NAMES } from '../jobs.constants.js';

export interface BadgesRecheckDispatchResult {
  users_enqueued: number;
}

export interface BadgesRecheckUserResult {
  badges_awarded: string[];
}

/**
 * Two-stage badge recheck.
 *
 *   `dispatch` (nightly): finds every user who completed at least one
 *      ride in the last 36 hours (small overlap so daylight-savings
 *      shifts and worker downtime never starve a user). Enqueues a
 *      `recheck-user` child job per user — idempotent on user_id so
 *      duplicate dispatches collapse.
 *
 *   `recheck-user` (per-user): runs `BadgesService.checkAndAward`. Any
 *      newly earned tiers are awarded inside that service's
 *      transaction, so this processor only logs the outcome.
 *
 * Recent-activity gating keeps the nightly job from re-checking
 * stable accounts every night for no payoff. Users who haven't
 * ridden in 36 hours have no new ride data to push them past a
 * threshold.
 */
@Processor(QUEUE_NAMES.BADGES_RECHECK)
export class BadgesRecheckProcessor extends WorkerHost {
  private readonly logger = new Logger(BadgesRecheckProcessor.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly badges: BadgesService,
    private readonly producer: JobsProducer,
    private readonly featureResolver: FeatureResolver,
  ) {
    super();
  }

  async process(
    job: Job,
  ): Promise<BadgesRecheckDispatchResult | BadgesRecheckUserResult> {
    if (job.name === JOB_NAMES.BADGES_RECHECK_DISPATCH) {
      return this.dispatch(job);
    }
    if (job.name === JOB_NAMES.BADGES_RECHECK_USER) {
      return this.recheckUser(job);
    }
    throw new Error(`Unknown badges.recheck job name: ${job.name}`);
  }

  private async dispatch(job: Job): Promise<BadgesRecheckDispatchResult> {
    if (
      !(await this.featureResolver.isSystemSwitchEnabled('sys_gamification'))
    ) {
      this.logger.log(
        `[${job.id ?? 'no-id'}] gamification disabled — skipping badge recheck`,
      );
      return { users_enqueued: 0 };
    }

    // Window is 36h: covers a "nightly" cron that runs once a day
    // with comfortable overlap so a worker outage of <12h doesn't
    // skip any users.
    const rows = await this.dataSource.query<{ user_id: string }[]>(`
      SELECT DISTINCT user_id::text AS user_id
      FROM rides
      WHERE ended_at IS NOT NULL
        AND ended_at > NOW() - INTERVAL '36 hours'
    `);
    let enqueued = 0;
    for (const { user_id } of rows) {
      await this.producer.enqueueBadgesRecheckUser({ user_id });
      enqueued += 1;
    }
    this.logger.log(
      `[${job.id ?? 'no-id'}] dispatched badge recheck for ${enqueued} user(s)`,
    );
    return { users_enqueued: enqueued };
  }

  private async recheckUser(job: Job): Promise<BadgesRecheckUserResult> {
    const data = job.data as { user_id?: string };
    if (!data.user_id) {
      throw new Error('badges-recheck-user job missing user_id');
    }
    const result = await this.badges.checkAndAward(data.user_id);
    if (result.newly_earned.length > 0) {
      this.logger.log(
        `[${job.id ?? 'no-id'}] user ${data.user_id} earned: ${result.newly_earned.join(', ')}`,
      );
    }
    return { badges_awarded: result.newly_earned };
  }
}
