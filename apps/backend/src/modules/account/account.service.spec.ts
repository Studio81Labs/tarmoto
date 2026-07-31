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
      // Default: the STORED subscription queried on a two-session conflict is
      // still live → the incoming is a genuine duplicate. Legitimate-
      // resubscription cases override this per-test to a terminal status.
      getSubscriptionStatus: jest.fn().mockResolvedValue('active'),
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
      // The freshly-minted customer id is persisted FIRST-WRITER-WINS via a
      // guarded `stripe_customer_id IS NULL` UPDATE — never an unguarded save.
      expect(userRepo.update).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'user-1',
          stripe_customer_id: expect.objectContaining({ _type: 'isNull' }),
        }),
        expect.objectContaining({ stripe_customer_id: 'cus_123' }),
      );
      expect(userRepo.save).not.toHaveBeenCalled();
      expect(response).toEqual({
        url: 'https://checkout.stripe.com/session/test',
      });
    });

    it('uses the stored winner customer when a concurrent initial checkout already claimed the slot (first-writer-wins, no overwrite)', async () => {
      // Two concurrent INITIAL checkouts both read a null `stripe_customer_id`
      // and each mint a DIFFERENT Stripe customer. This is the LOSER: its
      // guarded `stripe_customer_id IS NULL` UPDATE affects 0 rows because the
      // other session already stored its customer. The loser must RE-READ the
      // stored winner and check out against THAT customer — never overwrite the
      // winner's id with its own orphan customer.
      stripe.ensureCustomer.mockResolvedValueOnce('cus_loser');
      // Guarded claim loses the race (another session stored first).
      userRepo.update!.mockResolvedValueOnce({ affected: 0 });
      // Re-read returns the winner's stored customer.
      userRepo.findOne!.mockReset();
      userRepo
        .findOne!.mockResolvedValueOnce(buildUser())
        .mockResolvedValueOnce(buildUser({ stripe_customer_id: 'cus_winner' }));
      stripe.createCheckoutSession.mockResolvedValueOnce({
        url: 'https://checkout.stripe.com/session/test',
      });

      await service.createCheckoutSession('user-1', { tier: 'pro' });

      // The guarded write was attempted with the loser's minted customer under
      // the `stripe_customer_id IS NULL` guard, so it could only ever fill an
      // EMPTY slot — never overwrite the winner.
      expect(userRepo.update).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'user-1',
          stripe_customer_id: expect.objectContaining({ _type: 'isNull' }),
        }),
        expect.objectContaining({ stripe_customer_id: 'cus_loser' }),
      );
      // The Checkout session is created against the STORED WINNER, not the
      // loser's orphan customer.
      expect(stripe.createCheckoutSession).toHaveBeenCalledWith(
        expect.objectContaining({ customerId: 'cus_winner' }),
      );
      // The loser's just-minted customer holds the rider's email/name/user_id
      // metadata, so leaving it stranded strews PII that account deletion never
      // reaches — it must be deleted before falling back to the winner.
      expect(stripe.deleteCustomer).toHaveBeenCalledWith('cus_loser');
    });

    it('checks out against the stored winner even when deleting the orphan customer fails (best-effort)', async () => {
      // A failure deleting the orphan must NOT break checkout — log and continue
      // against the stored winner's customer.
      stripe.ensureCustomer.mockResolvedValueOnce('cus_loser');
      userRepo.update!.mockResolvedValueOnce({ affected: 0 });
      userRepo.findOne!.mockReset();
      userRepo
        .findOne!.mockResolvedValueOnce(buildUser())
        .mockResolvedValueOnce(buildUser({ stripe_customer_id: 'cus_winner' }));
      stripe.deleteCustomer.mockRejectedValueOnce(new Error('stripe down'));
      stripe.createCheckoutSession.mockResolvedValueOnce({
        url: 'https://checkout.stripe.com/session/test',
      });

      const response = await service.createCheckoutSession('user-1', {
        tier: 'pro',
      });

      expect(stripe.deleteCustomer).toHaveBeenCalledWith('cus_loser');
      expect(stripe.createCheckoutSession).toHaveBeenCalledWith(
        expect.objectContaining({ customerId: 'cus_winner' }),
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

    it('rejects a store-managed account even when a stale stripe_customer_id survives', async () => {
      // An Apple/Google-managed rider that retains an old `stripe_customer_id`
      // from a prior Stripe touch must NOT be routed into the Stripe billing
      // portal — the portal is Stripe-only. Gate on provider BEFORE creating any
      // portal session, mirroring the checkout guard and the snapshot's
      // `portal_available` gate.
      userRepo.findOne!.mockResolvedValueOnce(
        buildUser({
          subscription_provider: 'apple',
          stripe_customer_id: 'cus_stale',
          subscription_tier: 'premium',
          subscription_status: 'active',
        }),
      );

      await expect(
        service.createPortalSession('user-1', { flow: 'manage' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(stripe.createPortalSession).not.toHaveBeenCalled();
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

      // The transition winner writes ALL authoritative fields in its single
      // atomic UPDATE (provider, subscription id, tier, status, period end,
      // cancel flag, plan source) and locks ownership of the row, so it does
      // NOT re-run the follow-up exclusivity claim — that redundant second
      // write could clobber a newer, concurrently-committed status.
      expect(providerClaim.claimForStripe).not.toHaveBeenCalled();
      const transitionQb = userRepo.createQueryBuilder.mock.results.at(-1)!
        .value as { set: jest.Mock };
      expect(transitionQb.set).toHaveBeenCalledWith(
        expect.objectContaining({
          subscription_provider: 'stripe',
          stripe_subscription_id: 'sub_123',
          subscription_tier: 'pro',
          subscription_status: 'trialing',
          subscription_cancel_at_period_end: true,
          plan_source: 'subscription',
          // No per-item `current_period_end` in this fixture → null.
          subscription_current_period_end: null,
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

    it('ensures a deletion_cancel_failed reconciliation when it activates a subscription for an account scheduled for deletion', async () => {
      // Ordering closed here: the deletion request that stamped
      // `deletion_scheduled_at` ran BEFORE this subscription existed, so
      // `requestDeletion` opened no cancel-flag work item. The activation must
      // open one now so the lock-guarded worker re-reads the still-set
      // `deletion_scheduled_at` and stops the renewal.
      // First findOne = pre-claim snapshot; second = the fresh post-claim
      // re-read the gate now trusts. Both carry the scheduled deletion here.
      userRepo
        .findOne!.mockResolvedValueOnce(
          buildUser({
            stripe_customer_id: 'cus_123',
            deletion_scheduled_at: new Date('2026-08-01T00:00:00Z'),
          }),
        )
        .mockResolvedValueOnce(
          buildUser({
            stripe_customer_id: 'cus_123',
            deletion_scheduled_at: new Date('2026-08-01T00:00:00Z'),
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
            items: { data: [{ price: { lookup_key: 'pro' } }] },
          },
        },
      });

      await service.handleWebhook(Buffer.from('payload'), 'stripe-signature');

      // Deduped on any already-open row for this subscription before opening.
      expect(storeReconciliation.findOpen).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: 'stripe',
          reason: 'deletion_cancel_failed',
          stripeSubscriptionId: 'sub_123',
        }),
      );
      expect(storeReconciliation.openConflict).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-1',
          provider: 'stripe',
          stripeSubscriptionId: 'sub_123',
          reason: 'deletion_cancel_failed',
        }),
      );
    });

    it('does NOT re-open a deletion_cancel_failed reconciliation when one is already open for the subscription (dedup)', async () => {
      // Both the pre-claim snapshot and the fresh post-claim re-read carry the
      // scheduled deletion, so the gate reaches the dedup check.
      userRepo
        .findOne!.mockResolvedValueOnce(
          buildUser({
            stripe_customer_id: 'cus_123',
            deletion_scheduled_at: new Date('2026-08-01T00:00:00Z'),
          }),
        )
        .mockResolvedValueOnce(
          buildUser({
            stripe_customer_id: 'cus_123',
            deletion_scheduled_at: new Date('2026-08-01T00:00:00Z'),
          }),
        );
      // A row is already open for this subscription → no second row.
      storeReconciliation.findOpen.mockResolvedValueOnce([{ id: 'sbr-open' }]);
      stripe.constructWebhookEvent.mockReturnValueOnce({
        type: 'customer.subscription.updated',
        data: {
          object: {
            id: 'sub_123',
            customer: 'cus_123',
            status: 'active',
            cancel_at_period_end: false,
            current_period_end: 1779537600,
            items: { data: [{ price: { lookup_key: 'pro' } }] },
          },
        },
      });

      await service.handleWebhook(Buffer.from('payload'), 'stripe-signature');

      expect(storeReconciliation.openConflict).not.toHaveBeenCalled();
    });

    it('opens no deletion_cancel_failed reconciliation for a normal activation on a non-deleting account', async () => {
      // Regression guard: an ordinary activation (no pending deletion) must not
      // spuriously open a cancel-flag work item.
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
            items: { data: [{ price: { lookup_key: 'pro' } }] },
          },
        },
      });

      await service.handleWebhook(Buffer.from('payload'), 'stripe-signature');

      expect(storeReconciliation.openConflict).not.toHaveBeenCalled();
    });

    it('opens a deletion_cancel_failed reconciliation when deletion commits AFTER the pre-claim snapshot (race)', async () => {
      // Race: the webhook resolves the user with `deletion_scheduled_at = null`,
      // then `requestDeletion` locks and stamps the row while our activation
      // UPDATE waits on that lock; the deletion commits (no subscription visible,
      // so it opens no cancel work item) and only then does our claim win. The
      // stale pre-claim snapshot still shows null — the gate must trust the fresh
      // post-claim re-read, which now returns the committed schedule, and open
      // the reconciliation so the worker cancels the newly-active subscription.
      userRepo
        .findOne!.mockResolvedValueOnce(
          buildUser({
            stripe_customer_id: 'cus_123',
            deletion_scheduled_at: null,
          }),
        )
        .mockResolvedValueOnce(
          buildUser({
            stripe_customer_id: 'cus_123',
            deletion_scheduled_at: new Date('2026-08-01T00:00:00Z'),
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
            items: { data: [{ price: { lookup_key: 'pro' } }] },
          },
        },
      });

      await service.handleWebhook(Buffer.from('payload'), 'stripe-signature');

      expect(storeReconciliation.openConflict).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-1',
          provider: 'stripe',
          stripeSubscriptionId: 'sub_123',
          reason: 'deletion_cancel_failed',
        }),
      );
    });

    it('retries the deletion_cancel_failed reconciliation on a redelivery even when the activation transition was NOT won', async () => {
      // The transition WINNER's ensure insert failed transiently AFTER its
      // activation UPDATE committed, so no reconciliation row exists. Stripe
      // redelivers, but the row is already active → the conditional activation
      // UPDATE affects 0 rows and `wonActivationTransition` is false. A
      // winner-only gate would never retry, leaving a locked/deleting account
      // with a renewable subscription. The ensure must run on EVERY owning
      // activation delivery so the redelivery opens the (still-absent) row.
      activationClaimExecute.mockResolvedValue({ affected: 0 });
      userRepo
        .findOne!.mockResolvedValueOnce(
          buildUser({
            stripe_customer_id: 'cus_123',
            // Redelivery: the row is already active and owns this sub.
            subscription_status: 'active',
            subscription_tier: 'pro',
            stripe_subscription_id: 'sub_123',
            deletion_scheduled_at: new Date('2026-08-01T00:00:00Z'),
          }),
        )
        // Fresh post-claim re-read still carries the scheduled deletion.
        .mockResolvedValueOnce(
          buildUser({
            deletion_scheduled_at: new Date('2026-08-01T00:00:00Z'),
          }),
        );
      // No prior open row — the winner's insert failed, so this must open one.
      stripe.constructWebhookEvent.mockReturnValueOnce({
        type: 'customer.subscription.updated',
        data: {
          object: {
            id: 'sub_123',
            customer: 'cus_123',
            status: 'active',
            cancel_at_period_end: false,
            current_period_end: 1779537600,
            items: { data: [{ price: { lookup_key: 'pro' } }] },
          },
        },
      });

      await service.handleWebhook(Buffer.from('payload'), 'stripe-signature');

      // Non-winner (no confirmation email), but the reconciliation is retried.
      const emailService = service['email'] as unknown as {
        sendSubscriptionConfirmed: jest.Mock;
      };
      expect(emailService.sendSubscriptionConfirmed).not.toHaveBeenCalled();
      expect(storeReconciliation.openConflict).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-1',
          provider: 'stripe',
          stripeSubscriptionId: 'sub_123',
          reason: 'deletion_cancel_failed',
        }),
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

      // Activation is a transition win, so the tier resolution lands in the
      // single transition UPDATE — the redundant follow-up claim is skipped.
      expect(providerClaim.claimForStripe).not.toHaveBeenCalled();
      const transitionQb = userRepo.createQueryBuilder.mock.results.at(-1)!
        .value as { set: jest.Mock };
      expect(transitionQb.set).toHaveBeenCalledWith(
        expect.objectContaining({
          subscription_tier: 'pro',
          plan_source: 'subscription',
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
      // Conflict ⇒ another live session owns the row ⇒ this transition UPDATE
      // affects 0 rows and the handler falls through to the exclusivity claim.
      activationClaimExecute.mockResolvedValueOnce({ affected: 0 });
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

    it('does NOT refund or cancel a stale/already-ended losing subscription (delayed subscription.updated for a superseded sub)', async () => {
      // A delayed `customer.subscription.updated` for a PREVIOUS/superseded
      // subscription the rider already replaced also returns 'conflict', but it
      // is a stale event — NOT a live duplicate. Its subscription is already
      // `canceled`, so `cancelSubscription` would be a no-op while
      // `refundOrVoidLatestInvoice` would wrongly claw back a LEGITIMATE past
      // invoice. The handler must touch NO Stripe and open no reconciliation.
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
            id: 'sub_stale',
            customer: 'cus_123',
            // Already ended — a stale event, not a live duplicate.
            status: 'canceled',
            cancel_at_period_end: false,
            current_period_end: 1779537600,
            items: { data: [{ price: { lookup_key: 'pro' } }] },
          },
        },
      });

      await service.handleWebhook(Buffer.from('payload'), 'stripe-signature');

      // No wrongful clawback of the old subscription's legitimate invoice, and
      // no redundant cancel of an already-canceled subscription.
      expect(stripe.refundOrVoidLatestInvoice).not.toHaveBeenCalled();
      expect(stripe.cancelSubscription).not.toHaveBeenCalled();
      expect(storeReconciliation.openConflict).not.toHaveBeenCalled();
      // A non-live incoming short-circuits BEFORE the stored re-query — the
      // stored subscription's status is never consulted for a stale event.
      expect(stripe.getSubscriptionStatus).not.toHaveBeenCalled();
    });

    it('re-claims the slot for a LEGITIMATE resubscription when the STORED subscription has already ended (no refund/cancel, confirmation sent)', async () => {
      // The rider's PREVIOUS subscription ended and they started a NEW Checkout
      // before the delayed `customer.subscription.deleted` cleared the STORED
      // (old) id. The new active sub conflicts with the stale stored id — but
      // this is NOT a duplicate. Re-query the STORED subscription, see it is
      // gone/canceled (superseded), RE-CLAIM the slot for the incoming, and send
      // the confirmation. NEVER refund/cancel the rider's real new subscription.
      // Stale stored id ≠ incoming ⇒ this transition UPDATE affects 0 rows and
      // the handler falls through to the exclusivity claim (then reclaim).
      activationClaimExecute.mockResolvedValueOnce({ affected: 0 });
      providerClaim.claimForStripe.mockResolvedValueOnce('conflict');
      userRepo
        .findOne!.mockResolvedValueOnce(
          buildUser({
            stripe_customer_id: 'cus_123',
            stripe_subscription_id: 'sub_old',
            subscription_tier: 'free',
            subscription_status: 'canceled',
          }),
        )
        // The reclaim path re-reads the CURRENTLY-stored id fresh from the DB.
        .mockResolvedValueOnce(
          buildUser({ stripe_subscription_id: 'sub_old' }),
        );
      // The STORED (old) subscription is already terminal on Stripe.
      stripe.getSubscriptionStatus.mockResolvedValueOnce('canceled');
      stripe.constructWebhookEvent.mockReturnValueOnce({
        type: 'customer.subscription.updated',
        data: {
          object: {
            id: 'sub_new',
            customer: 'cus_123',
            status: 'active',
            cancel_at_period_end: false,
            current_period_end: 1779537600,
            items: { data: [{ price: { lookup_key: 'premium' } }] },
          },
        },
      });

      await service.handleWebhook(Buffer.from('payload'), 'stripe-signature');

      // The STORED sub's live status is what decided the branch.
      expect(stripe.getSubscriptionStatus).toHaveBeenCalledWith('sub_old');
      // The incoming is the rider's real subscription — NEVER clawed back.
      expect(stripe.cancelSubscription).not.toHaveBeenCalled();
      expect(stripe.refundOrVoidLatestInvoice).not.toHaveBeenCalled();
      expect(storeReconciliation.openConflict).not.toHaveBeenCalled();
      // The slot is re-claimed with a guarded UPDATE bound to the STALE stored
      // id, so a concurrent clear/claim can't be clobbered.
      const qb = userRepo.createQueryBuilder.mock.results.at(-1)!.value as {
        set: jest.Mock;
        andWhere: jest.Mock;
      };
      expect(qb.set).toHaveBeenCalledWith(
        expect.objectContaining({
          subscription_provider: 'stripe',
          stripe_subscription_id: 'sub_new',
          subscription_status: 'active',
          subscription_tier: 'premium',
        }),
      );
      expect(qb.andWhere).toHaveBeenCalledWith(
        'stripe_subscription_id = :staleSub',
        { staleSub: 'sub_old' },
      );
      // A confirmation goes out for the newly re-claimed subscription.
      const emailService = service['email'] as unknown as {
        sendSubscriptionConfirmed: jest.Mock;
      };
      expect(emailService.sendSubscriptionConfirmed).toHaveBeenCalledTimes(1);
    });

    it('stamps billing_trial_used_at when it re-claims a TRIALING replacement subscription (trial no longer eligible)', async () => {
      // A legitimate resubscription that comes in `trialing` while a terminal
      // old id is still stored takes the reclaim branch, which RETURNS before
      // the orthogonal `userRepo.update` that normally persists
      // `billing_trial_used_at`. Without folding the first-trial marker into the
      // reclaim UPDATE the rider would stay `trial_eligible` despite consuming a
      // trial. The reclaim write must carry it (incoming trialing + not already
      // used).
      // Stale stored id ≠ incoming ⇒ this transition UPDATE affects 0 rows and
      // the handler falls through to the exclusivity claim (then reclaim).
      activationClaimExecute.mockResolvedValueOnce({ affected: 0 });
      providerClaim.claimForStripe.mockResolvedValueOnce('conflict');
      userRepo
        .findOne!.mockResolvedValueOnce(
          buildUser({
            stripe_customer_id: 'cus_123',
            stripe_subscription_id: 'sub_old',
            subscription_tier: 'free',
            subscription_status: 'canceled',
            billing_trial_used_at: null,
          }),
        )
        .mockResolvedValueOnce(
          buildUser({ stripe_subscription_id: 'sub_old' }),
        );
      // The STORED (old) subscription is terminal → legitimate resubscription.
      stripe.getSubscriptionStatus.mockResolvedValueOnce('canceled');
      stripe.constructWebhookEvent.mockReturnValueOnce({
        type: 'customer.subscription.updated',
        data: {
          object: {
            id: 'sub_new',
            customer: 'cus_123',
            status: 'trialing',
            cancel_at_period_end: false,
            current_period_end: 1779537600,
            items: { data: [{ price: { lookup_key: 'premium' } }] },
          },
        },
      });

      await service.handleWebhook(Buffer.from('payload'), 'stripe-signature');

      // Never clawed back — it is the rider's real subscription.
      expect(stripe.cancelSubscription).not.toHaveBeenCalled();
      expect(stripe.refundOrVoidLatestInvoice).not.toHaveBeenCalled();
      // The reclaim UPDATE folds in the first-trial stamp.
      const qb = userRepo.createQueryBuilder.mock.results.at(-1)!.value as {
        set: jest.Mock;
      };
      expect(qb.set).toHaveBeenCalledWith(
        expect.objectContaining({
          stripe_subscription_id: 'sub_new',
          subscription_status: 'trialing',
          subscription_tier: 'premium',
          billing_trial_used_at: expect.any(Date),
        }),
      );
    });

    it('does NOT re-stamp billing_trial_used_at on a reclaim when the trial was already consumed', async () => {
      // First-trial semantics: a `trialing` reclaim on a rider who has ALREADY
      // used their trial must not overwrite the original marker (the reclaim
      // UPDATE omits the field entirely, mirroring the normal activation path).
      // Stale stored id ≠ incoming ⇒ this transition UPDATE affects 0 rows and
      // the handler falls through to the exclusivity claim (then reclaim).
      activationClaimExecute.mockResolvedValueOnce({ affected: 0 });
      providerClaim.claimForStripe.mockResolvedValueOnce('conflict');
      userRepo
        .findOne!.mockResolvedValueOnce(
          buildUser({
            stripe_customer_id: 'cus_123',
            stripe_subscription_id: 'sub_old',
            subscription_tier: 'free',
            subscription_status: 'canceled',
            billing_trial_used_at: new Date('2026-01-01T00:00:00Z'),
          }),
        )
        .mockResolvedValueOnce(
          buildUser({ stripe_subscription_id: 'sub_old' }),
        );
      stripe.getSubscriptionStatus.mockResolvedValueOnce('canceled');
      stripe.constructWebhookEvent.mockReturnValueOnce({
        type: 'customer.subscription.updated',
        data: {
          object: {
            id: 'sub_new',
            customer: 'cus_123',
            status: 'trialing',
            cancel_at_period_end: false,
            current_period_end: 1779537600,
            items: { data: [{ price: { lookup_key: 'premium' } }] },
          },
        },
      });

      await service.handleWebhook(Buffer.from('payload'), 'stripe-signature');

      const qb = userRepo.createQueryBuilder.mock.results.at(-1)!.value as {
        set: jest.Mock;
      };
      expect(qb.set).toHaveBeenCalledWith(
        expect.not.objectContaining({
          billing_trial_used_at: expect.anything(),
        }),
      );
    });

    it('opens a deletion_cancel_failed reconciliation when a reclaim activates on an account scheduled for deletion', async () => {
      // A LEGITIMATE resubscription reclaim that lands AFTER account deletion was
      // scheduled must run the SAME post-claim `deletion_scheduled_at` re-read the
      // normal-activation winner runs — otherwise the replacement subscription
      // renews/recharges on a deleted/locked account with no work item opened.
      // Stale stored id ≠ incoming ⇒ this transition UPDATE affects 0 rows and
      // the handler falls through to the exclusivity claim (then reclaim).
      activationClaimExecute.mockResolvedValueOnce({ affected: 0 });
      providerClaim.claimForStripe.mockResolvedValueOnce('conflict');
      userRepo
        .findOne!.mockResolvedValueOnce(
          buildUser({
            stripe_customer_id: 'cus_123',
            stripe_subscription_id: 'sub_old',
            subscription_tier: 'free',
            subscription_status: 'canceled',
          }),
        )
        // Reclaim re-reads the CURRENTLY-stored id fresh from the DB.
        .mockResolvedValueOnce(buildUser({ stripe_subscription_id: 'sub_old' }))
        // Post-reclaim re-read: the account is now scheduled for deletion.
        .mockResolvedValueOnce(
          buildUser({
            deletion_scheduled_at: new Date('2026-08-01T00:00:00Z'),
          }),
        );
      // The STORED (old) subscription is terminal → legitimate resubscription.
      stripe.getSubscriptionStatus.mockResolvedValueOnce('canceled');
      stripe.constructWebhookEvent.mockReturnValueOnce({
        type: 'customer.subscription.updated',
        data: {
          object: {
            id: 'sub_new',
            customer: 'cus_123',
            status: 'active',
            cancel_at_period_end: false,
            current_period_end: 1779537600,
            items: { data: [{ price: { lookup_key: 'premium' } }] },
          },
        },
      });

      await service.handleWebhook(Buffer.from('payload'), 'stripe-signature');

      // The reclaim landed (real subscription, never clawed back)...
      expect(stripe.cancelSubscription).not.toHaveBeenCalled();
      expect(stripe.refundOrVoidLatestInvoice).not.toHaveBeenCalled();
      // ...and the post-claim deletion re-read opened the cancel work item.
      expect(storeReconciliation.findOpen).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: 'stripe',
          reason: 'deletion_cancel_failed',
          stripeSubscriptionId: 'sub_new',
        }),
      );
      expect(storeReconciliation.openConflict).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-1',
          provider: 'stripe',
          stripeSubscriptionId: 'sub_new',
          reason: 'deletion_cancel_failed',
        }),
      );
    });

    it('cancels + refunds + reconciles a Stripe intruder when the reclaim hits a store-owned slot (0 rows)', async () => {
      // An Apple-owned account retains a terminal old `stripe_subscription_id`.
      // An outstanding Stripe activation reaches the reclaim branch (stored Stripe
      // sub not live), but the reclaim's ownership predicate excludes the
      // store-owned row → 0 rows affected. The incoming LIVE Stripe sub must NOT
      // be silently accepted (cross-provider double-billing): cancel + refund +
      // reconcile it exactly like the duplicate-loser path.
      activationClaimExecute.mockResolvedValue({ affected: 0 });
      providerClaim.claimForStripe.mockResolvedValueOnce('conflict');
      userRepo
        .findOne!.mockResolvedValueOnce(
          buildUser({
            stripe_customer_id: 'cus_123',
            stripe_subscription_id: 'sub_old',
            subscription_provider: 'apple',
            subscription_tier: 'premium',
            subscription_status: 'active',
          }),
        )
        .mockResolvedValueOnce(
          buildUser({ stripe_subscription_id: 'sub_old' }),
        );
      // The STORED (old) Stripe sub is terminal → reclaim branch, but 0 rows.
      stripe.getSubscriptionStatus.mockResolvedValueOnce('canceled');
      stripe.constructWebhookEvent.mockReturnValueOnce({
        type: 'customer.subscription.updated',
        data: {
          object: {
            id: 'sub_intruder',
            customer: 'cus_123',
            status: 'active',
            cancel_at_period_end: false,
            current_period_end: 1779537600,
            items: { data: [{ price: { lookup_key: 'pro' } }] },
          },
        },
      });

      await service.handleWebhook(Buffer.from('payload'), 'stripe-signature');

      expect(stripe.cancelSubscription).toHaveBeenCalledWith('sub_intruder');
      expect(stripe.refundOrVoidLatestInvoice).toHaveBeenCalledWith(
        'sub_intruder',
      );
      expect(storeReconciliation.openConflict).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-1',
          provider: 'stripe',
          stripeSubscriptionId: 'sub_intruder',
          reason: 'exclusivity_conflict',
        }),
      );
      const emailService = service['email'] as unknown as {
        sendSubscriptionConfirmed: jest.Mock;
      };
      expect(emailService.sendSubscriptionConfirmed).not.toHaveBeenCalled();
    });

    it('does NOT cancel/refund the just-claimed sub when a concurrent SAME-sub reclaim already won the slot (0-row loser is idempotent success)', async () => {
      // Two concurrent deliveries for the SAME new subscription both observe the
      // terminal stored id and enter reclaim. One wins the guarded UPDATE (the
      // slot now holds THIS incoming id); the OTHER's UPDATE affects 0 rows
      // precisely because the slot already holds this same incoming id. The
      // 0-row loser must RE-READ the stored id, see it equals the incoming, and
      // treat it as idempotent success — NOT claw back the subscription the
      // winner legitimately just claimed.
      activationClaimExecute.mockResolvedValue({ affected: 0 });
      providerClaim.claimForStripe.mockResolvedValueOnce('conflict');
      userRepo
        .findOne!.mockResolvedValueOnce(
          buildUser({
            stripe_customer_id: 'cus_123',
            stripe_subscription_id: 'sub_old',
            subscription_tier: 'free',
            subscription_status: 'canceled',
          }),
        )
        // The `stored` re-read still shows the terminal old id (both deliveries
        // resolved before either reclaim committed).
        .mockResolvedValueOnce(buildUser({ stripe_subscription_id: 'sub_old' }))
        // Post-reclaim re-read: the concurrent winner already stored the SAME
        // incoming id into the slot.
        .mockResolvedValueOnce(
          buildUser({ stripe_subscription_id: 'sub_new' }),
        );
      stripe.getSubscriptionStatus.mockResolvedValueOnce('canceled');
      stripe.constructWebhookEvent.mockReturnValueOnce({
        type: 'customer.subscription.updated',
        data: {
          object: {
            id: 'sub_new',
            customer: 'cus_123',
            status: 'active',
            cancel_at_period_end: false,
            current_period_end: 1779537600,
            items: { data: [{ price: { lookup_key: 'premium' } }] },
          },
        },
      });

      await service.handleWebhook(Buffer.from('payload'), 'stripe-signature');

      // The idempotent 0-row loser touches NO Stripe and opens NO conflict.
      expect(stripe.cancelSubscription).not.toHaveBeenCalled();
      expect(stripe.refundOrVoidLatestInvoice).not.toHaveBeenCalled();
      expect(storeReconciliation.openConflict).not.toHaveBeenCalled();
      // The winner (the other delivery) sends the confirmation, not this loser.
      const emailService = service['email'] as unknown as {
        sendSubscriptionConfirmed: jest.Mock;
      };
      expect(emailService.sendSubscriptionConfirmed).not.toHaveBeenCalled();
    });

    it('cancels + refunds + reconciles a GENUINE duplicate when the STORED subscription is still live', async () => {
      // Same-shape conflict, but the STORED subscription is STILL live on Stripe
      // → the incoming is a second, redundant subscription. The branch is
      // decided from the STORED status (not the incoming's): cancel + refund the
      // incoming and open a reconciliation (round-8 behavior preserved).
      // Conflict ⇒ another live session owns the row ⇒ this transition UPDATE
      // affects 0 rows and the handler falls through to the exclusivity claim.
      activationClaimExecute.mockResolvedValueOnce({ affected: 0 });
      providerClaim.claimForStripe.mockResolvedValueOnce('conflict');
      userRepo
        .findOne!.mockResolvedValueOnce(
          buildUser({
            stripe_customer_id: 'cus_123',
            stripe_subscription_id: 'sub_winning',
            subscription_tier: 'premium',
            subscription_status: 'active',
          }),
        )
        .mockResolvedValueOnce(
          buildUser({ stripe_subscription_id: 'sub_winning' }),
        );
      // The STORED subscription is confirmed still live on Stripe.
      stripe.getSubscriptionStatus.mockResolvedValueOnce('active');
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

      // The STORED status was consulted to reach the duplicate verdict.
      expect(stripe.getSubscriptionStatus).toHaveBeenCalledWith('sub_winning');
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
      // Conflict ⇒ another live session owns the row ⇒ this transition UPDATE
      // affects 0 rows and the handler falls through to the exclusivity claim.
      activationClaimExecute.mockResolvedValueOnce({ affected: 0 });
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
      // Conflict ⇒ another live session owns the row ⇒ this transition UPDATE
      // affects 0 rows and the handler falls through to the exclusivity claim.
      activationClaimExecute.mockResolvedValueOnce({ affected: 0 });
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

    it('locks provider ownership in the activation claim and skips the redundant follow-up claim so the transition winner sends exactly one confirmation', async () => {
      // Split-winner race guard. Previously the activation status-claim only
      // flipped `subscription_status`, leaving `stripe_subscription_id` NULL —
      // so a second session with a DIFFERENT id could still win
      // `claimForStripe` while the status-claim winner LOST it (returning at
      // the conflict branch before dispatching), and the true owner had
      // `wonActivationTransition=false` → the confirmation was dropped
      // entirely. The activation claim now ALSO writes
      // `subscription_provider='stripe'` + `stripe_subscription_id`, locking
      // the slot in ONE atomic UPDATE. Because that UPDATE is authoritative,
      // the transition winner no longer re-runs `claimForStripe` at all — the
      // redundant second write could clobber a newer concurrently-committed
      // status. Here the handler wins the transition (affected:1), skips the
      // follow-up claim, and sends exactly one confirmation for the true owner.
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
      // The transition winner does NOT re-run the follow-up exclusivity claim
      // (its atomic UPDATE already owns every field), yet exactly one
      // confirmation still goes out for the true owner.
      expect(providerClaim.claimForStripe).not.toHaveBeenCalled();
      const emailService = service['email'] as unknown as {
        sendSubscriptionConfirmed: jest.Mock;
      };
      expect(emailService.sendSubscriptionConfirmed).toHaveBeenCalledTimes(1);
    });

    it('writes ALL authoritative fields in the single activation UPDATE so a crash before claimForStripe leaves a COMPLETE row (not a status-only partial)', async () => {
      // Round-3 split the transition detection (status + identity only) from
      // the authoritative field write (`claimForStripe`: tier/period/cancel).
      // A crash between the two committed an active-status-but-no-tier/period
      // partial row; on Stripe's retry the transition predicate no longer won,
      // so `claimForStripe` repaired entitlement but `wonActivationTransition`
      // stayed false → the confirmation was permanently lost. Collapsing both
      // into ONE guarded UPDATE means the winning UPDATE alone leaves a
      // complete, correct row — the wider partial-state window is closed.
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
            items: {
              data: [
                {
                  price: { lookup_key: 'premium' },
                  current_period_end: 1779537600,
                },
              ],
            },
          },
        },
      });

      await service.handleWebhook(Buffer.from('payload'), 'stripe-signature');
      await new Promise((resolve) => setImmediate(resolve));

      const qb = userRepo.createQueryBuilder.mock.results.at(-1)!.value as {
        set: jest.Mock;
      };
      // The single transition UPDATE now writes the FULL authoritative field
      // set — status, ownership, tier, period end, cancel flag, plan source.
      expect(qb.set).toHaveBeenCalledWith(
        expect.objectContaining({
          subscription_status: 'active',
          subscription_provider: 'stripe',
          stripe_subscription_id: 'sub_winner',
          subscription_tier: 'premium',
          subscription_current_period_end: new Date(1779537600 * 1000),
          subscription_cancel_at_period_end: false,
          plan_source: 'subscription',
        }),
      );
      // The two-session/loser/double-send behavior is unchanged: exactly one
      // confirmation for the sole winner.
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

    it('does NOT re-run the exclusivity claim after winning the activation transition, so a concurrently-committed past_due status is never clobbered back to active', async () => {
      // Concurrent same-subscription ordering. An older `active` webhook and a
      // newer `past_due` webhook run in parallel for `sub_123`. The `active`
      // handler wins its transition UPDATE (writing status=active + all fields),
      // then pauses. Meanwhile the `past_due` handler commits its own transition
      // (status=past_due). If the `active` handler then RESUMED into the
      // follow-up `claimForStripe`, that unconditional guarded write — whose
      // WHERE clause matches on provider + subscription id but NOT status —
      // would re-stamp `active` OVER the freshly committed `past_due`,
      // reintroducing the split-write race the atomic transition UPDATE was
      // meant to remove. The transition winner must therefore SKIP the follow-up
      // claim entirely.
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
      await new Promise((resolve) => setImmediate(resolve));

      // The transition winner issues NO follow-up exclusivity claim — there is
      // no second, status-blind write that could overwrite the concurrently
      // committed `past_due` back to `active`.
      expect(providerClaim.claimForStripe).not.toHaveBeenCalled();
      // The single winning transition UPDATE stays the only status writer, and
      // the orthogonal update it flushes never carries `subscription_status`.
      expect(userRepo.update).toHaveBeenCalledWith(
        'user-1',
        expect.not.objectContaining({ subscription_status: expect.anything() }),
      );
      // The confirmation still goes out exactly once for the winning activation.
      const emailService = service['email'] as unknown as {
        sendSubscriptionConfirmed: jest.Mock;
      };
      expect(emailService.sendSubscriptionConfirmed).toHaveBeenCalledTimes(1);
    });
  });
});
