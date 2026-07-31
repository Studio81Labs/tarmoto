import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindManyOptions, LessThan, Repository } from 'typeorm';
import { StoreBillingReconciliation } from '../../entities/store-billing-reconciliation.entity.js';

export interface OpenConflictParams {
  userId: string;
  provider: StoreBillingReconciliation['provider'];
  stripeSubscriptionId?: string | null;
  appleOriginalTransactionId?: string | null;
  googlePurchaseToken?: string | null;
  reason: StoreBillingReconciliation['reason'];
  detail?: Record<string, unknown> | null;
}

export interface FindOpenFilter {
  userId?: string;
  provider?: StoreBillingReconciliation['provider'];
  reason?: StoreBillingReconciliation['reason'];
  stripeSubscriptionId?: string;
}

/**
 * Batching controls for `findOpen`. The reconciliation retry worker passes
 * these so a single hourly run loads a BOUNDED, oldest-first slice that
 * EXCLUDES rows already at the retry cap — otherwise a prolonged outage or an
 * accumulating backlog of parked rows would make every run scan the whole
 * history (unbounded runtime/memory/log volume, delaying fresh failures).
 * Omitting them preserves the unbounded read used by the synchronous callers.
 */
export interface FindOpenOptions {
  /** Exclude rows whose `attempts` are at or beyond this cap (parked for ops). */
  maxAttempts?: number;
  /** Cap on rows returned; when set, results are ordered oldest-first. */
  limit?: number;
}

/**
 * Per-rider advisory-lock key shared by the account-deletion restore path
 * (`AccountDeletionService.restoreAccount`) and the reconciliation retry
 * worker (`StoreReconciliationProcessor`). Both take
 * `pg_advisory_xact_lock(hashtext(key))` on this exact string so a restore
 * can't interleave with an in-flight `deletion_cancel_failed` retry and
 * re-enable cancellation on a now-restored subscription (a TOCTOU on the
 * worker's `deletion_scheduled_at` re-check). Kept here — the one module
 * both sides already depend on — so the two key strings can never drift.
 */
export function accountDeletionLockKey(userId: string): string {
  return `acct-del:${userId}`;
}

/**
 * Repository facade over `store_billing_reconciliations`: durable work items
 * for store-billing states that can't be resolved synchronously inside a
 * webhook (a cross-provider exclusivity conflict, a rejected ineligible
 * trial, a deletion cancel that failed to reach the store). Ops or a
 * follow-up job drains the `open` rows and records how each was resolved.
 */
@Injectable()
export class StoreReconciliationService {
  constructor(
    @InjectRepository(StoreBillingReconciliation)
    private readonly repo: Repository<StoreBillingReconciliation>,
  ) {}

  async openConflict(
    params: OpenConflictParams,
  ): Promise<StoreBillingReconciliation> {
    const row = this.repo.create({
      user_id: params.userId,
      provider: params.provider,
      stripe_subscription_id: params.stripeSubscriptionId ?? null,
      apple_original_transaction_id: params.appleOriginalTransactionId ?? null,
      google_purchase_token: params.googlePurchaseToken ?? null,
      reason: params.reason,
      status: 'open',
      resolution: null,
      detail: params.detail ?? null,
    });
    return this.repo.save(row);
  }

  async resolve(
    id: string,
    resolution: NonNullable<StoreBillingReconciliation['resolution']>,
  ): Promise<void> {
    await this.repo.update(id, {
      status: 'resolved',
      resolution,
      resolved_at: new Date(),
    });
  }

  async findOpen(
    filter: FindOpenFilter = {},
    options: FindOpenOptions = {},
  ): Promise<StoreBillingReconciliation[]> {
    const where: {
      status: 'open';
      user_id?: string;
      provider?: StoreBillingReconciliation['provider'];
      reason?: StoreBillingReconciliation['reason'];
      stripe_subscription_id?: string;
      attempts?: ReturnType<typeof LessThan<number>>;
    } = { status: 'open' };
    if (filter.userId) where.user_id = filter.userId;
    if (filter.provider) where.provider = filter.provider;
    if (filter.reason) where.reason = filter.reason;
    if (filter.stripeSubscriptionId)
      where.stripe_subscription_id = filter.stripeSubscriptionId;
    // Exclude rows already parked at the retry cap so a growing backlog of
    // permanently-failing rows can't bloat every worker run.
    if (options.maxAttempts != null)
      where.attempts = LessThan(options.maxAttempts);

    const findOptions: FindManyOptions<StoreBillingReconciliation> = { where };
    // Bound + oldest-first only when a limit is requested; the synchronous
    // callers (which pass no options) keep their existing unbounded read.
    if (options.limit != null) {
      findOptions.order = { created_at: 'ASC' };
      findOptions.take = options.limit;
    }
    return this.repo.find(findOptions);
  }
}
