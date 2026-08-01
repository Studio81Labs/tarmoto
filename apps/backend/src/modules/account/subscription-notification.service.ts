import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { formatSubscriptionPriceLabel } from '@tarmoto/shared';
import { User } from '../../entities/user.entity.js';
import type { BillingTier } from './stripe-billing.client.js';
import { EmailService } from '../email/email.service.js';
import { PushService } from '../push/index.js';
import { SubscriptionMutationLockService } from './subscription-mutation-lock.service.js';
import { getCompanionUrl } from '../../common/companion-url.js';

const BILLING_PLAN_META: Record<
  BillingTier,
  { name: string; priceLabel: string }
> = {
  free: { name: 'Free', priceLabel: formatSubscriptionPriceLabel('free') },
  pro: { name: 'Pro', priceLabel: formatSubscriptionPriceLabel('pro') },
  premium: {
    name: 'Premium',
    priceLabel: formatSubscriptionPriceLabel('premium'),
  },
};

/**
 * Durable subscription-notification job payloads. Each announces a subscription
 * TRANSITION decided under the per-rider lock; the consumer revalidates the
 * rider's CURRENT state against what the notification announces before sending
 * (see {@link SubscriptionNotificationService.deliver}). Dates are ISO strings —
 * BullMQ JSON-serialises payloads, so `Date` would arrive as a string anyway;
 * making it explicit keeps the type honest.
 */
export type SubscriptionNotifyJob =
  | {
      kind: 'confirmed';
      userId: string;
      tier: BillingTier;
      periodEnd: string | null;
    }
  | {
      kind: 'cancelled';
      userId: string;
      planName: string;
      periodEnd: string | null;
    }
  | {
      kind: 'billing_failed';
      userId: string;
    };

/** Persisted statuses that still entitle the rider (paid access). */
const ENTITLING_STATUSES: ReadonlySet<User['subscription_status']> = new Set<
  User['subscription_status']
>(['active', 'trialing', 'past_due']);

/**
 * Sends subscription lifecycle notifications (confirmation / cancellation email,
 * billing-failed push) that were decided under the per-rider subscription lock
 * but must be delivered OUTSIDE it — awaiting the ~10s email/push I/O inside the
 * Stripe webhook handler would risk Stripe's ~20s timeout and a retry-driven
 * duplicate (why the previous inline sends were fire-and-forget, which is what
 * lets a stale send outlive the lock).
 *
 * {@link deliver} is the consumer entry point (called by the queue processor).
 * It runs under the SAME per-rider lock the deciding flow used — which the WORKER
 * can hold across the send because, unlike the Stripe webhook handler, it isn't
 * bound by Stripe's ~20s timeout. Holding the lock through the send means no
 * concurrent transition can commit between the state re-check and the send
 * completing (closing the check-then-send race), and the re-check compares the
 * rider's CURRENT subscription STATE against what the notification announces (NOT
 * a fence token, which every webhook bumps — even a same-state redelivery — and
 * would wrongly drop a still-valid notification). A notification whose announced
 * transition no longer matches the current state is dropped; otherwise it is
 * delivered. Individual sends swallow their own transport errors (logged),
 * matching the prior best-effort behaviour.
 */
@Injectable()
export class SubscriptionNotificationService {
  private readonly logger = new Logger(SubscriptionNotificationService.name);

  constructor(
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    private readonly email: EmailService,
    private readonly pushService: PushService,
    private readonly config: ConfigService,
    private readonly subscriptionLock: SubscriptionMutationLockService,
  ) {}

  /**
   * Deliver an enqueued subscription notification. Runs under the per-rider lock
   * held through the send so no concurrent transition can interleave, and only
   * sends when the rider's CURRENT state still matches the announced transition.
   */
  async deliver(job: SubscriptionNotifyJob): Promise<void> {
    await this.subscriptionLock.runExclusive(job.userId, async (manager) => {
      const user = await manager
        .getRepository(User)
        .findOne({ where: { id: job.userId } });
      if (!user) {
        // Rider deleted between enqueue and delivery — nothing to notify.
        return;
      }
      if (!this.stillMatches(job, user)) {
        this.logger.log(
          `Dropping superseded subscription '${job.kind}' notification for user ${job.userId} — current state no longer matches the announced transition`,
        );
        return;
      }

      const periodEnd =
        'periodEnd' in job && job.periodEnd != null
          ? new Date(job.periodEnd)
          : null;

      switch (job.kind) {
        case 'confirmed':
          await this.sendConfirmed(user, job.tier, periodEnd);
          return;
        case 'cancelled':
          await this.sendCancelled(user, job.planName, periodEnd);
          return;
        case 'billing_failed':
          await this.sendBillingFailedPush(user.id);
          return;
      }
    });
  }

  /**
   * Whether the rider's CURRENT persisted state still matches the transition the
   * notification announces. This — not a fence token — is the delivery gate: a
   * notification is sent iff it still describes the rider's live state, so a
   * benign same-state webhook redelivery never drops a valid notification, and an
   * opposite transition (committed before this runs, under the lock we now hold)
   * correctly suppresses a now-stale one.
   */
  private stillMatches(job: SubscriptionNotifyJob, user: User): boolean {
    const entitling = ENTITLING_STATUSES.has(user.subscription_status);
    switch (job.kind) {
      case 'confirmed':
        // A confirmation is valid iff the rider is currently actively subscribed
        // at the announced tier (an upgrade/downgrade or cancellation since then
        // makes it stale).
        return (
          (user.subscription_status === 'active' ||
            user.subscription_status === 'trialing') &&
          user.subscription_tier === job.tier
        );
      case 'cancelled':
        // A cancellation is valid iff the rider is currently NOT entitled (a
        // reactivation since then makes it stale).
        return !entitling;
      case 'billing_failed':
        // A billing-failure push is valid iff the rider is currently past_due (a
        // recovery to active since then makes it stale).
        return user.subscription_status === 'past_due';
    }
  }

  private subscriptionPageUrl(): string {
    return `${getCompanionUrl(this.config)}/settings/subscription`;
  }

  private async sendConfirmed(
    user: User,
    tier: BillingTier,
    renewsAt: Date | null,
  ): Promise<void> {
    const plan = BILLING_PLAN_META[tier];
    if (!plan) {
      // Unreachable — `tier` is always a known billing plan — but keeps the
      // strict indexed-access checker happy without a non-null assertion.
      return;
    }
    try {
      await this.email.sendSubscriptionConfirmed(
        user.email,
        {
          displayName: user.display_name,
          planName: plan.name,
          priceLabel: plan.priceLabel,
          renewsAt,
          manageBillingUrl: this.subscriptionPageUrl(),
        },
        user.language,
      );
    } catch (err) {
      this.logger.warn(
        `Subscription-confirmed email failed for user ${user.id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  private async sendCancelled(
    user: User,
    planName: string,
    endsAt: Date | null,
  ): Promise<void> {
    try {
      await this.email.sendSubscriptionCancelled(
        user.email,
        {
          displayName: user.display_name,
          planName,
          endsAt,
          resubscribeUrl: this.subscriptionPageUrl(),
        },
        user.language,
      );
    } catch (err) {
      this.logger.warn(
        `Subscription-cancelled email failed for user ${user.id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  private async sendBillingFailedPush(userId: string): Promise<void> {
    try {
      await this.pushService.sendToUser(userId, {
        category: 'subscription_billing',
        title: 'Payment failed',
        body: "We couldn't charge your card for Tarmoto. Update your payment method to keep your subscription active.",
        data: {
          type: 'subscription_billing',
          status: 'past_due',
        },
      });
    } catch (err) {
      this.logger.warn(
        `subscription_billing push failed for user ${userId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}
