import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { formatSubscriptionPriceLabel } from '@tarmoto/shared';
import { User } from '../../entities/user.entity.js';
import type { BillingTier } from './stripe-billing.client.js';
import { EmailService } from '../email/email.service.js';
import { PushService } from '../push/index.js';
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
 * Durable subscription-notification job payloads. Each is DECIDED under the
 * per-rider subscription-mutation lock and carries the rider's
 * `subscription_lock_fence` value at decision time (`fenceToken`); the consumer
 * DROPS the send if a NEWER event has since advanced the row's fence past this
 * token (see {@link SubscriptionNotificationService.deliver}). Dates are ISO
 * strings — BullMQ JSON-serialises payloads, so `Date` would arrive as a string
 * anyway; making it explicit keeps the type honest.
 */
export type SubscriptionNotifyJob =
  | {
      kind: 'confirmed';
      userId: string;
      tier: BillingTier;
      periodEnd: string | null;
      fenceToken: number;
    }
  | {
      kind: 'cancelled';
      userId: string;
      planName: string;
      periodEnd: string | null;
      fenceToken: number;
    }
  | {
      kind: 'billing_failed';
      userId: string;
      fenceToken: number;
    };

/**
 * Sends subscription lifecycle notifications (confirmation / cancellation email,
 * billing-failed push) that were decided under the per-rider subscription lock
 * but must be delivered OUTSIDE it — awaiting the ~10s email/push I/O inside the
 * Stripe webhook handler would risk Stripe's ~20s timeout and a retry-driven
 * duplicate (why the previous inline sends were fire-and-forget, which is what
 * lets a stale send outlive the lock).
 *
 * {@link deliver} is the consumer entry point (called by the queue processor).
 * It re-reads the rider and DROPS the send if a newer event has advanced
 * `users.subscription_lock_fence` past the enqueued token — so a cancellation
 * can't be delivered after a reactivation, nor a confirmation after a deletion —
 * then dispatches by kind. Individual sends swallow their own transport errors
 * (logged), matching the prior best-effort behaviour.
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
  ) {}

  /**
   * Deliver an enqueued subscription notification, revalidating the rider fence
   * first so a notification superseded by a newer subscription event is dropped
   * rather than delivered out of order.
   */
  async deliver(job: SubscriptionNotifyJob): Promise<void> {
    const user = await this.userRepo.findOne({ where: { id: job.userId } });
    if (!user) {
      // Rider deleted between enqueue and delivery — nothing to notify.
      return;
    }
    // The enqueuing flow stamped the row's fence to its own token before
    // deciding to send; a STRICTLY GREATER current fence means a newer,
    // serialized event committed after this one, superseding it. `>` (not `>=`)
    // so the flow that enqueued this exact notification still delivers it.
    if (user.subscription_lock_fence > job.fenceToken) {
      this.logger.log(
        `Dropping superseded subscription '${job.kind}' notification for user ${job.userId} (enqueued fence ${job.fenceToken} < current ${user.subscription_lock_fence})`,
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
