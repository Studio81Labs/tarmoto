import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  DeepPartial,
  EntityManager,
  FindManyOptions,
  FindOptionsWhere,
  LessThan,
  Repository,
} from 'typeorm';
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
    const row = this.repo.create(this.buildOpenRow(params));
    return this.repo.save(row);
  }

  /**
   * Open a conflict row using the caller's transaction manager, so the INSERT
   * commits atomically with the caller's other writes. The account-deletion
   * path uses this to create the `deletion_cancel_failed` work item in the SAME
   * transaction that stamps `deletion_scheduled_at` — the row can therefore
   * never be lost to a later best-effort step failing (the earlier fragile
   * post-commit `.catch(log)` INSERT could vanish on a double failure).
   */
  async openConflictWith(
    manager: EntityManager,
    params: OpenConflictParams,
  ): Promise<StoreBillingReconciliation> {
    const row = manager.create(
      StoreBillingReconciliation,
      this.buildOpenRow(params),
    );
    return manager.save(StoreBillingReconciliation, row);
  }

  async resolve(
    id: string,
    resolution: NonNullable<StoreBillingReconciliation['resolution']>,
  ): Promise<void> {
    await this.repo.update(id, this.buildResolvePatch(resolution));
  }

  /**
   * Resolve using the caller's transaction manager so the status flip commits
   * atomically with — and under the same advisory lock as — the caller's other
   * writes/Stripe reconciliation. Prevents a resolve from racing a concurrent
   * restore that re-opens the same work item.
   */
  async resolveWith(
    manager: EntityManager,
    id: string,
    resolution: NonNullable<StoreBillingReconciliation['resolution']>,
  ): Promise<void> {
    await manager.update(
      StoreBillingReconciliation,
      id,
      this.buildResolvePatch(resolution),
    );
  }

  async findOpen(
    filter: FindOpenFilter = {},
    options: FindOpenOptions = {},
  ): Promise<StoreBillingReconciliation[]> {
    return this.repo.find(this.buildFindOptions(filter, options));
  }

  /**
   * Reset an open row's `attempts` counter to 0 using the caller's transaction
   * manager. The restore path calls this when it REUSES an already-open
   * `deletion_cancel_failed` row: an ambiguous Stripe timeout during the
   * deletion phase can have driven that row to the retry cap
   * (`attempts >= MAX_RETRY_ATTEMPTS`), which excludes it from the worker's
   * bounded `findOpen` slice. A restore turns the row into a FRESH re-enable
   * task, so its retry budget must be reset or the worker would never pick it
   * up again and the restored account's cancel-flag would never be cleared.
   */
  async resetAttemptsWith(manager: EntityManager, id: string): Promise<void> {
    await manager.update(StoreBillingReconciliation, id, { attempts: 0 });
  }

  /**
   * `findOpen` bound to the caller's transaction manager, so the read sees the
   * caller's own uncommitted writes and runs under the caller's advisory lock.
   * The restore path uses this to check-then-open the `deletion_cancel_failed`
   * work item atomically under the lock.
   */
  async findOpenWith(
    manager: EntityManager,
    filter: FindOpenFilter = {},
    options: FindOpenOptions = {},
  ): Promise<StoreBillingReconciliation[]> {
    return manager.find(
      StoreBillingReconciliation,
      this.buildFindOptions(filter, options),
    );
  }

  private buildOpenRow(
    params: OpenConflictParams,
  ): DeepPartial<StoreBillingReconciliation> {
    return {
      user_id: params.userId,
      provider: params.provider,
      stripe_subscription_id: params.stripeSubscriptionId ?? null,
      apple_original_transaction_id: params.appleOriginalTransactionId ?? null,
      google_purchase_token: params.googlePurchaseToken ?? null,
      reason: params.reason,
      status: 'open',
      resolution: null,
      detail: params.detail ?? null,
    };
  }

  private buildResolvePatch(
    resolution: NonNullable<StoreBillingReconciliation['resolution']>,
  ): {
    status: 'resolved';
    resolution: NonNullable<StoreBillingReconciliation['resolution']>;
    resolved_at: Date;
  } {
    return {
      status: 'resolved',
      resolution,
      resolved_at: new Date(),
    };
  }

  private buildFindOptions(
    filter: FindOpenFilter,
    options: FindOpenOptions,
  ): FindManyOptions<StoreBillingReconciliation> {
    const where: FindOptionsWhere<StoreBillingReconciliation> = {
      status: 'open',
    };
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
    return findOptions;
  }
}
