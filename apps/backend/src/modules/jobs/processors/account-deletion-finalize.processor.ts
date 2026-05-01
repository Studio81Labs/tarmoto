import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { AccountDeletionService } from '../../account/account-deletion.service.js';
import { QUEUE_NAMES } from '../jobs.constants.js';
import type { AccountDeletionFinalizeJobData } from '../jobs.producer.js';

export interface AccountDeletionFinalizeResult {
  users_purged: number;
}

/**
 * Per-user account deletion finalize. Calls
 * `AccountDeletionService.processDueDeletions` with `take: 1` semantics
 * (the service already filters by `deletion_scheduled_at <= NOW()` and
 * processes one user at a time), so a sweep that enqueues 100 finalize
 * jobs ends up with 100 independent retry chains rather than one
 * monolithic batch.
 *
 * Idempotent through the service's row-level guards: if the user has
 * already been purged (or restored, or postponed), the underlying
 * `purgeUser` short-circuits with `affected: 0` and no audit row.
 */
@Processor(QUEUE_NAMES.ACCOUNT_DELETION_FINALIZE)
export class AccountDeletionFinalizeProcessor extends WorkerHost {
  private readonly logger = new Logger(AccountDeletionFinalizeProcessor.name);

  constructor(private readonly accountDeletion: AccountDeletionService) {
    super();
  }

  async process(
    job: Job<AccountDeletionFinalizeJobData>,
  ): Promise<AccountDeletionFinalizeResult> {
    const { user_id } = job.data;
    if (!user_id) {
      throw new Error('account-deletion-finalize job missing user_id');
    }
    // The service exposes a per-user finalize that guards on the row
    // still being eligible. Returns true when this call actually
    // purged the row, false when the row was no longer eligible
    // (concurrent purge OR restore OR postpone).
    const purged = await this.accountDeletion.finalizeUser(user_id);
    if (purged) {
      this.logger.log(`[${job.id ?? 'no-id'}] purged user ${user_id}`);
    } else {
      this.logger.log(
        `[${job.id ?? 'no-id'}] user ${user_id} no longer eligible — skipped`,
      );
    }
    return { users_purged: purged ? 1 : 0 };
  }
}
