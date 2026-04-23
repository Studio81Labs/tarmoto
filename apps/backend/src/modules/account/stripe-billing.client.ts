import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';

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

export type BillingTier = 'free' | 'premium' | 'pro';
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
      subscriptionId?: string;
      afterCompletionUrl?: string;
    };
  }): Promise<{ url: string }>;
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
      ? new Stripe(secretKey, { apiVersion: '2026-03-25.dahlia' })
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
      invoices: invoices.data.map((invoice) => ({
        id: invoice.id ?? `invoice-${invoice.created}`,
        date: new Date(invoice.created * 1000).toISOString(),
        amountLabel: formatAmountLabel(
          invoice.amount_paid || invoice.amount_due,
          invoice.currency,
        ),
        status: normalizeInvoiceStatus(invoice.status),
        invoiceUrl: invoice.invoice_pdf ?? invoice.hosted_invoice_url ?? null,
      })),
    };
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
      subscriptionId?: string;
      afterCompletionUrl?: string;
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
  subscriptionId?: string;
  afterCompletionUrl?: string;
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
  if (price.lookup_key === 'pro' || (proPriceId && price.id === proPriceId)) {
    return 'pro';
  }
  if (
    price.lookup_key === 'premium' ||
    (premiumPriceId && price.id === premiumPriceId)
  ) {
    return 'premium';
  }
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
