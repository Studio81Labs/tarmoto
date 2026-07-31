import { Inject, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { DataSource } from 'typeorm';
import { User } from '../../../entities/user.entity.js';
import { StoreBillingReconciliation } from '../../../entities/store-billing-reconciliation.entity.js';
import {
  StoreReconciliationService,
  accountDeletionLockKey,
} from '../../account/store-reconciliation.service.js';
import {
  STRIPE_BILLING_CLIENT,
  type StripeBillingClient,
} from '../../account/stripe-billing.client.js';
import { QUEUE_NAMES } from '../jobs.constants.js';

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

/**
 * Max rows drained per hourly run. Bounds each run's runtime/memory/log volume
 * so a prolonged Stripe outage (or an accumulating backlog of parked rows)
 * can't make one tick load the whole historical backlog and starve fresh
 * failures. Matches the account-deletion sweep's per-run batch size; rows past
 * this slice are picked up on the next tick, oldest-first.
 */
const RETRY_BATCH_SIZE = 50;

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
    const rows = await this.reconciliation.findOpen(
      {
        provider: 'stripe',
        reason: 'deletion_cancel_failed',
      },
      // Bounded, oldest-first, retry-cap-excluding slice so one run can't load
      // the whole backlog. The `attempts >= MAX_RETRY_ATTEMPTS` guard in
      // `retryRow` stays as a belt-and-braces backstop for any capped row that
      // still slips through.
      { maxAttempts: MAX_RETRY_ATTEMPTS, limit: RETRY_BATCH_SIZE },
    );

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
   * Converge a single `deletion_cancel_failed` row to the rider's CURRENT
   * deletion state. The whole decision runs under a per-rider advisory lock
   * inside one transaction so a concurrent worker (or a second pod), a restore,
   * or a re-deletion can't read a stale `deletion_scheduled_at` and set the
   * cancel-flag in the wrong direction.
   *
   * The row is a durable "the Stripe cancel-flag must match the current
   * deletion state" work item, and this worker is the SINGLE convergence point
   * that sets it in BOTH directions, keyed on a FRESH under-lock read:
   *   - `deletion_scheduled_at IS NOT NULL` (still scheduled) →
   *     `setCancelAtPeriodEnd(subId, true)` (stop the next renewal);
   *   - `deletion_scheduled_at IS NULL` (restored) →
   *     `setCancelAtPeriodEnd(subId, false)` (re-enable the renewal).
   * On success the row resolves; a transient Stripe failure is RECORDED
   * (attempts++), not hidden — the row stays `open` for the next tick and one
   * bad row never fails the batch. Rows that exhaust `MAX_RETRY_ATTEMPTS` stay
   * open for ops. `expired` / `server_canceled` are the existing CHECK
   * resolutions for "re-enabled/no-longer-owed" and "cancel confirmed" — no
   * migration needed.
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
        accountDeletionLockKey(row.user_id),
      ]);

      const user = await manager.getRepository(User).findOne({
        where: { id: row.user_id },
        select: {
          id: true,
          deletion_scheduled_at: true,
          stripe_subscription_id: true,
        },
      });

      // The user row is entirely gone (hard-purged): the purge path already
      // ran the immediate `cancelSubscription`, so nothing is owed to Stripe.
      // Close the row out.
      if (!user) {
        await this.reconciliation.resolve(row.id, 'expired');
        return 'restored';
      }

      // Fresh under-lock read of the deletion state decides the DIRECTION.
      const stillScheduled = user.deletion_scheduled_at !== null;

      // Prefer the rider's live subscription id; fall back to the one
      // captured on the row when the reconciliation was opened.
      const subscriptionId =
        user.stripe_subscription_id ?? row.stripe_subscription_id;
      if (!subscriptionId) {
        // No subscription to set the flag on — nothing to reconcile either way.
        await this.reconciliation.resolve(
          row.id,
          stillScheduled ? 'server_canceled' : 'expired',
        );
        return stillScheduled ? 'canceled' : 'restored';
      }

      try {
        await this.stripe.setCancelAtPeriodEnd(subscriptionId, stillScheduled);
      } catch (err) {
        // Record the failure and leave the row open for the next tick. Not
        // a rethrow: a single unreachable subscription must not abort the
        // whole batch. The attempts counter bounds the retry so a
        // permanently-failing row eventually parks for ops.
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error(
          `reconciliation row ${row.id}: Stripe cancel-flag retry ` +
            `(setCancelAtPeriodEnd=${String(stillScheduled)}) failed — ${msg}`,
        );
        await manager
          .getRepository(StoreBillingReconciliation)
          .increment({ id: row.id }, 'attempts', 1);
        return 'still_open';
      }

      await this.reconciliation.resolve(
        row.id,
        stillScheduled ? 'server_canceled' : 'expired',
      );
      return stillScheduled ? 'canceled' : 'restored';
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
