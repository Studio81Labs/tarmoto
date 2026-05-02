import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';
import { formatSubscriptionPriceLabel } from '@tarmoto/shared';
import { User } from '../../entities/user.entity.js';
import { EmailService } from '../email/email.service.js';
import { PushService } from '../push/index.js';
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
import type { CreateCheckoutSessionDto } from './dto/create-checkout-session.dto.js';
import type { CreatePortalSessionDto } from './dto/create-portal-session.dto.js';
import type {
  RedirectUrlResponseDto,
  SubscriptionSnapshotResponseDto,
} from './dto/subscription-response.dto.js';

const INTRO_TRIAL_DAYS = 14;
type UserUpdate = Parameters<Repository<User>['update']>[1];

const PLAN_CATALOG: Record<
  BillingTier,
  {
    name: string;
    priceLabel: string;
    features: string[];
    description?: string;
    highlighted?: boolean;
  }
> = {
  free: {
    name: 'Free',
    priceLabel: formatSubscriptionPriceLabel('free'),
    features: [
      'Basic navigation',
      'Road quality overlay (limited)',
      'Hazard alerts',
      '1 active trip',
    ],
  },
  premium: {
    name: 'Premium',
    priceLabel: formatSubscriptionPriceLabel('premium'),
    highlighted: true,
    features: [
      'Unlimited trip planning',
      'Full road quality zoom',
      'Offline maps',
      'GPX export',
    ],
  },
  pro: {
    name: 'Pro',
    priceLabel: formatSubscriptionPriceLabel('pro'),
    description: 'For group organisers and power users.',
    features: [
      'Everything in Premium',
      'Unlimited group rides',
      'Priority hazard alerts',
      'Advanced analytics',
    ],
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
    private readonly email: EmailService,
    private readonly pushService: PushService,
  ) {}

  async getSubscription(
    userId: string,
  ): Promise<SubscriptionSnapshotResponseDto> {
    const user = await this.getUserById(userId);
    const liveSnapshot =
      user.stripe_customer_id != null
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

    const customerId = await this.stripe.ensureCustomer({
      existingCustomerId: user.stripe_customer_id,
      email: user.email,
      name: user.display_name,
      userId: user.id,
    });
    if (customerId !== user.stripe_customer_id) {
      user.stripe_customer_id = customerId;
      await this.userRepo.save(user);
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

    const update: UserUpdate = { updated_at: new Date() };
    if (nextCustomerId) update.stripe_customer_id = nextCustomerId;
    if (nextSubscriptionId) update.stripe_subscription_id = nextSubscriptionId;
    await this.userRepo.update(user.id, update);
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

    const update: UserUpdate = { updated_at: new Date() };
    if (customerId) update.stripe_customer_id = customerId;

    const periodEndSeconds = subscriptionPeriodEnd(subscription);
    const periodEnd: Date | null =
      periodEndSeconds != null ? new Date(periodEndSeconds * 1000) : null;

    if (isDeleted) {
      const previousTier = user.subscription_tier;
      update.stripe_subscription_id = null;
      update.subscription_tier = 'free';
      update.subscription_status = 'canceled';
      update.subscription_cancel_at_period_end = false;
      update.subscription_current_period_end = periodEnd;
      await this.userRepo.update(user.id, update);
      // Only fire the cancellation mail if the rider was actually on
      // a paid plan beforehand. Stripe also fires `customer.subscription
      // .deleted` when a free→paid trial gets aborted before activation,
      // which would otherwise bombard the user with a cancellation
      // notice for a plan they never had.
      if (previousTier !== 'free') {
        const planName = PLAN_CATALOG[previousTier]?.name ?? previousTier;
        // Fire-and-forget: a 10s Resend timeout on top of normal DB
        // I/O could push the webhook response close to Stripe's 20s
        // timeout window, triggering a retry — which would re-run
        // this handler and send the email again. The dispatch helper
        // catches its own errors; the trailing `.catch()` is a
        // belt-and-braces guard so a logger throwing inside that
        // catch can't escape as an unhandled rejection.
        this.dispatchSubscriptionCancelled(user, planName, periodEnd).catch(
          () => undefined,
        );
      }
      return;
    }

    const price = subscription.items.data[0]?.price;
    const newTier = this.tierFromPrice(price);
    const newStatus = this.statusFromSubscription(subscription.status);
    update.stripe_subscription_id = subscription.id;
    update.subscription_tier = newTier;
    update.subscription_cancel_at_period_end =
      subscription.cancel_at_period_end;
    update.subscription_current_period_end = periodEnd;
    if (subscription.status === 'trialing' && !user.billing_trial_used_at) {
      update.billing_trial_used_at = new Date();
    }

    // Atomic activation-transition claim. Stripe emits multiple
    // `customer.subscription.updated` events per period (proration
    // re-bills, payment-method changes, scheduled cancel toggles)
    // and may retry the SAME event in parallel. Two concurrent
    // handlers for the same canceled→active transition would
    // otherwise both read pre-update `subscription_status='canceled'`
    // from the in-memory `user`, both pass the
    // `!wasActiveBefore && isActiveNow` gate, and both fire the
    // confirmation email — a textbook double-send.
    //
    // Gating on a conditional UPDATE moves the check into Postgres
    // row-level locking: only one of two concurrent transactions
    // sees `subscription_status NOT IN ('active', 'trialing')` at
    // its locked-read instant; the loser sees affected: 0 and
    // skips the email. The unconditional `userRepo.update()` below
    // still runs for both so post-activation tweaks (period_end,
    // tier, cancel_at_period_end) flow through — but it does NOT
    // include `subscription_status` (see comment on the unconditional
    // update further down) so a slower handler can't overwrite the
    // status a faster handler atomically claimed.
    const willActivate =
      (newStatus === 'active' || newStatus === 'trialing') &&
      newTier !== 'free';
    let wonActivationTransition = false;
    if (willActivate) {
      const claim = await this.userRepo
        .createQueryBuilder()
        .update(User)
        .set({ subscription_status: newStatus })
        .where('id = :id', { id: user.id })
        .andWhere("subscription_status NOT IN ('active', 'trialing')")
        .execute();
      wonActivationTransition = (claim.affected ?? 0) > 0;
    }

    // Same atomic-claim pattern for past_due: Stripe retries
    // `invoice.payment_failed`-driven `customer.subscription.updated`
    // events in parallel, and an in-memory `user.subscription_status
    // !== 'past_due'` check would let two handlers both pass the gate
    // and fire duplicate `subscription_billing` pushes. The
    // conditional UPDATE serialises through Postgres row-level
    // locking; loser sees affected: 0 and skips the push.
    let wonPastDueTransition = false;
    if (newStatus === 'past_due') {
      const claim = await this.userRepo
        .createQueryBuilder()
        .update(User)
        .set({ subscription_status: 'past_due' })
        .where('id = :id', { id: user.id })
        .andWhere("subscription_status != 'past_due'")
        .execute();
      wonPastDueTransition = (claim.affected ?? 0) > 0;
    }

    // The conditional claims above are the authoritative writers of
    // `subscription_status` for active/trialing/past_due transitions.
    // For other statuses (e.g. an `updated` event landing with
    // `canceled`) neither claim runs, so the unconditional update
    // below stays responsible for writing the column — include
    // `subscription_status` only when no claim covers it.
    //
    // Why this matters: with two contradictory webhooks racing —
    // a `past_due` and an `active` for the same subscription — the
    // earlier round of this code ALSO let the unconditional update
    // re-write `subscription_status: newStatus` after the claim.
    // The slower handler's unconditional write would then overwrite
    // the faster handler's atomic transition, undoing it. Removing
    // the column from the unconditional payload makes the claim the
    // single source of truth: the row converges on whichever
    // atomic claim wrote last, instead of whichever unconditional
    // update happened to run last.
    if (!willActivate && newStatus !== 'past_due') {
      update.subscription_status = newStatus;
    }

    await this.userRepo.update(user.id, update);

    if (wonActivationTransition) {
      // Fire-and-forget for the same reason as the cancellation
      // path above — keep the webhook response well inside Stripe's
      // 20s timeout window so a slow Resend send can't trigger a
      // retry-and-duplicate-email loop. Trailing `.catch()` belts-
      // and-braces against an unhandled rejection escaping if the
      // helper's own logger ever throws.
      this.dispatchSubscriptionConfirmed(user, newTier, periodEnd).catch(
        () => undefined,
      );
    }

    if (wonPastDueTransition) {
      this.dispatchBillingFailedPush(user.id).catch(() => undefined);
    }
  }

  private async dispatchBillingFailedPush(userId: string): Promise<void> {
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

  private async dispatchSubscriptionConfirmed(
    user: User,
    tier: BillingTier,
    renewsAt: Date | null,
  ): Promise<void> {
    const plan = PLAN_CATALOG[tier];
    try {
      await this.email.sendSubscriptionConfirmed(user.email, {
        displayName: user.display_name,
        planName: plan.name,
        priceLabel: plan.priceLabel,
        renewsAt,
        manageBillingUrl: this.subscriptionPageUrl(),
      });
    } catch (err) {
      this.logger.warn(
        `Subscription-confirmed email failed for user ${user.id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  private async dispatchSubscriptionCancelled(
    user: User,
    planName: string,
    endsAt: Date | null,
  ): Promise<void> {
    try {
      await this.email.sendSubscriptionCancelled(user.email, {
        displayName: user.display_name,
        planName,
        endsAt,
        resubscribeUrl: this.subscriptionPageUrl(),
      });
    } catch (err) {
      this.logger.warn(
        `Subscription-cancelled email failed for user ${user.id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
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
    const currentPlanMeta = PLAN_CATALOG[currentTier];

    return {
      current_plan: {
        tier: currentTier,
        name: currentPlanMeta.name,
        status: currentStatus,
        price_label: currentPlanMeta.priceLabel,
        renews_at:
          liveSnapshot?.currentPlan?.renewsAt ??
          user.subscription_current_period_end?.toISOString() ??
          null,
        cancel_at_period_end:
          liveSnapshot?.currentPlan?.cancelAtPeriodEnd ??
          user.subscription_cancel_at_period_end,
      },
      plans: (
        Object.entries(PLAN_CATALOG) as Array<
          [BillingTier, (typeof PLAN_CATALOG)[BillingTier]]
        >
      ).map(([tier, plan]) => ({
        tier,
        name: plan.name,
        price_label: plan.priceLabel,
        features: plan.features,
        ...(plan.description ? { description: plan.description } : {}),
        ...(plan.highlighted ? { highlighted: plan.highlighted } : {}),
      })),
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
          status: invoice.status,
          invoice_url: invoice.invoiceUrl,
        })) ?? [],
      portal_available: Boolean(user.stripe_customer_id),
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
    if (price.lookup_key === 'pro') return 'pro';
    if (price.lookup_key === 'premium') return 'premium';

    const premiumPriceId =
      this.config.get<string>('TARMOTO_STRIPE_PREMIUM_PRICE_ID')?.trim() ??
      null;
    const proPriceId =
      this.config.get<string>('TARMOTO_STRIPE_PRO_PRICE_ID')?.trim() ?? null;

    if (proPriceId && price.id === proPriceId) return 'pro';
    if (premiumPriceId && price.id === premiumPriceId) return 'premium';
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
