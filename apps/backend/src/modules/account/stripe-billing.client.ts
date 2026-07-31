import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
import type { SubscriptionTier } from '@tarmoto/shared';

export const STRIPE_BILLING_CLIENT = Symbol('STRIPE_BILLING_CLIENT');

type StripeClient = InstanceType<typeof Stripe>;
type StripeWebhookEvent = ReturnType<
  StripeClient['webhooks']['constructEvent']
>;
type StripeCheckoutCompletedEvent = Extract<
  StripeWebhookEvent,
  { type: 'checkout.session.completed' }
>;
export type StripeCheckoutSession =
  StripeCheckoutCompletedEvent['data']['object'];
type StripeSubscriptionLifecycleEvent = Extract<
  StripeWebhookEvent,
  {
    type:
      | 'customer.subscription.created'
      | 'customer.subscription.updated'
      | 'customer.subscription.deleted';
  }
>;
export type StripeSubscription =
  StripeSubscriptionLifecycleEvent['data']['object'];
type StripeCustomer = Awaited<
  ReturnType<StripeClient['customers']['retrieve']>
>;
type StripeInvoice = Awaited<
  ReturnType<StripeClient['invoices']['list']>
>['data'][number];
type StripePrice = StripeSubscription['items']['data'][number]['price'];
type StripePortalAfterCompletion = {
  type: 'redirect';
  redirect: { return_url: string };
};
type StripePortalFlowData =
  | {
      type: 'payment_method_update';
      after_completion?: StripePortalAfterCompletion;
    }
  | {
      type: 'subscription_cancel';
      subscription_cancel: { subscription: string };
      after_completion?: StripePortalAfterCompletion;
    }
  | {
      type: 'subscription_update';
      subscription_update: { subscription: string };
      after_completion?: StripePortalAfterCompletion;
    };
type StripePortalSessionParams = {
  customer: string;
  return_url: string;
  configuration?: string;
  flow_data?: StripePortalFlowData;
};

export type BillingTier = SubscriptionTier;
export type BillingStatus = 'active' | 'trialing' | 'past_due' | 'canceled';
export type InvoiceStatus = 'paid' | 'open' | 'refunded';
export type BillingPortalFlowType =
  | 'manage'
  | 'payment_method_update'
  | 'subscription_cancel'
  | 'subscription_update';

export interface StripeBillingSnapshot {
  currentPlan: {
    tier: BillingTier;
    status: BillingStatus;
    renewsAt: string | null;
    cancelAtPeriodEnd: boolean;
  } | null;
  paymentMethod: {
    brand: string;
    last4: string;
    expMonth: number;
    expYear: number;
  } | null;
  invoices: Array<{
    id: string;
    date: string;
    amountMinor: number;
    currency: string;
    amountLabel: string;
    status: InvoiceStatus;
    invoiceUrl: string | null;
  }>;
}

export interface StripeBillingClient {
  ensureCustomer(input: {
    existingCustomerId: string | null;
    email: string;
    name: string;
    userId: string;
  }): Promise<string>;
  getBillingSnapshot(input: {
    customerId: string;
    subscriptionId: string | null;
  }): Promise<StripeBillingSnapshot>;
  createCheckoutSession(input: {
    customerId: string;
    priceId: string;
    successUrl: string;
    cancelUrl: string;
    userId: string;
    tier: Exclude<BillingTier, 'free'>;
    trialDays: number | null;
  }): Promise<{ url: string }>;
  createPortalSession(input: {
    customerId: string;
    returnUrl: string;
    flow: null | {
      type: Exclude<BillingPortalFlowType, 'manage'>;
      subscriptionId?: string | undefined;
      afterCompletionUrl?: string | undefined;
    };
  }): Promise<{ url: string }>;
  getSubscriptionStatus(
    subscriptionId: string,
  ): Promise<BillingStatus | 'missing'>;
  cancelSubscription(subscriptionId: string): Promise<void>;
  setCancelAtPeriodEnd(subscriptionId: string, cancel: boolean): Promise<void>;
  refundOrVoidLatestInvoice(
    subscriptionId: string,
  ): Promise<'refunded' | 'voided' | 'noop'>;
  deleteCustomer(customerId: string): Promise<void>;
  isConfigured(): boolean;
  constructWebhookEvent(payload: Buffer, signature: string): StripeWebhookEvent;
}

@Injectable()
export class StripeNodeBillingClient implements StripeBillingClient {
  private readonly stripe: StripeClient | null;
  private readonly webhookSecret: string | null;
  private readonly portalConfigurationId: string | null;
  private readonly premiumPriceId: string | null;
  private readonly proPriceId: string | null;

  constructor(private readonly config: ConfigService) {
    const secretKey = this.config
      .get<string>('TARMOTO_STRIPE_SECRET_KEY')
      ?.trim();
    this.stripe = secretKey
      ? new Stripe(secretKey, { apiVersion: '2026-04-22.dahlia' })
      : null;
    this.webhookSecret =
      this.config.get<string>('TARMOTO_STRIPE_WEBHOOK_SECRET')?.trim() ?? null;
    this.portalConfigurationId =
      this.config
        .get<string>('TARMOTO_STRIPE_PORTAL_CONFIGURATION_ID')
        ?.trim() ?? null;
    this.premiumPriceId =
      this.config.get<string>('TARMOTO_STRIPE_PREMIUM_PRICE_ID')?.trim() ??
      null;
    this.proPriceId =
      this.config.get<string>('TARMOTO_STRIPE_PRO_PRICE_ID')?.trim() ?? null;
  }

  async ensureCustomer(input: {
    existingCustomerId: string | null;
    email: string;
    name: string;
    userId: string;
  }): Promise<string> {
    const stripe = this.requireStripe();
    if (input.existingCustomerId) {
      return input.existingCustomerId;
    }

    const customer = await stripe.customers.create({
      email: input.email,
      name: input.name,
      metadata: { user_id: input.userId },
    });

    return customer.id;
  }

  async getBillingSnapshot(input: {
    customerId: string;
    subscriptionId: string | null;
  }): Promise<StripeBillingSnapshot> {
    const stripe = this.requireStripe();
    const [customer, subscriptions, invoices] = await Promise.all([
      stripe.customers.retrieve(input.customerId, {
        expand: ['invoice_settings.default_payment_method'],
      }),
      stripe.subscriptions.list({
        customer: input.customerId,
        status: 'all',
        limit: 10,
        expand: ['data.default_payment_method', 'data.items.data.price'],
      }),
      stripe.invoices.list({
        customer: input.customerId,
        limit: 12,
      }),
    ]);

    const currentSubscription = pickCurrentSubscription(
      subscriptions.data,
      input.subscriptionId,
    );

    return {
      currentPlan: currentSubscription
        ? {
            tier: priceToTier(
              currentSubscription.items.data[0]?.price,
              this.premiumPriceId,
              this.proPriceId,
            ),
            status: normalizeSubscriptionStatus(currentSubscription.status),
            renewsAt:
              subscriptionPeriodEnd(currentSubscription) != null
                ? new Date(
                    subscriptionPeriodEnd(currentSubscription)! * 1000,
                  ).toISOString()
                : null,
            cancelAtPeriodEnd: currentSubscription.cancel_at_period_end,
          }
        : null,
      paymentMethod: extractPaymentMethod(
        currentSubscription?.default_payment_method ??
          (isDeletedCustomer(customer)
            ? null
            : customer.invoice_settings.default_payment_method),
      ),
      invoices: invoices.data.map((invoice) => {
        const amountMinor = invoice.amount_paid || invoice.amount_due;
        const currency = (invoice.currency ?? 'usd').toUpperCase();
        return {
          id: invoice.id ?? `invoice-${invoice.created}`,
          date: new Date(invoice.created * 1000).toISOString(),
          amountMinor,
          currency,
          amountLabel: formatAmountLabel(amountMinor, currency),
          status: normalizeInvoiceStatus(invoice.status),
          invoiceUrl: invoice.invoice_pdf ?? invoice.hosted_invoice_url ?? null,
        };
      }),
    };
  }

  /**
   * Retrieve the CURRENT status of a single subscription, normalized to our
   * `BillingStatus`. Returns `'missing'` when the subscription no longer
   * exists on Stripe (`resource_missing`, e.g. it was superseded and Stripe
   * has already purged it). Used by the two-session conflict path to tell a
   * stale STORED subscription (superseded/ended) from one that is still live,
   * which decides whether an incoming subscription is a legitimate
   * resubscription (re-claim) or a live duplicate (cancel + refund).
   */
  async getSubscriptionStatus(
    subscriptionId: string,
  ): Promise<BillingStatus | 'missing'> {
    const stripe = this.requireStripe();
    try {
      const subscription = await stripe.subscriptions.retrieve(subscriptionId);
      return normalizeSubscriptionStatus(subscription.status);
    } catch (err) {
      if (isResourceMissing(err)) {
        return 'missing';
      }
      throw err;
    }
  }

  async createCheckoutSession(input: {
    customerId: string;
    priceId: string;
    successUrl: string;
    cancelUrl: string;
    userId: string;
    tier: Exclude<BillingTier, 'free'>;
    trialDays: number | null;
  }): Promise<{ url: string }> {
    const stripe = this.requireStripe();
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: input.customerId,
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      allow_promotion_codes: true,
      line_items: [{ price: input.priceId, quantity: 1 }],
      metadata: {
        user_id: input.userId,
        tier: input.tier,
      },
      subscription_data: {
        metadata: {
          user_id: input.userId,
          tier: input.tier,
        },
        ...(input.trialDays
          ? {
              trial_period_days: input.trialDays,
              trial_settings: {
                end_behavior: {
                  missing_payment_method: 'cancel' as const,
                },
              },
            }
          : {}),
      },
    });

    if (!session.url) {
      throw new ServiceUnavailableException(
        'Stripe checkout did not return a redirect URL',
      );
    }

    return { url: session.url };
  }

  async createPortalSession(input: {
    customerId: string;
    returnUrl: string;
    flow: null | {
      type: Exclude<BillingPortalFlowType, 'manage'>;
      subscriptionId?: string | undefined;
      afterCompletionUrl?: string | undefined;
    };
  }): Promise<{ url: string }> {
    const stripe = this.requireStripe();
    const params: StripePortalSessionParams = {
      customer: input.customerId,
      return_url: input.returnUrl,
    };
    if (this.portalConfigurationId) {
      params.configuration = this.portalConfigurationId;
    }
    if (input.flow) {
      params.flow_data = buildPortalFlowData(input.flow);
    }

    const session = await stripe.billingPortal.sessions.create(params);

    return { url: session.url };
  }

  isConfigured(): boolean {
    return this.stripe != null;
  }

  /**
   * Immediately cancel a subscription. Used when an account is being
   * hard-deleted — the rider has already passed the 30-day grace
   * period, so we don't bother with `cancel_at_period_end`. Tolerates
   * already-cancelled subscriptions (Stripe returns `resource_missing`
   * if the subscription was cancelled out-of-band, e.g. via the
   * customer portal).
   */
  async cancelSubscription(subscriptionId: string): Promise<void> {
    const stripe = this.requireStripe();
    try {
      await stripe.subscriptions.cancel(subscriptionId);
    } catch (err) {
      if (isResourceMissing(err)) {
        return;
      }
      throw err;
    }
  }

  /**
   * Toggle `cancel_at_period_end` on a subscription. Unlike
   * `cancelSubscription`, this is reversible — the subscription stays
   * active until the end of the current period and the toggle can be
   * flipped back. THROWS a service-unavailable error when billing isn't
   * configured (rather than silently succeeding): callers on the
   * account-deletion path treat a silent no-op as success and would then
   * NEVER open the `deletion_cancel_failed` reconciliation, leaving a
   * locked-out rider's renewal enabled. Tolerates a subscription that's
   * already gone the same way `cancelSubscription` does.
   */
  async setCancelAtPeriodEnd(
    subscriptionId: string,
    cancel: boolean,
  ): Promise<void> {
    const stripe = this.requireStripe();
    try {
      await stripe.subscriptions.update(subscriptionId, {
        cancel_at_period_end: cancel,
      });
    } catch (err) {
      if (isResourceMissing(err)) {
        return;
      }
      throw err;
    }
  }

  /**
   * Undo the losing side of a two-session exclusivity conflict: refund
   * the subscription's latest invoice if Stripe already collected
   * payment for it, or void it if it's still open and uncollected.
   * Returns `'noop'` when billing isn't configured, when there's no
   * invoice to act on, or when the invoice is in some other state
   * (draft, uncollectible, already void) that neither a refund nor a
   * void applies to.
   */
  async refundOrVoidLatestInvoice(
    subscriptionId: string,
  ): Promise<'refunded' | 'voided' | 'noop'> {
    if (!this.stripe) {
      return 'noop';
    }

    const invoices = await this.stripe.invoices.list({
      subscription: subscriptionId,
      limit: 1,
      expand: ['data.payments.data.payment.charge'],
    });
    const invoice = invoices.data[0];
    if (!invoice) {
      return 'noop';
    }

    if (invoice.status === 'paid') {
      const refundTarget = latestInvoiceRefundTarget(invoice);
      if (!refundTarget) {
        return 'noop';
      }
      try {
        await this.stripe.refunds.create(refundTarget);
      } catch (err) {
        // Idempotency: a redelivered two-session-conflict webhook can retry
        // the refund against a charge Stripe has ALREADY refunded, which
        // raises a `StripeInvalidRequestError` with code
        // `charge_already_refunded`. The desired end-state (the charge is
        // refunded) already holds, so treat it as success rather than
        // letting the webhook 500 and wedge in permanent retry. Only this
        // specific already-refunded case is swallowed — every other error
        // still propagates.
        if (!isChargeAlreadyRefunded(err)) {
          throw err;
        }
      }
      return 'refunded';
    }

    if (invoice.status === 'open') {
      await this.stripe.invoices.voidInvoice(invoice.id);
      return 'voided';
    }

    return 'noop';
  }

  /**
   * Delete the Stripe customer record entirely. Stripe cascades any
   * remaining subscriptions and detaches payment methods. Tolerates a
   * customer that is already gone (idempotent re-runs of the sweeper).
   */
  async deleteCustomer(customerId: string): Promise<void> {
    const stripe = this.requireStripe();
    try {
      await stripe.customers.del(customerId);
    } catch (err) {
      if (isResourceMissing(err)) {
        return;
      }
      throw err;
    }
  }

  constructWebhookEvent(
    payload: Buffer,
    signature: string,
  ): StripeWebhookEvent {
    const stripe = this.requireStripe();
    if (!this.webhookSecret) {
      throw new ServiceUnavailableException(
        'Stripe webhook secret is not configured',
      );
    }
    return stripe.webhooks.constructEvent(
      payload,
      signature,
      this.webhookSecret,
    );
  }

  private requireStripe(): StripeClient {
    if (!this.stripe) {
      throw new ServiceUnavailableException('Billing is not configured');
    }
    return this.stripe;
  }
}

function buildPortalFlowData(flow: {
  type: Exclude<BillingPortalFlowType, 'manage'>;
  subscriptionId?: string | undefined;
  afterCompletionUrl?: string | undefined;
}): StripePortalFlowData {
  const afterCompletion =
    flow.afterCompletionUrl != null
      ? {
          type: 'redirect' as const,
          redirect: { return_url: flow.afterCompletionUrl },
        }
      : undefined;

  if (flow.type === 'payment_method_update') {
    return {
      type: 'payment_method_update',
      ...(afterCompletion ? { after_completion: afterCompletion } : {}),
    };
  }

  if (!flow.subscriptionId) {
    throw new ServiceUnavailableException(
      `Stripe portal flow ${flow.type} requires a subscription id`,
    );
  }

  if (flow.type === 'subscription_cancel') {
    return {
      type: 'subscription_cancel',
      subscription_cancel: {
        subscription: flow.subscriptionId,
      },
      ...(afterCompletion ? { after_completion: afterCompletion } : {}),
    };
  }

  return {
    type: 'subscription_update',
    subscription_update: {
      subscription: flow.subscriptionId,
    },
    ...(afterCompletion ? { after_completion: afterCompletion } : {}),
  };
}

function pickCurrentSubscription(
  subscriptions: StripeSubscription[],
  preferredId: string | null,
): StripeSubscription | null {
  if (preferredId) {
    const match = subscriptions.find(
      (subscription) => subscription.id === preferredId,
    );
    if (match) return match;
  }

  const active = subscriptions.find((subscription) =>
    ['trialing', 'active', 'past_due', 'unpaid'].includes(subscription.status),
  );
  return active ?? subscriptions[0] ?? null;
}

function extractPaymentMethod(
  paymentMethod: unknown,
): StripeBillingSnapshot['paymentMethod'] {
  if (!isCardPaymentMethod(paymentMethod)) return null;

  return {
    brand: paymentMethod.card.brand,
    last4: paymentMethod.card.last4,
    expMonth: paymentMethod.card.exp_month,
    expYear: paymentMethod.card.exp_year,
  };
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

function normalizeSubscriptionStatus(status: string): BillingStatus {
  if (status === 'trialing') return 'trialing';
  if (status === 'past_due' || status === 'unpaid') return 'past_due';
  if (status === 'active') return 'active';
  return 'canceled';
}

function isResourceMissing(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    err.code === 'resource_missing'
  );
}

/**
 * A Stripe `StripeInvalidRequestError` raised when a refund is attempted
 * against a charge that has already been fully refunded. Detected by
 * Stripe's stable `charge_already_refunded` error code so a redelivered
 * conflict webhook can treat the retry as a successful no-op.
 */
function isChargeAlreadyRefunded(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    err.code === 'charge_already_refunded'
  );
}

/**
 * The Stripe API dropped the top-level `invoice.charge` field; the
 * charge for the default (auto-generated) payment now lives at
 * `invoice.payments.data[0].payment.charge` — but per the Stripe SDK
 * types, that field is only populated when the payment is NOT
 * associated with a PaymentIntent. Modern card/SCA subscription
 * invoices in this app ARE PaymentIntent-backed, so `charge` comes
 * back `undefined` and the refundable id lives at
 * `payment.payment_intent` instead. Prefer `charge` when present
 * (both are bare ids unless expanded into full objects) and fall
 * back to `payment_intent`.
 */
function latestInvoiceRefundTarget(
  invoice: StripeInvoice,
): { charge: string } | { payment_intent: string } | null {
  const payment = invoice.payments?.data[0]?.payment;
  if (!payment) return null;

  const { charge } = payment;
  if (charge) {
    return { charge: typeof charge === 'string' ? charge : charge.id };
  }

  const { payment_intent: paymentIntent } = payment;
  if (paymentIntent) {
    return {
      payment_intent:
        typeof paymentIntent === 'string' ? paymentIntent : paymentIntent.id,
    };
  }

  return null;
}

function normalizeInvoiceStatus(
  status: StripeInvoice['status'],
): InvoiceStatus {
  if (status === 'void' || status === 'uncollectible') return 'refunded';
  if (status === 'open' || status === 'draft') return 'open';
  return 'paid';
}

function priceToTier(
  price: StripePrice | undefined,
  premiumPriceId: string | null,
  proPriceId: string | null,
): BillingTier {
  if (!price || ('deleted' in price && price.deleted)) return 'free';
  // Configured price IDs win over lookup keys — same precedence (and
  // rationale) as `AccountService.tierFromPrice`: env vars are
  // per-environment and re-pointed with the 2026-07 tier-name swap,
  // while Stripe lookup keys may still carry the pre-swap pairing.
  if (proPriceId && price.id === proPriceId) return 'pro';
  if (premiumPriceId && price.id === premiumPriceId) return 'premium';
  if (price.lookup_key === 'pro') return 'pro';
  if (price.lookup_key === 'premium') return 'premium';
  return 'free';
}

function formatAmountLabel(amount: number, currency: string | null): string {
  const formatter = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: (currency ?? 'usd').toUpperCase(),
  });
  return formatter.format(amount / 100);
}

function isDeletedCustomer(
  customer: StripeCustomer,
): customer is Extract<StripeCustomer, { deleted: true }> {
  return 'deleted' in customer && customer.deleted === true;
}

function isCardPaymentMethod(paymentMethod: unknown): paymentMethod is {
  type: 'card';
  card: {
    brand: string;
    last4: string;
    exp_month: number;
    exp_year: number;
  };
} {
  if (paymentMethod == null || typeof paymentMethod !== 'object') return false;
  if (!('type' in paymentMethod) || paymentMethod.type !== 'card') return false;
  if (!('card' in paymentMethod) || paymentMethod.card == null) return false;

  const card = paymentMethod.card;
  return (
    typeof card === 'object' &&
    'brand' in card &&
    typeof card.brand === 'string' &&
    'last4' in card &&
    typeof card.last4 === 'string' &&
    'exp_month' in card &&
    typeof card.exp_month === 'number' &&
    'exp_year' in card &&
    typeof card.exp_year === 'number'
  );
}
