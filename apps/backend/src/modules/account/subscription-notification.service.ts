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
interface BaseNotifyJob {
  userId: string;
  /**
   * The rider's `subscription_notify_generation` at the moment this transition
   * enqueued the job. Delivery requires the row's CURRENT generation to still
   * equal this — so an ABA re-activation (which bumps the generation) drops the
   * stale earlier job, while a benign same-state redelivery (no enqueue → no
   * bump) keeps matching.
   */
  generation: number;
}

export type SubscriptionNotifyJob =
  | (BaseNotifyJob & {
      kind: 'confirmed';
      tier: BillingTier;
      periodEnd: string | null;
    })
  | (BaseNotifyJob & {
      kind: 'cancelled';
      planName: string;
      periodEnd: string | null;
    })
  | (BaseNotifyJob & {
      kind: 'billing_failed';
    });

/** Persisted statuses that still entitle the rider (paid access). */
const ENTITLING_STATUSES: ReadonlySet<User['subscription_status']> = new Set<
  User['subscription_status']
>(['active', 'trialing', 'past_due']);

/**
 * Upper bound (ms) on a single transport dispatch, deliberately below the 60s
 * subscription-lock TTL. The lease is reasserted (renewing the TTL to a full
 * window) immediately before the send, so a dispatch bounded by this can't
 * outlast the lease and be delivered after a newer transition acquired the lock —
 * the push providers (APN/FCM) otherwise have no timeout of their own.
 */
const SEND_TIMEOUT_MS = 15_000;

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
 * bound by Stripe's ~20s timeout. Two gates decide delivery, both read under the
 * lock: (1) the rider's `subscription_notify_generation` must still equal the
 * job's — a per-transition counter that bumps only when a transition enqueues a
 * notification, so an ABA re-activation gets a distinct generation and the stale
 * earlier job is dropped, while a benign same-state redelivery (no bump) keeps
 * matching; (2) the rider's current STATE must still match the announced
 * transition — catching a state change that didn't itself enqueue (so didn't bump
 * the generation). The lease is then reasserted and the transport bounded below
 * the TTL, so a dispatch can't outlive the lock (e.g. an unbounded push during a
 * Redis outage delivered after a newer transition). Individual sends swallow
 * their own transport errors (logged), matching the prior best-effort behaviour.
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
   * Deliver an enqueued subscription notification under the per-rider lock, only
   * when the rider's current generation AND state still match the announced
   * transition, reasserting the lease and bounding the transport before sending.
   */
  async deliver(job: SubscriptionNotifyJob): Promise<void> {
    await this.subscriptionLock.runExclusive(
      job.userId,
      async (manager, lease) => {
        const user = await manager
          .getRepository(User)
          .findOne({ where: { id: job.userId } });
        if (!user) {
          // Rider deleted between enqueue and delivery — nothing to notify.
          return;
        }
        if (
          user.subscription_notify_generation !== job.generation ||
          !this.stillMatches(job, user)
        ) {
          this.logger.log(
            `Dropping superseded subscription '${job.kind}' notification for user ${job.userId} (job generation ${job.generation}, current ${user.subscription_notify_generation})`,
          );
          return;
        }

        // Reassert the lease immediately before the send: a token-checked PEXPIRE
        // proves continuous ownership since acquisition AND renews the TTL to a
        // full window, so a lease lost during a Redis outage aborts here
        // (retryable) rather than letting the (bounded) transport below outlast
        // the TTL and be delivered after a newer transition took the lock.
        await lease.assertHeld();

        const periodEnd =
          'periodEnd' in job && job.periodEnd != null
            ? new Date(job.periodEnd)
            : null;

        // Bound the transport below the (just-renewed) TTL — the push providers
        // have no timeout of their own — so a hung send can't hold the lock past
        // the lease.
        await this.withSendTimeout(this.dispatch(job, user, periodEnd));
      },
    );
  }

  private async dispatch(
    job: SubscriptionNotifyJob,
    user: User,
    periodEnd: Date | null,
  ): Promise<void> {
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

  /**
   * Race a dispatch against {@link SEND_TIMEOUT_MS}. The send helpers swallow
   * their own errors (best-effort), so this only fires on a genuine HANG — it
   * rejects so BullMQ retries (the generation/state gates re-run on retry), and
   * bounds how long the send can hold the rider lock.
   */
  private async withSendTimeout(dispatch: Promise<void>): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new Error(
              `subscription notification transport exceeded ${SEND_TIMEOUT_MS}ms`,
            ),
          ),
        SEND_TIMEOUT_MS,
      );
    });
    try {
      await Promise.race([dispatch, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Whether the rider's CURRENT persisted state still matches the transition the
   * notification announces — the second delivery gate (alongside the generation
   * check), catching a state change that didn't itself enqueue a notification (so
   * left the generation untouched). A notification is sent iff it still describes
   * the rider's live state.
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
