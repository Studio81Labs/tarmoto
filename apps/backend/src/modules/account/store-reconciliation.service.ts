import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash } from 'node:crypto';
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
  googleOriginalTransactionId?: string | null;
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
 * Per-rider lock key that SERIALIZES the subscription-mutation entry points
 * against each other: `AccountService.handleSubscriptionUpdated` (the Stripe
 * webhook) and whichever store-ingestion flow lands Apple/Google purchases. A
 * rider holds ONE active subscription across providers, but each entry point
 * does read→decide→write across several statements (trial eligibility,
 * exclusivity, terminal ordering); concurrent Stripe + store deliveries could
 * interleave those steps and, e.g., grant two trials. Every such flow runs
 * inside `SubscriptionMutationLockService.runExclusive`, which takes the Redis
 * lock on this exact string, so only one runs per rider at a time and the
 * per-path guards become defense-in-depth rather than the sole mechanism. Any
 * new entry point that mutates a rider's subscription state MUST take it too.
 * Distinct from {@link accountDeletionLockKey}: that serialises restore vs the
 * deletion retry worker, a different critical section.
 */
export function subscriptionMutationLockKey(userId: string): string {
  return `sub-mut:${userId}`;
}

/**
 * OTID-scoped lock key that SERIALIZES store-ingestion flows claiming the SAME
 * Apple `originalTransactionId` on behalf of DIFFERENT riders. The per-rider
 * {@link subscriptionMutationLockKey} can't cover this: two riders claiming the
 * same previously-unowned OTID hold different rider keys, so nothing orders them
 * — both pass the ownership read and only the `apple_original_transaction_id`
 * unique index catches the loser at claim time, after it has already mutated
 * (violating the contract that an ownership conflict mutates nothing). Taken
 * INSIDE the rider lock (rider → OTID ordering only; the Stripe flow never takes
 * an OTID lock, so no ordering cycle is possible), it makes the two riders run
 * one at a time **for as long as both leases hold**, so the second sees the
 * first's committed claim in its under-lock ownership read and rejects
 * mutation-free.
 *
 * ⚠️ THAT LAST PROMISE IS CONDITIONAL, AND THIS COMMENT USED TO STATE IT
 * UNCONDITIONALLY. This is a Redis TTL lease: it can lapse between the ownership
 * read and the database claim, after which a stale callback can still reach its
 * transaction first and bind the identity ahead of the live holder. So treat this
 * key as PREFLIGHT EXCLUSION, not durable ordering. The durable mechanism is
 * deliberately undecided — see the OTID-ordering correction in
 * `docs/superpowers/specs/2026-08-06-mobile-iap-revenuecat-design.md`, which
 * carries the candidates and assigns the choice to step 4.75's real-Postgres
 * concurrency harness. Do not build a new ingestion path's identity binding on
 * this lock alone.
 *
 * The raw OTID is HASHED into the key so it never lands in a Redis key or a log
 * line (OTIDs are scrubbed from logs elsewhere — the key must not reintroduce
 * them). SHA-256 is collision-resistant, so distinct OTIDs never share a lock.
 *
 * NO CALLER TODAY: the native Apple validate flow that took this lock was
 * deleted with the rest of the native path. Kept, along with
 * `SubscriptionMutationLockService.runExclusiveByOtid`, because the race is a
 * property of the SHARED claim + unique index — not of that one flow — so any
 * future ingestion path that claims an Apple OTID must take it as well.
 */
export function subscriptionOtidLockKey(originalTransactionId: string): string {
  const digest = createHash('sha256')
    .update(originalTransactionId)
    .digest('hex');
  return `sub-otid:${digest}`;
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
    manager?: EntityManager,
  ): Promise<StoreBillingReconciliation> {
    const repo = manager
      ? manager.getRepository(StoreBillingReconciliation)
      : this.repo;
    const row = repo.create(this.buildOpenRow(params));
    try {
      return await repo.save(row);
    } catch (err) {
      // Race-safe dedup for Apple opens: two concurrent validations rejecting
      // the SAME ineligible/exclusivity Apple transaction can both pass the
      // caller's `findOpen` fast-path and try to insert. The partial unique
      // index `uq_sbr_open_apple_otid_reason` (open apple rows, by
      // otid + reason) lets Postgres reject the loser with a `23505`; treat
      // that as a no-op and return the row the winner already inserted.
      //
      // Scoped to the Apple dedup identity the index actually covers, so a
      // `23505` from any OTHER insert (notably the Stripe path, which the
      // partial index does not cover) still propagates instead of being
      // silently swallowed.
      if (
        params.provider === 'apple' &&
        params.appleOriginalTransactionId != null &&
        isUniqueViolation(err)
      ) {
        const otid = params.appleOriginalTransactionId;
        const existing = await this.findOpen(
          {
            userId: params.userId,
            provider: 'apple',
            reason: params.reason,
          },
          {},
          manager,
        );
        const match = existing.find(
          (candidate) => candidate.apple_original_transaction_id === otid,
        );
        if (match) {
          return match;
        }
      }
      throw err;
    }
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
    manager?: EntityManager,
  ): Promise<StoreBillingReconciliation[]> {
    const repo = manager
      ? manager.getRepository(StoreBillingReconciliation)
      : this.repo;
    return repo.find(this.buildFindOptions(filter, options));
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
      google_original_transaction_id:
        params.googleOriginalTransactionId ?? null,
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

/**
 * Detects a Postgres unique-constraint violation (SQLSTATE `23505`). TypeORM
 * wraps the driver error in a `QueryFailedError` whose `driverError.code` holds
 * the SQLSTATE; some code paths also surface it directly as `err.code`, so we
 * check both without a fragile blanket catch. Mirrors the helper in
 * `provider-claim.service.ts`.
 */
function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) {
    return false;
  }
  const code = (err as { code?: unknown }).code;
  const driverCode = (err as { driverError?: { code?: unknown } }).driverError
    ?.code;
  return code === '23505' || driverCode === '23505';
}
