/* eslint-disable @typescript-eslint/unbound-method, @typescript-eslint/no-unsafe-assignment */
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';
import { AccountService } from './account.service.js';
import {
  STRIPE_BILLING_CLIENT,
  type StripeBillingClient,
} from './stripe-billing.client.js';
import { EmailService } from '../email/email.service.js';
import { PushService } from '../push/index.js';
import { ProviderClaimService } from './provider-claim.service.js';
import { StoreReconciliationService } from './store-reconciliation.service.js';
import { User } from '../../entities/user.entity.js';

describe('AccountService', () => {
  let service: AccountService;
  let userRepo: Partial<jest.Mocked<Repository<User>>> & {
    createQueryBuilder: jest.Mock;
  };
  let stripe: jest.Mocked<StripeBillingClient>;
  let providerClaim: {
    claimForStripe: jest.Mock;
    clearStripeTerminal: jest.Mock;
  };
  let storeReconciliation: { openConflict: jest.Mock; findOpen: jest.Mock };

  const buildUser = (overrides: Partial<User> = {}): User =>
    ({
      id: 'user-1',
      email: 'rider@tarmoto.app',
      display_name: 'Test Rider',
      phone: null,
      avatar_url: null,
      bio: null,
      language: 'en',
      home_region: null,
      home_location: null,
      work_location: null,
      preferences: {},
      created_at: new Date('2026-04-23T12:00:00Z'),
      updated_at: new Date('2026-04-23T12:00:00Z'),
      stripe_customer_id: null,
      stripe_subscription_id: null,
      subscription_provider: null,
      subscription_tier: 'free',
      subscription_status: 'canceled',
      subscription_cancel_at_period_end: false,
      subscription_current_period_end: null,
      billing_trial_used_at: null,
      email_verified_at: new Date('2026-04-23T12:00:00Z'),
      ...overrides,
    }) as User;

  let activationClaimExecute: jest.Mock;

  beforeEach(async () => {
    activationClaimExecute = jest.fn().mockResolvedValue({ affected: 1 });
    userRepo = {
      findOne: jest.fn().mockResolvedValue(buildUser()),
      save: jest.fn().mockImplementation((entity) => Promise.resolve(entity)),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      createQueryBuilder: jest.fn().mockReturnValue({
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        execute: activationClaimExecute,
      }),
    };

    stripe = {
      ensureCustomer: jest.fn(),
      getBillingSnapshot: jest.fn(),
      createCheckoutSession: jest.fn(),
      createPortalSession: jest.fn(),
      cancelSubscription: jest.fn(),
      setCancelAtPeriodEnd: jest.fn(),
      refundOrVoidLatestInvoice: jest.fn().mockResolvedValue('refunded'),
      deleteCustomer: jest.fn(),
      isConfigured: jest.fn().mockReturnValue(true),
      constructWebhookEvent: jest.fn(),
    };

    // Provider-claim guard: by default the row is unclaimed → Stripe wins
    // ownership (`claimed`) and terminal clears succeed (`true`). Tests that
    // exercise the two-session/superseded paths override per-case.
    providerClaim = {
      claimForStripe: jest.fn().mockResolvedValue('claimed'),
      clearStripeTerminal: jest.fn().mockResolvedValue(true),
    };
    storeReconciliation = {
      openConflict: jest.fn().mockResolvedValue({ id: 'sbr-1' }),
      // No prior open conflict by default → the loser branch refunds once.
      findOpen: jest.fn().mockResolvedValue([]),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AccountService,
        { provide: getRepositoryToken(User), useValue: userRepo },
        { provide: STRIPE_BILLING_CLIENT, useValue: stripe },
        { provide: ProviderClaimService, useValue: providerClaim },
        {
          provide: StoreReconciliationService,
          useValue: storeReconciliation,
        },
        {
          provide: EmailService,
          useValue: {
            sendSubscriptionConfirmed: jest.fn().mockResolvedValue(null),
            sendSubscriptionCancelled: jest.fn().mockResolvedValue(null),
          },
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => {
              if (key === 'TARMOTO_STRIPE_PREMIUM_PRICE_ID') {
                return 'price_premium';
              }
              if (key === 'TARMOTO_STRIPE_PRO_PRICE_ID') {
                return 'price_pro';
              }
              return undefined;
            }),
          },
        },
        {
          provide: PushService,
          useValue: { sendToUser: jest.fn().mockResolvedValue(undefined) },
        },
      ],
    }).compile();

    service = module.get<AccountService>(AccountService);
  });

  describe('getSubscription', () => {
    it('returns a free-plan snapshot when billing has not been connected yet', async () => {
      const snapshot = await service.getSubscription('user-1');

      expect(stripe.getBillingSnapshot).not.toHaveBeenCalled();
      expect(snapshot.current_plan).toMatchObject({
        tier: 'free',
        status: 'canceled',
        cancel_at_period_end: false,
      });
      expect(snapshot.payment_method).toBeNull();
      expect(snapshot.billing_history).toEqual([]);
      expect(snapshot.plans).toHaveLength(3);
    });

    it('returns the live Stripe billing snapshot when the user has a customer id', async () => {
      userRepo.findOne!.mockResolvedValueOnce(
        buildUser({
          stripe_customer_id: 'cus_123',
          stripe_subscription_id: 'sub_123',
          subscription_tier: 'premium',
          subscription_status: 'active',
        }),
      );
      stripe.getBillingSnapshot.mockResolvedValueOnce({
        currentPlan: {
          tier: 'premium',
          status: 'active',
          renewsAt: '2026-05-23T12:00:00.000Z',
          cancelAtPeriodEnd: false,
        },
        paymentMethod: {
          brand: 'visa',
          last4: '4242',
          expMonth: 8,
          expYear: 2028,
        },
        invoices: [
          {
            id: 'inv_1',
            date: '2026-04-23T12:00:00.000Z',
            amountMinor: 2999,
            currency: 'EUR',
            amountLabel: '€29.99',
            status: 'paid',
            invoiceUrl: 'https://billing.example.com/invoices/inv_1.pdf',
          },
        ],
      });

      const snapshot = await service.getSubscription('user-1');

      expect(stripe.getBillingSnapshot).toHaveBeenCalledWith({
        customerId: 'cus_123',
        subscriptionId: 'sub_123',
      });
      expect(snapshot.current_plan).toMatchObject({
        tier: 'premium',
        status: 'active',
      });
      expect(snapshot.plans).toEqual([
        { tier: 'free' },
        { tier: 'pro' },
        { tier: 'premium' },
      ]);
      expect(snapshot.payment_method).toMatchObject({
        brand: 'visa',
        last4: '4242',
      });
      expect(snapshot.billing_history[0]).toMatchObject({
        id: 'inv_1',
        invoice_url: 'https://billing.example.com/invoices/inv_1.pdf',
      });
    });

    it('throws NotFoundException when the user does not exist', async () => {
      userRepo.findOne!.mockResolvedValueOnce(null);

      await expect(service.getSubscription('missing')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('builds the snapshot from stored columns for a store-managed (Apple) subscription without a Stripe read', async () => {
      userRepo.findOne!.mockResolvedValueOnce(
        buildUser({
          subscription_provider: 'apple',
          subscription_tier: 'pro',
          subscription_status: 'active',
          subscription_current_period_end: new Date('2026-06-23T12:00:00Z'),
          subscription_cancel_at_period_end: false,
        }),
      );

      const snapshot = await service.getSubscription('user-1');

      expect(stripe.getBillingSnapshot).not.toHaveBeenCalled();
      expect(snapshot.provider).toBe('apple');
      expect(snapshot.managed_by).toBe('app_store');
      expect(snapshot.current_plan).toMatchObject({
        tier: 'pro',
        status: 'active',
      });
      expect(snapshot.payment_method).toBeNull();
      expect(snapshot.billing_history).toEqual([]);
    });

    it('reports portal_available=false for a store-managed (Apple) user with a lingering stripe_customer_id', async () => {
      userRepo.findOne!.mockResolvedValueOnce(
        buildUser({
          subscription_provider: 'apple',
          // A lingering customer id from a prior Stripe touch must NOT open
          // the Stripe portal for a store-managed rider.
          stripe_customer_id: 'cus_stale',
          subscription_tier: 'pro',
          subscription_status: 'active',
        }),
      );

      const snapshot = await service.getSubscription('user-1');

      expect(stripe.getBillingSnapshot).not.toHaveBeenCalled();
      expect(snapshot.portal_available).toBe(false);
    });

    it('still reads live Stripe for a legacy user with a stripe_customer_id but no subscription_provider set', async () => {
      userRepo.findOne!.mockResolvedValueOnce(
        buildUser({
          stripe_customer_id: 'cus_legacy',
          stripe_subscription_id: 'sub_legacy',
          subscription_provider: null,
          subscription_tier: 'pro',
          subscription_status: 'active',
        }),
      );
      stripe.getBillingSnapshot.mockResolvedValueOnce({
        currentPlan: {
          tier: 'pro',
          status: 'active',
          renewsAt: '2026-05-23T12:00:00.000Z',
          cancelAtPeriodEnd: false,
        },
        paymentMethod: null,
        invoices: [],
      });

      const snapshot = await service.getSubscription('user-1');

      expect(stripe.getBillingSnapshot).toHaveBeenCalledWith({
        customerId: 'cus_legacy',
        subscriptionId: 'sub_legacy',
      });
      expect(snapshot.provider).toBeNull();
      expect(snapshot.managed_by).toBeNull();
    });

    it('reports trial_eligible=true when the intro trial has not been used yet', async () => {
      userRepo.findOne!.mockResolvedValueOnce(
        buildUser({ billing_trial_used_at: null }),
      );

      const snapshot = await service.getSubscription('user-1');

      expect(snapshot.trial_eligible).toBe(true);
    });

    it('reports trial_eligible=false once the intro trial has been used', async () => {
      userRepo.findOne!.mockResolvedValueOnce(
        buildUser({ billing_trial_used_at: new Date('2026-01-01T00:00:00Z') }),
      );

      const snapshot = await service.getSubscription('user-1');

      expect(snapshot.trial_eligible).toBe(false);
    });
  });

  describe('createCheckoutSession', () => {
    it('creates a checkout session for a free user and applies the introductory trial', async () => {
      stripe.ensureCustomer.mockResolvedValueOnce('cus_123');
      stripe.createCheckoutSession.mockResolvedValueOnce({
        url: 'https://checkout.stripe.com/session/test',
      });

      const response = await service.createCheckoutSession('user-1', {
        tier: 'premium',
      });

      expect(stripe.ensureCustomer).toHaveBeenCalledWith({
        existingCustomerId: null,
        email: 'rider@tarmoto.app',
        name: 'Test Rider',
        userId: 'user-1',
      });
      expect(stripe.createCheckoutSession).toHaveBeenCalledWith(
        expect.objectContaining({
          customerId: 'cus_123',
          priceId: 'price_premium',
          userId: 'user-1',
          trialDays: 14,
        }),
      );
      expect(userRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ stripe_customer_id: 'cus_123' }),
      );
      expect(response).toEqual({
        url: 'https://checkout.stripe.com/session/test',
      });
    });

    it('rejects checkout requests when the user already has a live subscription', async () => {
      userRepo.findOne!.mockResolvedValueOnce(
        buildUser({
          stripe_customer_id: 'cus_123',
          subscription_tier: 'free',
          subscription_status: 'canceled',
        }),
      );
      stripe.getBillingSnapshot.mockResolvedValueOnce({
        currentPlan: {
          tier: 'premium',
          status: 'active',
          renewsAt: '2026-05-23T12:00:00.000Z',
          cancelAtPeriodEnd: false,
        },
        paymentMethod: null,
        invoices: [],
      });

      await expect(
        service.createCheckoutSession('user-1', { tier: 'pro' }),
      ).rejects.toThrow(BadRequestException);
      expect(stripe.getBillingSnapshot).toHaveBeenCalledWith({
        customerId: 'cus_123',
        subscriptionId: null,
      });
    });

    it('rejects checkout when a store provider owns the slot even while the tier reads free (Play hold/pause)', async () => {
      // During an Apple/Google hold the tier can transiently read `free`
      // while the store still OWNS billing. Creating a Stripe subscription
      // here would double-bill, so the provider gate blocks it regardless of
      // tier — and short-circuits before any Stripe read.
      userRepo.findOne!.mockResolvedValueOnce(
        buildUser({
          subscription_provider: 'apple',
          subscription_tier: 'free',
          subscription_status: 'canceled',
        }),
      );

      await expect(
        service.createCheckoutSession('user-1', { tier: 'pro' }),
      ).rejects.toThrow(BadRequestException);
      expect(stripe.getBillingSnapshot).not.toHaveBeenCalled();
      expect(stripe.ensureCustomer).not.toHaveBeenCalled();
      expect(stripe.createCheckoutSession).not.toHaveBeenCalled();
    });
  });

  describe('createPortalSession', () => {
    it('creates a cancellation deep link for the active subscription', async () => {
      userRepo.findOne!.mockResolvedValueOnce(
        buildUser({
          stripe_customer_id: 'cus_123',
          stripe_subscription_id: 'sub_123',
          subscription_tier: 'premium',
          subscription_status: 'active',
        }),
      );
      stripe.createPortalSession.mockResolvedValueOnce({
        url: 'https://billing.stripe.com/p/session/test',
      });

      const response = await service.createPortalSession('user-1', {
        flow: 'subscription_cancel',
      });

      expect(stripe.createPortalSession).toHaveBeenCalledWith(
        expect.objectContaining({
          customerId: 'cus_123',
          returnUrl: 'http://localhost:3002/settings/subscription',
          flow: expect.objectContaining({
            type: 'subscription_cancel',
            subscriptionId: 'sub_123',
          }),
        }),
      );
      expect(response).toEqual({
        url: 'https://billing.stripe.com/p/session/test',
      });
    });
  });

  describe('handleWebhook', () => {
    it('persists customer ids from checkout completion events', async () => {
      stripe.constructWebhookEvent.mockReturnValueOnce({
        type: 'checkout.session.completed',
        data: {
          object: {
            customer: 'cus_123',
            subscription: 'sub_123',
            metadata: { user_id: 'user-1' },
          },
        },
      });

      await service.handleWebhook(Buffer.from('payload'), 'stripe-signature');

      expect(stripe.constructWebhookEvent).toHaveBeenCalledWith(
        Buffer.from('payload'),
        'stripe-signature',
      );
      // The customer id is persisted FIRST-WRITER-WINS — the criteria carries
      // `stripe_customer_id IS NULL` so a delayed loser completion can't
      // overwrite an already-stored winner customer id.
      expect(userRepo.update).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'user-1',
          stripe_customer_id: expect.objectContaining({ _type: 'isNull' }),
        }),
        expect.objectContaining({
          updated_at: expect.any(Date),
          stripe_customer_id: 'cus_123',
        }),
      );
      // The subscription id goes through the OWNERSHIP-guarded write, never the
      // unconditional `userRepo.update`.
      expect(userRepo.update).not.toHaveBeenCalledWith(
        'user-1',
        expect.objectContaining({ stripe_subscription_id: expect.anything() }),
      );
      const qb = userRepo.createQueryBuilder.mock.results.at(-1)!.value as {
        set: jest.Mock;
        andWhere: jest.Mock;
      };
      expect(qb.set).toHaveBeenCalledWith(
        expect.objectContaining({ stripe_subscription_id: 'sub_123' }),
      );
      expect(qb.andWhere).toHaveBeenCalledWith(
        '(stripe_subscription_id IS NULL OR stripe_subscription_id = :sub)',
        { sub: 'sub_123' },
      );
    });

    it('ignores checkout completion events for users that no longer exist', async () => {
      userRepo.findOne!.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
      stripe.constructWebhookEvent.mockReturnValueOnce({
        type: 'checkout.session.completed',
        data: {
          object: {
            customer: 'cus_missing',
            subscription: 'sub_missing',
            metadata: { user_id: 'missing-user' },
          },
        },
      });

      await expect(
        service.handleWebhook(Buffer.from('payload'), 'stripe-signature'),
      ).resolves.toBeUndefined();
      expect(userRepo.save).not.toHaveBeenCalled();
      expect(userRepo.update).not.toHaveBeenCalled();
    });

    it('updates checkout completion state without writing stale subscription fields', async () => {
      userRepo.findOne!.mockResolvedValueOnce(
        buildUser({
          stripe_customer_id: 'cus_existing',
          subscription_tier: 'free',
          subscription_status: 'canceled',
        }),
      );
      stripe.constructWebhookEvent.mockReturnValueOnce({
        type: 'checkout.session.completed',
        data: {
          object: {
            customer: 'cus_123',
            subscription: 'sub_123',
            metadata: { user_id: 'user-1' },
          },
        },
      });

      await service.handleWebhook(Buffer.from('payload'), 'stripe-signature');

      // Only the customer id (+ timestamp) rides the unconditional update — no
      // tier/status and no bare subscription-id write.
      const [, update] = userRepo.update!.mock.calls.at(-1)!;
      expect(update).toEqual({
        updated_at: expect.any(Date),
        stripe_customer_id: 'cus_123',
      });
      // The subscription id lands via the guarded conditional write.
      const qb = userRepo.createQueryBuilder.mock.results.at(-1)!.value as {
        set: jest.Mock;
      };
      expect(qb.set).toHaveBeenCalledWith(
        expect.objectContaining({ stripe_subscription_id: 'sub_123' }),
      );
    });

    it('does not clobber the stored winner subscription id when a delayed checkout completion for a loser session arrives', async () => {
      // Two-Checkout-session race: the row already stores the WINNER's
      // subscription id (`sub_winner`), and a delayed/redelivered
      // `checkout.session.completed` for the LOSER (`sub_loser`, a DIFFERENT
      // id) arrives. Its subscription-id write must be OWNERSHIP-GUARDED so it
      // cannot overwrite the winner — otherwise the loser's later
      // `customer.subscription.deleted` would match `clearStripeTerminal`'s
      // identity guard and wipe the still-active winning subscription. The
      // guard (`stripe_subscription_id IS NULL OR = :sub`) makes the DB reject
      // the loser's write; the customer id (shared across both sessions) is
      // still safe to persist unconditionally.
      userRepo.findOne!.mockResolvedValueOnce(
        buildUser({
          stripe_customer_id: 'cus_123',
          stripe_subscription_id: 'sub_winner',
          subscription_provider: 'stripe',
          subscription_tier: 'premium',
          subscription_status: 'active',
        }),
      );
      // Guard rejects the loser's write (a different id already owns the slot).
      activationClaimExecute.mockResolvedValueOnce({ affected: 0 });
      stripe.constructWebhookEvent.mockReturnValueOnce({
        type: 'checkout.session.completed',
        data: {
          object: {
            customer: 'cus_123',
            subscription: 'sub_loser',
            metadata: { user_id: 'user-1' },
          },
        },
      });

      await service.handleWebhook(Buffer.from('payload'), 'stripe-signature');

      // The loser's id write is fully ownership-guarded: only the winner's id
      // (or an unclaimed slot) may be written, and never via the unconditional
      // update.
      const qb = userRepo.createQueryBuilder.mock.results.at(-1)!.value as {
        set: jest.Mock;
        andWhere: jest.Mock;
      };
      expect(qb.set).toHaveBeenCalledWith(
        expect.objectContaining({ stripe_subscription_id: 'sub_loser' }),
      );
      expect(qb.andWhere).toHaveBeenCalledWith(
        "(subscription_provider IS NULL OR subscription_provider = 'stripe')",
      );
      expect(qb.andWhere).toHaveBeenCalledWith(
        '(stripe_subscription_id IS NULL OR stripe_subscription_id = :sub)',
        { sub: 'sub_loser' },
      );
      expect(userRepo.update).not.toHaveBeenCalledWith(
        'user-1',
        expect.objectContaining({ stripe_subscription_id: expect.anything() }),
      );
    });

    it('does not clobber the stored winner customer id when a delayed checkout completion for a loser session (different customer) arrives', async () => {
      // Two racing INITIAL Checkout requests minted DIFFERENT Stripe customers
      // before any id was stored. The winner's id (`cus_winner`) is already
      // persisted, and a delayed/redelivered `checkout.session.completed` for
      // the LOSER (`cus_loser`) arrives. Its customer-id write is
      // FIRST-WRITER-WINS (`stripe_customer_id IS NULL` in the criteria), so
      // the DB rejects the overwrite — later snapshots/portals keep targeting
      // the winner's customer. The loser's orphan customer/subscription is
      // refunded + cancelled by the two-session conflict path.
      userRepo.findOne!.mockResolvedValueOnce(
        buildUser({
          stripe_customer_id: 'cus_winner',
          stripe_subscription_id: 'sub_winner',
          subscription_provider: 'stripe',
        }),
      );
      stripe.constructWebhookEvent.mockReturnValueOnce({
        type: 'checkout.session.completed',
        data: {
          object: {
            customer: 'cus_loser',
            subscription: 'sub_loser',
            metadata: { user_id: 'user-1' },
          },
        },
      });

      await service.handleWebhook(Buffer.from('payload'), 'stripe-signature');

      // The customer-id write is guarded on `stripe_customer_id IS NULL`, so a
      // loser completion can only ever fill an EMPTY slot, never overwrite the
      // winner. (The DB no-ops the UPDATE because the slot is already claimed.)
      expect(userRepo.update).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'user-1',
          stripe_customer_id: expect.objectContaining({ _type: 'isNull' }),
        }),
        expect.objectContaining({ stripe_customer_id: 'cus_loser' }),
      );
      // Never an unconditional overwrite keyed only on the user id.
      expect(userRepo.update).not.toHaveBeenCalledWith(
        'user-1',
        expect.anything(),
      );
    });

    it('updates the persisted billing state from subscription lifecycle events', async () => {
      userRepo.findOne!.mockResolvedValueOnce(
        buildUser({ stripe_customer_id: 'cus_123' }),
      );
      stripe.constructWebhookEvent.mockReturnValueOnce({
        type: 'customer.subscription.updated',
        data: {
          object: {
            id: 'sub_123',
            customer: 'cus_123',
            status: 'trialing',
            cancel_at_period_end: true,
            current_period_end: 1779537600,
            items: {
              data: [
                {
                  price: {
                    lookup_key: 'pro',
                  },
                },
              ],
            },
          },
        },
      });

      await service.handleWebhook(Buffer.from('payload'), 'stripe-signature');

      // The exclusivity claim is the authoritative writer of the core
      // subscription row (provider, subscription id, tier, status,
      // period end, cancel flag, plan source).
      expect(providerClaim.claimForStripe).toHaveBeenCalledWith(
        'user-1',
        'sub_123',
        expect.objectContaining({
          tier: 'pro',
          status: 'trialing',
          cancelAtPeriodEnd: true,
          planSource: 'subscription',
          // No per-item `current_period_end` in this fixture → null.
          currentPeriodEnd: null,
        }),
      );
      // Only the orthogonal fields not covered by the claim are flushed
      // via the unconditional update — never `subscription_status`, and
      // never the core fields the claim already owns.
      expect(userRepo.update).toHaveBeenCalledWith(
        'user-1',
        expect.objectContaining({
          updated_at: expect.any(Date),
          stripe_customer_id: 'cus_123',
          billing_trial_used_at: expect.any(Date),
        }),
      );
      expect(userRepo.update).toHaveBeenCalledWith(
        'user-1',
        expect.not.objectContaining({ subscription_status: expect.anything() }),
      );
      // Conditional activation claim gates the winner-only email dispatch.
      expect(activationClaimExecute).toHaveBeenCalled();
      // Confirmation email goes out in the rider's stored language.
      const emailService = service['email'] as unknown as {
        sendSubscriptionConfirmed: jest.Mock;
      };
      expect(emailService.sendSubscriptionConfirmed).toHaveBeenCalledWith(
        'rider@tarmoto.app',
        expect.objectContaining({ planName: 'Pro' }),
        'en',
      );
    });

    it('lets the configured price ID beat a stale pre-swap lookup key', async () => {
      // 2026-07 tier-name swap: a Stripe price whose lookup_key still
      // says "premium" but whose ID is the configured PRO price must
      // resolve to pro — otherwise the checkout would flip the paid
      // entitlement onto the wrong tier.
      userRepo.findOne!.mockResolvedValueOnce(
        buildUser({ stripe_customer_id: 'cus_123' }),
      );
      stripe.constructWebhookEvent.mockReturnValueOnce({
        type: 'customer.subscription.updated',
        data: {
          object: {
            id: 'sub_123',
            customer: 'cus_123',
            status: 'active',
            cancel_at_period_end: false,
            current_period_end: 1779537600,
            items: {
              data: [{ price: { id: 'price_pro', lookup_key: 'premium' } }],
            },
          },
        },
      });

      await service.handleWebhook(Buffer.from('payload'), 'stripe-signature');

      expect(providerClaim.claimForStripe).toHaveBeenCalledWith(
        'user-1',
        'sub_123',
        expect.objectContaining({
          tier: 'pro',
          planSource: 'subscription',
        }),
      );
    });

    it('clears the tier and plan provenance when the subscription is deleted', async () => {
      userRepo.findOne!.mockResolvedValueOnce(
        buildUser({
          stripe_customer_id: 'cus_123',
          stripe_subscription_id: 'sub_123',
          subscription_tier: 'pro',
          plan_source: 'founder',
          subscription_status: 'active',
        }),
      );
      stripe.constructWebhookEvent.mockReturnValueOnce({
        type: 'customer.subscription.deleted',
        data: {
          object: {
            id: 'sub_123',
            customer: 'cus_123',
            status: 'canceled',
            cancel_at_period_end: false,
            current_period_end: 1779537600,
            items: { data: [] },
          },
        },
      });

      await service.handleWebhook(Buffer.from('payload'), 'stripe-signature');

      // The identity-guarded terminal clear owns the field reset; it is
      // only invoked for the event's exact subscription id.
      expect(providerClaim.clearStripeTerminal).toHaveBeenCalledWith(
        'user-1',
        'sub_123',
      );
      // Cancellation email goes out in the rider's stored language.
      const emailService = service['email'] as unknown as {
        sendSubscriptionCancelled: jest.Mock;
      };
      expect(emailService.sendSubscriptionCancelled).toHaveBeenCalledWith(
        'rider@tarmoto.app',
        expect.objectContaining({ planName: 'Pro' }),
        'en',
      );
    });

    it('leaves the row untouched and sends no email when a stale delete targets a superseded subscription id', async () => {
      // A `customer.subscription.deleted` for a subscription the rider has
      // since replaced: the identity-guarded clear no-ops (returns false),
      // so the still-active subscription is preserved and no cancellation
      // email fires.
      providerClaim.clearStripeTerminal.mockResolvedValueOnce(false);
      userRepo.findOne!.mockResolvedValueOnce(
        buildUser({
          stripe_customer_id: 'cus_123',
          stripe_subscription_id: 'sub_current',
          subscription_tier: 'pro',
          plan_source: 'subscription',
          subscription_status: 'active',
        }),
      );
      stripe.constructWebhookEvent.mockReturnValueOnce({
        type: 'customer.subscription.deleted',
        data: {
          object: {
            id: 'sub_stale',
            customer: 'cus_123',
            status: 'canceled',
            cancel_at_period_end: false,
            current_period_end: 1779537600,
            items: { data: [] },
          },
        },
      });

      await service.handleWebhook(Buffer.from('payload'), 'stripe-signature');

      expect(providerClaim.clearStripeTerminal).toHaveBeenCalledWith(
        'user-1',
        'sub_stale',
      );
      // No field-clearing update and no cancellation email on the no-op.
      expect(userRepo.update).not.toHaveBeenCalled();
      const emailService = service['email'] as unknown as {
        sendSubscriptionCancelled: jest.Mock;
      };
      expect(emailService.sendSubscriptionCancelled).not.toHaveBeenCalled();
    });

    it('refunds the losing session and opens a reconciliation on a two-session conflict', async () => {
      // A second concurrent activation lands with a DIFFERENT subscription
      // id while the row is already owned by another live Stripe
      // subscription. The exclusivity claim rejects it; this event is the
      // loser — refund/void its just-charged invoice, open an
      // `exclusivity_conflict` work item, and dispatch nothing.
      providerClaim.claimForStripe.mockResolvedValueOnce('conflict');
      userRepo.findOne!.mockResolvedValueOnce(
        buildUser({
          stripe_customer_id: 'cus_123',
          stripe_subscription_id: 'sub_winning',
          subscription_tier: 'premium',
          subscription_status: 'active',
        }),
      );
      stripe.constructWebhookEvent.mockReturnValueOnce({
        type: 'customer.subscription.updated',
        data: {
          object: {
            id: 'sub_losing',
            customer: 'cus_123',
            status: 'active',
            cancel_at_period_end: false,
            current_period_end: 1779537600,
            items: { data: [{ price: { lookup_key: 'pro' } }] },
          },
        },
      });

      await service.handleWebhook(Buffer.from('payload'), 'stripe-signature');

      // The loser is CANCELLED (not just refunded) — a refund alone would
      // leave it active to renew, recharge the rider, and keep emitting
      // conflicting webhooks.
      expect(stripe.cancelSubscription).toHaveBeenCalledWith('sub_losing');
      expect(stripe.refundOrVoidLatestInvoice).toHaveBeenCalledWith(
        'sub_losing',
      );
      expect(storeReconciliation.openConflict).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-1',
          provider: 'stripe',
          stripeSubscriptionId: 'sub_losing',
          reason: 'exclusivity_conflict',
        }),
      );
      // The winning row is never overwritten and no confirmation goes out.
      expect(userRepo.update).not.toHaveBeenCalled();
      const emailService = service['email'] as unknown as {
        sendSubscriptionConfirmed: jest.Mock;
      };
      expect(emailService.sendSubscriptionConfirmed).not.toHaveBeenCalled();
    });

    it('refunds a conflict loser even when the in-memory user snapshot is stale (pre-winner-commit)', async () => {
      // The genuine two-session race: the loser's `findUserForSubscriptionEvent`
      // resolves the user BEFORE the winner's `claimForStripe` commits, so the
      // in-memory snapshot still reads `stripe_subscription_id: null`. The DB
      // (via `claimForStripe`) is the source of truth and returns `conflict`.
      // The handler must refund + reconcile off the DB verdict, NOT the stale
      // snapshot — the old in-memory gate wrongly skipped the refund here,
      // silently leaving the loser charged.
      providerClaim.claimForStripe.mockResolvedValueOnce('conflict');
      userRepo.findOne!.mockResolvedValueOnce(
        buildUser({
          stripe_customer_id: 'cus_123',
          // Stale: the winner had not committed its id yet when we read.
          stripe_subscription_id: null,
          subscription_tier: 'free',
          subscription_status: 'canceled',
        }),
      );
      stripe.constructWebhookEvent.mockReturnValueOnce({
        type: 'customer.subscription.updated',
        data: {
          object: {
            id: 'sub_losing',
            customer: 'cus_123',
            status: 'active',
            cancel_at_period_end: false,
            current_period_end: 1779537600,
            items: { data: [{ price: { lookup_key: 'pro' } }] },
          },
        },
      });

      await service.handleWebhook(Buffer.from('payload'), 'stripe-signature');

      expect(stripe.refundOrVoidLatestInvoice).toHaveBeenCalledWith(
        'sub_losing',
      );
      expect(storeReconciliation.openConflict).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-1',
          provider: 'stripe',
          stripeSubscriptionId: 'sub_losing',
          reason: 'exclusivity_conflict',
        }),
      );
    });

    it('does not double-refund a redelivered conflict already reconciled', async () => {
      // A redelivery of an already-handled conflict: an OPEN
      // exclusivity_conflict reconciliation already exists for this
      // subscription id. Idempotency is decided from DB state — skip the
      // refund and skip opening a duplicate row.
      providerClaim.claimForStripe.mockResolvedValueOnce('conflict');
      storeReconciliation.findOpen.mockResolvedValueOnce([
        { id: 'sbr-existing', stripe_subscription_id: 'sub_losing' },
      ]);
      userRepo.findOne!.mockResolvedValueOnce(
        buildUser({
          stripe_customer_id: 'cus_123',
          stripe_subscription_id: 'sub_winning',
          subscription_tier: 'premium',
          subscription_status: 'active',
        }),
      );
      stripe.constructWebhookEvent.mockReturnValueOnce({
        type: 'customer.subscription.updated',
        data: {
          object: {
            id: 'sub_losing',
            customer: 'cus_123',
            status: 'active',
            cancel_at_period_end: false,
            current_period_end: 1779537600,
            items: { data: [{ price: { lookup_key: 'pro' } }] },
          },
        },
      });

      await service.handleWebhook(Buffer.from('payload'), 'stripe-signature');

      expect(storeReconciliation.findOpen).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: 'stripe',
          reason: 'exclusivity_conflict',
          stripeSubscriptionId: 'sub_losing',
        }),
      );
      // Both the cancel AND the refund are skipped on a redelivery we've
      // already reconciled (idempotent no-op).
      expect(stripe.cancelSubscription).not.toHaveBeenCalled();
      expect(stripe.refundOrVoidLatestInvoice).not.toHaveBeenCalled();
      expect(storeReconciliation.openConflict).not.toHaveBeenCalled();
    });

    it('skips the confirmation email when a concurrent webhook already claimed the activation transition', async () => {
      // Two parallel `customer.subscription.updated` events for the
      // same canceled→active transition: the first wins the
      // conditional UPDATE (`subscription_status NOT IN ('active',
      // 'trialing')`), the second sees affected: 0 and must NOT
      // re-fire the confirmation email.
      activationClaimExecute.mockResolvedValueOnce({ affected: 0 });

      userRepo.findOne!.mockResolvedValueOnce(
        buildUser({
          stripe_customer_id: 'cus_123',
          // Pre-update in-memory read still says 'canceled' because
          // we haven't refetched after the concurrent winner committed.
          subscription_status: 'canceled',
          subscription_tier: 'free',
        }),
      );
      stripe.constructWebhookEvent.mockReturnValueOnce({
        type: 'customer.subscription.updated',
        data: {
          object: {
            id: 'sub_123',
            customer: 'cus_123',
            status: 'active',
            cancel_at_period_end: false,
            current_period_end: 1779537600,
            items: { data: [{ price: { lookup_key: 'premium' } }] },
          },
        },
      });

      await service.handleWebhook(Buffer.from('payload'), 'stripe-signature');

      const emailService = service['email'] as {
        sendSubscriptionConfirmed: jest.Mock;
      };
      expect(emailService.sendSubscriptionConfirmed).not.toHaveBeenCalled();
      // Other-field updates still flow even on the loser path.
      expect(userRepo.update).toHaveBeenCalled();
    });

    it('locks provider ownership in the activation claim so the transition winner is the exclusivity winner (no split-winner dropped confirmation)', async () => {
      // Split-winner race guard. Previously the activation status-claim only
      // flipped `subscription_status`, leaving `stripe_subscription_id` NULL —
      // so a second session with a DIFFERENT id could still win
      // `claimForStripe` while the status-claim winner LOST it (returning at
      // the conflict branch before dispatching), and the true owner had
      // `wonActivationTransition=false` → the confirmation was dropped
      // entirely. The activation claim now ALSO writes
      // `subscription_provider='stripe'` + `stripe_subscription_id`, locking
      // the slot so whoever wins the transition is guaranteed to also win
      // `claimForStripe`. Here the handler wins BOTH (activation claim
      // affected:1, claimForStripe 'claimed') and sends exactly one
      // confirmation, for the true owner.
      activationClaimExecute.mockResolvedValueOnce({ affected: 1 });
      userRepo.findOne!.mockResolvedValueOnce(
        buildUser({
          stripe_customer_id: 'cus_123',
          subscription_status: 'canceled',
          subscription_tier: 'free',
        }),
      );
      stripe.constructWebhookEvent.mockReturnValueOnce({
        type: 'customer.subscription.updated',
        data: {
          object: {
            id: 'sub_winner',
            customer: 'cus_123',
            status: 'active',
            cancel_at_period_end: false,
            current_period_end: 1779537600,
            items: { data: [{ price: { lookup_key: 'premium' } }] },
          },
        },
      });

      await service.handleWebhook(Buffer.from('payload'), 'stripe-signature');
      await new Promise((resolve) => setImmediate(resolve));

      // The activation claim locks OWNERSHIP (provider + subscription id), not
      // just status — this alignment is the fix.
      const qb = userRepo.createQueryBuilder.mock.results.at(-1)!.value as {
        set: jest.Mock;
      };
      expect(qb.set).toHaveBeenCalledWith(
        expect.objectContaining({
          subscription_status: 'active',
          subscription_provider: 'stripe',
          stripe_subscription_id: 'sub_winner',
        }),
      );
      // The exclusivity claim ran for the same id, and exactly one
      // confirmation went out.
      expect(providerClaim.claimForStripe).toHaveBeenCalledWith(
        'user-1',
        'sub_winner',
        expect.objectContaining({ tier: 'premium' }),
      );
      const emailService = service['email'] as unknown as {
        sendSubscriptionConfirmed: jest.Mock;
      };
      expect(emailService.sendSubscriptionConfirmed).toHaveBeenCalledTimes(1);
    });

    it('fires the billing-failed push when claiming the past_due transition', async () => {
      // Stripe transitions the subscription to past_due after a failed
      // auto-renewal. The conditional UPDATE claims the transition
      // atomically so concurrent webhook retries can't double-push.
      activationClaimExecute.mockResolvedValueOnce({ affected: 1 });

      userRepo.findOne!.mockResolvedValueOnce(
        buildUser({
          stripe_customer_id: 'cus_123',
          subscription_status: 'active',
          subscription_tier: 'premium',
        }),
      );
      stripe.constructWebhookEvent.mockReturnValueOnce({
        type: 'customer.subscription.updated',
        data: {
          object: {
            id: 'sub_123',
            customer: 'cus_123',
            status: 'past_due',
            cancel_at_period_end: false,
            current_period_end: 1779537600,
            items: { data: [{ price: { lookup_key: 'premium' } }] },
          },
        },
      });

      await service.handleWebhook(Buffer.from('payload'), 'stripe-signature');
      // Push is fire-and-forget — flush microtasks so the dispatch
      // helper's `await pushService.sendToUser` resolves before assertion.
      await new Promise((resolve) => setImmediate(resolve));

      const pushService = service['pushService'] as { sendToUser: jest.Mock };
      expect(pushService.sendToUser).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ category: 'subscription_billing' }),
      );
    });

    it('skips the billing-failed push when a concurrent webhook already claimed the past_due transition', async () => {
      activationClaimExecute.mockResolvedValueOnce({ affected: 0 });

      userRepo.findOne!.mockResolvedValueOnce(
        buildUser({
          stripe_customer_id: 'cus_123',
          subscription_status: 'active',
          subscription_tier: 'premium',
        }),
      );
      stripe.constructWebhookEvent.mockReturnValueOnce({
        type: 'customer.subscription.updated',
        data: {
          object: {
            id: 'sub_123',
            customer: 'cus_123',
            status: 'past_due',
            cancel_at_period_end: false,
            current_period_end: 1779537600,
            items: { data: [{ price: { lookup_key: 'premium' } }] },
          },
        },
      });

      await service.handleWebhook(Buffer.from('payload'), 'stripe-signature');
      await new Promise((resolve) => setImmediate(resolve));

      const pushService = service['pushService'] as { sendToUser: jest.Mock };
      expect(pushService.sendToUser).not.toHaveBeenCalled();
      // Loser path still flushes the unconditional update.
      expect(userRepo.update).toHaveBeenCalled();
    });

    it('keeps subscription_status out of the unconditional update for past_due transitions', async () => {
      // The contradictory-webhook race: `past_due` and `active` for
      // the same subscription land concurrently. Each conditional
      // claim atomically writes its own status, but the
      // unconditional update used to also write `subscription_status:
      // newStatus`, so the slower handler would overwrite the
      // faster handler's atomic transition. Verify the unconditional
      // update no longer carries the status field on the past_due
      // path.
      activationClaimExecute.mockResolvedValueOnce({ affected: 1 });

      userRepo.findOne!.mockResolvedValueOnce(
        buildUser({
          stripe_customer_id: 'cus_123',
          subscription_status: 'active',
          subscription_tier: 'premium',
        }),
      );
      stripe.constructWebhookEvent.mockReturnValueOnce({
        type: 'customer.subscription.updated',
        data: {
          object: {
            id: 'sub_123',
            customer: 'cus_123',
            status: 'past_due',
            cancel_at_period_end: false,
            current_period_end: 1779537600,
            items: { data: [{ price: { lookup_key: 'premium' } }] },
          },
        },
      });

      await service.handleWebhook(Buffer.from('payload'), 'stripe-signature');

      expect(userRepo.update).toHaveBeenCalledWith(
        'user-1',
        expect.not.objectContaining({ subscription_status: expect.anything() }),
      );
    });
  });
});
