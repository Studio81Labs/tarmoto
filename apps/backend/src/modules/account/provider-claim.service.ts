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
   */
  async claimForApple(
    userId: string,
    originalTransactionId: string,
    fields: AppleClaimFields,
  ): Promise<'claimed' | 'conflict'> {
    const result = await this.userRepo
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

    return (result.affected ?? 0) > 0 ? 'claimed' : 'conflict';
  }

  /**
   * Identity-guarded terminal clear for an Apple subscription expiry/
   * revocation. The WHERE clause requires the row to currently be
   * Apple-owned AND hold the exact original transaction id from the
   * event, so a stale notification for an original transaction id the
   * user has since replaced (a superseded/re-subscribed id) is a no-op
   * instead of wiping the current, still-active subscription.
   *
   * Returns whether a row was actually cleared.
   */
  async clearAppleTerminal(
    userId: string,
    originalTransactionId: string,
  ): Promise<boolean> {
    const result = await this.userRepo
      .createQueryBuilder()
      .update(User)
      .set({
        subscription_provider: null,
        plan_source: null,
        apple_original_transaction_id: null,
        subscription_tier: 'free',
        subscription_status: 'canceled',
        subscription_cancel_at_period_end: false,
      })
      .where('id = :id', { id: userId })
      .andWhere("subscription_provider = 'apple'")
      .andWhere('apple_original_transaction_id = :otid', {
        otid: originalTransactionId,
      })
      .execute();

    return (result.affected ?? 0) > 0;
  }
}
