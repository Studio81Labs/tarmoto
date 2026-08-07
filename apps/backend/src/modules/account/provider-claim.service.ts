import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, MoreThan, Repository } from 'typeorm';
import type {
  PlanSource,
  SubscriptionProvider,
  SubscriptionTier,
} from '@tarmoto/shared';
import { User } from '../../entities/user.entity.js';

/**
 * Shared FENCE-STALE guard for a 0-row guarded subscription UPDATE. Every guarded
 * write carries `subscription_lock_fence <= :fenceToken`, so a 0-row result has
 * two very different causes: a genuine BUSINESS rejection (ownership/identity/
 * signedDate/status guard), or this flow's FENCE being stale — a NEWER lock
 * holder advanced `subscription_lock_fence` past our token (its lease was handed
 * off while ours ran, possibly via a no-op that changed nothing else). The
 * business classifiers must NOT run on the second cause: they'd emit a wrong
 * verdict (a false exclusivity conflict / 409, an acknowledged-but-unapplied
 * terminal deletion, a spurious reconciliation). Call this right after a 0-row
 * guarded UPDATE, BEFORE any business classification: it re-reads the row's fence
 * and, if a newer holder is ahead of us, throws a retryable 503 so a fresh,
 * non-stale flow re-decides (the client / Stripe redelivery retries). A missing
 * row is not our concern here (a deleted rider) — the caller's own logic handles
 * that. `fence > token` can only happen if our lease was lost (only the lock
 * holder ever publishes a fence), so this cannot false-positive on a live holder.
 */
export async function assertSubscriptionFenceCurrent(
  repo: Repository<User>,
  userId: string,
  fenceToken: number,
): Promise<void> {
  // `existsBy` (not `findOne`) so this fresh check never disturbs a caller's
  // `findOne` sequencing, and reads only a boolean. True iff the rider's row
  // carries a fence STRICTLY GREATER than ours — i.e. a newer holder is ahead.
  const stale = await repo.existsBy({
    id: userId,
    subscription_lock_fence: MoreThan(fenceToken),
  });
  if (stale) {
    throw new ServiceUnavailableException({
      message: 'Subscription service is busy. Please retry shortly.',
      retryable: true,
    });
  }
}

export interface StripeClaimFields {
  tier: SubscriptionTier;
  status: 'active' | 'trialing' | 'past_due' | 'canceled';
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  planSource: PlanSource | null;
  /**
   * The per-acquisition fencing token from the subscription-mutation lock
   * ({@link SubscriptionLockLease.fenceToken}). Stamped on the row and used as a
   * `subscription_lock_fence <= :token` guard so a flow whose lease was lost
   * mid-section can't clobber/resurrect a newer flow's state.
   */
  fenceToken: number;
}

export interface AppleClaimFields {
  tier: SubscriptionTier;
  status: 'active' | 'trialing' | 'past_due' | 'canceled';
  currentPeriodEnd: Date | null;
  /**
   * The authoritative transaction's JWS `signedDate` — a strictly-monotonic
   * optimistic-concurrency ordering value (Apple stamps each issued state, so a
   * later state has a strictly greater `signedDate`). Written to
   * `subscription_store_signed_date` AND used as the ordering key of the guarded
   * UPDATE so an older Apple snapshot cannot regress a newer committed one.
   */
  signedDate: Date;
  cancelAtPeriodEnd: boolean;
  /**
   * When true, the SAME guarded UPDATE that claims the row also stamps the
   * once-per-rider trial marker via `billing_trial_used_at = COALESCE(
   * billing_trial_used_at, NOW())`. `COALESCE` preserves an already-set stamp,
   * so this is idempotent and never overwrites an earlier trial timestamp.
   * Folding it into the claim makes the tier grant and the trial stamp a single
   * atomic write — a separate post-claim stamp could fail and leave the rider
   * entitled while still eligible for another trial.
   */
  markTrialUsed?: boolean;
  /**
   * COMPARE-AND-SWAP baseline for Branch A (Finding 1, round 25): the
   * `(subscription_provider, apple_original_transaction_id,
   * subscription_store_signed_date)` the SERVICE observed at its initial read of
   * the row (before the Apple re-query). Branch A replaces an UNOWNED slot across
   * UNRELATED lineages (this otid vs a retained tombstone for a DIFFERENT otid),
   * so a cross-lineage `signedDate` comparison is meaningless. Instead Branch A
   * requires the row to STILL match this observed version (`IS NOT DISTINCT FROM`
   * on all three, NULL-safe), so it replaces only when nothing changed the slot
   * since the read. A concurrent write since the read fails the CAS → the claim
   * affects 0 rows → classified `'stale'` so the caller re-validates. Branch B
   * (same-otid) is unaffected and keeps its monotonic `signedDate` ordering.
   */
  observedProvider: SubscriptionProvider | null;
  observedOriginalTransactionId: string | null;
  observedSignedDate: Date | null;
  /**
   * The per-acquisition fencing token from the subscription-mutation lock
   * ({@link SubscriptionLockLease.fenceToken}). Stamped on the row and used as a
   * `subscription_lock_fence <= :token` guard so a flow whose lease was lost
   * mid-section can't clobber/resurrect a newer flow's state.
   */
  fenceToken: number;
}

export interface GoogleClaimFields {
  tier: SubscriptionTier;
  status: 'active' | 'trialing' | 'past_due' | 'canceled';
  currentPeriodEnd: Date | null;
  /**
   * Ordering key, written to `subscription_store_signed_date`. This is
   * RevenueCat's `request_date_ms` from the authoritative subscriber re-query.
   *
   * NOTE the semantics differ from Apple's `signedDate`, which versions the
   * STATE. `request_date_ms` versions the READ: it says when we asked, not when
   * the subscription last changed. The `<=` guard therefore orders two
   * concurrent consumers correctly (a read that started earlier cannot overwrite
   * what a later read already committed) but carries NO claim that the state it
   * carries is newer. Correctness rests on the consumer always applying freshly
   * re-queried authoritative state under the per-rider lock — see spec §4 step 3.
   */
  observedAt: Date;
  cancelAtPeriodEnd: boolean;
  /**
   * Folds `billing_trial_used_at = COALESCE(billing_trial_used_at, NOW())` into
   * the SAME guarded UPDATE that grants the tier, so the grant and the
   * once-per-rider trial stamp commit atomically. `COALESCE` preserves an
   * already-set stamp, so this is idempotent and never re-dates an earlier trial.
   */
  markTrialUsed?: boolean;
  /** Per-acquisition fencing token from the subscription-mutation lock. */
  fenceToken: number;
}

/**
 * Centralises the guarded, single-statement UPDATEs that make a billing
 * provider's ownership of a `users` row race-safe, across every provider
 * (Stripe, Apple, and Google once wired) that can claim the rider's single
 * cross-provider-exclusive subscription slot.
 *
 * All operations follow the conditional-claim pattern already used in
 * `AccountService` (see the activation/past_due transitions around
 * `account.service.ts:304-336`): a single UPDATE with the ownership/identity
 * check baked into the WHERE clause, so concurrent or out-of-order webhook
 * deliveries resolve via Postgres row-level locking instead of an
 * in-memory read-then-write race.
 */
@Injectable()
export class ProviderClaimService {
  constructor(
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
  ) {}

  /**
   * Resolves the `User` repository to use. When a caller passes the
   * `EntityManager` of the per-rider subscription-mutation lock's reserved
   * connection (see `SubscriptionMutationLockService`), the guarded UPDATE runs
   * on THAT connection so the lock winner needs no extra pool connection;
   * otherwise it uses the injected pool-backed repo (unchanged behaviour for
   * non-serialised callers).
   */
  private repoFor(manager?: EntityManager): Repository<User> {
    return manager ? manager.getRepository(User) : this.userRepo;
  }

  /**
   * Atomically claims (or re-confirms) Stripe ownership of a user's
   * subscription row. The WHERE clause only allows the write when the
   * row is unclaimed by another provider (`subscription_provider IS
   * NULL OR = 'stripe'`) and the stored subscription id is either unset
   * or already matches the incoming one — so a Stripe event can never
   * clobber an Apple/Google-owned row, and a stale event for a
   * different Stripe subscription id loses the race instead of
   * overwriting the current one.
   *
   * Returns `'claimed'` when the guard passed and the row was updated,
   * `'conflict'` otherwise (caller should skip dependent side effects).
   *
   * `options.skipStatus` omits the `subscription_status` write. The caller
   * passes it when an activation/past_due transition UPDATE already owns the
   * status for this event (it ran and either won or found the row already at
   * target): re-stamping the status here could clobber a NEWER, concurrently
   * committed status for the same subscription. The ownership/identity guard
   * and the mutable-field refresh (tier, period end, cancel flag, plan source)
   * still run, so conflict detection is unaffected.
   *
   * `options.skipOwnership` omits the `subscription_provider` /
   * `stripe_subscription_id` writes — the row is refreshed but the Stripe slot
   * is NOT taken. The caller passes it for a subscription that has never
   * entitled the rider landing on a founder/promo/admin grant: recording that
   * subscription as the row's owner would arm `clearStripeTerminal` (whose
   * guard is `subscription_provider = 'stripe'` AND the stored id) to wipe the
   * grant when the dead checkout later expires or is deleted. The WHERE clause
   * is deliberately untouched, so the exclusivity guard still rejects an
   * Apple/Google-owned row or a different subscription id and conflict
   * detection is unaffected.
   */
  async claimForStripe(
    userId: string,
    subscriptionId: string,
    fields: StripeClaimFields,
    options?: {
      skipStatus?: boolean;
      skipOwnership?: boolean;
      manager?: EntityManager;
    },
  ): Promise<'claimed' | 'conflict'> {
    const result = await this.repoFor(options?.manager)
      .createQueryBuilder()
      .update(User)
      .set({
        ...(options?.skipOwnership
          ? {}
          : {
              subscription_provider: 'stripe' as const,
              stripe_subscription_id: subscriptionId,
            }),
        subscription_tier: fields.tier,
        ...(options?.skipStatus ? {} : { subscription_status: fields.status }),
        subscription_current_period_end: fields.currentPeriodEnd,
        subscription_cancel_at_period_end: fields.cancelAtPeriodEnd,
        plan_source: fields.planSource,
        subscription_lock_fence: fields.fenceToken,
      })
      .where('id = :id', { id: userId })
      .andWhere(
        "(subscription_provider IS NULL OR subscription_provider = 'stripe')",
      )
      .andWhere(
        '(stripe_subscription_id IS NULL OR stripe_subscription_id = :sub)',
        { sub: subscriptionId },
      )
      // Fence: reject if a NEWER lock acquisition (higher token) already wrote
      // this row — a lease-lost stale flow can't clobber the newer state.
      .andWhere('subscription_lock_fence <= :fence', {
        fence: fields.fenceToken,
      })
      .execute();

    if ((result.affected ?? 0) > 0) return 'claimed';
    // 0 rows: distinguish a genuine exclusivity conflict from a STALE FENCE (a
    // newer holder advanced past us) — the latter throws a retryable 503 rather
    // than a false 'conflict' that would cancel/refund a valid subscription.
    await assertSubscriptionFenceCurrent(
      this.repoFor(options?.manager),
      userId,
      fields.fenceToken,
    );
    return 'conflict';
  }

  /**
   * Atomically claims (or re-confirms) Google ownership of a user's subscription
   * row. The WHERE clause only allows the write when the row is unclaimed by
   * another provider (`subscription_provider IS NULL OR = 'google'`), the
   * stored original-transaction id is either unset or already matches, the
   * `subscription_store_signed_date` ordering guard is satisfied (see
   * `GoogleClaimFields.observedAt`), and the fencing token has not been
   * superseded — so a Google event can never clobber a Stripe/Apple-owned row,
   * a stale event for a superseded Google subscription loses instead of
   * overwriting the current one, and a flow whose lock lease was lost can't
   * clobber a row a newer acquisition already advanced.
   *
   * `originalTransactionId` MUST be RevenueCat's `original_transaction_id` —
   * "`transaction_id` of the original transaction in the subscription" — NOT the
   * subscriber API's per-subscription `store_transaction_id` (nor the event's
   * `transaction_id`), which is the CURRENT period's transaction and advances on
   * every renewal. That distinction is load-bearing for THIS method: the identity
   * guard below is `(google_original_transaction_id IS NULL OR = :otid)`, so a
   * per-renewal identifier would fail it on every renewal after the first,
   * yielding a reconciliation row per renewal and a
   * `subscription_current_period_end` that never advances. The stable id also
   * makes the two stores symmetric — RevenueCat's `original_transaction_id` for
   * an App Store subscription IS the Apple OTID that
   * `apple_original_transaction_id` holds.
   *
   * Returns `'claimed'` when the guard passed, `'conflict'` otherwise — except
   * when the 0-row result is actually a STALE FENCE (a newer lock holder
   * already advanced past this flow's token), which throws a retryable 503
   * instead of a false conflict (see `assertSubscriptionFenceCurrent`). The
   * caller opens a `store_billing_reconciliations` row on `'conflict'` — a
   * purchase that keeps billing with no entitlement must not be silently
   * acknowledged.
   *
   * Deliberately follows `claimForStripe` rather than `claimForApple`: see the
   * scope correction in spec §3.
   */
  async claimForGoogle(
    userId: string,
    originalTransactionId: string,
    fields: GoogleClaimFields,
    options?: { manager?: EntityManager },
  ): Promise<'claimed' | 'conflict'> {
    const result = await this.repoFor(options?.manager)
      .createQueryBuilder()
      .update(User)
      .set({
        subscription_provider: 'google',
        google_original_transaction_id: originalTransactionId,
        subscription_tier: fields.tier,
        subscription_status: fields.status,
        subscription_current_period_end: fields.currentPeriodEnd,
        subscription_store_signed_date: fields.observedAt,
        subscription_cancel_at_period_end: fields.cancelAtPeriodEnd,
        plan_source: 'subscription',
        subscription_lock_fence: fields.fenceToken,
        ...(fields.markTrialUsed
          ? {
              billing_trial_used_at: () =>
                'COALESCE(billing_trial_used_at, NOW())',
            }
          : {}),
      })
      .where('id = :id', { id: userId })
      .andWhere(
        "(subscription_provider IS NULL OR subscription_provider = 'google')",
      )
      .andWhere(
        '(google_original_transaction_id IS NULL OR google_original_transaction_id = :otid)',
        { otid: originalTransactionId },
      )
      // Ordering: a read that started earlier cannot overwrite what a later read
      // already committed. NOT a state-monotonicity guarantee — see
      // `GoogleClaimFields.observedAt`.
      .andWhere(
        '(subscription_store_signed_date IS NULL OR subscription_store_signed_date <= :observedAt)',
        { observedAt: fields.observedAt },
      )
      // Fence: a lease-lost stale flow can't clobber a row a newer acquisition
      // already advanced.
      .andWhere('subscription_lock_fence <= :fence', {
        fence: fields.fenceToken,
      })
      .execute();

    if ((result.affected ?? 0) > 0) return 'claimed';
    // 0 rows: distinguish a genuine exclusivity/ordering conflict from a STALE
    // FENCE (a newer holder advanced past us) — the latter throws a retryable
    // 503 rather than a false 'conflict' that would open a spurious billing
    // reconciliation for a transient, self-healing race (see `claimForStripe`).
    await assertSubscriptionFenceCurrent(
      this.repoFor(options?.manager),
      userId,
      fields.fenceToken,
    );
    return 'conflict';
  }

  /**
   * Identity-guarded terminal clear for a Stripe subscription deletion.
   * The WHERE clause requires the row to currently be Stripe-owned
   * AND hold the exact subscription id from the event, so a stale
   * `customer.subscription.deleted` for a subscription id the user has
   * since replaced (a superseded/re-subscribed id) is a no-op instead
   * of wiping the current, still-active subscription.
   *
   * Returns whether a row was actually cleared.
   *
   * `options.preserveGrant` keeps `subscription_tier` and `plan_source` while
   * still releasing the Stripe slot (provider, subscription id, status, cancel
   * flag). The caller passes it when the row's tier comes from a
   * founder/promo/admin grant rather than from this subscription: a grant is
   * not the ending subscription's to revoke, and the rider would otherwise lose
   * it — and be mailed a cancellation for it — the moment an unrelated Stripe
   * subscription on the same row ended. Skipping ownership at claim time
   * (`claimForStripe`'s `skipOwnership`) cannot cover this, because it only
   * avoids ADDING ownership; a row that was ALREADY Stripe-owned when the grant
   * was applied still matches this clear's guard.
   *
   * The predicate itself deliberately stays in the caller
   * (`isNonSubscriptionGrant`) rather than being re-encoded as SQL here, so the
   * definition of "non-subscription grant" lives in exactly one place. The
   * WHERE clause is unchanged either way, so the identity/ownership/fence
   * guards — and the stale-fence 503 below — behave identically.
   */
  async clearStripeTerminal(
    userId: string,
    subscriptionId: string,
    fenceToken: number,
    options?: { preserveGrant?: boolean; manager?: EntityManager },
  ): Promise<boolean> {
    const manager = options?.manager;
    const result = await this.repoFor(manager)
      .createQueryBuilder()
      .update(User)
      .set({
        subscription_provider: null,
        stripe_subscription_id: null,
        subscription_status: 'canceled',
        subscription_cancel_at_period_end: false,
        subscription_lock_fence: fenceToken,
        ...(options?.preserveGrant
          ? {}
          : { subscription_tier: 'free' as const, plan_source: null }),
      })
      .where('id = :id', { id: userId })
      .andWhere("subscription_provider = 'stripe'")
      .andWhere('stripe_subscription_id = :sub', { sub: subscriptionId })
      // Fence (see `claimForStripe`): a lease-lost stale flow can't clear a row a
      // newer acquisition already advanced.
      .andWhere('subscription_lock_fence <= :fence', { fence: fenceToken })
      .execute();

    if ((result.affected ?? 0) > 0) return true;
    // 0 rows: a genuine stale/superseded deletion (identity guard) returns false
    // and the caller acks the webhook — but if OUR fence is stale (a newer holder
    // advanced past us), a false ack would leave the deleted subscription's paid
    // tier persisted with no Stripe retry. Distinguish: throw a retryable 503 on
    // a stale fence so Stripe redelivers.
    await assertSubscriptionFenceCurrent(
      this.repoFor(manager),
      userId,
      fenceToken,
    );
    return false;
  }

  /**
   * Identity-guarded terminal clear for a Google subscription. The WHERE
   * clause requires the row to currently be Google-owned
   * (`subscription_provider = 'google'`), hold the exact original transaction id
   * from the event (`google_original_transaction_id = :otid` — RevenueCat's
   * `original_transaction_id`, stable for the subscription's lifetime; see
   * `claimForGoogle`), satisfy the same read-ordering guard `claimForGoogle`
   * uses (`subscription_store_signed_date IS NULL OR <= :observedAt` — see
   * `GoogleClaimFields.observedAt` for why this orders READS rather than STATE),
   * and the fencing token must not have been superseded
   * (`subscription_lock_fence <= :fence`) — so a delayed terminal for a
   * subscription the rider has since replaced, or a stale read that started
   * before a newer one already committed, is a no-op rather than wiping the
   * current, still-active subscription.
   *
   * `google_original_transaction_id` is NULLED, exactly as `clearStripeTerminal`
   * nulls `stripe_subscription_id` — and deliberately UNLIKE
   * `clearAppleTerminal`, which retains its OTID.
   *
   * Nulling is precisely what leaves the freed slot claimable by a LATER
   * re-subscribe, which starts a NEW subscription and therefore carries a NEW
   * `original_transaction_id`. `claimForGoogle`'s identity guard is
   * `(google_original_transaction_id IS NULL OR = :otid)`, and it has no
   * equivalent of `claimForApple`'s Branch A escape hatch for replacing a
   * retained-but-unowned binding. A retained id would therefore lock the rider
   * out of their own re-subscribe permanently: the Play subscription expires →
   * this clear nulls the provider but keeps id `A` → the rider re-subscribes →
   * RevenueCat reports a DIFFERENT `original_transaction_id` `B` → the provider
   * guard passes (NULL) but the identity guard fails (`A` is neither NULL nor
   * `B`) → 0 rows → `'conflict'` → a reconciliation row, repeated on every
   * redelivery and every future purchase, with the rider billed by Google and
   * stranded on `free`. Nothing self-heals that.
   *
   * `clearAppleTerminal`'s retention does NOT generalise to this method. It
   * exists because the NATIVE Apple path resolves the rider FROM the OTID in
   * the store payload. Under RevenueCat, rider resolution is a primary-key
   * lookup on the webhook's `app_user_id` (spec §2) — the original transaction
   * id is never used to find the rider — so retaining it buys nothing here and
   * costs the lockout. Nor does it add a guard: every stale claim a retained
   * identity would have rejected is ALREADY rejected by the read-ordering guard
   * below, which this clear advances to its own `observedAt`.
   *
   * PRECONDITION on the strict provider guard — LOAD-BEARING for whoever builds
   * the step-5 consumer. This method guards `subscription_provider = 'google'`
   * strictly, where `clearAppleTerminal` broadens to `(= 'apple' OR IS NULL)`
   * so a SECOND terminal for the same retained identity can still advance the
   * ordering watermark. Google needs no such broadening ONLY because terminals
   * are derived from the authoritative re-query (spec §4 step 2), NEVER from
   * the event body: an entitling read necessarily precedes the termination
   * instant, which precedes the terminal consumer's own read, so any claim that
   * could resurrect this row carries an `observedAt` older than the watermark
   * this clear writes and loses to the ordering guard. If step 5 ever shortcuts
   * a terminal straight from the event payload, that argument collapses and
   * this provider guard MUST be broadened to `(= 'google' OR IS NULL)`.
   *
   * `options.preserveGrant` keeps `subscription_tier` and `plan_source` while
   * still releasing the Google slot (provider, original transaction id, status,
   * cancel flag, signed-date watermark) — identical carve-out to
   * `clearStripeTerminal`'s `preserveGrant` (see its doc for the full
   * rationale): a founder/promo/admin grant that merely shares the row is not
   * the ending subscription's to revoke.
   *
   * Returns whether a row was actually cleared. On a 0-row result, distinguish
   * a genuine stale/superseded terminal (returns `false`; the caller completes
   * the inbox row) from OUR fence being stale because a newer holder advanced
   * past us (throws a retryable 503 via `assertSubscriptionFenceCurrent` — a
   * real refund/expiry must never be acked as a no-op and lost).
   */
  async clearGoogleTerminal(
    userId: string,
    originalTransactionId: string,
    observedAt: Date,
    fenceToken: number,
    options?: { preserveGrant?: boolean; manager?: EntityManager },
  ): Promise<boolean> {
    const manager = options?.manager;
    const result = await this.repoFor(manager)
      .createQueryBuilder()
      .update(User)
      .set({
        subscription_provider: null,
        // NULLED, like clearStripeTerminal's stripe_subscription_id — a
        // retained id would fail claimForGoogle's identity guard forever on a
        // re-subscribe under a NEW original transaction id (see doc).
        google_original_transaction_id: null,
        subscription_status: 'canceled',
        subscription_cancel_at_period_end: false,
        subscription_store_signed_date: observedAt,
        subscription_lock_fence: fenceToken,
        ...(options?.preserveGrant
          ? {}
          : { subscription_tier: 'free' as const, plan_source: null }),
      })
      .where('id = :id', { id: userId })
      .andWhere("subscription_provider = 'google'")
      .andWhere('google_original_transaction_id = :otid', {
        otid: originalTransactionId,
      })
      // Ordering (see `claimForGoogle`): a read that started earlier cannot
      // clear what a later read already committed.
      .andWhere(
        '(subscription_store_signed_date IS NULL OR subscription_store_signed_date <= :observedAt)',
        { observedAt },
      )
      // Fence (see `claimForStripe`): a lease-lost stale flow can't clear a row
      // a newer acquisition already advanced.
      .andWhere('subscription_lock_fence <= :fence', { fence: fenceToken })
      .execute();

    if ((result.affected ?? 0) > 0) return true;
    // 0 rows is either a genuine stale/superseded terminal (return false, the
    // caller completes the inbox row) or OUR fence being stale because a newer
    // holder advanced past us. The second must NOT be acked as a no-op, or a
    // real refund/expiry is lost — throw a retryable 503 so it is redelivered.
    await assertSubscriptionFenceCurrent(
      this.repoFor(manager),
      userId,
      fenceToken,
    );
    return false;
  }

  /**
   * Atomically claims (or re-confirms) Apple ownership of a user's
   * subscription row. The WHERE clause is `A OR B`:
   *
   *  - Branch A — genuine REPLACEMENT of an unowned slot bearing a
   *    DIFFERENT/absent retained OTID (`subscription_provider IS NULL AND
   *    apple_original_transaction_id IS DISTINCT FROM :otid`), guarded by a
   *    COMPARE-AND-SWAP on the initially-observed row version (Finding 1, round
   *    25) rather than a cross-lineage `signedDate` comparison.
   *    `clearAppleTerminal` clears the provider to NULL but RETAINS the old
   *    `apple_original_transaction_id` as a historical binding, so a later valid
   *    purchase carrying a DIFFERENT original transaction id (e.g. the rider
   *    switched back to an OLDER App Store account) must be able to overwrite
   *    that stale binding — even when the incoming subscription's latest
   *    `signedDate` PREDATES the retained tombstone's, because the two belong to
   *    UNRELATED lineages and their timestamps are not comparable. Round 24
   *    wrongly added a monotonic `signedDate` guard here; against an older-signed
   *    but active OTID switching back over a newer DIFFERENT-otid tombstone it
   *    rejected forever → a `'stale'` livelock (503 on every retry). The CAS
   *    replaces it: Branch A additionally requires the row to STILL match the
   *    `(provider, otid, signedDate)` the service observed at its initial read
   *    (`IS NOT DISTINCT FROM :casProvider / :casOtid / :casSignedDate`, NULL-
   *    safe). It therefore replaces only when NOTHING changed the slot since that
   *    read — no cross-lineage timestamp compare — and the SET clause writes the
   *    new otid + signedDate. Round 24's target race (a NEWER tombstone for a
   *    different OTID appears DURING this validate): the initial read saw the
   *    pre-tombstone state, the row is the new tombstone at claim time → CAS
   *    fails → 0 rows → `'stale'` retry. Round 25's false livelock (the newer
   *    tombstone already existed at the initial read, no concurrent change): CAS
   *    matches → the replacement claims. ✓
   *
   *    TRIAL GUARD (Branch A only): when `fields.markTrialUsed` is true (this
   *    claim is granting a trial), Branch A ALSO requires
   *    `billing_trial_used_at IS NULL`. Trial eligibility is otherwise only
   *    checked in the SERVICE before the claim, which is a read-then-write race:
   *    a concurrent validation for a DIFFERENT subscription can consume the
   *    rider's trial (stamp `billing_trial_used_at`) and terminal-clear its slot
   *    between this claim's eligibility read and its UPDATE, leaving a
   *    newly-unowned row that Branch A would otherwise still match — granting a
   *    second trial. Requiring the stamp be NULL in Branch A closes that race:
   *    if the stamp was set concurrently, Branch A no longer matches, the
   *    UPDATE affects 0 rows, and the follow-up disambiguating read resolves to
   *    `'conflict'` (the row's otid now belongs to the other subscription). This
   *    guard is intentionally confined to Branch A: Branch B is a same-OTID
   *    reclaim of the rider's OWN retained/active subscription, so a REACTIVATION
   *    of that exact trial must still be allowed even after
   *    `billing_trial_used_at` is set — it's the same trial, not a second one.
   *  - Branch B — same-OTID reclaim after a terminal clear OR active Apple
   *    ownership, ORDERING-GUARDED:
   *    `((subscription_provider IS NULL AND apple_original_transaction_id = :otid)
   *      OR (subscription_provider = 'apple' AND (apple_original_transaction_id
   *      IS NULL OR apple_original_transaction_id = :otid)))
   *      AND (subscription_store_signed_date IS NULL OR
   *           subscription_store_signed_date <= :signedDate)`.
   *
   * An Apple event can never clobber a Stripe/Google-owned row (the provider is
   * neither NULL nor `'apple'` then).
   *
   * MONOTONIC guard (Branch B ONLY): the same-otid write is gated on
   * `subscription_store_signed_date IS NULL OR <= :signedDate` — the JWS
   * `signedDate` is Apple's strictly-monotonic per-state stamp, so within the
   * SAME lineage an OLDER snapshot cannot regress a NEWER committed one. This
   * REPLACES the former period-based guard, which was insufficient: an `active`
   * and a later `revoked`/`expired` state for the SAME otid can share the same
   * `subscription_current_period_end`, so a `<=` period guard let a stale active
   * snapshot resurrect a subscription a concurrent terminal clear already killed.
   * (`subscription_current_period_end` is still written as a business field, but
   * is no longer the ordering key.) Branch A (a DIFFERENT-otid replacement across
   * unrelated lineages) does NOT use this monotonic guard — it uses the CAS above
   * (Finding 1, round 25), because comparing two lineages' signedDates is
   * meaningless and produced a livelock.
   *
   * `plan_source` is always stamped `'subscription'` for Apple claims
   * (unlike Stripe, there is no founder/promo/admin variant reachable
   * through this path).
   *
   * Returns:
   *  - `'claimed'` — the guard passed and the row was updated;
   *  - `'stale'` — the UPDATE affected 0 rows for a RETRYABLE/idempotent reason.
   *    Either (a) the stored row is Apple-owned or unowned AND holds THIS otid
   *    with a `subscription_store_signed_date` >= the incoming one (active-owned
   *    OR terminal-cleared, same otid) — Branch B's monotonic guard blocked an
   *    older same-lineage snapshot; or (b) Branch A's CAS failed because the row
   *    CHANGED since the version the service initially observed (Finding 1, round
   *    25): a concurrent write (a newer tombstone/owner for a DIFFERENT otid, or
   *    any other slot mutation) moved the slot between the initial read and this
   *    guarded UPDATE. A benign no-op, NOT a conflict: the caller must treat it as
   *    retryable/idempotent, not open an exclusivity reconciliation. The caller's
   *    `'stale'` handler only returns a snapshot as SUCCESS when the re-read row
   *    is entitling AND owned by THIS otid, so case (b) (the changed slot is now a
   *    non-entitling foreign-otid tombstone, or a racing different-otid recovery)
   *    forces a clean retryable re-validate. If a DIFFERENT active provider
   *    (Stripe/Google) OWNED the slot at the initial read AND still does (the CAS
   *    matches, so the row did NOT change), this is a genuine `'conflict'`, not
   *    `'stale'`;
   *  - `'trial_ineligible'` — the UPDATE affected 0 rows, `fields.markTrialUsed`
   *    was true, and the disambiguating read shows the slot is UNOWNED
   *    (`subscription_provider IS NULL`) with `billing_trial_used_at` now SET on
   *    a row that does not hold THIS otid. For a trial claim on an unowned slot,
   *    the ONLY thing in Branch A that can block the write is its
   *    `billing_trial_used_at IS NULL` guard — so this shape means a
   *    CONCURRENT validation for a DIFFERENT subscription consumed the rider's
   *    once-per-rider trial (and terminal-cleared its own slot) between this
   *    claim's eligibility read and its guarded UPDATE. The slot is unowned, not
   *    held by a rival provider/otid, so this is an ineligible-trial condition
   *    for THIS rider, not an exclusivity conflict — the caller must route it to
   *    the SAME `ineligible_trial_rejected` remediation as the pre-claim
   *    trial-eligibility check, never `exclusivity_conflict`;
   *  - `'conflict'` — the UPDATE affected 0 rows and the row is owned by a
   *    different provider or a different Apple otid (caller should skip dependent
   *    side effects and surface the ownership 409);
   *  - `'ownership_conflict'` — the UPDATE itself was rejected by Postgres with a
   *    `23505` unique violation on `apple_original_transaction_id` (see below).
   *    This is a FOREIGN-OTID conflict — a DIFFERENT rider already owns this
   *    otid — never the caller's own slot being contested, so the caller must
   *    NOT treat it like `'conflict'`'s same-slot exclusivity case.
   *
   * The ownership predicates pass for the CURRENT row, but the same
   * `originalTransactionId` may already be stored on ANOTHER user's row —
   * Postgres's partial unique index on `apple_original_transaction_id` then
   * rejects the UPDATE with a `23505` unique violation. Because this UPDATE's
   * WHERE targets ONLY the caller's own row (`id = :userId`), a `23505` here can
   * ONLY mean the collision is with a DIFFERENT rider's row — a cross-rider
   * OWNERSHIP conflict, never the caller's own slot being taken by another
   * provider/otid (that case is the zero-row `'conflict'` above). We therefore
   * translate it to the DISTINCT `'ownership_conflict'` result (not `'conflict'`)
   * so the caller never opens an `exclusivity_conflict` reconciliation — which
   * would file another rider's OTID as a drainable work item against THIS rider,
   * handing ops an actionable row that could refund or revoke a purchase the
   * caller does not own — rather than letting an untyped 500 escape. Other
   * errors still propagate.
   */
  async claimForApple(
    userId: string,
    originalTransactionId: string,
    fields: AppleClaimFields,
    manager?: EntityManager,
  ): Promise<
    'claimed' | 'conflict' | 'stale' | 'trial_ineligible' | 'ownership_conflict'
  > {
    // WHERE = A OR B. Branch A (genuine cross-lineage replacement) is CAS-guarded
    // on the initially-observed row version (Finding 1, round 25) and DOES carry
    // the trial-eligibility guard below when this claim is a trial claim; branch B
    // (same-OTID reclaim / active ownership) is ordering-guarded on the monotonic
    // `signedDate` and is NEVER trial-guarded (see the method doc's TRIAL GUARD
    // section).
    const branchATrialGuard = fields.markTrialUsed
      ? ' AND billing_trial_used_at IS NULL'
      : '';
    // Branch A COMPARE-AND-SWAP on the initially-observed row version (Finding 1,
    // round 25). Branch A replaces an UNOWNED slot across UNRELATED lineages (this
    // otid vs a retained tombstone for a DIFFERENT otid), so comparing their
    // `signedDate`s is meaningless — round 24's cross-lineage monotonic guard
    // rejected an older-signed but active OTID switching back over a newer
    // different-otid tombstone forever, a `'stale'` livelock. Instead require the
    // row to STILL match the `(provider, otid, signedDate)` the service observed
    // at its initial read: `IS NOT DISTINCT FROM` on each (NULL-safe). If nothing
    // changed the slot since the read, the replacement lands; a concurrent write
    // (a newer tombstone/owner appearing DURING this validate — round 24's target
    // race) changes the row so the CAS fails, the UPDATE affects 0 rows, and the
    // disambiguating read below classifies `'stale'` so the caller re-validates.
    const branchACas =
      ' AND subscription_provider IS NOT DISTINCT FROM :casProvider' +
      ' AND apple_original_transaction_id IS NOT DISTINCT FROM :casOtid' +
      ' AND subscription_store_signed_date IS NOT DISTINCT FROM :casSignedDate';
    // Monotonic ordering guard — Branch B ONLY. The JWS `signedDate` is Apple's
    // strictly-monotonic per-state stamp, so WITHIN the same otid lineage an OLDER
    // snapshot must never regress a NEWER committed one. A fresh row
    // (`subscription_store_signed_date IS NULL`) still claims.
    const orderingGuard =
      ' AND (subscription_store_signed_date IS NULL OR subscription_store_signed_date <= :signedDate)';
    const guard =
      '((subscription_provider IS NULL AND apple_original_transaction_id IS DISTINCT FROM :otid' +
      branchATrialGuard +
      branchACas +
      ')' +
      ' OR (((subscription_provider IS NULL AND apple_original_transaction_id = :otid)' +
      " OR (subscription_provider = 'apple' AND (apple_original_transaction_id IS NULL OR apple_original_transaction_id = :otid)))" +
      orderingGuard +
      '))';
    const guardParams = {
      otid: originalTransactionId,
      signedDate: fields.signedDate,
      casProvider: fields.observedProvider,
      casOtid: fields.observedOriginalTransactionId,
      casSignedDate: fields.observedSignedDate,
    };

    let result;
    try {
      result = await this.repoFor(manager)
        .createQueryBuilder()
        .update(User)
        .set({
          subscription_provider: 'apple',
          apple_original_transaction_id: originalTransactionId,
          subscription_tier: fields.tier,
          subscription_status: fields.status,
          subscription_current_period_end: fields.currentPeriodEnd,
          subscription_store_signed_date: fields.signedDate,
          subscription_cancel_at_period_end: fields.cancelAtPeriodEnd,
          plan_source: 'subscription',
          subscription_lock_fence: fields.fenceToken,
          // Fold the once-per-rider trial stamp into the SAME atomic UPDATE.
          // `COALESCE` preserves an already-set stamp (idempotent), so this
          // never re-dates an earlier trial. Omitted entirely when the caller
          // did not use a trial, leaving the column untouched. A zero-row guard
          // miss (`'stale'`/`'conflict'`) writes nothing, so the stamp is never
          // applied without a real claim.
          ...(fields.markTrialUsed
            ? {
                billing_trial_used_at: () =>
                  'COALESCE(billing_trial_used_at, NOW())',
              }
            : {}),
        })
        .where('id = :id', { id: userId })
        .andWhere(guard, guardParams)
        // Fence (see `claimForStripe`): reject if a NEWER lock acquisition
        // already wrote this row — a lease-lost stale flow can't clobber it.
        .andWhere('subscription_lock_fence <= :fence', {
          fence: fields.fenceToken,
        })
        .execute();
    } catch (err: unknown) {
      // A different user's row already holds this originalTransactionId: the
      // partial unique index rejects the UPDATE. This UPDATE's WHERE targets
      // ONLY the caller's own row (`id = :userId`), so a 23505 here can only
      // mean the otid collided with a DIFFERENT rider's row — a cross-rider
      // OWNERSHIP conflict, not the caller's own slot being contested by
      // another provider/otid. Surface the DISTINCT `'ownership_conflict'`
      // result (not `'conflict'`) so the caller opens NO exclusivity
      // reconciliation for what is really another rider's purchase.
      if (isUniqueViolation(err)) {
        return 'ownership_conflict';
      }
      throw err;
    }

    if ((result.affected ?? 0) > 0) {
      return 'claimed';
    }

    // Zero rows updated: disambiguate the benign, retryable no-ops from a real
    // ownership conflict with a follow-up read, in priority order below —
    //  1. Branch B same-lineage monotonic no-op (`'stale'`): the slot is still
    //     Apple-owned OR unowned AND holds THIS otid with a signedDate at-or-after
    //     the incoming one (a newer/equal same-otid state is already recorded). If
    //     another ACTIVE provider (Stripe/Google) has since claimed the slot, this
    //     is NOT this case (the provider guard below fails) — even if a retained
    //     apple otid/date lingers.
    //  2. Branch A trial-guard loss (`'trial_ineligible'`): a concurrent trial
    //     consumed the rider's once-per-rider marker (see below).
    //  3. Branch A CAS-fail (`'stale'`): the row CHANGED since the initially
    //     observed version — a concurrent write moved the slot; retryable.
    // A zero-row miss where the CAS still matches (the row did NOT change) and it
    // is not a same-otid monotonic no-op is a genuine `'conflict'`.
    const current = await this.repoFor(manager).findOne({
      where: { id: userId },
    });
    // STALE FENCE first: if a NEWER holder advanced `subscription_lock_fence`
    // past our token, this 0-row is a FENCE rejection — even though the
    // ownership/CAS predicates may still match the observed baseline — NOT a
    // business conflict. Surfacing `'conflict'` here would open a false
    // reconciliation and return a non-retryable 409 for a valid purchase. Throw a
    // retryable 503 so a fresh, non-stale flow re-decides (reuses the `current`
    // read above; a missing row falls through to the normal classification).
    if (
      current != null &&
      current.subscription_lock_fence > fields.fenceToken
    ) {
      throw new ServiceUnavailableException({
        message: 'Subscription service is busy. Please retry shortly.',
        retryable: true,
      });
    }
    const appleOwnedOrUnowned =
      current?.subscription_provider === 'apple' ||
      current?.subscription_provider == null;
    if (
      appleOwnedOrUnowned &&
      current?.apple_original_transaction_id === originalTransactionId &&
      current.subscription_store_signed_date != null &&
      current.subscription_store_signed_date.getTime() >=
        fields.signedDate.getTime()
    ) {
      return 'stale';
    }
    // Finding 2 (round 17): disambiguate the atomic trial-guard-loss race from
    // a genuine exclusivity conflict. This claim requested a trial
    // (`markTrialUsed`), the slot is UNOWNED, and `billing_trial_used_at` is
    // now set on a row that does NOT hold this otid. On an unowned slot,
    // Branch A's ONLY blocking condition (beyond otid/ownership, which pass
    // here) is `billing_trial_used_at IS NULL` — so a set stamp can only mean a
    // concurrent validation for a DIFFERENT subscription consumed the rider's
    // once-per-rider trial (and terminal-cleared its own slot) between this
    // claim's eligibility read and its guarded UPDATE. Nothing else blocked
    // Branch A, so this is NOT an exclusivity conflict — the caller must route
    // it to the same ineligible-trial remediation as the pre-claim check.
    if (
      fields.markTrialUsed === true &&
      current != null &&
      current.subscription_provider === null &&
      current.billing_trial_used_at != null &&
      current.apple_original_transaction_id !== originalTransactionId
    ) {
      return 'trial_ineligible';
    }
    // Branch A CAS-fail (Finding 1, round 25): the row CHANGED since the version
    // the service initially observed, so Branch A's compare-and-swap matched no
    // row. A concurrent write moved the slot (a newer tombstone/owner for a
    // DIFFERENT otid appeared, or the slot was otherwise mutated) between the
    // initial read and this guarded UPDATE. This is a benign, RETRYABLE race, NOT
    // a genuine exclusivity conflict: classify `'stale'` so the caller
    // re-validates against the now-current state rather than opening a FALSE
    // `exclusivity_conflict`. The caller's `'stale'` handler is what keeps this
    // safe — it only returns a snapshot as success when the re-read row is
    // entitling AND owned by THIS otid, so a changed/foreign slot forces a clean
    // re-validate. When the row is UNCHANGED since the observed version (the CAS
    // still matches), the miss is a genuine same-slot ownership `'conflict'` and
    // falls through below.
    if (current != null && !this.rowMatchesObservedVersion(current, fields)) {
      return 'stale';
    }
    return 'conflict';
  }

  /**
   * True when the CURRENT row still matches the `(provider, otid, signedDate)`
   * the service observed at its initial read — the JS mirror of Branch A's
   * `IS NOT DISTINCT FROM` compare-and-swap (NULL-safe on every field). Used on a
   * zero-row claim to tell a benign CAS-fail race (row changed → retry) apart
   * from a genuine unchanged-slot ownership conflict.
   */
  private rowMatchesObservedVersion(
    current: User,
    fields: AppleClaimFields,
  ): boolean {
    const stored = current.subscription_store_signed_date;
    const observed = fields.observedSignedDate;
    const signedDatesMatch =
      stored == null || observed == null
        ? stored == null && observed == null
        : stored.getTime() === observed.getTime();
    return (
      current.subscription_provider === fields.observedProvider &&
      current.apple_original_transaction_id ===
        fields.observedOriginalTransactionId &&
      signedDatesMatch
    );
  }

  /**
   * Identity- AND signedDate-guarded terminal clear for an Apple subscription
   * expiry/revocation. Clears ACTIVE ownership (provider, tier→free, status→
   * canceled, cancel flag, plan_source) but **RETAINS
   * `apple_original_transaction_id`** as a historical store binding — per the
   * design spec's terminal-semantics rule (both stores retain the store-id
   * column so a later store-side reactivation/reconciliation can still resolve
   * the rider by OTID). Because the OTID stays and the provider is cleared to
   * NULL, a same-OTID `claimForApple` reactivation still passes branch B
   * (`subscription_provider IS NULL` and `apple_original_transaction_id = :otid`,
   * subject to the signedDate ordering guard). It ALSO writes
   * `subscription_store_signed_date = :signedDate`, stamping the terminal state's
   * ordering value so a later stale `active` snapshot with an OLDER signedDate
   * cannot resurrect the killed subscription via `claimForApple`.
   *
   * The WHERE clause requires:
   *  - the row to currently be Apple-owned OR ALREADY a same-OTID TOMBSTONE
   *    (`subscription_provider = 'apple' OR subscription_provider IS NULL`) AND
   *    hold the exact original transaction id from the event, so a stale
   *    notification for an OTID the user has since replaced is a no-op, and a
   *    Stripe/Google-owned row is never touched; AND
   *  - a MONOTONIC signedDate guard: the stored `subscription_store_signed_date`
   *    must NOT be newer than the JWS `signedDate` THIS caller authoritatively
   *    observed (`IS NULL OR <= :signedDate`). Apple reuses the SAME OTID across
   *    a reactivation and stamps a strictly-greater `signedDate` on each issued
   *    state, so the identity guard alone can't tell that a concurrent recovery
   *    already advanced the row to a newer state. Two overlapping validations for
   *    one OTID — A sees an OLDER `revoked`/`expired`, B sees a NEWER `active` and
   *    commits it — must not let A's stale terminal clear drop the rider B just
   *    recovered. Conditioning on the observed signedDate makes A's clear match
   *    no row once B advanced it. (This REPLACES the former period-based guard,
   *    which was insufficient because an active and a later terminal state for
   *    the same OTID can share the same period.)
   *
   * The `OR subscription_provider IS NULL` broadening (round 23) lets a NEWER
   * terminal observation advance an ALREADY-cleared same-OTID tombstone's
   * `subscription_store_signed_date`. Without it, a second terminal clear for
   * the same OTID (e.g. a later `expired` notification arriving after an
   * earlier `revoked` one already cleared the row) would never match — the
   * tombstone's `subscription_provider` is already `NULL`, not `'apple'` — so
   * its stored signedDate would freeze at the FIRST clear's value. A
   * subsequent OLDER-but-still-newer-than-the-freeze active validation could
   * then pass `claimForApple`'s Branch B monotonic guard (stored <= incoming)
   * and resurrect paid access even though a NEWER terminal state was already
   * observed. The identity (`apple_original_transaction_id = :otid`) guard
   * keeps this safe: a fresh/never-Apple row has a NULL otid and won't match,
   * and a Stripe/Google-owned row has a non-null, non-`'apple'` provider and is
   * excluded by the provider predicate — so only THIS subscription's own
   * tombstone can be advanced.
   *
   * Returns whether a row was actually cleared (false when the identity or
   * signedDate guard matched nothing — e.g. a concurrent recovery won).
   */
  async clearAppleTerminal(
    userId: string,
    originalTransactionId: string,
    signedDate: Date,
    fenceToken: number,
    manager?: EntityManager,
  ): Promise<boolean> {
    const result = await this.repoFor(manager)
      .createQueryBuilder()
      .update(User)
      .set({
        subscription_provider: null,
        plan_source: null,
        // apple_original_transaction_id is intentionally RETAINED (see doc).
        subscription_tier: 'free',
        subscription_status: 'canceled',
        subscription_cancel_at_period_end: false,
        subscription_store_signed_date: signedDate,
        subscription_lock_fence: fenceToken,
      })
      .where('id = :id', { id: userId })
      .andWhere(
        "(subscription_provider = 'apple' OR subscription_provider IS NULL)",
      )
      .andWhere('apple_original_transaction_id = :otid', {
        otid: originalTransactionId,
      })
      .andWhere(
        '(subscription_store_signed_date IS NULL OR subscription_store_signed_date <= :signedDate)',
        { signedDate },
      )
      // Fence (see `claimForStripe`): a lease-lost stale flow can't clear a row a
      // newer acquisition already advanced.
      .andWhere('subscription_lock_fence <= :fence', { fence: fenceToken })
      .execute();

    return (result.affected ?? 0) > 0;
  }
}

/**
 * Detects a Postgres unique-constraint violation (SQLSTATE `23505`). TypeORM
 * wraps the driver error in a `QueryFailedError` whose `driverError.code` holds
 * the SQLSTATE; some code paths also surface it directly as `err.code` (the
 * pattern used elsewhere in the codebase, e.g. `challenges.service.ts`), so we
 * check both without a fragile blanket catch.
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
