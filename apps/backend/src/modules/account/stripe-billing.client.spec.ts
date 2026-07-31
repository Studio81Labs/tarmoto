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

    it('is a no-op when Stripe is not configured', async () => {
      const client = new StripeNodeBillingClient(unconfiguredConfig());

      await expect(
        client.setCancelAtPeriodEnd('sub_123', true),
      ).resolves.toBeUndefined();
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
