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
  FUTURE_BILLING_CHAIN_SQL,
  LIVE_CHAIN_SQL,
  isFutureBilling,
  isSourceLive,
  liveChainParams,
  overlapFallbackWindowMs,
  overlapGraceMs,
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
  /** The caller's knowledge of the Stripe side — see {@link StripeOverlapSide}. */
  stripe?: StripeOverlapSide | null;
}

/**
 * What a caller knows about ONE Stripe subscription, for overlap membership —
 * id and creation time BOUND TOGETHER, because they describe the same record
 * or they describe nothing.
 *
 * The Stripe webhook path reads both off the event (`subscription.id` /
 * `subscription.created`); a snapshot-driven caller reads both off the
 * SELECTED plan (`StripeBillingSnapshot.currentPlan.id` / `.created` — the
 * item-8 fields, which exist for exactly this). Passing them separately
 * invited the mismatch the refund role cannot survive: a delayed terminal for
 * a superseded subscription carries the OLD record's `created` while the
 * rider's row names the NEW one, and a pair built from the two writes a
 * confidently wrong `overlap_older_member` that `ON CONFLICT` never corrects.
 * {@link StoreChainWriterService.loadFutureBillingSources} therefore uses
 * `createdAt` only when this id IS the identity it emits, and records the
 * ambiguity sentinel otherwise.
 *
 * `terminal` is REQUIRED so a settle point can never forget to state what
 * kind of observation it is delivering. A terminal event is an observation
 * that the named subscription has ENDED — not a fresh sighting of it alive.
 * The distinction cannot be recovered from the persisted row in the one shape
 * where it matters: a terminal ending a grant-preserving OWNERLESS checkout
 * (`clearStripeTerminal` deliberately matches zero rows there, so the
 * normalized non-terminal status persists with a null id). Treating the
 * event's id as ordinary evidence then made a KNOWN-DEAD subscription
 * future-billing — advancing its observation stamp and holding a false
 * overlap against any live chain for a full fallback window (round-5
 * review). Bound by the same identity rule as everything else here: the flag
 * speaks only for the subscription this record names.
 */
export interface StripeOverlapSide {
  subscriptionId: string;
  createdAt: Date | null;
  /** This record reports the named subscription ENDED (deletion event, or a
   *  raw terminal-class status), not an observation of it billing. A terminal
   *  record's id is never ADOPTED as the tracked identity for a
   *  null-stored-id rider — it names only what ended, and any OTHER
   *  previously-recorded Stripe identity stays indeterminate on this
   *  evidence (round-6 review). */
  terminal: boolean;
}

/**
 * - `claimed` — the chain row was written and the rollup + overlap state now
 *   reflect it.
 * - `stale` — the rider already holds a NEWER observation of this chain
 *   (`store_signed_date` ordering guard); an idempotent no-op, never a
 *   conflict. Per-chain on purpose: an event for chain B can no longer advance
 *   the value a later-but-valid event for chain A is checked against.
 * - `ownership_conflict` — the identity belongs to a DIFFERENT rider
 *   (`uq_ss_provider_target_key` / `uq_ss_provider_original_txn`, confirmed by
 *   a post-abort read of who holds the row — a same-rider duplicate insert
 *   under a lost lease raises the same 23505 and is classified `stale`/503
 *   instead), and NOTHING was mutated (the transaction rolled back). The
 *   caller must not open an `exclusivity_conflict` reconciliation carrying
 *   another rider's identity — that routes someone else's purchase into the
 *   refund workflow.
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
  /** Riders whose locked evaluation errored; their rows stay due for the next tick. */
  failed: number;
}

/** One reading of a rider's sources, plus what that reading could NOT decide. */
interface FutureBillingRead {
  sources: OverlapMember[];
  /**
   * The persisted Stripe status is non-terminal but NO identity could be
   * resolved (null column, no caller-supplied id). A `stripe:` pair member
   * absent from {@link sources} is then INDETERMINATE, not stopped: retiring
   * on it would drop tracking of a subscription this reading simply could not
   * see — the legacy customer-only shape, or the grant-preserving unclaimed
   * one — so retirement treats such members as still billing and the pair
   * waits for a reading that can decide (a settle point with the event id, or
   * step 5's snapshot-driven re-query).
   */
  stripeIndeterminate: boolean;
  /**
   * The encoded `stripe:` member a TERMINAL record affirmatively ended, when
   * the reading carried one — retirable even while the rest of the Stripe
   * side is {@link stripeIndeterminate}. A terminal record's id is never
   * ADOPTED as the tracked identity (round-6 review): for a null-stored-id
   * rider it names only what ended, and letting it stand in for the whole
   * side made a delayed terminal for subscription C retire the `stripe:A`
   * pair an earlier snapshot recorded — dropping tracking of two sources
   * that both still bill. Null when the reading carried no terminal record.
   */
  stripeTerminalMember: string | null;
  /**
   * This reading carried a Stripe record whose subscription id IS the
   * identity being tracked — a genuine observation of that subscription, to
   * be persisted (monotonically) into `users.subscription_stripe_observed_at`
   * by the enclosing sync. The same predicate gates the in-flight "observed
   * now" liveness anchor and the `purchasedAt` chronology: false for
   * non-observing readings AND for the mismatched-record case (a delayed
   * event for a SUPERSEDED subscription must not vouch for the current one's
   * liveness — re-arming its fallback window — exactly as it must not donate
   * its `createdAt` to the refund role).
   */
  stampStripeObservation: boolean;
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

  /** The bounded null-period window — the ONE reading, owned by `store-chain-liveness.ts`. */
  private fallbackWindowMs(): number {
    return overlapFallbackWindowMs(this.config);
  }

  /** Grace beyond a period boundary before a provisional overlap is due. */
  private graceMs(): number {
    return overlapGraceMs(this.config);
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
        await this.syncOverlapsInTx(tx, input.userId, input.stripe ?? null);
        return 'claimed';
      });
    } catch (err) {
      if (err instanceof StoreChainOwnershipConflictError) {
        // A 23505 on the GLOBAL `(provider, target_key)` index is not yet a
        // verdict: a SAME-RIDER duplicate insert raises the identical code
        // when this flow's lease lapsed and a newer acquisition inserted the
        // row between our existence read and our INSERT. Classifying that as
        // `ownership_conflict` hands step 5 the wrong contract on the money
        // path ("belongs to a DIFFERENT rider" routes into the refund
        // workflow). The transaction is already aborted (25P02), so the
        // disambiguating read runs on the BASE manager: our own rider holding
        // the row is the fence-stale race — surfaced exactly like every other
        // guarded write (retryable 503 when a newer holder advanced past us,
        // benign `stale` otherwise, which the reversed interleaving already
        // yields via the 0-row UPDATE path).
        //
        // One read by `target_key` covers the secondary index too: a row
        // hitting `uq_ss_provider_original_txn` under a DIFFERENT target_key
        // would need `original_transaction_id <> target_key` on an identified
        // row, which `ss_staged_key_check` forbids.
        const owner = await base.getRepository(StoreSubscription).findOne({
          where: { provider: input.provider, target_key: targetKey },
          select: { id: true, user_id: true },
        });
        if (owner?.user_id === input.userId) {
          await assertSubscriptionFenceCurrent(
            base.getRepository(User),
            input.userId,
            input.fenceToken,
          );
          return 'stale';
        }
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
      // A unique violation on (provider, target_key) / (provider,
      // original_transaction_id): USUALLY the cross-rider protection doing its
      // job — but a same-rider concurrent insert under a lost lease raises the
      // identical 23505, so the marker is disambiguated in `applyChainState`'s
      // catch, on a live manager (this transaction is aborted from here on).
      // Deliberately NARROW: any other error (a 23514 constraint failure, a
      // driver fault) must propagate, never be dressed up as a conflict.
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
    stripe: StripeOverlapSide | null = null,
  ): Promise<void> {
    await manager.transaction(async (tx) => {
      await this.syncOverlapsInTx(tx, userId, stripe);
    });
  }

  /**
   * Creation and retirement, from ONE reading of the rider's sources — the
   * design's rule is that the two must test the same `futureBilling` predicate
   * or rows appear that nothing can clear.
   *
   *  - CREATE a `provisional` row for every unordered pair of future-billing
   *    sources that lacks an unresolved one. `ON CONFLICT` against
   *    `uq_sbr_unresolved_overlap_pair` makes redelivery idempotent (a
   *    still-provisional row has only its DEADLINE refreshed; an `open` row —
   *    promotion mutates only `reason`/`status`, never the pair — is left
   *    untouched entirely).
   *  - RETIRE, silently, every provisional row naming a member that has
   *    affirmatively stopped future billing. Not `open` rows: those are
   *    operator items, and the deadline path's re-query (step 5) is what
   *    retires or resolves them.
   *
   * A provisional row is deliberately NOT an operator item; findOpen selects
   * `status = 'open'` only, so nothing here surfaces in the ops drain.
   */
  private async syncOverlapsInTx(
    tx: EntityManager,
    userId: string,
    stripe: StripeOverlapSide | null,
  ): Promise<void> {
    // Serialize this read-and-write against every OTHER writer for the rider
    // before anything is read. The per-rider lease alone cannot carry that
    // guarantee: a holder whose lease lapsed mid-section can commit a sync
    // computed from a read that predates a newer holder's — re-creating an
    // overlap the newer cancellation retired, or retiring one the newer
    // reactivation refreshed. Chain writes reject such staleness on the users
    // fence; the reconciliation writes have no fence, so they take the users
    // ROW lock instead: any concurrent sync or chain write (the rollup writes
    // this row in the same transaction as its chain upsert) serializes here,
    // and whichever sync runs second re-reads COMMITTED state — a late
    // lost-lease sync becomes a redundant correct write, never a stale one.
    // Lock ordering stays acyclic: chain writers take chain row → users row,
    // this path takes users row and only ever SELECTs chains.
    await tx.query(`SELECT id FROM users WHERE id = $1 FOR UPDATE`, [userId]);

    const read = await this.loadFutureBillingSources(tx, userId, stripe);
    const { sources } = read;
    const encoded = sources.map((source) =>
      encodeOverlapMember(source.provider, source.identity),
    );

    if (read.stampStripeObservation) {
      // This reading IS a Stripe observation of the tracked subscription:
      // persist the anchor every NON-observing reading (store settle points,
      // the deadline sweep) measures the null-period fallback window from.
      // `GREATEST` keeps it monotonic under out-of-order webhook deliveries;
      // an unconditional single-column write, so no fence is needed — see the
      // column's doc on `User` and migration 1838 for the full rationale.
      await tx.query(
        `UPDATE users
            SET subscription_stripe_observed_at =
                  GREATEST(coalesce(subscription_stripe_observed_at, '-infinity'::timestamptz), now())
          WHERE id = $1`,
        [userId],
      );
    }

    // Retirement FIRST, so a pair both created and invalidated by one event's
    // state cannot be inserted and immediately retired in the same pass.
    //
    // A member is retired-on only when it is AFFIRMATIVELY stopped: absent
    // from the future-billing set, and — for a `stripe:` member while this
    // reading could not resolve a Stripe identity at all
    // (`stripeIndeterminate`) — not merely unseeable. Without that guard,
    // every chain event for a legacy customer-only rider would retire the
    // very Stripe pair a snapshot-driven observation recorded. `$3 = false`
    // reduces this to the plain both-members-billing predicate. One carve-out
    // pierces the guard (round-6 review): the member a TERMINAL record
    // affirmatively ended (`$4`) is retirable even while the rest of the
    // Stripe side is indeterminate — the reading DOES know that one
    // subscription stopped, and only that one. `resolution` is stamped
    // `purchase_inactive` — migration 1834's "the purchase has expired
    // upstream" outcome — so an operator can tell these from legacy unset
    // rows; a per-path vocabulary would need a migration and is left with
    // step 5 if wanted.
    await tx.query(
      `UPDATE store_billing_reconciliations
          SET status = 'retired', resolution = 'purchase_inactive',
              resolved_at = now()
        WHERE user_id = $1
          AND status = 'provisional'
          AND (
            (NOT (overlap_pair_low = ANY($2::text[]))
             AND (NOT $3::boolean
                  OR overlap_pair_low NOT LIKE 'stripe:%'
                  OR overlap_pair_low = $4))
            OR
            (NOT (overlap_pair_high = ANY($2::text[]))
             AND (NOT $3::boolean
                  OR overlap_pair_high NOT LIKE 'stripe:%'
                  OR overlap_pair_high = $4))
          )`,
      [userId, encoded, read.stripeIndeterminate, read.stripeTerminalMember],
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
      // `DO UPDATE` refreshes ONLY the deadline of a still-provisional row:
      // the design defines `escalate_after` as min(effective ends) + grace,
      // and a renewal advances a member's end — `DO NOTHING` would freeze the
      // deadline at creation, leaving a permanently-due row that monopolises
      // the sweep's bounded batch. Creation-time facts (the refund role, the
      // member detail) are deliberately NOT refreshed — the role is a
      // creation-time fact by design — and an `open` row (an operator item)
      // is left untouched by the `WHERE`.
      await tx.query(
        `INSERT INTO store_billing_reconciliations
           (user_id, provider, reason, status,
            overlap_pair_low, overlap_pair_high, overlap_older_member,
            escalate_after, detail)
         VALUES ($1, $2, 'provisional_overlap', 'provisional', $3, $4, $5, $6, $7::jsonb)
         ON CONFLICT (user_id, overlap_pair_low, overlap_pair_high)
           WHERE status IN ('open','provisional') AND overlap_pair_low IS NOT NULL
           DO UPDATE SET escalate_after = EXCLUDED.escalate_after
           WHERE store_billing_reconciliations.status = 'provisional'`,
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
   * The rider's FUTURE-BILLING sources: their chains (filtered in SQL — a
   * rider accumulates one row per chain over their lifetime, and this runs on
   * every Stripe webhook), plus the Stripe side.
   *
   * The Stripe member's IDENTITY is the persisted `stripe_subscription_id`,
   * falling back to the caller-supplied {@link StripeOverlapSide} when the
   * column is null. The fallback is what the design's coverage list demands —
   * "a customer-only Stripe rider whose entitling subscription is discovered
   * from the customer can still form a pair with a store chain: the selected
   * id reaches the encoding" — and item (8)'s snapshot fields exist to supply
   * it. Never `subscription_provider`, which is single-valued and cannot
   * answer "who is billing this rider?" once both sides can exist.
   *
   * The member's `purchasedAt` is taken from the caller's record ONLY when its
   * id IS the identity emitted: id and created describe one subscription or
   * they describe nothing, and a delayed terminal for a superseded
   * subscription otherwise attaches the OLD record's `created` to the NEW
   * identity — a confidently wrong refund role that `ON CONFLICT` never
   * corrects. On a mismatch the role falls to NULL, the documented ambiguity
   * sentinel.
   *
   * A non-terminal status with NO resolvable identity does not throw — it is
   * flagged {@link FutureBillingRead.stripeIndeterminate}. The shape is
   * deliberately writable today: `AccountService` persists a never-entitling
   * checkout's `past_due` status onto a founder/promo/admin grant rider with
   * `skipOwnership`, leaving the id null precisely so the failed checkout can
   * never revoke the grant. Throwing failed every delivery of that Stripe
   * event into an indefinite retry loop; where the gap could actually have
   * suppressed a pair (chains exist to pair with), it is logged.
   */
  private async loadFutureBillingSources(
    tx: EntityManager,
    userId: string,
    stripe: StripeOverlapSide | null,
  ): Promise<FutureBillingRead> {
    const now = new Date();
    const fallbackMs = this.fallbackWindowMs();

    const chains = await tx
      .getRepository(StoreSubscription)
      .createQueryBuilder('chain')
      .where('chain.user_id = :userId', { userId })
      .andWhere(
        FUTURE_BILLING_CHAIN_SQL('chain'),
        liveChainParams(now, fallbackMs),
      )
      .getMany();
    const sources: OverlapMember[] = chains.map((chain) => ({
      provider: chain.provider,
      identity: chain.target_key,
      currentPeriodEnd: chain.current_period_end,
      observedAt: chain.store_signed_date,
      purchasedAt: chain.original_purchase_date,
    }));

    let stripeIndeterminate = false;
    let stampStripeObservation = false;
    // A terminal record affirmatively ends the subscription it NAMES, whether
    // or not that subscription is the tracked identity — recorded here so the
    // retirement predicate can act on exactly that knowledge and nothing more.
    const stripeTerminalMember =
      stripe != null && stripe.terminal
        ? encodeOverlapMember('stripe', stripe.subscriptionId)
        : null;
    const stripeSide = await tx.getRepository(User).findOne({
      where: { id: userId },
      select: {
        id: true,
        stripe_subscription_id: true,
        subscription_status: true,
        subscription_current_period_end: true,
        subscription_cancel_at_period_end: true,
        subscription_stripe_observed_at: true,
        updated_at: true,
      },
    });
    if (stripeSide) {
      // Identity resolution: the persisted column, else a LIVE supplied
      // record. A TERMINAL record's id is never adopted (round-6 review): it
      // names only what ended, and adopting it would let its terminal flag
      // speak for the WHOLE Stripe side — a delayed terminal for C would then
      // retire the `stripe:A` pair an earlier snapshot recorded, dropping two
      // still-billing sources. With no adoption, a null-stored-id rider's
      // side is judged exactly like a no-record reading (indeterminate while
      // the row is future-billing), while `stripeTerminalMember` above
      // carries the one affirmative fact for targeted retirement.
      const identity =
        stripeSide.stripe_subscription_id ??
        (stripe != null && !stripe.terminal ? stripe.subscriptionId : null);
      // ONE binding predicate for every per-subscription use of the supplied
      // record: it vouches only for the subscription it names. A delayed
      // event for a SUPERSEDED subscription arrives with `stripe != null`,
      // but it observed THAT subscription — letting it anchor the TRACKED
      // one's liveness at "now" would re-arm an already-aged-out null-period
      // side for another full window (and letting it donate `createdAt`
      // would forge the refund role). So: matched record → this reading IS
      // an observation of the tracked subscription ("now" is honest, and the
      // sync persists it); anything else — a store settle point, the
      // deadline sweep, a mismatched record — anchors to the persisted
      // stamp. Rows predating migration 1838 fall back to `updated_at`, an
      // overestimate that errs toward keeping a subscription live, never
      // toward retiring one.
      const stripeObservedNow =
        stripe != null &&
        identity != null &&
        stripe.subscriptionId === identity;
      // A terminal record for the tracked identity is an observation that the
      // subscription ENDED. It overrides the persisted status in the one
      // shape where that status lies — a terminal ending a grant-preserving
      // OWNERLESS checkout leaves the zero-row-cleared `past_due` behind —
      // and it contributes NO liveness: the stamp and the "now" anchor
      // measure when the side was last seen BILLING, so a terminal reading
      // advances neither (round-5 review; treating the event's id as fresh
      // billing evidence held a false overlap open for a full window).
      const stripeEventTerminal =
        stripe != null && stripeObservedNow && stripe.terminal;
      stampStripeObservation = stripeObservedNow && !stripeEventTerminal;
      const stripeObservedAt = stampStripeObservation
        ? now
        : (stripeSide.subscription_stripe_observed_at ?? stripeSide.updated_at);
      const stripeFutureBilling = isFutureBilling(
        {
          terminal:
            stripeSide.subscription_status === 'canceled' ||
            stripeEventTerminal,
          cancelAtPeriodEnd: stripeSide.subscription_cancel_at_period_end,
          currentPeriodEnd: stripeSide.subscription_current_period_end,
          observedAt: stripeObservedAt,
        },
        now,
        fallbackMs,
      );
      if (stripeFutureBilling && identity != null) {
        sources.push({
          provider: 'stripe',
          identity,
          currentPeriodEnd: stripeSide.subscription_current_period_end,
          observedAt: stripeObservedAt,
          // Bound to the identity, or nothing — see the binding rule above.
          purchasedAt:
            stripe != null && stripeObservedNow ? stripe.createdAt : null,
        });
      } else if (stripeFutureBilling) {
        stripeIndeterminate = true;
        if (sources.length > 0) {
          this.logger.warn(
            `user ${userId} has a non-terminal Stripe status with no resolvable subscription id ` +
              `beside ${sources.length} future-billing chain(s); no Stripe overlap member recorded ` +
              'and stripe-side retirement is suspended for this reading (see loadFutureBillingSources)',
          );
        }
      }
    }

    return {
      sources,
      stripeIndeterminate,
      stampStripeObservation,
      stripeTerminalMember,
    };
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
   * is exactly what the status is for, and is re-examined next tick.
   *
   * ## Why the check-and-retire runs under the PER-RIDER LOCK
   *
   * Evaluated outside it, the sweep races the chain writers in the one
   * direction retirement cannot heal from: the sweep reads a member as
   * non-billing, a concurrent claim REACTIVATES that member and runs its own
   * overlap sync — which finds the still-provisional row and inserts nothing
   * (`ON CONFLICT`) — and the sweep's guarded UPDATE then retires it. Both
   * sources are future-billing with NO unresolved overlap, and since the
   * writer's sync already ran, no later event is guaranteed to re-create the
   * pair. Taking the same lock the chain writers hold makes the interleaving
   * impossible: a reactivation either commits before the sweep's locked
   * section — and its state is seen by the re-read inside it — or after, and
   * its own sync finds the retired row out of the unique index and re-creates
   * the pair.
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

    // One locked section per RIDER, not per row: their due rows are judged
    // against one under-lock reading of their sources.
    const dueByUser = new Map<string, StoreBillingReconciliation[]>();
    for (const row of due) {
      const rows = dueByUser.get(row.user_id) ?? [];
      rows.push(row);
      dueByUser.set(row.user_id, rows);
    }

    let retired = 0;
    let waiting = 0;
    let failed = 0;
    for (const [userId, rows] of dueByUser) {
      try {
        const outcome = await this.subscriptionLock.runExclusive(
          userId,
          async (manager) =>
            // ONE transaction per rider, opened on the users ROW lock — the
            // lease alone cannot serialize this section's read against its
            // writes (round-5 review, the `syncOverlapsInTx` argument
            // verbatim): if the lease lapses after the re-read, a newer chain
            // writer can reactivate a member and its sync keep the pair, and
            // this stale section's status-guarded retirement would still
            // match — retiring a pair whose members BOTH bill, with no
            // guaranteed event to re-create it. Plain reads do not block on
            // row locks, so the guarantee must come from taking the SAME lock
            // every writer holds: whichever side runs second re-reads
            // committed state. Lock order stays users → sbr in every path.
            manager.transaction(async (tx) => {
              await tx.query(`SELECT id FROM users WHERE id = $1 FOR UPDATE`, [
                userId,
              ]);
              // Re-read INSIDE the locked transaction — the rows and the
              // sources a pre-lock read produced can both be stale by the
              // time the lock is acquired (see the class of race in the
              // method doc).
              const read = await this.loadFutureBillingSources(
                tx,
                userId,
                null,
              );
              const bySource = new Map(
                read.sources.map((source) => [
                  encodeOverlapMember(source.provider, source.identity),
                  source,
                ]),
              );
              // A member is retired-on only when AFFIRMATIVELY stopped:
              // absent from the future-billing set, and not a `stripe:`
              // member this reading could not resolve an identity for (the
              // sweep supplies no event id, so a legacy customer-only Stripe
              // side is unseeable here — indeterminate, never "stopped").
              const memberStopped = (member: string): boolean =>
                !bySource.has(member) &&
                (!read.stripeIndeterminate || !member.startsWith('stripe:'));

              let riderRetired = 0;
              let riderWaiting = 0;
              for (const row of rows) {
                if (
                  row.overlap_pair_low == null ||
                  row.overlap_pair_high == null
                ) {
                  // Unreachable — `sbr_provisional_pair_required_check`
                  // forbids it — but a row this sweep cannot decode must not
                  // be silently skipped forever.
                  this.logger.error(
                    `provisional overlap ${row.id} carries no pair; cannot evaluate`,
                  );
                  riderWaiting += 1;
                  continue;
                }
                if (
                  !memberStopped(row.overlap_pair_low) &&
                  !memberStopped(row.overlap_pair_high)
                ) {
                  // Cannot be decided locally — the step-5 re-query's case.
                  // The deadline is pushed to the CURRENT pair deadline so an
                  // undecidable row yields its slot in the bounded,
                  // oldest-first batch: left frozen in the past it would be
                  // re-selected ahead of every newer due row, and ~50 such
                  // rows would starve the sweep's one release-A job (retiring
                  // lost-terminal replacements) permanently. A member this
                  // reading cannot see contributes the bounded fallback,
                  // exactly as an unknown period does everywhere else.
                  const nextDeadline = computeEscalateAfter(
                    [
                      this.memberForDeadline(
                        row.overlap_pair_low,
                        bySource,
                        now,
                      ),
                      this.memberForDeadline(
                        row.overlap_pair_high,
                        bySource,
                        now,
                      ),
                    ],
                    this.fallbackWindowMs(),
                    this.graceMs(),
                  );
                  await tx
                    .getRepository(StoreBillingReconciliation)
                    .update(
                      { id: row.id, status: 'provisional' },
                      { escalate_after: nextDeadline },
                    );
                  riderWaiting += 1;
                  continue;
                }
                // Guarded on the status so a writer's own sync retiring the
                // same row (before this lock was acquired) is a benign no-op
                // rather than a double write. Same resolution stamp as the
                // sync's retirement — see `syncOverlapsInTx`.
                const result = await tx
                  .getRepository(StoreBillingReconciliation)
                  .update(
                    { id: row.id, status: 'provisional' },
                    {
                      status: 'retired',
                      resolution: 'purchase_inactive',
                      resolved_at: new Date(),
                    },
                  );
                if ((result.affected ?? 0) > 0) riderRetired += 1;
              }
              return { riderRetired, riderWaiting };
            }),
        );
        retired += outcome.riderRetired;
        waiting += outcome.riderWaiting;
      } catch (err) {
        // One uninspectable rider (lock contention, Redis unavailable) must
        // not fail the batch — mirroring `recomputeExpiredRollups` — and must
        // never fail the whole hourly processor; their rows stay due for the
        // next tick.
        failed += 1;
        this.logger.error(
          `overlap deadline sweep failed for user ${userId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    if (waiting > 0) {
      this.logger.log(
        `${waiting} provisional overlap(s) past deadline await the step-5 re-query-confirmed promotion`,
      );
    }
    return { scanned: due.length, retired, waiting, failed };
  }

  /**
   * The effective-deadline input for one pair member during a sweep refresh:
   * the member's own current state where this reading resolved it, otherwise a
   * synthetic null-period source observed now — which contributes the bounded
   * fallback window, the same substitution every null period gets.
   */
  private memberForDeadline(
    encoded: string,
    bySource: ReadonlyMap<string, OverlapMember>,
    now: Date,
  ): OverlapMember {
    return (
      bySource.get(encoded) ?? {
        provider: 'stripe',
        identity: encoded,
        currentPeriodEnd: null,
        observedAt: now,
        purchasedAt: null,
      }
    );
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
