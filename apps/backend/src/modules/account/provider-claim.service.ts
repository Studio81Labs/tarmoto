import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { PlanSource, SubscriptionTier } from '@tarmoto/shared';
import { User } from '../../entities/user.entity.js';

export interface StripeClaimFields {
  tier: SubscriptionTier;
  status: 'active' | 'trialing' | 'past_due' | 'canceled';
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  planSource: PlanSource | null;
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
   */
  async claimForStripe(
    userId: string,
    subscriptionId: string,
    fields: StripeClaimFields,
    options?: { skipStatus?: boolean },
  ): Promise<'claimed' | 'conflict'> {
    const result = await this.userRepo
      .createQueryBuilder()
      .update(User)
      .set({
        subscription_provider: 'stripe',
        stripe_subscription_id: subscriptionId,
        subscription_tier: fields.tier,
        ...(options?.skipStatus ? {} : { subscription_status: fields.status }),
        subscription_current_period_end: fields.currentPeriodEnd,
        subscription_cancel_at_period_end: fields.cancelAtPeriodEnd,
        plan_source: fields.planSource,
      })
      .where('id = :id', { id: userId })
      .andWhere(
        "(subscription_provider IS NULL OR subscription_provider = 'stripe')",
      )
      .andWhere(
        '(stripe_subscription_id IS NULL OR stripe_subscription_id = :sub)',
        { sub: subscriptionId },
      )
      .execute();

    return (result.affected ?? 0) > 0 ? 'claimed' : 'conflict';
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
   */
  async clearStripeTerminal(
    userId: string,
    subscriptionId: string,
  ): Promise<boolean> {
    const result = await this.userRepo
      .createQueryBuilder()
      .update(User)
      .set({
        subscription_provider: null,
        plan_source: null,
        stripe_subscription_id: null,
        subscription_tier: 'free',
        subscription_status: 'canceled',
        subscription_cancel_at_period_end: false,
      })
      .where('id = :id', { id: userId })
      .andWhere("subscription_provider = 'stripe'")
      .andWhere('stripe_subscription_id = :sub', { sub: subscriptionId })
      .execute();

    return (result.affected ?? 0) > 0;
  }

  /**
   * Atomically claims (or re-confirms) Apple ownership of a user's
   * subscription row. The WHERE clause is `A OR B`:
   *
   *  - Branch A — genuine REPLACEMENT of an unowned slot bearing a
   *    DIFFERENT/absent retained OTID (`subscription_provider IS NULL AND
   *    apple_original_transaction_id IS DISTINCT FROM :otid`), with NO ordering
   *    guard. `clearAppleTerminal` clears the provider to NULL but RETAINS the
   *    old `apple_original_transaction_id` as a historical binding, so a later
   *    valid purchase carrying a DIFFERENT original transaction id (e.g. the
   *    rider switched App Store accounts) must be able to overwrite that stale
   *    binding. A brand-new subscription legitimately starts a fresh `signedDate`
   *    lineage, so this branch is never blocked by the ordering guard; the SET
   *    clause writes the new otid + signedDate, replacing the stale ones.
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
   * MONOTONIC guard (branch B): the write is gated on
   * `subscription_store_signed_date IS NULL OR <= :signedDate` — the JWS
   * `signedDate` is Apple's strictly-monotonic per-state stamp, so an OLDER
   * snapshot cannot regress a NEWER committed one. This REPLACES the former
   * period-based guard, which was insufficient: an `active` and a later
   * `revoked`/`expired` state for the SAME otid can share the same
   * `subscription_current_period_end`, so a `<=` period guard let a stale active
   * snapshot resurrect a subscription a concurrent terminal clear already killed.
   * (`subscription_current_period_end` is still written as a business field, but
   * is no longer the ordering key.)
   *
   * `plan_source` is always stamped `'subscription'` for Apple claims
   * (unlike Stripe, there is no founder/promo/admin variant reachable
   * through this path).
   *
   * Returns:
   *  - `'claimed'` — the guard passed and the row was updated;
   *  - `'stale'` — the UPDATE affected 0 rows BUT the stored row is still
   *    Apple-owned or unowned (`subscription_provider` is `'apple'` or `NULL`)
   *    AND already holds THIS otid with a `subscription_store_signed_date` >= the
   *    incoming one, i.e. a newer/equal Apple state (active-owned OR
   *    terminal-cleared) is already recorded and the ordering guard blocked this
   *    older snapshot. A benign no-op, NOT a conflict: the caller must treat it
   *    as an idempotent success, not open an exclusivity reconciliation. If a
   *    DIFFERENT active provider (Stripe/Google) now owns the slot — even with a
   *    retained apple otid/date lingering — this is a `'conflict'`, not `'stale'`;
   *  - `'conflict'` — the UPDATE affected 0 rows and the row is owned by a
   *    different provider or a different Apple otid (caller should skip dependent
   *    side effects and surface the ownership 409).
   *
   * The ownership predicates pass for the CURRENT row, but the same
   * `originalTransactionId` may already be stored on ANOTHER user's row —
   * Postgres's partial unique index on `apple_original_transaction_id` then
   * rejects the UPDATE with a `23505` unique violation. That is an ownership
   * conflict, not an internal error, so we translate it to `'conflict'` (like a
   * zero-row guard miss) rather than letting an untyped 500 escape. Other
   * errors still propagate.
   */
  async claimForApple(
    userId: string,
    originalTransactionId: string,
    fields: AppleClaimFields,
  ): Promise<'claimed' | 'conflict' | 'stale'> {
    // WHERE = A OR B. Branch A (genuine replacement) carries NO ordering guard;
    // branch B (same-OTID reclaim / active ownership) is ordering-guarded on the
    // monotonic `signedDate`.
    const guard =
      '((subscription_provider IS NULL AND apple_original_transaction_id IS DISTINCT FROM :otid)' +
      ' OR (((subscription_provider IS NULL AND apple_original_transaction_id = :otid)' +
      " OR (subscription_provider = 'apple' AND (apple_original_transaction_id IS NULL OR apple_original_transaction_id = :otid)))" +
      ' AND (subscription_store_signed_date IS NULL OR subscription_store_signed_date <= :signedDate)))';
    const guardParams = {
      otid: originalTransactionId,
      signedDate: fields.signedDate,
    };

    let result;
    try {
      result = await this.userRepo
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
        .execute();
    } catch (err: unknown) {
      // A different user's row already holds this originalTransactionId: the
      // partial unique index rejects the UPDATE. Surface it as a conflict so the
      // validation flow emits the ownership 409, not a 500.
      if (isUniqueViolation(err)) {
        return 'conflict';
      }
      throw err;
    }

    if ((result.affected ?? 0) > 0) {
      return 'claimed';
    }

    // Zero rows updated: disambiguate a benign monotonic no-op from a real
    // ownership conflict with a follow-up read. The benign `'stale'`
    // classification requires ALL of:
    //  - the slot is still Apple-owned OR unowned (`subscription_provider` is
    //    `'apple'` or `NULL`). If another ACTIVE provider (Stripe/Google) has
    //    since claimed the slot, this older Apple snapshot lost its guarded write
    //    to a DIFFERENT owner — an exclusivity `'conflict'` — EVEN IF the retained
    //    apple otid + signedDate still linger on the row from a prior terminal
    //    clear. Returning `'stale'` there would hand the rival provider's snapshot
    //    back as success and open no exclusivity reconciliation;
    //  - the stored row holds THIS otid with a signedDate at-or-after the incoming
    //    one — a newer/equal Apple state is already recorded (an active-owned-newer
    //    row OR a terminal-cleared-newer row), so this older snapshot's guarded
    //    UPDATE matched no row.
    // Any other state (different otid, different/other provider, missing row, or
    // no recorded signedDate) is a genuine `'conflict'`.
    const current = await this.userRepo.findOne({
      where: { id: userId },
    });
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
    return 'conflict';
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
   *  - the row to currently be Apple-owned AND hold the exact original
   *    transaction id from the event, so a stale notification for an OTID the
   *    user has since replaced is a no-op; AND
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
   * Returns whether a row was actually cleared (false when the identity or
   * signedDate guard matched nothing — e.g. a concurrent recovery won).
   */
  async clearAppleTerminal(
    userId: string,
    originalTransactionId: string,
    signedDate: Date,
  ): Promise<boolean> {
    const result = await this.userRepo
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
      })
      .where('id = :id', { id: userId })
      .andWhere("subscription_provider = 'apple'")
      .andWhere('apple_original_transaction_id = :otid', {
        otid: originalTransactionId,
      })
      .andWhere(
        '(subscription_store_signed_date IS NULL OR subscription_store_signed_date <= :signedDate)',
        { signedDate },
      )
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
