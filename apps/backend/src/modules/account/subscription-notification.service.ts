import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import {
  formatSubscriptionPriceLabel,
  type SubscriptionProvider,
} from '@tarmoto/shared';
import { User } from '../../entities/user.entity.js';
import { StoreSubscription } from '../../entities/store-subscription.entity.js';
import type { BillingTier } from './stripe-billing.client.js';
import { EmailService } from '../email/email.service.js';
import { PushService } from '../push/index.js';
import { SubscriptionMutationLockService } from './subscription-mutation-lock.service.js';
import { StoreChainWriterService } from './store-chain-writer.service.js';
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
  /**
   * The BILLING SOURCE this notification is about — its provider and the
   * source's stable identity (the Stripe subscription id, or a chain's
   * `target_key`). {@link SubscriptionNotificationService.stillMatches}
   * validates the job against THAT source, because rider-level state cannot
   * answer per-source questions once both sides can exist: a store-only
   * purchase confirmation read against the Stripe-owned `users` columns sees
   * `canceled`/`free` and is discarded as superseded, and an Apple chain's
   * cancellation under a live Stripe representative looks like "still
   * entitled" and is discarded too — in both cases a valid notice lost.
   *
   * Optional ONLY for jobs enqueued before delivery became source-aware (a
   * rolling-deploy skew window); those validate with the legacy rider-level
   * predicate. Every new enqueue must carry it.
   */
  source?: {
    provider: SubscriptionProvider;
    identity: string;
  };
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
 * bound by Stripe's ~20s timeout. It first PUBLISHES its (higher) fence so an
 * older webhook that lost its lease and stalled can't land a guarded write during
 * delivery. Two gates then decide delivery, both read under the lock: (1) the rider's `subscription_notify_generation` must still equal the
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
    // Owns the chain-liveness vocabulary (config-bounded fallback window), so
    // the store branches below judge a chain by the SAME rule every other
    // reader does.
    private readonly storeChains: StoreChainWriterService,
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
        // Confirm we are STILL the holder before reading the rider. Since #1138
        // acquisition itself stamps the fence, so an OLDER webhook that lost its
        // lease is already locked out at the DB — its guarded UPDATE no longer
        // matches. What this adds is the early abort: if OUR lease was the one
        // lost, stop now rather than read state and send a notification decided
        // from it while the legitimate holder is changing that state.
        await lease.assertFenceCurrent();

        const user = await manager
          .getRepository(User)
          .findOne({ where: { id: job.userId } });
        if (!user) {
          // Rider deleted between enqueue and delivery — nothing to notify.
          return;
        }
        if (
          user.subscription_notify_generation !== job.generation ||
          !(await this.stillMatches(job, user, manager))
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
   *
   * RESIDUAL (accepted): this bounds our WAIT, not the underlying request — the
   * push SDKs (`@parse/node-apn`, `firebase-admin`) expose no per-call
   * abort/timeout, so a hung send may still complete in the background after this
   * rejects. A truly cancellable transport would need replacing those SDKs with
   * raw abortable HTTP (out of this change's scope). The exposure is small and
   * self-correcting: a >15s push is almost always a failing/dead connection, and
   * a late orphan is gated on retry — the generation + state re-checks under the
   * lock suppress a delivery the rider's current state no longer warrants.
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
   * Whether the SOURCE the notification is about still matches the transition
   * it announces — the second delivery gate (alongside the generation check),
   * catching a state change that didn't itself enqueue a notification (so left
   * the generation untouched).
   *
   * Validated against the source the job names, never the resolved rider
   * state, which fails in both directions: an Apple Pro chain cancelled while
   * Stripe Premium remains representative leaves the resolved state unchanged
   * (the cancellation notice would be discarded as superseded), and a
   * confirmation for a lower-tier second source can never match the resolved
   * tier. The `users.subscription_*` columns are the STRIPE side, so they
   * answer only for a `stripe` source.
   */
  private async stillMatches(
    job: SubscriptionNotifyJob,
    user: User,
    manager: EntityManager,
  ): Promise<boolean> {
    const source = job.source;
    if (!source) return this.legacyStillMatches(job, user);
    if (source.provider === 'stripe') {
      return this.stripeSourceStillMatches(job, user, source.identity);
    }
    // A store source is judged by ITS chain row, read under the same per-rider
    // lock as the rest of delivery. Chains are keyed by `target_key`, the one
    // identity every chain has (an unidentified chain has no original id).
    const chain = await manager.getRepository(StoreSubscription).findOne({
      where: {
        user_id: job.userId,
        provider: source.provider,
        target_key: source.identity,
      },
    });
    switch (job.kind) {
      case 'confirmed':
        // Valid iff THIS chain is currently subscribed at the announced tier
        // and still entitling. `past_due` deliberately does not confirm,
        // mirroring the Stripe rule.
        return (
          chain != null &&
          (chain.status === 'active' || chain.status === 'trialing') &&
          chain.tier === job.tier &&
          this.storeChains.isChainCurrentlyLive(chain)
        );
      case 'cancelled':
        // Valid iff THIS chain will not charge again — a chain that resumed
        // future billing since the enqueue makes the notice stale. A canceled
        // chain still ENTITLING to its paid period end is exactly the state a
        // cancellation notice describes, so entitlement is not the test.
        return chain == null || !this.storeChains.isChainFutureBilling(chain);
      case 'billing_failed':
        return chain?.status === 'past_due';
    }
  }

  /**
   * A `stripe` source, judged by the `users` billing columns — which ARE the
   * Stripe side — scoped to the subscription the job names. The identity scope
   * is what keeps a notice about subscription X from being judged against a
   * successor: `clearStripeTerminal` nulls the stored id, so after a real
   * cancellation nothing matches the identity and the notice stays valid.
   */
  private stripeSourceStillMatches(
    job: SubscriptionNotifyJob,
    user: User,
    identity: string,
  ): boolean {
    const isNamedSubscription = user.stripe_subscription_id === identity;
    switch (job.kind) {
      case 'confirmed':
        return (
          isNamedSubscription &&
          (user.subscription_status === 'active' ||
            user.subscription_status === 'trialing') &&
          user.subscription_tier === job.tier
        );
      case 'cancelled':
        // Valid iff the named subscription is NOT currently the rider's
        // entitling Stripe side (a reactivation of that same subscription
        // since then makes it stale).
        return !(
          isNamedSubscription &&
          ENTITLING_STATUSES.has(user.subscription_status)
        );
      case 'billing_failed':
        return isNamedSubscription && user.subscription_status === 'past_due';
    }
  }

  /**
   * The pre-source rider-level validation, kept verbatim for jobs already in
   * the queue when source-aware delivery deploys (they carry no `source`).
   * Correct for them by construction: every such job was enqueued by the
   * Stripe webhook path while the `users` columns were the only billing state.
   */
  private legacyStillMatches(job: SubscriptionNotifyJob, user: User): boolean {
    const entitling = ENTITLING_STATUSES.has(user.subscription_status);
    switch (job.kind) {
      case 'confirmed':
        return (
          (user.subscription_status === 'active' ||
            user.subscription_status === 'trialing') &&
          user.subscription_tier === job.tier
        );
      case 'cancelled':
        return !entitling;
      case 'billing_failed':
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
