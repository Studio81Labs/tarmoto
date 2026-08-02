import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { ConfigService } from '@nestjs/config';
import { JOB_NAMES, QUEUE_NAMES } from '../jobs/jobs.constants.js';
import { DEFAULT_JOB_OPTIONS } from '../jobs/jobs.config.js';
import type { SubscriptionNotifyJob } from './subscription-notification.service.js';
import { EntityManager, IsNull, LessThanOrEqual, Repository } from 'typeorm';
import {
  formatSubscriptionPriceLabel,
  managedByForProvider,
  SUBSCRIPTION_TIERS,
} from '@tarmoto/shared';
import { User } from '../../entities/user.entity.js';
import { getCompanionUrl } from '../../common/companion-url.js';
import {
  STRIPE_BILLING_CLIENT,
  type StripeCheckoutSession,
  type StripeSubscription,
  type BillingStatus,
  type BillingTier,
  type StripeBillingClient,
  type StripeBillingSnapshot,
} from './stripe-billing.client.js';
import {
  ProviderClaimService,
  assertSubscriptionFenceCurrent,
} from './provider-claim.service.js';
import { StoreReconciliationService } from './store-reconciliation.service.js';
import {
  SubscriptionMutationLockService,
  type SubscriptionLockLease,
} from './subscription-mutation-lock.service.js';
import type { CreateCheckoutSessionDto } from './dto/create-checkout-session.dto.js';
import type { CreatePortalSessionDto } from './dto/create-portal-session.dto.js';
import type {
  RedirectUrlResponseDto,
  SubscriptionSnapshotResponseDto,
} from './dto/subscription-response.dto.js';

const INTRO_TRIAL_DAYS = 14;
type UserUpdate = Parameters<Repository<User>['update']>[1];

// Shape of the fresh, post-claim re-read both the normal activation-transition
// lost-guard handler and the resubscription-reclaim lost-guard handler consult
// to decide whether a 0-row trialing grant lost SOLELY because
// `billing_trial_used_at` was already set (see `isIneligibleTrialRejection`).
type TrialGuardRow = Pick<
  User,
  | 'subscription_status'
  | 'subscription_provider'
  | 'stripe_subscription_id'
  | 'billing_trial_used_at'
>;

// Billing-email variables stay server-owned; client-facing subscription copy
// is derived from the stable tier in each surface's locale catalog.
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

@Injectable()
export class AccountService {
  private readonly logger = new Logger(AccountService.name);

  constructor(
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    @Inject(STRIPE_BILLING_CLIENT)
    private readonly stripe: StripeBillingClient,
    private readonly config: ConfigService,
    private readonly providerClaim: ProviderClaimService,
    private readonly storeReconciliation: StoreReconciliationService,
    private readonly subscriptionLock: SubscriptionMutationLockService,
    // Subscription lifecycle notifications (confirmation/cancellation email,
    // billing-failed push) are DECIDED here under the lock but ENQUEUED for
    // out-of-lock delivery (the consumer revalidates the fence before sending),
    // so a stale send can't outlive a newer event and the ~10s send never risks
    // Stripe's webhook timeout.
    @InjectQueue(QUEUE_NAMES.SUBSCRIPTION_NOTIFY)
    private readonly notifyQueue: Queue,
  ) {}

  /**
   * Enqueue a subscription notification for durable, fence-revalidated delivery
   * (see {@link SubscriptionNotifyJob}). Awaited so the job is durably enqueued
   * under the lock (its fence is already stamped), but a Redis hiccup only
   * downgrades to a lost best-effort notification — never fails the committed
   * subscription mutation.
   */
  /**
   * Atomically bump the rider's per-transition NOTIFICATION GENERATION and return
   * the new value, to stamp on the notification job about to be enqueued. Called
   * under the per-rider lock (after `lease.assertHeld()`), so the increment is
   * serialized; the consumer delivers a job only while the row's generation still
   * equals the stamped value, so an ABA re-activation (a fresh bump) drops the
   * stale earlier job while a benign same-state redelivery (no enqueue → no bump)
   * keeps matching.
   */
  private async nextNotifyGeneration(
    userId: string,
    manager: EntityManager,
    fenceToken: number,
  ): Promise<number> {
    // FENCE-GUARDED like every other guarded write: if this UPDATE waited for a
    // pool connection until our Redis lease lapsed and a newer holder (higher
    // fence) committed + enqueued first, `subscription_lock_fence <= :fence` now
    // matches 0 rows. Minting a generation anyway would stamp the OLDER
    // transition as the NEWEST — the worker would then drop the real latest job
    // and deliver this stale one. A 0-row result is that lost-lease case: abort
    // retryable so the flow re-drives under a fresh lease.
    const result: unknown = await manager.query(
      `UPDATE users
          SET subscription_notify_generation = subscription_notify_generation + 1
        WHERE id = $1 AND subscription_lock_fence <= $2
        RETURNING subscription_notify_generation`,
      [userId, fenceToken],
    );
    // node-postgres via TypeORM returns `[returnedRows, affectedCount]` for an
    // UPDATE ... RETURNING (same tuple shape the lock's `publishFence` unwraps for
    // its affected count) — the RETURNING rows are the FIRST element, not the
    // tuple itself. Reading the tuple as the row array would make rows[0] an array
    // and yield generation 0, dropping every notification.
    const returnedRows: unknown = Array.isArray(result) ? result[0] : undefined;
    const rows = Array.isArray(returnedRows)
      ? (returnedRows as Array<{
          subscription_notify_generation: string | number;
        }>)
      : [];
    if (rows.length === 0) {
      throw new ServiceUnavailableException({
        message: 'Subscription service is busy. Please retry shortly.',
        retryable: true,
      });
    }
    return Number(rows[0]?.subscription_notify_generation ?? 0);
  }

  /**
   * Enqueue a subscription notification. A failed enqueue is logged and
   * swallowed rather than failing the webhook.
   *
   * RESIDUAL (accepted): the transition + generation increment have already
   * committed by here, so a swallowed enqueue loses that one notification (Stripe
   * acks and won't redeliver; a redelivery wouldn't re-win the transition
   * predicate). Fully closing this needs a transactional outbox (persist the
   * intent atomically with the transition, relay to the queue with retry) — a
   * disproportionate addition here. The exposure is minimal: this enqueue targets
   * the SAME Redis the per-rider lock + `publishFence` just succeeded against
   * milliseconds earlier, so a failure means Redis died in that tiny window; and
   * the loss is a missed email/push only — the subscription STATE is correct, so
   * it's a low-harm degradation, not a billing error. Failing the webhook instead
   * would NOT help (the retry can't re-win the already-committed transition), so
   * swallowing is the correct trade here.
   */
  private async enqueueSubscriptionNotification(
    job: SubscriptionNotifyJob,
  ): Promise<void> {
    try {
      await this.notifyQueue.add(
        JOB_NAMES.SUBSCRIPTION_NOTIFY_SEND,
        job,
        DEFAULT_JOB_OPTIONS,
      );
    } catch (err) {
      this.logger.warn(
        `Failed to enqueue subscription '${job.kind}' notification for user ${job.userId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  async getSubscription(
    userId: string,
  ): Promise<SubscriptionSnapshotResponseDto> {
    const user = await this.getUserById(userId);
    return this.getSubscriptionSnapshotForUser(user);
  }

  /**
   * Builds the subscription snapshot for an ALREADY-LOADED `User` row, rather
   * than re-reading it by id. Callers that must make an entitling decision and
   * return a snapshot reflecting THAT SAME decision (e.g.
   * `IapValidateService`'s stale/clear-loss success paths) load the row once
   * and pass it here — a separate re-read would reopen a window for a
   * concurrent terminal clear to land between the decision and the read,
   * letting a free/canceled snapshot be returned as a success.
   */
  async getSubscriptionSnapshotForUser(
    user: User,
  ): Promise<SubscriptionSnapshotResponseDto> {
    // Live Stripe reads are Stripe-owned-row behavior only: a row explicitly
    // claimed by a store provider ('apple'/'google') is never queried against
    // Stripe. A null `subscription_provider` with a stripe_customer_id is a
    // legacy row from before the column existed and still gets the live read.
    const isStripeManaged =
      user.subscription_provider === 'stripe' ||
      (user.subscription_provider == null && user.stripe_customer_id != null);
    const liveSnapshot =
      isStripeManaged && user.stripe_customer_id != null
        ? await this.stripe.getBillingSnapshot({
            customerId: user.stripe_customer_id,
            subscriptionId: user.stripe_subscription_id,
          })
        : null;

    return this.buildSubscriptionSnapshot(user, liveSnapshot);
  }

  async createCheckoutSession(
    userId: string,
    dto: CreateCheckoutSessionDto,
  ): Promise<RedirectUrlResponseDto> {
    const user = await this.getUserById(userId);
    // A store provider (Apple/Google) OWNS the subscription slot regardless of
    // the current tier. During a Play hold/pause the tier can transiently read
    // `free`/`canceled` while the store still owns billing — creating a Stripe
    // subscription here would double-bill. The provider gate (not just the
    // paid-plan check below, which only inspects tier/status) blocks that.
    if (
      user.subscription_provider === 'apple' ||
      user.subscription_provider === 'google'
    ) {
      throw new BadRequestException(
        'Your subscription is managed through the App Store or Google Play — manage your existing subscription there',
      );
    }
    const liveSnapshot =
      user.stripe_customer_id != null
        ? await this.stripe.getBillingSnapshot({
            customerId: user.stripe_customer_id,
            subscriptionId: user.stripe_subscription_id,
          })
        : null;
    const currentTier =
      liveSnapshot?.currentPlan?.tier ?? user.subscription_tier;
    const currentStatus =
      liveSnapshot?.currentPlan?.status ?? user.subscription_status;

    if (
      currentTier !== 'free' &&
      ['active', 'trialing', 'past_due'].includes(currentStatus)
    ) {
      throw new BadRequestException(
        'Existing subscriptions must be changed in the billing portal',
      );
    }

    let customerId = await this.stripe.ensureCustomer({
      existingCustomerId: user.stripe_customer_id,
      email: user.email,
      name: user.display_name,
      userId: user.id,
    });
    // Persist a FRESHLY-MINTED customer id FIRST-WRITER-WINS. `ensureCustomer`
    // reuses an already-stored customer verbatim (it short-circuits on
    // `existingCustomerId`), so this branch only runs when the slot was null at
    // entry and we just created a NEW Stripe customer. Two concurrent INITIAL
    // checkouts each mint a DIFFERENT customer; an unguarded `save` lets the
    // second overwrite the first — and if the OTHER session then wins the
    // subscription claim, the completion guard can no longer repair the id (the
    // column is already non-null with the wrong customer). Persist under a
    // `stripe_customer_id IS NULL` guard so only the first store lands. If we
    // did NOT win (affected 0 → a concurrent session stored first), RE-READ the
    // stored winner and use THAT for this Checkout session. Our just-created
    // Stripe customer is NOT a harmless discard: `ensureCustomer` already
    // stamped it with the rider's email, name, and `user_id` metadata, so
    // leaving it stranded strews rider PII across an orphan customer that
    // account deletion (which only removes the STORED `stripe_customer_id`)
    // will never reach. DELETE the orphan we just minted before falling back to
    // the stored winner. Best-effort: `deleteCustomer` tolerates
    // `resource_missing`, but any other delete failure must NOT break checkout —
    // log and continue against the stored winner's customer. Net: both
    // concurrent sessions check out against the SAME customer and no orphan PII
    // lingers.
    if (customerId !== user.stripe_customer_id) {
      const claimed = await this.userRepo.update(
        { id: user.id, stripe_customer_id: IsNull() },
        { stripe_customer_id: customerId, updated_at: new Date() },
      );
      if (!claimed.affected) {
        const orphanCustomerId = customerId;
        const stored = await this.userRepo.findOne({
          where: { id: user.id },
          select: { id: true, stripe_customer_id: true },
        });
        if (stored?.stripe_customer_id) {
          customerId = stored.stripe_customer_id;
        }
        try {
          await this.stripe.deleteCustomer(orphanCustomerId);
        } catch (err) {
          this.logger.error(
            `Failed to delete orphan Stripe customer ${orphanCustomerId} after losing customer-claim race`,
            err instanceof Error ? err.stack : String(err),
          );
        }
      }
    }

    return this.stripe.createCheckoutSession({
      customerId,
      priceId: this.priceIdForTier(dto.tier),
      successUrl: `${this.subscriptionPageUrl()}?checkout=success`,
      cancelUrl: `${this.subscriptionPageUrl()}?checkout=canceled`,
      userId: user.id,
      tier: dto.tier,
      trialDays: this.isIntroTrialEligible(user) ? INTRO_TRIAL_DAYS : null,
    });
  }

  async createPortalSession(
    userId: string,
    dto: CreatePortalSessionDto,
  ): Promise<RedirectUrlResponseDto> {
    const user = await this.getUserById(userId);
    // A store provider (Apple/Google) OWNS the subscription slot even if a
    // lingering `stripe_customer_id` from a prior Stripe touch survives on the
    // row. The Stripe billing portal is Stripe-only; routing a store-managed
    // rider into it would let them "manage" a subscription Stripe does not own.
    // Gate on provider BEFORE creating any portal session — the same class of
    // guard `createCheckoutSession` applies, and it mirrors the snapshot's
    // `portal_available` gate so the API is safe-by-default.
    if (
      user.subscription_provider === 'apple' ||
      user.subscription_provider === 'google'
    ) {
      throw new BadRequestException(
        'Your subscription is managed through the App Store or Google Play — manage your existing subscription there',
      );
    }
    if (!user.stripe_customer_id) {
      throw new BadRequestException(
        'Billing has not been set up for this account',
      );
    }

    const flow = dto.flow ?? 'manage';
    const redirectUrl = this.subscriptionPageUrl();

    if (flow === 'manage') {
      return this.stripe.createPortalSession({
        customerId: user.stripe_customer_id,
        returnUrl: redirectUrl,
        flow: null,
      });
    }

    if (
      (flow === 'subscription_cancel' || flow === 'subscription_update') &&
      !user.stripe_subscription_id
    ) {
      throw new BadRequestException(
        'This account does not have an active subscription to manage',
      );
    }

    return this.stripe.createPortalSession({
      customerId: user.stripe_customer_id,
      returnUrl: redirectUrl,
      flow: {
        type: flow,
        subscriptionId: user.stripe_subscription_id ?? undefined,
        afterCompletionUrl: redirectUrl,
      },
    });
  }

  async handleWebhook(payload: Buffer, signature: string): Promise<void> {
    const event = this.stripe.constructWebhookEvent(payload, signature);

    if (event.type === 'checkout.session.completed') {
      await this.handleCheckoutCompleted(event.data.object);
      return;
    }

    if (
      event.type === 'customer.subscription.created' ||
      event.type === 'customer.subscription.updated' ||
      event.type === 'customer.subscription.deleted'
    ) {
      await this.handleSubscriptionUpdated(
        event.data.object,
        event.type === 'customer.subscription.deleted',
      );
    }
  }

  private async handleCheckoutCompleted(
    session: StripeCheckoutSession,
  ): Promise<void> {
    const userId = session.metadata?.['user_id'];
    if (!userId) return;
    const nextCustomerId =
      typeof session.customer === 'string' ? session.customer : null;
    const nextSubscriptionId =
      typeof session.subscription === 'string' ? session.subscription : null;
    const user = await this.findUserForSubscriptionEvent(
      nextCustomerId,
      userId,
    );
    if (!user) return;

    if (!nextCustomerId && !nextSubscriptionId) return;

    // `stripe_customer_id` identifies the CUSTOMER, not the subscription
    // ownership slot — but it is still FIRST-WRITER-WINS, not unconditional.
    // Two racing INITIAL Checkout requests (before any customer id is stored)
    // create DIFFERENT Stripe customers; a delayed/redelivered
    // `checkout.session.completed` for the LOSING session would otherwise
    // overwrite the stored winner's customer id, so later billing snapshots and
    // portal sessions would target the loser's customer (wrong payment methods,
    // wrong invoices). The loser's orphan customer/subscription is already
    // refunded + cancelled by the two-session conflict path, so we only need to
    // stop it clobbering the slot: write the id ONLY when the slot is still
    // empty (`stripe_customer_id IS NULL`). Whichever completion lands first
    // wins; every later one no-ops. (`ensureCustomer` reuses an already-stored
    // customer id, so a non-racing subsequent checkout never mints a second
    // customer to begin with.)
    if (nextCustomerId) {
      await this.userRepo.update(
        { id: user.id, stripe_customer_id: IsNull() },
        {
          stripe_customer_id: nextCustomerId,
          updated_at: new Date(),
        },
      );
    }

    // `stripe_subscription_id` IS the ownership slot, so its write must be
    // ownership-guarded — NOT unconditional. In a two-Checkout-session race a
    // delayed/redelivered `checkout.session.completed` for the LOSING session
    // would otherwise overwrite the stored winner id with the loser's; the
    // loser's later `customer.subscription.deleted` would then satisfy
    // `clearStripeTerminal`'s identity guard (stored id now matches the loser)
    // and wipe the still-active WINNING subscription — rider charged, no
    // entitlement. Guard the write so it only lands when the slot is unclaimed
    // (or already this subscription) and not owned by another provider. This
    // mirrors `claimForStripe`, which the sibling
    // `customer.subscription.created/updated` event runs for the same id, so
    // the two writers agree on ownership.
    if (nextSubscriptionId) {
      await this.userRepo
        .createQueryBuilder()
        .update(User)
        .set({
          stripe_subscription_id: nextSubscriptionId,
          updated_at: new Date(),
        })
        .where('id = :id', { id: user.id })
        .andWhere(
          "(subscription_provider IS NULL OR subscription_provider = 'stripe')",
        )
        .andWhere(
          '(stripe_subscription_id IS NULL OR stripe_subscription_id = :sub)',
          { sub: nextSubscriptionId },
        )
        .execute();
    }
  }

  private async handleSubscriptionUpdated(
    subscription: StripeSubscription,
    isDeleted: boolean,
  ): Promise<void> {
    const customerId =
      typeof subscription.customer === 'string' ? subscription.customer : null;
    const metadataUserId = subscription.metadata?.['user_id'] ?? null;
    const user = await this.findUserForSubscriptionEvent(
      customerId,
      metadataUserId,
    );
    if (!user) return;

    // Serialise the whole event against the rider's OTHER subscription-mutation
    // flows (an Apple `iap/validate`, a future ASSN webhook, or a concurrent
    // Stripe delivery) under the per-rider lock, so their read→decide→write steps
    // can't interleave (e.g. a Stripe trial and an Apple trial both consuming the
    // once-per-rider marker). The in-flow guards stay as defense-in-depth.
    await this.subscriptionLock.runExclusive(user.id, (manager, lease) =>
      this.applyStripeSubscriptionEvent(
        user,
        subscription,
        isDeleted,
        manager,
        lease,
      ),
    );
  }

  private async applyStripeSubscriptionEvent(
    resolvedUser: User,
    subscription: StripeSubscription,
    isDeleted: boolean,
    // The pool manager from the per-rider lock: DB work runs on it (a pooled
    // connection per statement, none held across an API call — see
    // `SubscriptionMutationLockService`).
    manager: EntityManager,
    // Fences the destructive Stripe compensation writes: `lease.assertHeld()` is
    // awaited immediately before each cancel/refund/setCancelAtPeriodEnd so we
    // never compensate on a lease we've lost (Redis partition). DB writes need no
    // fence — they are CAS-guarded.
    lease: SubscriptionLockLease,
  ): Promise<void> {
    const userRepo = manager.getRepository(User);
    // Publish this holder's fence FIRST — before the re-read below — so a
    // lower-token straggler (an older flow that lost its Redis lease and stalled)
    // can't land its guarded UPDATE between the read and the fence publish and
    // corrupt the state this event's transition/notification decisions rest on
    // (e.g. a stale activation landing after a deletion handler read
    // `previousTier`, letting it clear a now-active subscription AND skip the
    // cancellation notice). Stamping our (higher) fence up front locks those
    // stragglers out at the DB. It tolerates a deleted rider (0-row, no row →
    // returns); the re-read then early-outs on null. If a newer holder already
    // published a higher fence, this throws a retryable 503 (Stripe redelivers).
    await lease.publishFence();

    // RE-READ the rider UNDER the advisory lock (and now behind our published
    // fence). `handleSubscriptionUpdated` resolves the rider BEFORE acquiring the
    // lock (it needs the id for the lock key), so that pre-lock snapshot can be
    // stale — e.g. a concurrent Apple terminal validation cleared the provider
    // while this event waited on the lock. Every subscription-state decision below
    // (the trial-eligibility pre-filter, ownership/exclusivity, the cancel email's
    // previous tier) must use the state as of lock acquisition, not the pre-lock
    // read; otherwise a stale "Apple-owned" snapshot would skip the
    // ineligible-trial re-read and let `claimForStripe` grant a second trial on
    // the now-cleared slot.
    const user = await userRepo.findOne({ where: { id: resolvedUser.id } });
    // Deleted/purged between the pre-lock resolve and acquiring the lock.
    if (!user) return;

    const customerId =
      typeof subscription.customer === 'string' ? subscription.customer : null;

    const update: UserUpdate = { updated_at: new Date() };
    if (customerId) update.stripe_customer_id = customerId;

    const periodEndSeconds = subscriptionPeriodEnd(subscription);
    const periodEnd: Date | null =
      periodEndSeconds != null ? new Date(periodEndSeconds * 1000) : null;

    if (isDeleted) {
      const previousTier = user.subscription_tier;
      // Identity-guarded terminal clear: the guard only fires when the row
      // is still Stripe-owned AND holds this exact subscription id, so a
      // stale `customer.subscription.deleted` for a subscription the rider
      // has since replaced (a superseded/re-subscribed id) is a no-op and
      // can't wipe the current, still-active subscription. It is the
      // authoritative writer of the reset fields (provider, plan_source,
      // subscription id, tier, status, cancel flag).
      const cleared = await this.providerClaim.clearStripeTerminal(
        user.id,
        subscription.id,
        lease.fenceToken,
        manager,
      );
      // Only fire the cancellation mail when the clear actually happened
      // (a stale/superseded terminal returns false → no clear, no email)
      // AND the rider was actually on a paid plan beforehand. Stripe also
      // fires `customer.subscription.deleted` when a free→paid trial gets
      // aborted before activation, which would otherwise bombard the user
      // with a cancellation notice for a plan they never had.
      if (cleared && previousTier !== 'free') {
        const planName = BILLING_PLAN_META[previousTier].name;
        // Reassert the lease before enqueuing: if we lost it after the guarded
        // clear and a newer delivery reactivated the rider, we must NOT enqueue a
        // cancellation over the newer active state. A lost lease throws
        // (retryable) before the enqueue.
        await lease.assertHeld();
        // Enqueue for durable, out-of-lock delivery carrying this transition's
        // notification generation: the consumer drops it if a newer transition
        // has bumped the generation (a reactivation) or the state no longer
        // matches, so a cancellation can't outlive it — and the send never runs
        // inline where a slow Resend call could push the webhook past Stripe's
        // ~20s timeout and trigger a duplicate.
        const generation = await this.nextNotifyGeneration(
          user.id,
          manager,
          lease.fenceToken,
        );
        await this.enqueueSubscriptionNotification({
          kind: 'cancelled',
          userId: user.id,
          planName,
          periodEnd: periodEnd?.toISOString() ?? null,
          generation,
        });
      }
      return;
    }

    const price = subscription.items.data[0]?.price;
    const newTier = this.tierFromPrice(price);
    const newStatus = this.statusFromSubscription(subscription.status);
    // The tier now comes from Stripe, so record 'subscription' provenance
    // (a launch-granted 'founder' who converts to paid becomes a paying
    // customer in the admin view). An unmapped price resolves to 'free',
    // which has no plan to attribute — clear the marker.
    const planSource = newTier === 'free' ? null : 'subscription';
    // A `trialing` activation consumes the rider's single free trial, so the
    // once-per-rider marker must be stamped — but ATOMICALLY, in the SAME guarded
    // UPDATE that grants the tier (below), never in a separate follow-up
    // statement. The prior code granted the tier in the activation UPDATE and
    // stamped `billing_trial_used_at` in a LATER `userRepo.update`; an
    // overlapping terminal Stripe delivery clearing the slot between the two
    // statements left a window where an Apple trial validation could satisfy
    // `claimForApple`'s `billing_trial_used_at IS NULL` guard and grant a SECOND
    // trial. Folding the stamp into the grant UPDATE closes that window. The fold
    // uses `COALESCE(billing_trial_used_at, NOW())`, so it is safe to apply on
    // EVERY trial activation: an already-set marker (a re-subscription into a
    // trial, or a marker set concurrently between our read and write) is
    // preserved, never re-dated (idempotent, monotonic).
    const isTrialActivation = subscription.status === 'trialing';

    // Atomic activation-transition claim — the winner-only gate for the
    // confirmation email. Stripe emits multiple `customer.subscription
    // .updated` events per period (proration re-bills, payment-method
    // changes, scheduled cancel toggles) and may retry the SAME event in
    // parallel. Two concurrent handlers for the same canceled→active
    // transition would otherwise both read pre-update `subscription_status
    // ='canceled'` from the in-memory `user`, both pass the
    // `!wasActiveBefore && isActiveNow` gate, and both fire the
    // confirmation email — a textbook double-send.
    //
    // Gating on a conditional UPDATE moves the check into Postgres
    // row-level locking: only one of two concurrent transactions sees
    // `subscription_status NOT IN ('active', 'trialing')` at its
    // locked-read instant; the loser sees affected: 0 and skips the
    // email. The Stripe-ownership + subscription-identity guards are
    // ANDed in so this claim can't spuriously flip status (or fire an
    // email) for a losing two-session event that the exclusivity claim
    // below rejects.
    //
    // Critically, this claim ALSO writes `subscription_provider='stripe'`
    // and `stripe_subscription_id` — it doesn't just flip status. That
    // makes the transition winner LOCK ownership of the slot: a second
    // session with a DIFFERENT id can then no longer win `claimForStripe`
    // below (its `stripe_subscription_id IS NULL OR = :sub` guard now
    // fails). Without this, the transition winner and the exclusivity
    // winner could DIVERGE — one handler wins the status-claim but loses
    // `claimForStripe` (returning at the conflict branch before
    // dispatching), while the true owner has `wonActivationTransition=
    // false` — dropping the confirmation entirely. Locking ownership here
    // guarantees the status-claim winner IS the `claimForStripe` winner,
    // so exactly one handler both owns the row and sends the email.
    const willActivate =
      (newStatus === 'active' || newStatus === 'trialing') &&
      newTier !== 'free';
    let wonActivationTransition = false;
    if (willActivate) {
      // The transition claim writes ALL authoritative fields (tier, status,
      // period end, cancel flag, provider, subscription id, plan source), not
      // just status — so a crash (or a `claimForStripe` failure) right after
      // this UPDATE commits leaves a COMPLETE, correct row instead of an
      // active-status-but-no-tier/period/cancel partial one. The winner/dispatch
      // decision comes from THIS one UPDATE's `affected`; `claimForStripe` below
      // stays the conflict detector and the writer for the non-transition
      // (already-active) path, re-writing these same values idempotently.
      const claimQb = userRepo
        .createQueryBuilder()
        .update(User)
        .set({
          subscription_status: newStatus,
          subscription_provider: 'stripe',
          stripe_subscription_id: subscription.id,
          subscription_tier: newTier,
          subscription_current_period_end: periodEnd,
          subscription_cancel_at_period_end: subscription.cancel_at_period_end,
          plan_source: planSource,
          subscription_lock_fence: lease.fenceToken,
          // Fold the once-per-rider trial marker into the SAME atomic grant so
          // the tier and the marker commit together (see `isTrialActivation`).
          // COALESCE preserves an already-set stamp, so this never re-dates an
          // earlier trial; omitted entirely for a non-trial activation, leaving
          // the column untouched.
          ...(isTrialActivation
            ? {
                billing_trial_used_at: () =>
                  'COALESCE(billing_trial_used_at, NOW())',
              }
            : {}),
        })
        .where('id = :id', { id: user.id })
        .andWhere("subscription_status NOT IN ('active', 'trialing')")
        .andWhere(
          "(subscription_provider IS NULL OR subscription_provider = 'stripe')",
        )
        .andWhere(
          '(stripe_subscription_id IS NULL OR stripe_subscription_id = :sub)',
          { sub: subscription.id },
        )
        // Fence: a lease-lost stale flow can't win the activation transition over
        // a newer acquisition (which resurrection depends on — see the fence doc).
        .andWhere('subscription_lock_fence <= :fence', {
          fence: lease.fenceToken,
        });
      // FINDING 2 (round 25): guard the trial GRANT on CURRENT eligibility. Round
      // 24 made the trial STAMP atomic (COALESCE) but NOT the eligibility, so if
      // an Apple trial consumed `billing_trial_used_at` (and terminal-cleared its
      // slot, freeing it) between Checkout creation and this delayed `trialing`
      // webhook, the grant still ran → the rider got BOTH trials. Requiring
      // `billing_trial_used_at IS NULL` here makes an INELIGIBLE trial activation
      // affect 0 rows; the lost-guard handler below then cancels + reconciles it
      // instead of granting. Applied ONLY to the trial-activation path — a
      // non-trial/paid activation is unaffected.
      if (isTrialActivation) {
        claimQb.andWhere('billing_trial_used_at IS NULL');
      }
      const claim = await claimQb.execute();
      wonActivationTransition = (claim.affected ?? 0) > 0;
    }

    // FINDING 2 (round 25): handle a LOST trial-eligibility guard. A `trialing`
    // activation whose grant UPDATE above affected 0 rows may have lost SOLELY
    // because `billing_trial_used_at` is already set (the rider consumed their
    // once-per-rider trial elsewhere, e.g. an Apple trial that then freed the
    // slot). Detect that specific case and cancel + reconcile INSTEAD of falling
    // through to `claimForStripe`, which — with no eligibility guard of its own —
    // would otherwise re-grant the tier on the now-free slot (the double trial
    // this finding prevents). We must distinguish it from the benign losers that
    // also produce 0 rows and MUST fall through: a concurrent delivery of the
    // SAME event that already granted the trial (the row is now live for this
    // sub), and a rival-provider/different-id exclusivity conflict (handled by
    // the `claimForStripe` 'conflict' branch, which already cancels + refunds).
    if (isTrialActivation && willActivate && !wonActivationTransition) {
      // Cheap pre-filter on the INITIAL snapshot: only the ineligible-candidate
      // shape needs the authoritative re-read — the slot is claimable by THIS
      // Stripe subscription (so `claimForStripe` below WOULD grant the tier) and
      // is not already live for the rider. A different-id resubscription reclaim
      // or a rival-provider exclusivity conflict is handled by the
      // `claimForStripe` path instead and must NOT trigger this re-read.
      const initialClaimable =
        (user.subscription_provider == null ||
          user.subscription_provider === 'stripe') &&
        (user.stripe_subscription_id == null ||
          user.stripe_subscription_id === subscription.id);
      const initialLive =
        user.subscription_status === 'active' ||
        user.subscription_status === 'trialing';
      // Not the ineligible shape (a different-id reclaim or rival-provider
      // conflict) → leave it to the existing claim/reclaim path below.
      if (initialClaimable && !initialLive) {
        const fresh = await userRepo.findOne({
          where: { id: user.id },
          select: {
            id: true,
            subscription_status: true,
            subscription_provider: true,
            stripe_subscription_id: true,
            billing_trial_used_at: true,
          },
        });
        // A concurrent delivery of THIS event legitimately granted the trial —
        // the row is now live for this rider. That is a normal idempotent loser,
        // NOT an ineligible trial: fall through so `claimForStripe` no-ops.
        // Re-confirm on the authoritative row that the slot is still claimable by
        // THIS Stripe subscription (so `claimForStripe` below WOULD grant the
        // tier on it) — as opposed to a rival-provider or different-id slot, a
        // genuine exclusivity conflict the `claimForStripe` 'conflict' branch
        // already cancels + reconciles.
        const isIneligible = this.isIneligibleTrialRejection(fresh, {
          isAlreadyLiveForRider: (row) =>
            row.subscription_status === 'active' ||
            row.subscription_status === 'trialing',
          isClaimableSlot: (row) =>
            (row.subscription_provider == null ||
              row.subscription_provider === 'stripe') &&
            (row.stripe_subscription_id == null ||
              row.stripe_subscription_id === subscription.id),
        });
        if (isIneligible) {
          // Do NOT grant the trialing tier — reject through the shared
          // lost-guard handler (also used by the resubscription-reclaim branch
          // below) and return before `claimForStripe`.
          await this.rejectIneligibleTrial(
            user.id,
            subscription.id,
            manager,
            lease,
          );
          return;
        }
      }
    }

    // Same atomic-claim pattern for past_due: Stripe retries
    // `invoice.payment_failed`-driven `customer.subscription.updated`
    // events in parallel, and an in-memory `user.subscription_status
    // !== 'past_due'` check would let two handlers both pass the gate
    // and fire duplicate `subscription_billing` pushes. The
    // conditional UPDATE serialises through Postgres row-level
    // locking; loser sees affected: 0 and skips the push. Same
    // ownership + identity guards as the activation claim — and, like it,
    // this claim also writes `subscription_provider`/`stripe_subscription_id`
    // so the transition winner locks the slot and stays aligned with the
    // `claimForStripe` winner below (no split-winner dropped push).
    let wonPastDueTransition = false;
    if (newStatus === 'past_due') {
      // Same collapse as the activation claim: write ALL authoritative fields
      // so a crash right after this UPDATE leaves a complete row, and take the
      // winner signal from this single UPDATE's `affected`.
      const claim = await userRepo
        .createQueryBuilder()
        .update(User)
        .set({
          subscription_status: 'past_due',
          subscription_provider: 'stripe',
          stripe_subscription_id: subscription.id,
          subscription_tier: newTier,
          subscription_current_period_end: periodEnd,
          subscription_cancel_at_period_end: subscription.cancel_at_period_end,
          plan_source: planSource,
          subscription_lock_fence: lease.fenceToken,
        })
        .where('id = :id', { id: user.id })
        .andWhere("subscription_status != 'past_due'")
        .andWhere(
          "(subscription_provider IS NULL OR subscription_provider = 'stripe')",
        )
        .andWhere(
          '(stripe_subscription_id IS NULL OR stripe_subscription_id = :sub)',
          { sub: subscription.id },
        )
        // Fence: a lease-lost stale flow can't win over a newer acquisition.
        .andWhere('subscription_lock_fence <= :fence', {
          fence: lease.fenceToken,
        })
        .execute();
      wonPastDueTransition = (claim.affected ?? 0) > 0;
    }

    // Did an activation/past_due transition UPDATE run for this event (i.e. is
    // this event's status one a transition claim owns)? When it did, that
    // single atomic UPDATE — not `claimForStripe` — is the authoritative status
    // writer for the row.
    const transitionAttempted = willActivate || newStatus === 'past_due';
    const wonTransition = wonActivationTransition || wonPastDueTransition;

    // Exclusivity claim: the race-safe writer of the core subscription row.
    // Its guard only allows the write when the row is unclaimed by another
    // provider AND its stored subscription id is null-or-equal to this event's
    // — so a Stripe event can never clobber an Apple/Google-owned row, and a
    // second concurrent session's DIFFERENT subscription id loses the race
    // instead of overwriting the current one.
    //
    // A TRANSITION WINNER SKIPS THIS FOLLOW-UP ENTIRELY. The transition UPDATE
    // above already wrote ALL authoritative fields (provider, subscription id,
    // tier, status, period end, cancel flag, plan source) atomically and locked
    // Stripe ownership of the row, so the winner owns the slot by construction
    // — `claimForStripe` would be redundant. Worse, it is an UNCONDITIONAL
    // re-write of `subscription_status` whose WHERE clause guards provider/id
    // ownership but NOT the status: a NEWER same-subscription event that
    // committed between our transition UPDATE and now (e.g. a concurrent
    // `past_due` after our `active`) would be clobbered back to our older
    // status. So the winner treats the claim as 'claimed' without re-writing.
    //
    // Only the NON-winner path runs `claimForStripe`: it is either already at
    // the target status (a period-only update / redelivery), a `canceled` event
    // (no transition owns `canceled`), or a two-session conflict. When a
    // transition was ATTEMPTED but lost (already-at-target active/trialing/
    // past_due), `skipStatus` refreshes only the current-event mutable fields
    // WITHOUT re-stamping a status a newer event may have superseded; when no
    // transition was attempted (`canceled`), `claimForStripe` stays the
    // authoritative status writer.
    let claimResult: 'claimed' | 'conflict';
    if (wonTransition) {
      claimResult = 'claimed';
    } else {
      claimResult = await this.providerClaim.claimForStripe(
        user.id,
        subscription.id,
        {
          tier: newTier,
          status: newStatus,
          currentPeriodEnd: periodEnd,
          cancelAtPeriodEnd: subscription.cancel_at_period_end,
          planSource,
          fenceToken: lease.fenceToken,
        },
        { skipStatus: transitionAttempted, manager },
      );
    }

    if (claimResult === 'conflict') {
      // The exclusivity claim rejected the write, so the DB row's stored
      // subscription id differs from this event's `subscription.id`.
      // `claimForStripe`'s guard matches a same-id redelivery and returns
      // 'claimed' (idempotent same-value write), so a 'conflict' ALWAYS means a
      // genuine different-id row. That is NOT automatically a duplicate to
      // refund: it is EITHER a live duplicate (the stored subscription is still
      // active) OR a legitimate resubscription (the stored subscription already
      // ended and the incoming is the rider's real new one). We resolve which
      // below from the STORED subscription's status, never from the in-memory
      // `user.stripe_subscription_id`: in the real two-session race the loser
      // can resolve the user BEFORE the winner commits, so that snapshot is
      // stale (still null/old).
      //
      // Idempotency is guarded from DB state, not the stale snapshot: if an
      // OPEN exclusivity_conflict reconciliation already exists for THIS
      // subscription id, this is a redelivered conflict already handled →
      // skip the refund and the duplicate row (idempotent no-op).
      const alreadyHandled = await this.storeReconciliation.findOpen(
        {
          provider: 'stripe',
          reason: 'exclusivity_conflict',
          stripeSubscriptionId: subscription.id,
        },
        {},
        manager,
      );
      if (alreadyHandled.length > 0) {
        // Redelivered conflict we've already reconciled — idempotent no-op
        // (skip both the Stripe calls and a duplicate reconciliation row).
        return;
      }

      // A non-active/trialing/past_due incoming is a stale/superseded event, not
      // a live subscription: a delayed `customer.subscription.updated` for a
      // subscription Stripe has ALREADY ended (`canceled`/`incomplete_expired`/
      // `ended` — all normalized to `canceled`) also returns 'conflict', but its
      // `cancelSubscription` is a no-op while `refundOrVoidLatestInvoice` would
      // claw back a LEGITIMATE past charge. Touch NO Stripe and open no
      // reconciliation.
      const incomingLive =
        newStatus === 'active' ||
        newStatus === 'trialing' ||
        newStatus === 'past_due';
      if (!incomingLive) {
        this.logger.log(
          `Ignoring stale two-session conflict for already-ended subscription ${subscription.id} (status=${newStatus}) — no refund, no cancel`,
        );
        return;
      }

      // The correct distinguisher between a LIVE DUPLICATE and a LEGITIMATE
      // RESUBSCRIPTION is the STORED subscription's current status, NOT the
      // incoming's — the incoming is live in BOTH cases (it is either the
      // rider's real new subscription or a redundant duplicate). Gating on the
      // incoming alone mis-handles a rider whose PREVIOUS subscription ended and
      // who started a NEW Checkout before the delayed
      // `customer.subscription.deleted` cleared the STORED (old) id: the new
      // active sub conflicts with the stale stored id and would be wrongly
      // cancelled/refunded. Re-read the CURRENTLY-stored id fresh from the DB
      // (the pre-claim `user` snapshot can be stale in the two-session race),
      // then ask Stripe whether that stored subscription is still live.
      const stored = await userRepo.findOne({
        where: { id: user.id },
        select: { id: true, stripe_subscription_id: true },
      });
      const storedStaleId = stored?.stripe_subscription_id ?? null;
      // With no stored Stripe subscription id the conflict is a
      // provider-ownership conflict (an Apple/Google-owned row), NOT a
      // superseded-Stripe-id one: there is nothing to supersede, so treat the
      // incoming as a live duplicate that must not persist (round-8 behavior).
      let storedStillLive = true;
      if (storedStaleId != null) {
        const storedStatus =
          await this.stripe.getSubscriptionStatus(storedStaleId);
        storedStillLive =
          storedStatus === 'active' ||
          storedStatus === 'trialing' ||
          storedStatus === 'past_due';
      }

      // The Stripe status read above is an external round-trip during which our
      // lease could be lost. Before the reclaim/duplicate compensations + their
      // reconciliation rows, bail if a newer holder has advanced the fence past
      // us (stale flow) — a retryable 503 so a fresh flow re-decides rather than
      // cancelling/refunding or reconciling on a stale verdict.
      await assertSubscriptionFenceCurrent(userRepo, user.id, lease.fenceToken);

      if (!storedStillLive) {
        // LEGITIMATE RESUBSCRIPTION: the STORED subscription has ended/canceled/
        // missing (superseded) and Stripe has not yet cleared it via
        // `customer.subscription.deleted`. The incoming subscription is the
        // rider's REAL new one. RE-CLAIM the slot for it with a guarded UPDATE
        // that only lands while the stale id is still stored (so a concurrent
        // clear/claim can't be clobbered) and the row is not owned by another
        // provider, then proceed as a normal activation. NEVER refund/cancel the
        // incoming — it is the rider's real subscription.
        const reclaimQb = userRepo
          .createQueryBuilder()
          .update(User)
          .set({
            subscription_status: newStatus,
            subscription_provider: 'stripe',
            stripe_subscription_id: subscription.id,
            subscription_tier: newTier,
            subscription_current_period_end: periodEnd,
            subscription_cancel_at_period_end:
              subscription.cancel_at_period_end,
            plan_source: planSource,
            subscription_lock_fence: lease.fenceToken,
            // First-trial stamp on the reclaim path: this branch RETURNS before
            // the orthogonal `userRepo.update(user.id, update)` below, so a
            // `trialing` replacement subscription would otherwise leave the
            // rider `trial_eligible` despite having consumed a trial. Fold the
            // SAME first-trial marker the normal activation path computes into
            // this reclaim UPDATE. COALESCE preserves an already-set stamp
            // (never re-dates it) and is a no-op when the `billing_trial_used_at
            // IS NULL` guard below rejects the write outright.
            ...(isTrialActivation
              ? {
                  billing_trial_used_at: () =>
                    'COALESCE(billing_trial_used_at, NOW())',
                }
              : {}),
          })
          .where('id = :id', { id: user.id })
          .andWhere('stripe_subscription_id = :staleSub', {
            staleSub: storedStaleId,
          })
          .andWhere(
            "(subscription_provider IS NULL OR subscription_provider = 'stripe')",
          )
          // Fence: a lease-lost stale flow can't reclaim over a newer acquisition.
          .andWhere('subscription_lock_fence <= :fence', {
            fence: lease.fenceToken,
          });
        // FINDING (round 26): guard the RECLAIM trialing GRANT on the SAME
        // current-eligibility invariant round 25 applied to the normal
        // activation transition above. Without this, a rider whose
        // `billing_trial_used_at` is already set still had the tier GRANTED
        // here (the SET above merely skipped re-dating the marker) — bypassing
        // both the normal path's eligibility guard and its lost-guard rejection,
        // letting a delayed resubscription checkout mint a SECOND trial.
        if (isTrialActivation) {
          reclaimQb.andWhere('billing_trial_used_at IS NULL');
        }
        const reclaimed = await reclaimQb.execute();

        if ((reclaimed.affected ?? 0) > 0) {
          // Dispatch the confirmation only when the re-claim actually landed
          // and the incoming is an activation. Same fire-and-forget contract as
          // the normal activation dispatch below.
          if (willActivate) {
            // Reassert the lease before enqueuing (see the activation enqueue
            // below) — never confirm over a newer holder's committed state.
            await lease.assertHeld();
            const generation = await this.nextNotifyGeneration(
              user.id,
              manager,
              lease.fenceToken,
            );
            await this.enqueueSubscriptionNotification({
              kind: 'confirmed',
              userId: user.id,
              tier: newTier,
              periodEnd: periodEnd?.toISOString() ?? null,
              generation,
            });
          }
          // The reclaim is a winning activation, so it must run the SAME
          // post-claim `deletion_scheduled_at` re-read the normal-activation
          // winner runs: a replacement subscription that activates AFTER
          // deletion was scheduled would otherwise renew/recharge on a
          // deleted/locked account with no cancel work item ever opened.
          await this.ensureDeletionCancelReconciliation(
            user.id,
            subscription.id,
            manager,
          );
          return;
        }

        // The reclaim affected ZERO rows. Before compensating, RE-READ the
        // currently-stored row to distinguish three very different causes
        // (widened select: the trial-eligibility check below needs
        // `billing_trial_used_at`/`subscription_provider`/`subscription_status`
        // alongside the id).
        const postReclaim = await userRepo.findOne({
          where: { id: user.id },
          select: {
            id: true,
            subscription_status: true,
            subscription_provider: true,
            stripe_subscription_id: true,
            billing_trial_used_at: true,
          },
        });

        // CAUSE 1 (round 26): the rider's `billing_trial_used_at` was already
        // set — the reclaim's own `billing_trial_used_at IS NULL` guard is what
        // rejected the write, NOT a stale-id race. Detected by the slot STILL
        // holding the stale id this UPDATE targeted (a real race would have
        // moved it to either this incoming id or a foreign one). Reject through
        // the SAME shared handler the normal activation path uses: never grant,
        // cancel + reconcile instead.
        //
        // FINDING (round 27): "already live for the rider" must be keyed on the
        // INCOMING subscription's identity, NOT the stored row's status. When the
        // stale subscription has ended at Stripe but its terminal
        // `customer.subscription.deleted` webhook is DELAYED, `postReclaim` can
        // legitimately still show `active`/`trialing` under `storedStaleId`. A
        // bare status check would then call the OLD subscription "already live",
        // suppress this ineligible-trial branch, and fall through to the
        // exclusivity path — which wrongly cancels/refunds the charge-free
        // incoming trial. So "already live" means the row is owned by THIS
        // incoming subscription id in a live state (the incoming trial already
        // won a concurrent delivery — CAUSE 2's shape); a stale-id row is NOT
        // live for the incoming purchase.
        if (
          isTrialActivation &&
          this.isIneligibleTrialRejection(postReclaim, {
            isAlreadyLiveForRider: (row) =>
              row.stripe_subscription_id === subscription.id &&
              (row.subscription_status === 'active' ||
                row.subscription_status === 'trialing'),
            isClaimableSlot: (row) =>
              (row.subscription_provider == null ||
                row.subscription_provider === 'stripe') &&
              row.stripe_subscription_id === storedStaleId,
          })
        ) {
          await this.rejectIneligibleTrial(
            user.id,
            subscription.id,
            manager,
            lease,
          );
          return;
        }

        // CAUSE 2: two concurrent deliveries of the SAME incoming subscription
        // both observe the terminal stored id and enter reclaim; ONE wins the
        // guarded UPDATE (the slot now holds THIS incoming id) and the OTHER's
        // UPDATE affects 0 rows *precisely because the slot now already holds
        // this same incoming id* (its `WHERE stripe_subscription_id = :staleSub`
        // no longer matches). That loser must NOT cancel/refund — doing so
        // would claw back the subscription the winning delivery legitimately
        // just claimed.
        if (postReclaim?.stripe_subscription_id === subscription.id) {
          // A concurrent delivery of THIS SAME subscription already claimed the
          // slot — the 0-row result is that race's idempotent loser, NOT a
          // foreign-owned slot. Touch no Stripe and open no conflict. Still run
          // the (deduped, idempotent) post-claim deletion re-read so a winner
          // whose `ensureDeletionCancelReconciliation` insert failed transiently
          // gets a retry, matching the winning-reclaim path above.
          await this.ensureDeletionCancelReconciliation(
            user.id,
            subscription.id,
            manager,
          );
          return;
        }

        // CAUSE 3: the slot is owned by a DIFFERENT subscription or another
        // provider (Apple/Google retains a terminal old `stripe_subscription_id`,
        // or a concurrent clear/claim moved a different id in): a genuine intruder.
        // This is NOT a safe silent return — the incoming is a LIVE Stripe
        // subscription that never took the slot, so leaving it untouched runs a
        // Stripe sub on a foreign-owned account (cross-provider double-billing).
        // Compensate it exactly like the duplicate-loser path below: cancel +
        // refund + open an `exclusivity_conflict` (deduped by the
        // `alreadyHandled` check at the top of this branch). Fence the lease
        // (atomic check-and-extend) before EACH external write so neither can run
        // on a lease we've lost, and each gets a fresh full-TTL window.
        await lease.assertHeld();
        await this.stripe.cancelSubscription(subscription.id);
        await lease.assertHeld();
        await this.stripe.refundOrVoidLatestInvoice(subscription.id);
        await this.storeReconciliation.openConflict(
          {
            userId: user.id,
            provider: 'stripe',
            stripeSubscriptionId: subscription.id,
            reason: 'exclusivity_conflict',
            detail: {
              losingSubscriptionId: subscription.id,
              reclaimUnclaimable: true,
            },
          },
          manager,
        );
        return;
      }

      // GENUINE DUPLICATE: the STORED subscription is still live, so the
      // incoming is a second, redundant subscription. Cancel AND refund it — a
      // refund alone leaves it ACTIVE to renew, recharge the rider, and keep
      // emitting conflicting webhooks, so the immediate `cancelSubscription`
      // (not `cancel_at_period_end`) is correct. It tolerates `resource_missing`,
      // so a redelivery that races an out-of-band cancel is idempotent; the
      // `findOpen` dedup above already skips both calls on a reconciled
      // redelivery. Fence the lease (atomic check-and-extend) before EACH
      // external write — never compensate on a lost lease, and each op gets a
      // fresh full-TTL window.
      await lease.assertHeld();
      await this.stripe.cancelSubscription(subscription.id);
      await lease.assertHeld();
      await this.stripe.refundOrVoidLatestInvoice(subscription.id);
      await this.storeReconciliation.openConflict(
        {
          userId: user.id,
          provider: 'stripe',
          stripeSubscriptionId: subscription.id,
          reason: 'exclusivity_conflict',
          detail: {
            losingSubscriptionId: subscription.id,
          },
        },
        manager,
      );
      return;
    }

    // Fallback trial stamp ONLY for the trial paths the atomic grant UPDATE
    // above could NOT cover: a `trialing` event that did not win the activation
    // transition (the row was already active/trialing — the winning delivery
    // already stamped atomically, so COALESCE is a no-op here), or a `trialing`
    // subscription whose price maps to no paid tier (no activation UPDATE runs).
    // The TRIAL-GRANT winner is deliberately EXCLUDED (`wonActivationTransition`)
    // so the marker is never written in a separate, race-prone statement on the
    // grant path — that atomic fold is Finding 1's fix. COALESCE keeps this
    // fallback idempotent/monotonic.
    if (isTrialActivation && !wonActivationTransition) {
      update.billing_trial_used_at = () =>
        'COALESCE(billing_trial_used_at, NOW())';
    }

    // Flush the orthogonal fields the exclusivity claim does NOT touch (customer
    // id, updated_at, the fallback trial marker above). This payload never
    // carries `subscription_status`, so a slower handler can't overwrite the
    // status the atomic claims settled — but it IS otherwise unconditional, so it
    // must ALSO be fence-guarded ATOMICALLY (a check-then-update would race): the
    // WHERE carries `subscription_lock_fence <= :fence` and the SET restamps it,
    // so a stale handler (a newer holder already advanced the fence) matches 0
    // rows and never overwrites `stripe_customer_id` with a superseded value or
    // stamps `billing_trial_used_at` from a superseded fallback-trial event. The
    // monotonic trigger protects the fence column but NOT these other fields, so
    // the predicate must live in this same statement. A 0-row result is a benign
    // skip (the newer flow already wrote the correct orthogonal fields).
    await userRepo.update(
      {
        id: user.id,
        subscription_lock_fence: LessThanOrEqual(lease.fenceToken),
      },
      { ...update, subscription_lock_fence: lease.fenceToken },
    );

    // Dispatch is gated on BOTH the exclusivity claim (`claimResult ===
    // 'claimed'` — established above; the conflict branch already returned)
    // AND the transition claim. Because the transition claim now locks
    // ownership, its winner IS the exclusivity winner, so this AND fires for
    // exactly one handler. The explicit `claimResult` check is the belt to the
    // transition claim's braces: it also suppresses the confirmation in the
    // rare window where an Apple/Google event claims the row between the
    // status-claim and `claimForStripe` (which then returns 'conflict').
    // Reassert the lease before the winner-only notifications: `won*Transition`
    // was decided earlier, and if our lease lapsed since (a newer delivery
    // committing the opposite state), we must NOT send a stale confirmation /
    // billing-failed alert. A lost lease throws (retryable) before either send.
    if (
      (claimResult === 'claimed' && wonActivationTransition) ||
      (claimResult === 'claimed' && wonPastDueTransition)
    ) {
      await lease.assertHeld();
    }
    if (claimResult === 'claimed' && wonActivationTransition) {
      // Enqueue for durable, out-of-lock delivery (see the cancellation path
      // above) instead of an inline send — keeps the webhook response well inside
      // Stripe's 20s window and lets the consumer drop a confirmation whose
      // generation/state a newer event (e.g. an immediate cancellation) has
      // superseded.
      const generation = await this.nextNotifyGeneration(
        user.id,
        manager,
        lease.fenceToken,
      );
      await this.enqueueSubscriptionNotification({
        kind: 'confirmed',
        userId: user.id,
        tier: newTier,
        periodEnd: periodEnd?.toISOString() ?? null,
        generation,
      });
    }

    if (claimResult === 'claimed' && wonPastDueTransition) {
      const generation = await this.nextNotifyGeneration(
        user.id,
        manager,
        lease.fenceToken,
      );
      await this.enqueueSubscriptionNotification({
        kind: 'billing_failed',
        userId: user.id,
        generation,
      });
    }

    // If this activation lands on an account already SCHEDULED for deletion, the
    // deletion request that stamped `deletion_scheduled_at` ran BEFORE this
    // subscription became visible on the row — so `requestDeletion` captured a
    // null subscription id and opened no cancel-flag work item. Ensure a durable
    // `deletion_cancel_failed` reconciliation exists now (deduped on any
    // already-open row for this subscription, like the exclusivity-conflict
    // path): the lock-guarded worker will re-read the still-set
    // `deletion_scheduled_at` and `setCancelAtPeriodEnd(true)`, so a
    // newly-activated subscription can't keep renewing/charging a rider whose
    // account is locked for deletion. Run on EVERY activation delivery that OWNS
    // this subscription (`claimResult === 'claimed'` + `willActivate`), NOT only
    // the transition winner: if the winner's insert failed transiently AFTER its
    // activation UPDATE committed, Stripe redelivers with
    // `wonActivationTransition=false` (the row is already active) — a
    // winner-only gate would then never retry and a locked/deleting account
    // would keep a renewable subscription. The `findOpen` dedup inside keeps a
    // redelivery idempotent when the row already exists, and the fresh
    // `deletion_scheduled_at` re-read keeps it cheap (a SELECT that returns early
    // on non-deleting accounts, which is the overwhelmingly common case).
    if (claimResult === 'claimed' && willActivate) {
      await this.ensureDeletionCancelReconciliation(
        user.id,
        subscription.id,
        manager,
      );
    }
  }

  // FINDING 2 (round 25) / FINDING (round 26): shared predicate for the
  // lost-trial-guard case. Both the normal activation transition and the
  // resubscription reclaim guard their `trialing` GRANT on
  // `billing_trial_used_at IS NULL`. When that guarded UPDATE affects 0 rows,
  // each call site re-reads the row fresh and must distinguish the INELIGIBLE
  // shape (the marker is already set, the row is not already live for the
  // rider, and the slot is otherwise still claimable by this event) from its
  // own benign 0-row losers (a concurrent delivery that already won, or a
  // genuine cross-provider/different-id conflict its own path already
  // handles). Only the ineligible shape must reject instead of granting —
  // factored out so the two call sites can't drift out of sync on what
  // "ineligible" means.
  private isIneligibleTrialRejection(
    fresh: TrialGuardRow | null,
    opts: {
      isAlreadyLiveForRider: (row: TrialGuardRow) => boolean;
      isClaimableSlot: (row: TrialGuardRow) => boolean;
    },
  ): boolean {
    if (!fresh) {
      return false;
    }
    const markerAlreadySet = fresh.billing_trial_used_at != null;
    return (
      markerAlreadySet &&
      !opts.isAlreadyLiveForRider(fresh) &&
      opts.isClaimableSlot(fresh)
    );
  }

  // The rejection side effects for a lost trial-eligibility guard, shared by
  // BOTH the normal activation-transition path and the resubscription-reclaim
  // path: cancel the (charge-free) trial via the reversible P0 cancel and open
  // a deduped `ineligible_trial_rejected` reconciliation for ops. Never a
  // refund — a trial has no charge yet, unlike the exclusivity-conflict path.
  // Deduped like that path: a redelivered ineligible trial already reconciled
  // is an idempotent no-op (skips both the Stripe cancel and a duplicate
  // reconciliation row).
  private async rejectIneligibleTrial(
    userId: string,
    subscriptionId: string,
    manager: EntityManager,
    lease: SubscriptionLockLease,
  ): Promise<void> {
    // This runs when a guarded trial-grant UPDATE affected 0 rows. If that 0-row
    // was actually a STALE FENCE (a newer holder advanced past us), rejecting the
    // trial here would open a spurious `ineligible_trial_rejected` reconciliation
    // and cancel a valid trial. Bail with a retryable 503 first so a fresh flow
    // re-decides.
    await assertSubscriptionFenceCurrent(
      manager.getRepository(User),
      userId,
      lease.fenceToken,
    );
    const alreadyHandled = await this.storeReconciliation.findOpen(
      {
        provider: 'stripe',
        reason: 'ineligible_trial_rejected',
        stripeSubscriptionId: subscriptionId,
      },
      {},
      manager,
    );
    if (alreadyHandled.length === 0) {
      // Fence the external write on the lock (never cancel on a lost lease).
      await lease.assertHeld();
      await this.stripe.setCancelAtPeriodEnd(subscriptionId, true);
      await this.storeReconciliation.openConflict(
        {
          userId,
          provider: 'stripe',
          stripeSubscriptionId: subscriptionId,
          reason: 'ineligible_trial_rejected',
        },
        manager,
      );
    }
  }

  // After WINNING a Stripe activation/reclaim, re-read the CURRENT
  // `deletion_scheduled_at` and, if the account is scheduled for deletion, open
  // a deduped `deletion_cancel_failed` reconciliation so the lock-guarded worker
  // cancels the subscription. Shared by BOTH the normal-activation winner and
  // the resubscription reclaim winner: a replacement subscription that activates
  // AFTER deletion was scheduled must open the same work item, or it renews and
  // recharges a rider whose account is locked for deletion with no work item
  // ever opened.
  private async ensureDeletionCancelReconciliation(
    userId: string,
    subscriptionId: string,
    manager: EntityManager,
  ): Promise<void> {
    // RE-READ the CURRENT `deletion_scheduled_at` from the DB rather than
    // trusting the pre-claim `user` snapshot. Race: this webhook can resolve
    // `user` with `deletion_scheduled_at = null` just before `requestDeletion`
    // locks and stamps the row; our winning activation UPDATE then WAITS on
    // that row lock, the deletion transaction commits (sees no subscription,
    // opens no cancel work item), and only then does our claim win. The stale
    // pre-claim snapshot still shows null and would skip this gate, leaving a
    // renewable subscription on a deleting account. Because the winning claim
    // UPDATE serializes against `requestDeletion`'s users-row write, this
    // post-claim SELECT reflects any deletion that committed while the claim
    // was waiting.
    const fresh = await manager.getRepository(User).findOne({
      where: { id: userId },
      select: { id: true, deletion_scheduled_at: true },
    });
    if (fresh?.deletion_scheduled_at == null) return;
    const alreadyOpen = await this.storeReconciliation.findOpen(
      {
        provider: 'stripe',
        reason: 'deletion_cancel_failed',
        stripeSubscriptionId: subscriptionId,
      },
      {},
      manager,
    );
    if (alreadyOpen.length > 0) return;
    await this.storeReconciliation.openConflict(
      {
        userId,
        provider: 'stripe',
        stripeSubscriptionId: subscriptionId,
        reason: 'deletion_cancel_failed',
        detail: {
          subscriptionId,
          opened: 'activated_during_deletion',
        },
      },
      manager,
    );
  }

  private async findUserForSubscriptionEvent(
    customerId: string | null,
    userId: string | null,
  ): Promise<User | null> {
    if (customerId) {
      const byCustomer = await this.userRepo.findOne({
        where: { stripe_customer_id: customerId },
      });
      if (byCustomer) return byCustomer;
    }

    if (userId) {
      return this.userRepo.findOne({ where: { id: userId } });
    }

    return null;
  }

  private buildSubscriptionSnapshot(
    user: User,
    liveSnapshot: StripeBillingSnapshot | null,
  ): SubscriptionSnapshotResponseDto {
    const currentTier =
      liveSnapshot?.currentPlan?.tier ?? user.subscription_tier;
    const currentStatus =
      liveSnapshot?.currentPlan?.status ?? user.subscription_status;
    // Store-managed riders (Apple/Google) must never be routed into the
    // Stripe billing portal, even if a lingering `stripe_customer_id` from a
    // prior Stripe touch survives on the row. The portal is Stripe-only;
    // gate `portal_available` on provider so the contract itself is
    // safe-by-default rather than relying on each client to re-check.
    const isStoreManaged =
      user.subscription_provider === 'apple' ||
      user.subscription_provider === 'google';
    return {
      current_plan: {
        tier: currentTier,
        status: currentStatus,
        renews_at:
          liveSnapshot?.currentPlan?.renewsAt ??
          user.subscription_current_period_end?.toISOString() ??
          null,
        cancel_at_period_end:
          liveSnapshot?.currentPlan?.cancelAtPeriodEnd ??
          user.subscription_cancel_at_period_end,
      },
      // A tier is the stable display-content identifier. Localized names,
      // features, descriptions and prices belong to each client catalog, not
      // this locale-neutral API response.
      plans: SUBSCRIPTION_TIERS.map((tier) => ({ tier })),
      payment_method: liveSnapshot?.paymentMethod
        ? {
            brand: liveSnapshot.paymentMethod.brand,
            last4: liveSnapshot.paymentMethod.last4,
            exp_month: liveSnapshot.paymentMethod.expMonth,
            exp_year: liveSnapshot.paymentMethod.expYear,
          }
        : null,
      billing_history:
        liveSnapshot?.invoices.map((invoice) => ({
          id: invoice.id,
          date: invoice.date,
          amount_label: invoice.amountLabel,
          amount_minor: invoice.amountMinor,
          currency: invoice.currency,
          status: invoice.status,
          invoice_url: invoice.invoiceUrl,
        })) ?? [],
      portal_available: !isStoreManaged && Boolean(user.stripe_customer_id),
      provider: user.subscription_provider,
      managed_by: user.subscription_provider
        ? managedByForProvider(user.subscription_provider)
        : null,
      trial_eligible: user.billing_trial_used_at == null,
    };
  }

  private async getUserById(userId: string): Promise<User> {
    const user = await this.userRepo.findOne({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('User not found');
    }
    return user;
  }

  private priceIdForTier(tier: Exclude<BillingTier, 'free'>): string {
    const envKey =
      tier === 'premium'
        ? 'TARMOTO_STRIPE_PREMIUM_PRICE_ID'
        : 'TARMOTO_STRIPE_PRO_PRICE_ID';
    const priceId = this.config.get<string>(envKey)?.trim();
    if (!priceId) {
      throw new BadRequestException(
        `Billing price for ${tier} is not configured`,
      );
    }
    return priceId;
  }

  private subscriptionPageUrl(): string {
    return `${getCompanionUrl(this.config)}/settings/subscription`;
  }

  private isIntroTrialEligible(user: User): boolean {
    return user.billing_trial_used_at == null;
  }

  private tierFromPrice(
    price: StripeSubscription['items']['data'][number]['price'] | undefined,
  ): BillingTier {
    if (!price || ('deleted' in price && price.deleted)) return 'free';

    // Configured price IDs are checked BEFORE lookup keys: the env vars
    // are per-environment and under our control, while Stripe lookup
    // keys may still carry the pre-swap (2026-07) name↔price pairing.
    // With correctly re-pointed env vars, a stale lookup key can no
    // longer flip a paid user onto the wrong tier.
    const premiumPriceId =
      this.config.get<string>('TARMOTO_STRIPE_PREMIUM_PRICE_ID')?.trim() ??
      null;
    const proPriceId =
      this.config.get<string>('TARMOTO_STRIPE_PRO_PRICE_ID')?.trim() ?? null;
    if (proPriceId && price.id === proPriceId) return 'pro';
    if (premiumPriceId && price.id === premiumPriceId) return 'premium';

    if (price.lookup_key === 'pro') return 'pro';
    if (price.lookup_key === 'premium') return 'premium';
    return 'free';
  }

  private statusFromSubscription(status: string): BillingStatus {
    if (status === 'trialing') return 'trialing';
    if (status === 'past_due' || status === 'unpaid') return 'past_due';
    if (status === 'active') return 'active';
    return 'canceled';
  }
}

function subscriptionPeriodEnd(
  subscription: StripeSubscription,
): number | null {
  const ends = subscription.items.data
    .map((item) => item.current_period_end)
    .filter((value): value is number => typeof value === 'number');
  if (ends.length === 0) return null;
  return Math.max(...ends);
}
