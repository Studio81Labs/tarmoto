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
import { User } from '../../entities/user.entity.js';

describe('AccountService', () => {
  let service: AccountService;
  let userRepo: Partial<jest.Mocked<Repository<User>>> & {
    createQueryBuilder: jest.Mock;
  };
  let stripe: jest.Mocked<StripeBillingClient>;

  const buildUser = (overrides: Partial<User> = {}): User =>
    ({
      id: 'user-1',
      email: 'rider@tarmoto.app',
      display_name: 'Test Rider',
      phone: null,
      avatar_url: null,
      bio: null,
      home_region: null,
      home_location: null,
      work_location: null,
      preferences: {},
      created_at: new Date('2026-04-23T12:00:00Z'),
      updated_at: new Date('2026-04-23T12:00:00Z'),
      stripe_customer_id: null,
      stripe_subscription_id: null,
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
    } as unknown as typeof userRepo;

    stripe = {
      ensureCustomer: jest.fn(),
      getBillingSnapshot: jest.fn(),
      createCheckoutSession: jest.fn(),
      createPortalSession: jest.fn(),
      cancelSubscription: jest.fn(),
      deleteCustomer: jest.fn(),
      isConfigured: jest.fn().mockReturnValue(true),
      constructWebhookEvent: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AccountService,
        { provide: getRepositoryToken(User), useValue: userRepo },
        { provide: STRIPE_BILLING_CLIENT, useValue: stripe },
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
        name: 'Free',
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
            amountLabel: '$29.99',
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
        price_label: '$29.99/yr',
      });
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
          returnUrl: 'http://localhost:3000/settings/subscription',
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
      expect(userRepo.update).toHaveBeenCalledWith(
        'user-1',
        expect.objectContaining({
          updated_at: expect.any(Date),
          stripe_customer_id: 'cus_123',
          stripe_subscription_id: 'sub_123',
        }),
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

      const [, update] = userRepo.update!.mock.calls.at(-1)!;
      expect(userRepo.update).toHaveBeenCalledWith('user-1', update);
      expect(update).toEqual({
        updated_at: expect.any(Date),
        stripe_customer_id: 'cus_123',
        stripe_subscription_id: 'sub_123',
      });
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

      expect(userRepo.update).toHaveBeenCalledWith(
        'user-1',
        expect.objectContaining({
          updated_at: expect.any(Date),
          stripe_customer_id: 'cus_123',
          stripe_subscription_id: 'sub_123',
          subscription_tier: 'pro',
          subscription_status: 'trialing',
          subscription_cancel_at_period_end: true,
          billing_trial_used_at: expect.any(Date),
        }),
      );
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
  });
});
