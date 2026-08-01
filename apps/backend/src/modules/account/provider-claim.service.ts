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
   * subscription row. Mirrors `claimForStripe`'s guard shape: the WHERE
   * clause only allows the write when the row is unclaimed by another
   * provider (`subscription_provider IS NULL OR = 'apple'`) and the
   * stored original transaction id is either unset or already matches
   * the incoming one — so an Apple event can never clobber a
   * Stripe/Google-owned row, and a stale event for a different Apple
   * subscription loses the race instead of overwriting the current one.
   *
   * `plan_source` is always stamped `'subscription'` for Apple claims
   * (unlike Stripe, there is no founder/promo/admin variant reachable
   * through this path).
   *
   * Returns `'claimed'` when the guard passed and the row was updated,
   * `'conflict'` otherwise (caller should skip dependent side effects).
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
  ): Promise<'claimed' | 'conflict'> {
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
          subscription_cancel_at_period_end: fields.cancelAtPeriodEnd,
          plan_source: 'subscription',
          // Fold the once-per-rider trial stamp into the SAME atomic UPDATE.
          // `COALESCE` preserves an already-set stamp (idempotent), so this
          // never re-dates an earlier trial. Omitted entirely when the caller
          // did not use a trial, leaving the column untouched.
          ...(fields.markTrialUsed
            ? {
                billing_trial_used_at: () =>
                  'COALESCE(billing_trial_used_at, NOW())',
              }
            : {}),
        })
        .where('id = :id', { id: userId })
        .andWhere(
          "(subscription_provider IS NULL OR subscription_provider = 'apple')",
        )
        .andWhere(
          '(apple_original_transaction_id IS NULL OR apple_original_transaction_id = :otid)',
          { otid: originalTransactionId },
        )
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

    return (result.affected ?? 0) > 0 ? 'claimed' : 'conflict';
  }

  /**
   * Identity- AND period-guarded terminal clear for an Apple subscription
   * expiry/revocation. Clears ACTIVE ownership (provider, tier→free, status→
   * canceled, cancel flag, plan_source) but **RETAINS
   * `apple_original_transaction_id`** as a historical store binding — per the
   * design spec's terminal-semantics rule (both stores retain the store-id
   * column so a later store-side reactivation/reconciliation can still resolve
   * the rider by OTID). Because the OTID stays and the provider is cleared to
   * NULL, a same-OTID `claimForApple` reactivation still passes both guards
   * (`subscription_provider IS NULL` and `apple_original_transaction_id = :otid`).
   *
   * The WHERE clause requires:
   *  - the row to currently be Apple-owned AND hold the exact original
   *    transaction id from the event, so a stale notification for an OTID the
   *    user has since replaced is a no-op; AND
   *  - a MONOTONIC period guard: the stored `subscription_current_period_end`
   *    must NOT be newer than the expiry THIS caller authoritatively observed.
   *    Apple reuses the SAME OTID across a reactivation, so the identity guard
   *    alone can't tell that a concurrent recovery already advanced the row to a
   *    newer entitlement. Two overlapping validations for one OTID — A sees
   *    `expired`, B sees `active` and commits a later period — must not let A's
   *    stale terminal clear drop the rider that B just recovered. Conditioning
   *    on the observed period makes A's clear match no row once B advanced it.
   *
   * Null-handling for `observedExpiresAt`:
   *  - non-null: clear when `subscription_current_period_end IS NULL OR <= the
   *    observed expiry` (a stored period at or before what A saw is not newer);
   *  - null: A observed a terminal state with NO expiry date, so it cannot prove
   *    the row is stale relative to any concrete period — clear ONLY when the
   *    stored period is also NULL, never clobbering a non-null (possibly
   *    concurrently-advanced) period.
   *
   * Returns whether a row was actually cleared (false when the identity or
   * period guard matched nothing — e.g. a concurrent recovery won).
   */
  async clearAppleTerminal(
    userId: string,
    originalTransactionId: string,
    observedExpiresAt: Date | null,
  ): Promise<boolean> {
    const qb = this.userRepo
      .createQueryBuilder()
      .update(User)
      .set({
        subscription_provider: null,
        plan_source: null,
        // apple_original_transaction_id is intentionally RETAINED (see doc).
        subscription_tier: 'free',
        subscription_status: 'canceled',
        subscription_cancel_at_period_end: false,
      })
      .where('id = :id', { id: userId })
      .andWhere("subscription_provider = 'apple'")
      .andWhere('apple_original_transaction_id = :otid', {
        otid: originalTransactionId,
      });

    if (observedExpiresAt !== null) {
      qb.andWhere(
        '(subscription_current_period_end IS NULL OR subscription_current_period_end <= :observedExpiresAt)',
        { observedExpiresAt },
      );
    } else {
      qb.andWhere('subscription_current_period_end IS NULL');
    }

    const result = await qb.execute();

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
