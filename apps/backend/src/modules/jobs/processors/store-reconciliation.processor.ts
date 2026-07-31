import { Inject, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { DataSource } from 'typeorm';
import { User } from '../../../entities/user.entity.js';
import { StoreBillingReconciliation } from '../../../entities/store-billing-reconciliation.entity.js';
import { StoreReconciliationService } from '../../account/store-reconciliation.service.js';
import {
  STRIPE_BILLING_CLIENT,
  type StripeBillingClient,
} from '../../account/stripe-billing.client.js';
import { QUEUE_NAMES } from '../jobs.constants.js';

/**
 * Per-rider advisory-lock key for the reconciliation retry. This lock
 * serialises reconciliation workers against EACH OTHER only — two pods or
 * overlapping ticks can't both read a pre-restore `deletion_scheduled_at`
 * for the same rider and double-cancel Stripe. It does NOT serialise
 * against the account-deletion grace/restore/purge flow: no other code
 * takes the `acct-del:` key (`requestDeletion`/restore take no advisory
 * lock, and the purge uses `hazard_photo_upload:${userId}`).
 * Restoration-safety therefore relies on the under-lock re-read of
 * `deletion_scheduled_at` in `retryRow`, not on cross-flow serialisation.
 */
export function storeReconciliationLockKey(userId: string): string {
  return `acct-del:${userId}`;
}

/**
 * Retention horizon for the completed-notification inbox prune. Completed
 * `processed_store_notifications` rows exist only to make a redelivered
 * webhook a no-op; once a row is this old a store will not redeliver it,
 * so it can be dropped. Kept conservative — the inbox is tiny and the
 * dedup window only needs to outlive a store's redelivery retries.
 */
const INBOX_COMPLETED_RETENTION_DAYS = 7;

/**
 * Bound on how many times a single row is retried against Stripe before it
 * is left for ops. Without this a permanently-failing row (e.g. a
 * subscription Stripe can neither find nor cancel) would be retried on
 * every hourly tick forever. Rows at/over the cap stay `open` so they
 * surface in the ops drain instead of being silently resolved.
 */
const MAX_RETRY_ATTEMPTS = 5;

export interface StoreReconciliationRetryResult {
  rows_scanned: number;
  resolved_restored: number;
  resolved_canceled: number;
  still_open: number;
  inbox_pruned: number;
}

@Processor(QUEUE_NAMES.STORE_RECONCILIATION_RETRY)
export class StoreReconciliationProcessor extends WorkerHost {
  private readonly logger = new Logger(StoreReconciliationProcessor.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly reconciliation: StoreReconciliationService,
    @Inject(STRIPE_BILLING_CLIENT)
    private readonly stripe: StripeBillingClient,
  ) {
    super();
  }

  async process(job: Job): Promise<StoreReconciliationRetryResult> {
    // P0 scope: only Stripe-actionable `deletion_cancel_failed` rows. A
    // failed store cancellation during account deletion is the one reason
    // this worker can act on unattended — the Apple/Google exclusivity and
    // ineligible-trial reasons need a store round-trip whose producers
    // arrive in P1/P2, so they stay `open` for the ops drain.
    const rows = await this.reconciliation.findOpen({
      provider: 'stripe',
      reason: 'deletion_cancel_failed',
    });

    let resolvedRestored = 0;
    let resolvedCanceled = 0;
    let stillOpen = 0;

    for (const row of rows) {
      const outcome = await this.retryRow(row);
      if (outcome === 'restored') resolvedRestored += 1;
      else if (outcome === 'canceled') resolvedCanceled += 1;
      else stillOpen += 1;
    }

    const inboxPruned = await this.pruneCompletedInbox();

    if (resolvedRestored || resolvedCanceled || stillOpen || inboxPruned) {
      this.logger.log(
        `[${job.id ?? 'no-id'}] reconciliation retry: ` +
          `${resolvedCanceled} canceled, ${resolvedRestored} restored, ` +
          `${stillOpen} still open (of ${rows.length}); ` +
          `pruned ${inboxPruned} completed inbox row(s)`,
      );
    }

    return {
      rows_scanned: rows.length,
      resolved_restored: resolvedRestored,
      resolved_canceled: resolvedCanceled,
      still_open: stillOpen,
      inbox_pruned: inboxPruned,
    };
  }

  /**
   * Retry a single `deletion_cancel_failed` row restoration-safely. The
   * whole decision runs under a per-rider advisory lock inside one
   * transaction so a concurrent worker (or a second pod) can't read the
   * same pre-restore `deletion_scheduled_at` and double-cancel Stripe.
   *
   * A transient Stripe failure is RECORDED (attempts++), not hidden: the
   * row stays `open` for the next hourly tick and one bad row never fails
   * the rest of the batch (mirrors the deletion sweep's per-user
   * isolation). Rows that exhaust `MAX_RETRY_ATTEMPTS` stay open for ops
   * rather than being retried forever or silently resolved.
   */
  private async retryRow(
    row: StoreBillingReconciliation,
  ): Promise<'restored' | 'canceled' | 'still_open'> {
    if (row.attempts >= MAX_RETRY_ATTEMPTS) {
      this.logger.warn(
        `reconciliation row ${row.id} hit the retry cap (${row.attempts}); leaving open for ops`,
      );
      return 'still_open';
    }

    return this.dataSource.transaction(async (manager) => {
      await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        storeReconciliationLockKey(row.user_id),
      ]);

      const user = await manager.getRepository(User).findOne({
        where: { id: row.user_id },
        select: {
          id: true,
          deletion_scheduled_at: true,
          stripe_subscription_id: true,
        },
      });

      // Restoration-safe: if the rider was restored (or purged) during the
      // grace window, the deletion is no longer pending. A stale retry must
      // NOT cancel a subscription the rider is once again paying for.
      // Nothing is owed to Stripe here, so close the row out. `expired` is
      // the least-wrong existing CHECK resolution for "the reason to act
      // lapsed" — inventing a `restored` value would need a migration, which
      // is out of P0 scope.
      if (!user || user.deletion_scheduled_at === null) {
        await this.reconciliation.resolve(row.id, 'expired');
        return 'restored';
      }

      // Prefer the rider's live subscription id; fall back to the one
      // captured on the row when the reconciliation was opened.
      const subscriptionId =
        user.stripe_subscription_id ?? row.stripe_subscription_id;
      if (!subscriptionId) {
        // No subscription left to cancel — the deletion-time cancel has
        // effectively nothing to target, so the server side is done.
        await this.reconciliation.resolve(row.id, 'server_canceled');
        return 'canceled';
      }

      try {
        await this.stripe.setCancelAtPeriodEnd(subscriptionId, true);
      } catch (err) {
        // Record the failure and leave the row open for the next tick. Not
        // a rethrow: a single unreachable subscription must not abort the
        // whole batch. The attempts counter bounds the retry so a
        // permanently-failing row eventually parks for ops.
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error(
          `reconciliation row ${row.id}: Stripe cancel retry failed — ${msg}`,
        );
        await manager
          .getRepository(StoreBillingReconciliation)
          .increment({ id: row.id }, 'attempts', 1);
        return 'still_open';
      }

      await this.reconciliation.resolve(row.id, 'server_canceled');
      return 'canceled';
    });
  }

  /**
   * Retention prune of the store-notification inbox. Only `completed`
   * rows past the horizon are dropped: they exist solely to make a
   * redelivered webhook a no-op, and no store redelivers this far out.
   * `pending`/`dead_letter` rows are always retained (the predicate can't
   * match them). This is the ONLY inbox job in P0 — lease/redelivery/
   * dead-letter processing has no producers until P1/P2.
   */
  private async pruneCompletedInbox(): Promise<number> {
    const cutoff = new Date(
      Date.now() - INBOX_COMPLETED_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    );
    const deleted: Array<{ id: string }> = await this.dataSource.query(
      `DELETE FROM processed_store_notifications
       WHERE status = 'completed' AND created_at < $1
       RETURNING id`,
      [cutoff],
    );
    return Array.isArray(deleted) ? deleted.length : 0;
  }
}
