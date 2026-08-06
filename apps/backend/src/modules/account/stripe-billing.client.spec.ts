import { ConfigService } from '@nestjs/config';
import { StripeNodeBillingClient } from './stripe-billing.client.js';

function unconfiguredConfig(): ConfigService {
  return { get: () => undefined } as unknown as ConfigService;
}

/**
 * `StripeNodeBillingClient` has no DI seam for the Stripe SDK client
 * itself — it's built from a secret key in the constructor. Since the
 * field is only `private` at the type level (erased at runtime), tests
 * substitute a fake directly, the same way the class treats it as
 * possibly-null internally.
 */
function withFakeStripe(
  client: StripeNodeBillingClient,
  stripe: Record<string, unknown>,
): void {
  (client as unknown as { stripe: unknown }).stripe = stripe;
}

function resourceMissingError(): Error & { code: string } {
  return Object.assign(new Error('No such subscription'), {
    code: 'resource_missing',
  });
}

describe('StripeNodeBillingClient', () => {
  describe('setCancelAtPeriodEnd', () => {
    it('updates the subscription with cancel_at_period_end', async () => {
      const client = new StripeNodeBillingClient(unconfiguredConfig());
      const update = jest.fn().mockResolvedValue({});
      withFakeStripe(client, { subscriptions: { update } });

      await client.setCancelAtPeriodEnd('sub_123', true);

      expect(update).toHaveBeenCalledWith('sub_123', {
        cancel_at_period_end: true,
      });
    });

    it('swallows a resource_missing error', async () => {
      const client = new StripeNodeBillingClient(unconfiguredConfig());
      const update = jest.fn().mockRejectedValue(resourceMissingError());
      withFakeStripe(client, { subscriptions: { update } });

      await expect(
        client.setCancelAtPeriodEnd('sub_missing', false),
      ).resolves.toBeUndefined();
    });

    it('rethrows errors other than resource_missing', async () => {
      const client = new StripeNodeBillingClient(unconfiguredConfig());
      const update = jest.fn().mockRejectedValue(new Error('rate_limited'));
      withFakeStripe(client, { subscriptions: { update } });

      await expect(
        client.setCancelAtPeriodEnd('sub_123', true),
      ).rejects.toThrow('rate_limited');
    });

    it('THROWS (does not silently succeed) when Stripe is not configured', async () => {
      // On the account-deletion path a silent no-op reads as success, so
      // `requestDeletion` would open NO reconciliation and the locked-out
      // rider's renewal stays enabled. Fail loudly so the caller's catch
      // retains the failure for the retry worker.
      const client = new StripeNodeBillingClient(unconfiguredConfig());

      await expect(
        client.setCancelAtPeriodEnd('sub_123', true),
      ).rejects.toThrow('Billing is not configured');
    });
  });

  describe('getSubscriptionStatus', () => {
    it('returns the normalized status of a live subscription', async () => {
      const client = new StripeNodeBillingClient(unconfiguredConfig());
      const retrieve = jest.fn().mockResolvedValue({ status: 'active' });
      withFakeStripe(client, { subscriptions: { retrieve } });

      await expect(client.getSubscriptionStatus('sub_123')).resolves.toBe(
        'active',
      );
      expect(retrieve).toHaveBeenCalledWith('sub_123');
    });

    it("normalizes Stripe's terminal statuses to 'canceled'", async () => {
      const client = new StripeNodeBillingClient(unconfiguredConfig());
      const retrieve = jest
        .fn()
        .mockResolvedValue({ status: 'incomplete_expired' });
      withFakeStripe(client, { subscriptions: { retrieve } });

      await expect(client.getSubscriptionStatus('sub_ended')).resolves.toBe(
        'canceled',
      );
    });

    it("returns 'missing' when the subscription no longer exists (resource_missing)", async () => {
      // A superseded subscription Stripe has already purged returns
      // `resource_missing`; the conflict path relies on 'missing' to treat the
      // stored subscription as ended so the incoming can re-claim the slot.
      const client = new StripeNodeBillingClient(unconfiguredConfig());
      const retrieve = jest.fn().mockRejectedValue(resourceMissingError());
      withFakeStripe(client, { subscriptions: { retrieve } });

      await expect(client.getSubscriptionStatus('sub_gone')).resolves.toBe(
        'missing',
      );
    });

    it('rethrows errors other than resource_missing', async () => {
      const client = new StripeNodeBillingClient(unconfiguredConfig());
      const retrieve = jest.fn().mockRejectedValue(new Error('rate_limited'));
      withFakeStripe(client, { subscriptions: { retrieve } });

      await expect(client.getSubscriptionStatus('sub_123')).rejects.toThrow(
        'rate_limited',
      );
    });

    it('THROWS when Stripe is not configured', async () => {
      const client = new StripeNodeBillingClient(unconfiguredConfig());

      await expect(client.getSubscriptionStatus('sub_123')).rejects.toThrow(
        'Billing is not configured',
      );
    });
  });

  describe('getSubscription', () => {
    it('returns the RAW subscription object so callers see the un-normalised status', async () => {
      const client = new StripeNodeBillingClient(unconfiguredConfig());
      const retrieve = jest
        .fn()
        .mockResolvedValue({ id: 'sub_1', status: 'unpaid' });
      withFakeStripe(client, { subscriptions: { retrieve } });

      const result = await client.getSubscription('sub_1');

      // Raw, NOT normalised: `getSubscriptionStatus` would have collapsed this
      // to `past_due`, which the entitling-status allowlist must never see.
      expect(result).toEqual({ id: 'sub_1', status: 'unpaid' });
      expect(retrieve).toHaveBeenCalledWith('sub_1');
    });

    it("returns 'missing' when Stripe has purged the subscription", async () => {
      const client = new StripeNodeBillingClient(unconfiguredConfig());
      const retrieve = jest.fn().mockRejectedValue(resourceMissingError());
      withFakeStripe(client, { subscriptions: { retrieve } });

      await expect(client.getSubscription('sub_gone')).resolves.toBe('missing');
    });

    it('rethrows errors other than resource_missing', async () => {
      const client = new StripeNodeBillingClient(unconfiguredConfig());
      const retrieve = jest.fn().mockRejectedValue(new Error('rate_limited'));
      withFakeStripe(client, { subscriptions: { retrieve } });

      await expect(client.getSubscription('sub_1')).rejects.toThrow(
        'rate_limited',
      );
    });
  });

  describe('getBillingSnapshot', () => {
    // The snapshot's `tier` is the BILLED PRODUCT (the price alone) and its
    // `status` is normalized, so `unpaid` — which entitles nothing — collapses
    // into `past_due`, Stripe's entitling grace window. `entitling` is the
    // separate, RAW-status verdict `AccountService.buildSubscriptionSnapshot`
    // needs to keep the served plan aligned with the persisted tier that
    // `FeatureResolverService` enforces.
    function fakeStripeWithSubscription(
      status: string,
      lookupKey = 'pro',
    ): Record<string, unknown> {
      return {
        customers: {
          retrieve: jest.fn().mockResolvedValue({
            id: 'cus_1',
            invoice_settings: { default_payment_method: null },
          }),
        },
        subscriptions: {
          list: jest.fn().mockResolvedValue({
            data: [
              {
                id: 'sub_1',
                status,
                cancel_at_period_end: false,
                items: {
                  data: [
                    {
                      price: { lookup_key: lookupKey },
                      current_period_end: 1779537600,
                    },
                  ],
                },
              },
            ],
          }),
        },
        invoices: { list: jest.fn().mockResolvedValue({ data: [] }) },
      };
    }

    it.each([['active'], ['trialing'], ['past_due']])(
      'reports the live plan as entitling for the raw status %s',
      async (status) => {
        const client = new StripeNodeBillingClient(unconfiguredConfig());
        withFakeStripe(client, fakeStripeWithSubscription(status));

        const snapshot = await client.getBillingSnapshot({
          customerId: 'cus_1',
          subscriptionId: 'sub_1',
        });

        expect(snapshot.currentPlan).toMatchObject({
          tier: 'pro',
          entitling: true,
        });
      },
    );

    it.each([['unpaid'], ['incomplete'], ['incomplete_expired'], ['paused']])(
      'reports the live plan as NON-entitling for the raw status %s',
      async (status) => {
        const client = new StripeNodeBillingClient(unconfiguredConfig());
        withFakeStripe(client, fakeStripeWithSubscription(status));

        const snapshot = await client.getBillingSnapshot({
          customerId: 'cus_1',
          subscriptionId: 'sub_1',
        });

        // The BILLED tier is still reported (the checkout guard in
        // `createCheckoutSession` needs it, and the invoice list describes that
        // same billed product) — only the entitlement claim differs.
        expect(snapshot.currentPlan).toMatchObject({
          tier: 'pro',
          entitling: false,
        });
      },
    );

    it('keeps `unpaid` distinguishable from `past_due` even though both normalize to past_due', async () => {
      // The exact collapse that made a status-only check impossible: without
      // the raw-status verdict, this snapshot is byte-identical to a genuinely
      // entitling `past_due` one.
      const client = new StripeNodeBillingClient(unconfiguredConfig());
      withFakeStripe(client, fakeStripeWithSubscription('unpaid', 'premium'));

      const snapshot = await client.getBillingSnapshot({
        customerId: 'cus_1',
        subscriptionId: 'sub_1',
      });

      expect(snapshot.currentPlan).toMatchObject({
        tier: 'premium',
        status: 'past_due',
        entitling: false,
      });
    });
  });

  describe('refundOrVoidLatestInvoice', () => {
    it('refunds the charge on a paid invoice', async () => {
      const client = new StripeNodeBillingClient(unconfiguredConfig());
      const list = jest.fn().mockResolvedValue({
        data: [
          {
            id: 'in_paid',
            status: 'paid',
            payments: { data: [{ payment: { charge: 'ch_123' } }] },
          },
        ],
      });
      const create = jest.fn().mockResolvedValue({});
      withFakeStripe(client, {
        invoices: { list },
        refunds: { create },
      });

      const result = await client.refundOrVoidLatestInvoice('sub_123');

      expect(result).toBe('refunded');
      expect(list).toHaveBeenCalledWith(
        expect.objectContaining({ subscription: 'sub_123' }),
      );
      expect(create).toHaveBeenCalledWith({ charge: 'ch_123' });
    });

    it('refunds via payment_intent when the invoice payment has no charge id', async () => {
      // Regression: modern card/SCA subscription invoices are
      // PaymentIntent-backed, so `payment.charge` comes back
      // `undefined` per the Stripe SDK types and the refundable id
      // lives at `payment.payment_intent` instead.
      const client = new StripeNodeBillingClient(unconfiguredConfig());
      const list = jest.fn().mockResolvedValue({
        data: [
          {
            id: 'in_paid',
            status: 'paid',
            payments: {
              data: [{ payment: { payment_intent: 'pi_123' } }],
            },
          },
        ],
      });
      const create = jest.fn().mockResolvedValue({});
      withFakeStripe(client, {
        invoices: { list },
        refunds: { create },
      });

      const result = await client.refundOrVoidLatestInvoice('sub_123');

      expect(result).toBe('refunded');
      expect(create).toHaveBeenCalledWith({ payment_intent: 'pi_123' });
    });

    it('treats an already-refunded charge as success (idempotent redelivery)', async () => {
      // A redelivered two-session-conflict webhook retries the refund
      // against a charge Stripe has already refunded. The method must
      // return 'refunded' (the end-state already holds), not throw and
      // wedge the webhook in permanent retry.
      const client = new StripeNodeBillingClient(unconfiguredConfig());
      const list = jest.fn().mockResolvedValue({
        data: [
          {
            id: 'in_paid',
            status: 'paid',
            payments: { data: [{ payment: { charge: 'ch_123' } }] },
          },
        ],
      });
      const create = jest.fn().mockRejectedValue(
        Object.assign(new Error('Charge ch_123 has already been refunded.'), {
          code: 'charge_already_refunded',
        }),
      );
      withFakeStripe(client, {
        invoices: { list },
        refunds: { create },
      });

      await expect(client.refundOrVoidLatestInvoice('sub_123')).resolves.toBe(
        'refunded',
      );
    });

    it('rethrows refund errors other than charge_already_refunded', async () => {
      const client = new StripeNodeBillingClient(unconfiguredConfig());
      const list = jest.fn().mockResolvedValue({
        data: [
          {
            id: 'in_paid',
            status: 'paid',
            payments: { data: [{ payment: { charge: 'ch_123' } }] },
          },
        ],
      });
      const create = jest.fn().mockRejectedValue(new Error('rate_limited'));
      withFakeStripe(client, {
        invoices: { list },
        refunds: { create },
      });

      await expect(client.refundOrVoidLatestInvoice('sub_123')).rejects.toThrow(
        'rate_limited',
      );
    });

    it('voids an open invoice instead of refunding it', async () => {
      const client = new StripeNodeBillingClient(unconfiguredConfig());
      const list = jest.fn().mockResolvedValue({
        data: [{ id: 'in_open', status: 'open' }],
      });
      const voidInvoice = jest.fn().mockResolvedValue({});
      withFakeStripe(client, { invoices: { list, voidInvoice } });

      const result = await client.refundOrVoidLatestInvoice('sub_123');

      expect(result).toBe('voided');
      expect(voidInvoice).toHaveBeenCalledWith('in_open');
    });

    it('returns noop for a draft invoice', async () => {
      const client = new StripeNodeBillingClient(unconfiguredConfig());
      const list = jest.fn().mockResolvedValue({
        data: [{ id: 'in_draft', status: 'draft' }],
      });
      withFakeStripe(client, { invoices: { list } });

      await expect(client.refundOrVoidLatestInvoice('sub_123')).resolves.toBe(
        'noop',
      );
    });

    it('returns noop when there is no invoice for the subscription', async () => {
      const client = new StripeNodeBillingClient(unconfiguredConfig());
      const list = jest.fn().mockResolvedValue({ data: [] });
      withFakeStripe(client, { invoices: { list } });

      await expect(client.refundOrVoidLatestInvoice('sub_123')).resolves.toBe(
        'noop',
      );
    });

    it('is a no-op when Stripe is not configured', async () => {
      const client = new StripeNodeBillingClient(unconfiguredConfig());

      await expect(client.refundOrVoidLatestInvoice('sub_123')).resolves.toBe(
        'noop',
      );
    });
  });
});
