import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, LessThanOrEqual, Repository } from 'typeorm';
import type { StoreTier, SubscriptionProvider } from '@tarmoto/shared';
import { StoreSubscription } from '../../entities/store-subscription.entity.js';
import { StoreBillingReconciliation } from '../../entities/store-billing-reconciliation.entity.js';
import { User } from '../../entities/user.entity.js';
import { assertSubscriptionFenceCurrent } from './provider-claim.service.js';
import { computeStoreRollup } from './store-rollup.js';
import {
  LIVE_CHAIN_SQL,
  isFutureBilling,
  isSourceLive,
  liveChainParams,
} from './store-chain-liveness.js';
import {
  allOverlapPairs,
  buildOverlapPair,
  computeEscalateAfter,
  encodeOverlapMember,
  type OverlapMember,
} from './store-overlap.js';
import { SubscriptionMutationLockService } from './subscription-mutation-lock.service.js';
import { trialMarkerStamp } from './trial-consumption.js';

/**
 * Everything one store event says about one chain. Claims AND terminals flow
 * through the same shape: a terminal is a state write like any other (status
 * `canceled`, and — for a refund or store revocation — `currentPeriodEnd`
 * TRUNCATED to the revocation instant by the caller), so one ordering-guarded
 * writer covers both and no reader has to know which statuses are terminal.
 */
export interface StoreChainStateInput {
  userId: string;
  provider: Extract<SubscriptionProvider, 'apple' | 'google'>;
  /**
   * RevenueCat's `original_transaction_id` — the stable chain identity. NULL
   * only for a chain observed without one (restore / the deletion
   * enumeration), which is then keyed provisionally by
   * {@link storeTransactionId} until enrichment re-keys it.
   */
  originalTransactionId: string | null;
  /**
   * The observed per-renewal `store_transaction_id` — the PROVISIONAL
   * `target_key` when the original id is unknown. Required then; ignored for
   * an identified chain, whose key is the original id itself
   * (`ss_staged_key_check` requires the two to agree).
   */
  storeTransactionId?: string | null;
  productId: string;
  /** The store's own chronology; kept via COALESCE so a later event missing it cannot erase it. */
  originalPurchaseDate: Date | null;
  tier: StoreTier;
  status: StoreSubscription['status'];
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  /** The read-ordering key (`request_date_ms`), stored per chain as `store_signed_date`. */
  observedAt: Date;
  /** The per-acquisition token from `SubscriptionMutationLockService`. */
  fenceToken: number;
  /**
   * Stamp the once-per-rider trial marker in the SAME users UPDATE that writes
   * the rollup. `COALESCE` keeps it idempotent and monotonic. Unlike the
   * retired single-slot claims this carries NO eligibility guard: under
   * RevenueCat the STORE has already granted the intro offer by the time the
   * event arrives, so the marker records a fact rather than authorising a
   * grant — refusing the write would not stop the store's trial, only lose the
   * record that gates a later Stripe one.
   */
  markTrialUsed?: boolean;
  /**
   * Stripe's `created` for the persisted Stripe side, when the caller has it
   * (the Stripe webhook path reads it off the event; snapshot readers get it
   * from `StripeBillingSnapshot.currentPlan.created`). Feeds the overlap
   * refund-target role; absent, a Stripe-involving pair records the target as
   * ambiguous (NULL), which readers must surface as unknown.
   */
  stripeCreatedAt?: Date | null;
}

/**
 * - `claimed` — the chain row was written and the rollup + overlap state now
 *   reflect it.
 * - `stale` — the rider already holds a NEWER observation of this chain
 *   (`store_signed_date` ordering guard); an idempotent no-op, never a
 *   conflict. Per-chain on purpose: an event for chain B can no longer advance
 *   the value a later-but-valid event for chain A is checked against.
 * - `ownership_conflict` — the identity belongs to a DIFFERENT rider
 *   (`uq_ss_provider_target_key` / `uq_ss_provider_original_txn`), and NOTHING
 *   was mutated (the transaction rolled back). The caller must not open an
 *   `exclusivity_conflict` reconciliation carrying another rider's identity —
 *   that routes someone else's purchase into the refund workflow.
 *
 * A stale FENCE (a newer lock holder advanced past this flow's token) is not a
 * result — it throws a retryable 503, exactly like every other guarded
 * subscription write, so the event source redelivers to a fresh flow.
 */
export type StoreChainWriteResult = 'claimed' | 'stale' | 'ownership_conflict';

/** Thrown inside the write transaction to surface a cross-rider unique hit. */
class StoreChainOwnershipConflictError extends Error {
  constructor() {
    super('store chain identity is bound to a different rider');
  }
}

interface RollupSweepResult {
  scanned: number;
  recomputed: number;
  failed: number;
}

interface OverlapSweepResult {
  scanned: number;
  retired: number;
  /** Due rows whose members are both still locally future-billing — left for step 5's re-query-confirmed promotion. */
  waiting: number;
}

/**
 * The CHAIN writers — release A item (2) of #1191, replacing the retired
 * single-slot `claimForApple` / `claimForGoogle`.
 *
 * ## What a chain write is
 *
 * One store event about one chain becomes, in ONE transaction:
 *
 *  1. an ordering- and fence-guarded upsert of the `store_subscriptions` row —
 *     `users.subscription_*` is NEVER touched, those columns are the STRIPE
 *     side of `max(stripe, chains)` now, and a store writer that also wrote
 *     them would overwrite a rider's Stripe Premium with a Google Pro;
 *  2. a recomputation of the rollup pair `users.store_subscription_tier` /
 *     `store_subscription_tier_expires_at` from the rider's LIVE chains —
 *     atomically with the chain row, under the same per-rider lock, stamped
 *     with the same fence. "Chain table only" is the wrong reading: the rollup
 *     is what every synchronous entitlement reader consults, so skipping it
 *     leaves a store-only paying rider resolved as `free` by every guard;
 *  3. an overlap sync: a provisional pair for every unordered pair of
 *     FUTURE-BILLING sources (chains + the persisted Stripe side), and silent
 *     retirement of provisional pairs naming a member that stopped future
 *     billing. Detect and reconcile — never refuse to persist: refusing the
 *     write never stopped the store billing, it only made us blind to it.
 *
 * ## What is deliberately NOT here
 *
 *  - The re-query-confirmed PROMOTION of a provisional overlap to an operator
 *    item needs the RevenueCat client and lands with step 5. Provisional rows
 *    accumulate safely — they are not operator items.
 *  - Enrichment (re-keying a provisional `target_key` to the original id and
 *    MERGING same-rider duplicates, with its pair re-key protocol) is driven
 *    by the Scheduled Data Export and lands with steps 5/6.5.
 *  - No caller exists yet: the RevenueCat webhook consumer (step 5) is blocked
 *    on exactly this seam. Everything here ships dark.
 *
 * Callers run inside `SubscriptionMutationLockService.runExclusive` — the same
 * per-rider serialisation every other subscription mutation takes.
 */
@Injectable()
export class StoreChainWriterService {
  private readonly logger = new Logger(StoreChainWriterService.name);

  constructor(
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    @InjectRepository(StoreBillingReconciliation)
    private readonly reconciliationRepo: Repository<StoreBillingReconciliation>,
    private readonly config: ConfigService,
    private readonly subscriptionLock: SubscriptionMutationLockService,
  ) {}

  /** The bounded window a chain with no known period end is trusted for. */
  private fallbackWindowMs(): number {
    return (
      this.config.get<number>('TARMOTO_BILLING_OVERLAP_FALLBACK_DAYS', 35) *
      24 *
      60 *
      60 *
      1000
    );
  }

  /** Grace beyond a period boundary before a provisional overlap is due — store webhook lag is hours, not minutes. */
  private graceMs(): number {
    return (
      this.config.get<number>('TARMOTO_BILLING_OVERLAP_GRACE_HOURS', 72) *
      60 *
      60 *
      1000
    );
  }

  /**
   * Apply one store event's state to its chain — see the class doc for the
   * three steps this performs atomically and {@link StoreChainWriteResult} for
   * the outcomes.
   */
  async applyChainState(
    input: StoreChainStateInput,
    manager?: EntityManager,
  ): Promise<StoreChainWriteResult> {
    const provisional = input.originalTransactionId == null;
    const targetKey = input.originalTransactionId ?? input.storeTransactionId;
    if (!targetKey) {
      // Programming error, not store state: every discovery path has one of
      // the two identifiers, and a chain with neither cannot be named at all.
      throw new Error(
        'store chain write needs originalTransactionId or storeTransactionId',
      );
    }

    const base = manager ?? this.userRepo.manager;
    try {
      return await base.transaction(async (tx) => {
        const wrote = await this.upsertChainRow(
          tx,
          input,
          targetKey,
          provisional,
        );
        if (wrote === 'stale') return 'stale';

        // Rollup + overlaps commit WITH the chain row: a crash between them
        // must not leave a chain the guards cannot see, so all three ride one
        // transaction and a fence-stale rollup write rolls the chain back too.
        await this.recomputeRollupInTx(tx, input.userId, input.fenceToken, {
          markTrialUsed: input.markTrialUsed === true,
        });
        await this.syncOverlapsInTx(tx, input.userId, {
          stripeCreatedAt: input.stripeCreatedAt ?? null,
        });
        return 'claimed';
      });
    } catch (err) {
      if (err instanceof StoreChainOwnershipConflictError) {
        return 'ownership_conflict';
      }
      throw err;
    }
  }

  /**
   * Ordering- and fence-guarded upsert of the chain row itself.
   *
   * UPDATE first: the common case after the first event is a renewal or state
   * change of a chain we already hold. A zero-row result is disambiguated by a
   * follow-up read — the row exists (ordering/fence rejected: check the fence,
   * else `stale`) or it does not (INSERT, translating a unique violation into
   * the ownership conflict above).
   */
  private async upsertChainRow(
    tx: EntityManager,
    input: StoreChainStateInput,
    targetKey: string,
    provisional: boolean,
  ): Promise<'wrote' | 'stale'> {
    const updated = await tx
      .createQueryBuilder()
      .update(StoreSubscription)
      .set({
        product_id: input.productId,
        // COALESCE keeps the store's chronology once known: a later event that
        // omits it must not erase the refund-target evidence.
        original_purchase_date: () =>
          'COALESCE(:opd::timestamptz, original_purchase_date)',
        tier: input.tier,
        status: input.status,
        current_period_end: input.currentPeriodEnd,
        cancel_at_period_end: input.cancelAtPeriodEnd,
        store_signed_date: input.observedAt,
        lock_fence: input.fenceToken,
      })
      .setParameter('opd', input.originalPurchaseDate)
      .where('user_id = :userId', { userId: input.userId })
      .andWhere('provider = :provider', { provider: input.provider })
      .andWhere('target_key = :targetKey', { targetKey })
      // PER-CHAIN ordering: a read that started earlier cannot overwrite what
      // a later read already committed — and an event for another chain can no
      // longer advance the watermark this one is checked against.
      .andWhere('store_signed_date <= :observedAt', {
        observedAt: input.observedAt,
      })
      // Fence: a lease-lost stale flow can't clobber a row a newer acquisition
      // already advanced.
      .andWhere('lock_fence <= :fence', { fence: input.fenceToken })
      .execute();
    if ((updated.affected ?? 0) > 0) return 'wrote';

    const existing = await tx.getRepository(StoreSubscription).findOne({
      where: {
        user_id: input.userId,
        provider: input.provider,
        target_key: targetKey,
      },
      select: { id: true },
    });
    if (existing) {
      // The rider holds this chain but the guarded UPDATE matched nothing:
      // either OUR fence is stale (throws a retryable 503 so a fresh flow
      // re-decides) or this is an older read losing the per-chain ordering —
      // a benign, idempotent no-op.
      await assertSubscriptionFenceCurrent(
        tx.getRepository(User),
        input.userId,
        input.fenceToken,
      );
      return 'stale';
    }

    try {
      await tx.getRepository(StoreSubscription).insert({
        user_id: input.userId,
        provider: input.provider,
        original_transaction_id: input.originalTransactionId,
        target_key: targetKey,
        target_key_provisional: provisional,
        product_id: input.productId,
        original_purchase_date: input.originalPurchaseDate,
        tier: input.tier,
        status: input.status,
        current_period_end: input.currentPeriodEnd,
        cancel_at_period_end: input.cancelAtPeriodEnd,
        store_signed_date: input.observedAt,
        lock_fence: input.fenceToken,
      });
    } catch (err) {
      // The rider's own row was absent under the per-rider lock, so a unique
      // violation on (provider, target_key) or (provider,
      // original_transaction_id) can only mean the identity is bound to a
      // DIFFERENT rider — the cross-rider protection doing its job. Surfaced
      // as a distinct result (transaction rolls back, nothing mutated); the
      // 23514/23505 codes surface on `err.code` or `driverError.code`
      // depending on the path, so check both.
      if (isUniqueViolation(err)) {
        throw new StoreChainOwnershipConflictError();
      }
      throw err;
    }
    return 'wrote';
  }

  /**
   * Recompute the rider's rollup pair from their LIVE chains and write both
   * columns in one fence-guarded UPDATE.
   *
   * Both columns are `select: false`, so they are NAMED here explicitly — an
   * omitted column would silently persist nothing. A zero-row result means a
   * newer lock holder advanced the fence: throw retryable so the enclosing
   * transaction (chain row included) rolls back rather than committing a chain
   * the rollup does not reflect.
   */
  private async recomputeRollupInTx(
    tx: EntityManager,
    userId: string,
    fenceToken: number,
    opts: { markTrialUsed: boolean },
  ): Promise<void> {
    const rollup = await this.computeRollupFromLiveChains(tx, userId);
    const updated = await tx
      .createQueryBuilder()
      .update(User)
      .set({
        store_subscription_tier: rollup.tier,
        store_subscription_tier_expires_at: rollup.expiresAt,
        subscription_lock_fence: fenceToken,
        ...(opts.markTrialUsed
          ? { billing_trial_used_at: trialMarkerStamp() }
          : {}),
      })
      .where('id = :userId', { userId })
      .andWhere('subscription_lock_fence <= :fence', { fence: fenceToken })
      .execute();
    if ((updated.affected ?? 0) === 0) {
      throw new ServiceUnavailableException({
        message: 'Subscription service is busy. Please retry shortly.',
        retryable: true,
      });
    }
  }

  /** The rollup value for the rider's CURRENT live set. */
  private async computeRollupFromLiveChains(
    tx: EntityManager,
    userId: string,
  ): Promise<{ tier: StoreTier | null; expiresAt: Date | null }> {
    const now = new Date();
    const fallbackMs = this.fallbackWindowMs();
    const liveChains = await tx
      .getRepository(StoreSubscription)
      .createQueryBuilder('chain')
      .where('chain.user_id = :userId', { userId })
      .andWhere(LIVE_CHAIN_SQL('chain'), liveChainParams(now, fallbackMs))
      .getMany();
    return computeStoreRollup(
      liveChains.map((chain) => ({
        tier: chain.tier,
        currentPeriodEnd: chain.current_period_end,
        observedAt: chain.store_signed_date,
      })),
      fallbackMs,
    );
  }

  /**
   * Bring the rider's provisional-overlap rows in line with their CURRENT
   * future-billing sources, after a STRIPE-side write. Runs its own
   * transaction on the given manager; the chain writer calls the `InTx`
   * variant inside its own.
   *
   * Idempotent in both directions (the pair unique index dedups creation, the
   * `status = 'provisional'` guard scopes retirement), so every Stripe settle
   * point can call it unconditionally — for a rider with no chains it reads
   * two indexed, empty sets and writes nothing, which is every rider until the
   * step-5 consumer ships.
   */
  async syncOverlapsAfterBillingChange(
    manager: EntityManager,
    userId: string,
    opts: { stripeCreatedAt?: Date | null } = {},
  ): Promise<void> {
    await manager.transaction(async (tx) => {
      await this.syncOverlapsInTx(tx, userId, {
        stripeCreatedAt: opts.stripeCreatedAt ?? null,
      });
    });
  }

  /**
   * Creation and retirement, from ONE reading of the rider's sources — the
   * design's rule is that the two must test the same `futureBilling` predicate
   * or rows appear that nothing can clear.
   *
   *  - CREATE a `provisional` row for every unordered pair of future-billing
   *    sources that lacks an unresolved one. `ON CONFLICT ... DO NOTHING`
   *    against `uq_sbr_unresolved_overlap_pair` makes redelivery idempotent,
   *    and — because promotion mutates only `reason`/`status`, never the pair —
   *    an event arriving AFTER promotion also inserts nothing.
   *  - RETIRE, silently, every provisional row naming a member that is no
   *    longer future-billing. Not `open` rows: those are operator items, and
   *    the deadline path's re-query (step 5) is what retires or resolves them.
   *
   * A provisional row is deliberately NOT an operator item; findOpen selects
   * `status = 'open'` only, so nothing here surfaces in the ops drain.
   */
  private async syncOverlapsInTx(
    tx: EntityManager,
    userId: string,
    opts: { stripeCreatedAt: Date | null },
  ): Promise<void> {
    const sources = await this.loadFutureBillingSources(
      tx,
      userId,
      opts.stripeCreatedAt,
    );
    const encoded = sources.map((source) =>
      encodeOverlapMember(source.provider, source.identity),
    );

    // Retirement FIRST, so a pair both created and invalidated by one event's
    // state cannot be inserted and immediately retired in the same pass.
    // `= ANY` over the future-billing set: a member that no longer appears in
    // it — a canceled chain, a Stripe side gone terminal, an identity that no
    // longer exists locally at all — makes its rows stale. An empty set
    // retires everything, which is correct: no future-billing sources means no
    // overlap can survive.
    await tx.query(
      `UPDATE store_billing_reconciliations
          SET status = 'retired', resolved_at = now()
        WHERE user_id = $1
          AND status = 'provisional'
          AND NOT (overlap_pair_low = ANY($2::text[])
                   AND overlap_pair_high = ANY($2::text[]))`,
      [userId, encoded],
    );

    if (sources.length < 2) return;

    const fallbackMs = this.fallbackWindowMs();
    const graceMs = this.graceMs();
    for (const [a, b] of allOverlapPairs(sources)) {
      const pair = buildOverlapPair(a, b);
      const escalateAfter = computeEscalateAfter([a, b], fallbackMs, graceMs);
      // `provider` is single-valued legacy vocabulary a pair does not fit;
      // recorded as the byte-wise HIGH member's provider, preferring a store
      // member over `stripe` where the pair has one (the store side is what
      // legacy per-provider tooling filters on). Informational only — the
      // decodable pair columns are what every consumer acts on.
      const rowProvider =
        a.provider === 'stripe'
          ? b.provider
          : b.provider === 'stripe'
            ? a.provider
            : (pair.high === encodeOverlapMember(b.provider, b.identity)
                ? b
                : a
              ).provider;
      await tx.query(
        `INSERT INTO store_billing_reconciliations
           (user_id, provider, reason, status,
            overlap_pair_low, overlap_pair_high, overlap_older_member,
            escalate_after, detail)
         VALUES ($1, $2, 'provisional_overlap', 'provisional', $3, $4, $5, $6, $7::jsonb)
         ON CONFLICT (user_id, overlap_pair_low, overlap_pair_high)
           WHERE status IN ('open','provisional') AND overlap_pair_low IS NOT NULL
           DO NOTHING`,
        [
          userId,
          rowProvider,
          pair.low,
          pair.high,
          pair.olderMember,
          escalateAfter,
          JSON.stringify({
            members: [a, b].map((member) => ({
              provider: member.provider,
              identity: member.identity,
              current_period_end:
                member.currentPeriodEnd?.toISOString() ?? null,
              observed_at: member.observedAt.toISOString(),
              purchased_at: member.purchasedAt?.toISOString() ?? null,
            })),
          }),
        ],
      );
    }
  }

  /**
   * The rider's FUTURE-BILLING sources: their chains, plus the persisted
   * Stripe side.
   *
   * The Stripe side is admitted on EVIDENCE — a stored subscription id plus a
   * non-terminal status — never on `subscription_provider`, which is
   * single-valued and cannot answer "who is billing this rider?" once both
   * sides can exist. A non-terminal Stripe status with NO stored id cannot
   * form a pair at all (the identity is half the key), and silently skipping
   * it is the unrecorded double-billing this machinery exists to catch — so it
   * fails loudly instead. The persisted columns cannot represent that state
   * through any current writer; reaching it means the row needs repair.
   */
  private async loadFutureBillingSources(
    tx: EntityManager,
    userId: string,
    stripeCreatedAt: Date | null,
  ): Promise<OverlapMember[]> {
    const now = new Date();
    const fallbackMs = this.fallbackWindowMs();

    const chains = await tx.getRepository(StoreSubscription).find({
      where: { user_id: userId },
    });
    const sources: OverlapMember[] = chains
      .filter((chain) =>
        isFutureBilling(
          {
            terminal: chain.status === 'canceled',
            cancelAtPeriodEnd: chain.cancel_at_period_end,
            currentPeriodEnd: chain.current_period_end,
            observedAt: chain.store_signed_date,
          },
          now,
          fallbackMs,
        ),
      )
      .map((chain) => ({
        provider: chain.provider,
        identity: chain.target_key,
        currentPeriodEnd: chain.current_period_end,
        observedAt: chain.store_signed_date,
        purchasedAt: chain.original_purchase_date,
      }));

    const stripeSide = await tx.getRepository(User).findOne({
      where: { id: userId },
      select: {
        id: true,
        stripe_subscription_id: true,
        subscription_status: true,
        subscription_current_period_end: true,
        subscription_cancel_at_period_end: true,
      },
    });
    if (stripeSide) {
      const stripeFutureBilling = isFutureBilling(
        {
          terminal: stripeSide.subscription_status === 'canceled',
          cancelAtPeriodEnd: stripeSide.subscription_cancel_at_period_end,
          currentPeriodEnd: stripeSide.subscription_current_period_end,
          // The persisted Stripe columns carry no per-observation timestamp;
          // this sync runs at a settle point where the Stripe state was just
          // (re)written or read, so "observed now" is the honest anchor for a
          // null-period fallback.
          observedAt: now,
        },
        now,
        fallbackMs,
      );
      if (stripeFutureBilling && stripeSide.stripe_subscription_id == null) {
        throw new Error(
          `user ${userId} has a future-billing Stripe status with no stripe_subscription_id — ` +
            'an overlap involving it cannot be identified, and skipping it would hide a double-billing; repair the row',
        );
      }
      if (stripeFutureBilling && stripeSide.stripe_subscription_id != null) {
        sources.push({
          provider: 'stripe',
          identity: stripeSide.stripe_subscription_id,
          currentPeriodEnd: stripeSide.subscription_current_period_end,
          observedAt: now,
          purchasedAt: stripeCreatedAt,
        });
      }
    }

    return sources;
  }

  /**
   * The expired-rollup RECOMPUTATION worker — release A item (4)'s "separate
   * obligation", shipped WITH the writers because the accepted under-grant is
   * only acceptable while it is bounded.
   *
   * The resolver ignores the WHOLE store rollup once its expiry passes — a
   * single-valued cache cannot express "the next-best live chain" — so a rider
   * whose Premium chain lapses beside a still-renewing Pro chain falls to
   * their Stripe/grant tier and, without this sweep, STAYS there for as long
   * as no further store event happens to arrive. Each due rider is recomputed
   * under the per-rider lock with a fresh fence, exactly like a claim.
   *
   * Bounded and indexed (`idx_users_store_rollup_expiry`, partial on the tier
   * being present), oldest-expiry first; a no-op on the empty production
   * tables this ships against. Correctness never depends on it — the expiry in
   * the resolver's signature is what stops a lapsed rollup granting — this is
   * the ACCURACY half.
   */
  async recomputeExpiredRollups(
    limit: number,
    now: Date = new Date(),
  ): Promise<RollupSweepResult> {
    const due: Array<{ id: string }> = await this.userRepo
      .createQueryBuilder('u')
      .select('u.id', 'id')
      .where('u.store_subscription_tier IS NOT NULL')
      .andWhere('u.store_subscription_tier_expires_at <= :now', { now })
      .orderBy('u.store_subscription_tier_expires_at', 'ASC')
      .limit(limit)
      .getRawMany();

    let recomputed = 0;
    let failed = 0;
    for (const { id } of due) {
      try {
        await this.subscriptionLock.runExclusive(id, (manager, lease) =>
          manager.transaction((tx) =>
            this.recomputeRollupInTx(tx, id, lease.fenceToken, {
              markTrialUsed: false,
            }),
          ),
        );
        recomputed += 1;
      } catch (err) {
        // One unrecomputable rider must not fail the batch; the row stays in
        // the partial index and the next tick retries it.
        failed += 1;
        this.logger.error(
          `expired-rollup recompute failed for user ${id}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    return { scanned: due.length, recomputed, failed };
  }

  /**
   * The provisional-overlap DEADLINE sweep — the durable, self-firing half of
   * the overlap machinery. The deadline is a prompt to CHECK, never a verdict:
   * promotion on the clock alone would refund a legitimate replacement whose
   * terminal webhook was lost, which is the most likely deadline case.
   *
   * Release A's check is the LOCAL half: a due pair whose members are read
   * against the rider's current future-billing sources, and RETIRED when
   * either member has stopped future billing locally — the lost-terminal
   * replacement retires here, because by `escalate_after` the superseded
   * source has locally expired. A pair whose members BOTH still bill locally
   * needs the authoritative RevenueCat re-query to be promoted, and that
   * client does not exist until step 5 — so it WAITS in `provisional`, which
   * is exactly what the status is for, and is re-examined next tick. Wrongly
   * retiring on a locally-lost renewal is self-healing: the next observation
   * of both sources re-creates the pair (retired rows do not occupy the
   * unique index).
   */
  async sweepDueOverlaps(
    limit: number,
    now: Date = new Date(),
  ): Promise<OverlapSweepResult> {
    const due = await this.reconciliationRepo.find({
      where: { status: 'provisional', escalate_after: LessThanOrEqual(now) },
      order: { escalate_after: 'ASC' },
      take: limit,
    });

    let retired = 0;
    let waiting = 0;
    const futureBillingByUser = new Map<string, Set<string>>();
    for (const row of due) {
      if (row.overlap_pair_low == null || row.overlap_pair_high == null) {
        // Unreachable — `sbr_provisional_pair_required_check` forbids it — but
        // a row this sweep cannot decode must not be silently skipped forever.
        this.logger.error(
          `provisional overlap ${row.id} carries no pair; cannot evaluate`,
        );
        waiting += 1;
        continue;
      }
      let futureBilling = futureBillingByUser.get(row.user_id);
      if (!futureBilling) {
        const sources = await this.loadFutureBillingSources(
          this.userRepo.manager,
          row.user_id,
          null,
        );
        futureBilling = new Set(
          sources.map((source) =>
            encodeOverlapMember(source.provider, source.identity),
          ),
        );
        futureBillingByUser.set(row.user_id, futureBilling);
      }

      if (
        futureBilling.has(row.overlap_pair_low) &&
        futureBilling.has(row.overlap_pair_high)
      ) {
        waiting += 1;
        continue;
      }

      // Guarded on the status so a concurrent claim-path sync retiring the
      // same row is a benign no-op rather than a double write.
      const result = await this.reconciliationRepo.update(
        { id: row.id, status: 'provisional' },
        { status: 'retired', resolved_at: new Date() },
      );
      if ((result.affected ?? 0) > 0) retired += 1;
    }

    if (waiting > 0) {
      this.logger.log(
        `${waiting} provisional overlap(s) past deadline await the step-5 re-query-confirmed promotion`,
      );
    }
    return { scanned: due.length, retired, waiting };
  }

  /**
   * A chain's own liveness, for source-aware notification delivery — the same
   * `isSourceLive` every other reader applies, exported through the service so
   * the config-owned fallback window is read in one place.
   */
  isChainCurrentlyLive(
    chain: Pick<StoreSubscription, 'current_period_end' | 'store_signed_date'>,
    now: Date = new Date(),
  ): boolean {
    return isSourceLive(
      {
        currentPeriodEnd: chain.current_period_end,
        observedAt: chain.store_signed_date,
      },
      now,
      this.fallbackWindowMs(),
    );
  }

  /** {@link isFutureBilling} over a chain row, with the config-owned window. */
  isChainFutureBilling(
    chain: Pick<
      StoreSubscription,
      | 'status'
      | 'cancel_at_period_end'
      | 'current_period_end'
      | 'store_signed_date'
    >,
    now: Date = new Date(),
  ): boolean {
    return isFutureBilling(
      {
        terminal: chain.status === 'canceled',
        cancelAtPeriodEnd: chain.cancel_at_period_end,
        currentPeriodEnd: chain.current_period_end,
        observedAt: chain.store_signed_date,
      },
      now,
      this.fallbackWindowMs(),
    );
  }
}

/**
 * Detects a Postgres unique-constraint violation (SQLSTATE `23505`). TypeORM
 * wraps the driver error in a `QueryFailedError` whose `driverError.code`
 * holds the SQLSTATE; some paths surface it directly as `err.code`. Mirrors
 * the helper in `provider-claim.service.ts`.
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
