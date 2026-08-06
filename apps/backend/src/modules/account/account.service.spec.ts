/* eslint-disable @typescript-eslint/unbound-method, @typescript-eslint/no-unsafe-assignment */
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { getQueueToken } from '@nestjs/bullmq';
import {
  BadRequestException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Repository, EntityManager } from 'typeorm';
import { AccountService } from './account.service.js';
import {
  STRIPE_BILLING_CLIENT,
  type StripeBillingClient,
} from './stripe-billing.client.js';
import { QUEUE_NAMES } from '../jobs/jobs.constants.js';
import { ProviderClaimService } from './provider-claim.service.js';
import { StoreReconciliationService } from './store-reconciliation.service.js';
import { SubscriptionMutationLockService } from './subscription-mutation-lock.service.js';
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
  // The subscription-notification queue: AccountService enqueues here instead of
  // sending inline (the fence-revalidated delivery is verified in
  // subscription-notification.service.spec). Tests assert the enqueued payload.
  let notifyQueue: { add: jest.Mock };
  // Backs nextNotifyGeneration()'s fence-guarded increment-returning. Defaults to
  // one row (generation 1); a test can override it to `[]` to simulate the
  // lost-lease (fence-guard 0-row) case.
  let genQuery: jest.Mock;

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

  // Enqueued notification payloads of a given kind (the fence-revalidated
  // delivery itself is covered by subscription-notification.service.spec).
  const notifyCalls = (
    kind: 'confirmed' | 'cancelled' | 'billing_failed',
  ): Array<Record<string, unknown>> =>
    notifyQueue.add.mock.calls
      .map((c: unknown[]) => c[1] as Record<string, unknown>)
      .filter((data) => data?.kind === kind);

  // The `.set` mock off the LAST `userRepo.createQueryBuilder()` call — used
  // to inspect what a WINNING atomic transition claim (activation or
  // past-due) persisted, for the cases where that claim — not the
  // `claimForStripe` follow-up it skips on a win — is the actual writer (see
  // the finding-5a entitling-status tests below). Throws instead of
  // non-null-asserting: a missing result means the transition claim never
  // ran, which is itself a real regression this should surface clearly
  // rather than mask behind a generic "cannot read property of undefined".
  const lastTransitionClaimSet = (): jest.Mock => {
    const result = userRepo.createQueryBuilder.mock.results.at(-1);
    if (!result) {
      throw new Error(
        'userRepo.createQueryBuilder was not called — no transition claim ran',
      );
    }
    return (result.value as { set: jest.Mock }).set;
  };

  let activationClaimExecute: jest.Mock;

  beforeEach(async () => {
    activationClaimExecute = jest.fn().mockResolvedValue({ affected: 1 });
    userRepo = {
      findOne: jest.fn().mockResolvedValue(buildUser()),
      // Fence-stale guard (`assertSubscriptionFenceCurrent`): default not stale.
      existsBy: jest.fn().mockResolvedValue(false),
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
    notifyQueue = { add: jest.fn().mockResolvedValue(undefined) };
    // node-postgres via TypeORM returns `[returnedRows, affectedCount]` for an
    // UPDATE ... RETURNING — the row array is the FIRST tuple element.
    genQuery = jest
      .fn()
      .mockResolvedValue([[{ subscription_notify_generation: '1' }], 1]);

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
          // Passthrough: the real per-rider Redis lock is verified by reasoning +
          // the proven POI upload-lock pattern, not in unit tests. Here it just
          // runs the fn on the (mocked) pool manager with a lease whose
          // `assertHeld` always passes (lock held).
          provide: SubscriptionMutationLockService,
          useValue: {
            runExclusive: <T>(
              _userId: string,
              fn: (
                m: EntityManager,
                lease: {
                  assertHeld: () => Promise<void>;
                  fenceToken: number;
                  publishFence: () => Promise<void>;
                },
              ) => Promise<T>,
            ): Promise<T> =>
              fn(
                {
                  getRepository: () => userRepo,
                  // nextNotifyGeneration()'s atomic, fence-guarded
                  // increment-returning (overridable per-test via `genQuery`).
                  query: genQuery,
                } as unknown as EntityManager,
                {
                  assertHeld: () => Promise.resolve(),
                  fenceToken: 1,
                  publishFence: () => Promise.resolve(),
                },
              ),
          },
        },
        {
          provide: getQueueToken(QUEUE_NAMES.SUBSCRIPTION_NOTIFY),
          useValue: notifyQueue,
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
      // Finding 1: the once-per-rider trial marker is folded into the SAME
      // atomic grant UPDATE (via COALESCE), not written in a separate,
      // race-prone follow-up statement.
      const transitionSet = (
        transitionQb.set.mock.calls as unknown as Array<
          [Record<string, unknown>]
        >
      ).at(-1)?.[0];
      const trialStamp = transitionSet?.billing_trial_used_at as () => string;
      expect(typeof trialStamp).toBe('function');
      expect(trialStamp()).toBe('COALESCE(billing_trial_used_at, NOW())');
      // Finding 2 (round 25): the trialing grant is guarded on CURRENT
      // eligibility — the WHERE requires `billing_trial_used_at IS NULL`, so an
      // ineligible trial (marker already consumed elsewhere) affects 0 rows and
      // is cancelled + reconciled rather than granted.
      expect(transitionQb.andWhere).toHaveBeenCalledWith(
        'billing_trial_used_at IS NULL',
      );
      // Only the orthogonal fields not covered by the claim are flushed via the
      // unconditional update — never `subscription_status`, never the core fields
      // the claim already owns, and (Finding 1) NO separate trial stamp on the
      // trial-GRANT path (the winning activation stamped it atomically above).
      // The orthogonal flush is now an ATOMIC fence-guarded update: the criteria
      // is a where object (id + `subscription_lock_fence <= :token`), and the
      // payload also stamps the fence.
      expect(userRepo.update).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'user-1' }),
        expect.objectContaining({
          updated_at: expect.any(Date),
          stripe_customer_id: 'cus_123',
          subscription_lock_fence: 1,
        }),
      );
      expect(userRepo.update).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'user-1' }),
        expect.not.objectContaining({
          billing_trial_used_at: expect.anything(),
        }),
      );
      expect(userRepo.update).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'user-1' }),
        expect.not.objectContaining({ subscription_status: expect.anything() }),
      );
      // Conditional activation claim gates the winner-only email dispatch.
      expect(activationClaimExecute).toHaveBeenCalled();
      // Confirmation is ENQUEUED (fence-revalidated delivery covered elsewhere)
      // carrying the tier + this flow's fence token.
      expect(notifyCalls('confirmed')).toHaveLength(1);
      expect(notifyCalls('confirmed')[0]).toMatchObject({
        kind: 'confirmed',
        userId: 'user-1',
        tier: 'pro',
      });
    });

    // Round-28: the notification-generation increment is FENCE-GUARDED. If it
    // affects 0 rows (a newer holder advanced the fence while this UPDATE waited
    // for a pool connection past the lease), the flow must abort retryable rather
    // than mint a stale generation that would out-rank the newer transition.
    it('fails retryable when the notification-generation increment is fenced out (0 rows)', async () => {
      // Fenced-out UPDATE ... RETURNING: zero returned rows, zero affected.
      genQuery.mockResolvedValue([[], 0]);
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

      await expect(
        service.handleWebhook(Buffer.from('payload'), 'stripe-signature'),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      // Never enqueued a notification on the fenced-out (stale) flow.
      expect(notifyCalls('confirmed')).toHaveLength(0);
    });

    // Round-31 (accepted residual): a failed enqueue is swallowed — the
    // transition already committed, so failing the webhook wouldn't help (the
    // retry can't re-win the transition) and the subscription state is still
    // correct. The webhook must ack, not throw.
    it('swallows a notification enqueue failure without failing the webhook', async () => {
      notifyQueue.add.mockRejectedValueOnce(new Error('redis down'));
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

      await expect(
        service.handleWebhook(Buffer.from('payload'), 'stripe-signature'),
      ).resolves.toBeUndefined();
      // The enqueue was attempted (and failed) — the transition still committed.
      expect(notifyQueue.add).toHaveBeenCalled();
    });

    // Round-19/20: the orthogonal follow-up flush must be ATOMICALLY fence-guarded
    // (a check-then-update would race). Its criteria carries the fence predicate
    // and its payload restamps the fence, so a stale handler matches 0 rows and
    // never clobbers stripe_customer_id / billing_trial_used_at over newer state.
    it('flushes the orthogonal fields via an atomic fence-guarded update', async () => {
      userRepo.findOne!.mockResolvedValue(
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

      // The flush's criteria includes the fence predicate (a FindOperator on
      // subscription_lock_fence), and the payload restamps the fence — one atomic
      // statement, not a check-then-update.
      expect(userRepo.update).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'user-1',
          subscription_lock_fence: expect.anything(),
        }),
        expect.objectContaining({ subscription_lock_fence: 1 }),
      );
    });

    // Finding 1: a NON-trial (active) Stripe activation must NOT stamp
    // billing_trial_used_at — neither in the atomic grant UPDATE nor in the
    // orthogonal follow-up update.
    it('does NOT stamp billing_trial_used_at on a non-trial (active) activation', async () => {
      userRepo.findOne!.mockResolvedValueOnce(
        buildUser({
          stripe_customer_id: 'cus_123',
          billing_trial_used_at: null,
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

      const transitionQb = userRepo.createQueryBuilder.mock.results.at(-1)!
        .value as { set: jest.Mock };
      const transitionSet = (
        transitionQb.set.mock.calls as unknown as Array<
          [Record<string, unknown>]
        >
      ).at(-1)?.[0];
      expect(transitionSet).not.toHaveProperty('billing_trial_used_at');
      // Finding 2 (round 25): the eligibility guard is confined to the trial
      // path — a non-trial (active) activation must NOT carry it.
      expect(transitionQb.andWhere).not.toHaveBeenCalledWith(
        'billing_trial_used_at IS NULL',
      );
      expect(userRepo.update).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'user-1' }),
        expect.not.objectContaining({
          billing_trial_used_at: expect.anything(),
        }),
      );
    });

    // Finding 2 (round 25): an INELIGIBLE `trialing` activation — the rider's
    // once-per-rider trial marker is ALREADY set (consumed elsewhere, e.g. an
    // Apple trial that then freed the slot) and the grant UPDATE affects 0 rows
    // because of the `billing_trial_used_at IS NULL` guard. The handler must NOT
    // grant the trialing tier: instead it cancels the Stripe trial via the P0
    // reversible cancel (`setCancelAtPeriodEnd(true)` — a trial has no charge, so
    // never a refund) and opens a deduped `ineligible_trial_rejected`
    // reconciliation, without ever calling `claimForStripe` (which would re-grant
    // the tier on the freed slot — the double-trial this finding prevents).
    it('does NOT grant an ineligible trialing activation: cancels + opens ineligible_trial_rejected instead', async () => {
      // Initial user load.
      userRepo
        .findOne!.mockResolvedValueOnce(
          buildUser({
            stripe_customer_id: 'cus_123',
            subscription_status: 'canceled',
            billing_trial_used_at: new Date('2026-01-01T00:00:00Z'),
          }),
        )
        .mockResolvedValueOnce(
          buildUser({
            stripe_customer_id: 'cus_123',
            subscription_status: 'canceled',
            billing_trial_used_at: new Date('2026-01-01T00:00:00Z'),
          }),
        );
      // The eligibility-guarded grant UPDATE matches no row (marker already set).
      activationClaimExecute.mockResolvedValue({ affected: 0 });
      // The `fresh` re-read the lost-guard handler consults: marker set, NOT
      // active/trialing, and the slot is claimable by this Stripe sub (so
      // `claimForStripe` WOULD otherwise grant the tier) — the ineligible shape.
      userRepo.findOne!.mockResolvedValueOnce(
        buildUser({
          subscription_status: 'canceled',
          subscription_provider: null,
          stripe_subscription_id: null,
          billing_trial_used_at: new Date('2026-01-01T00:00:00Z'),
        }),
      );
      stripe.constructWebhookEvent.mockReturnValueOnce({
        type: 'customer.subscription.updated',
        data: {
          object: {
            id: 'sub_123',
            customer: 'cus_123',
            status: 'trialing',
            cancel_at_period_end: false,
            current_period_end: 1779537600,
            items: { data: [{ price: { lookup_key: 'pro' } }] },
          },
        },
      });

      await service.handleWebhook(Buffer.from('payload'), 'stripe-signature');

      // The tier is NOT granted — no fall-through to the exclusivity claim.
      expect(providerClaim.claimForStripe).not.toHaveBeenCalled();
      // Cancelled via the reversible P0 cancel (trial has no charge → not refund).
      expect(stripe.setCancelAtPeriodEnd).toHaveBeenCalledWith('sub_123', true);
      expect(stripe.cancelSubscription).not.toHaveBeenCalled();
      expect(stripe.refundOrVoidLatestInvoice).not.toHaveBeenCalled();
      // A durable, deduped reconciliation is opened for ops.
      expect(storeReconciliation.openConflict).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-1',
          provider: 'stripe',
          stripeSubscriptionId: 'sub_123',
          reason: 'ineligible_trial_rejected',
        }),
        expect.anything(),
      );
      // No confirmation email — nothing was granted.
      expect(notifyCalls('confirmed')).toHaveLength(0);
    });

    // Finding 2 (round 25): a redelivered ineligible trial we have already
    // reconciled is an idempotent no-op — the `findOpen` dedup skips both the
    // Stripe cancel and a duplicate reconciliation row.
    it('is an idempotent no-op on a redelivered ineligible trialing activation already reconciled', async () => {
      userRepo
        .findOne!.mockResolvedValueOnce(
          buildUser({
            stripe_customer_id: 'cus_123',
            subscription_status: 'canceled',
            billing_trial_used_at: new Date('2026-01-01T00:00:00Z'),
          }),
        )
        .mockResolvedValueOnce(
          buildUser({
            stripe_customer_id: 'cus_123',
            subscription_status: 'canceled',
            billing_trial_used_at: new Date('2026-01-01T00:00:00Z'),
          }),
        );
      activationClaimExecute.mockResolvedValue({ affected: 0 });
      userRepo.findOne!.mockResolvedValueOnce(
        buildUser({
          subscription_status: 'canceled',
          subscription_provider: null,
          stripe_subscription_id: null,
          billing_trial_used_at: new Date('2026-01-01T00:00:00Z'),
        }),
      );
      // An open ineligible_trial_rejected reconciliation already exists.
      storeReconciliation.findOpen.mockResolvedValue([{ id: 'sbr-existing' }]);
      stripe.constructWebhookEvent.mockReturnValueOnce({
        type: 'customer.subscription.updated',
        data: {
          object: {
            id: 'sub_123',
            customer: 'cus_123',
            status: 'trialing',
            cancel_at_period_end: false,
            current_period_end: 1779537600,
            items: { data: [{ price: { lookup_key: 'pro' } }] },
          },
        },
      });

      await service.handleWebhook(Buffer.from('payload'), 'stripe-signature');

      expect(providerClaim.claimForStripe).not.toHaveBeenCalled();
      expect(stripe.setCancelAtPeriodEnd).not.toHaveBeenCalled();
      expect(storeReconciliation.openConflict).not.toHaveBeenCalled();
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
        {},
        expect.anything(),
      );
      expect(storeReconciliation.openConflict).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-1',
          provider: 'stripe',
          stripeSubscriptionId: 'sub_123',
          reason: 'deletion_cancel_failed',
        }),
        expect.anything(),
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
        expect.anything(),
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
        .mockResolvedValueOnce(
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
      expect(notifyCalls('confirmed')).toHaveLength(0);
      expect(storeReconciliation.openConflict).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-1',
          provider: 'stripe',
          stripeSubscriptionId: 'sub_123',
          reason: 'deletion_cancel_failed',
        }),
        expect.anything(),
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
      userRepo
        .findOne!.mockResolvedValueOnce(
          buildUser({
            stripe_customer_id: 'cus_123',
            stripe_subscription_id: 'sub_123',
            subscription_tier: 'pro',
            plan_source: 'founder',
            subscription_status: 'active',
          }),
        )
        .mockResolvedValueOnce(
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
        expect.any(Number),
        expect.anything(),
      );
      // Cancellation is ENQUEUED carrying the plan name + this flow's fence token.
      expect(notifyCalls('cancelled')).toHaveLength(1);
      expect(notifyCalls('cancelled')[0]).toMatchObject({
        kind: 'cancelled',
        userId: 'user-1',
        planName: 'Pro',
      });
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
        expect.any(Number),
        expect.anything(),
      );
      // No field-clearing update and no cancellation email on the no-op.
      expect(userRepo.update).not.toHaveBeenCalled();
      expect(notifyCalls('cancelled')).toHaveLength(0);
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
        expect.anything(),
      );
      // The winning row is never overwritten and no confirmation goes out.
      expect(userRepo.update).not.toHaveBeenCalled();
      expect(notifyCalls('confirmed')).toHaveLength(0);
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
        .mockResolvedValueOnce(
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
      expect(notifyCalls('confirmed')).toHaveLength(1);
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
      // The reclaim UPDATE folds in the first-trial stamp atomically (via
      // COALESCE, matching the normal activation transition), and is guarded
      // on current eligibility the same way (Finding round 26).
      const qb = userRepo.createQueryBuilder.mock.results.at(-1)!.value as {
        set: jest.Mock;
        andWhere: jest.Mock;
      };
      expect(qb.set).toHaveBeenCalledWith(
        expect.objectContaining({
          stripe_subscription_id: 'sub_new',
          subscription_status: 'trialing',
          subscription_tier: 'premium',
        }),
      );
      const reclaimSet = (
        qb.set.mock.calls as unknown as Array<[Record<string, unknown>]>
      ).at(-1)?.[0];
      const trialStamp = reclaimSet?.billing_trial_used_at as () => string;
      expect(typeof trialStamp).toBe('function');
      expect(trialStamp()).toBe('COALESCE(billing_trial_used_at, NOW())');
      expect(qb.andWhere).toHaveBeenCalledWith('billing_trial_used_at IS NULL');
    });

    // FINDING (round 26): a `trialing` RECLAIM on a rider whose
    // `billing_trial_used_at` is ALREADY set must not grant the tier — the
    // reclaim's own `billing_trial_used_at IS NULL` guard (mirroring the
    // normal activation transition) rejects the UPDATE, and the SAME
    // lost-guard rejection round 25 wired for the normal path fires here too:
    // cancel the (charge-free) trial and open a deduped
    // `ineligible_trial_rejected` reconciliation. Before this fix, the reclaim
    // path only skipped RE-DATING the marker on an already-used trial but
    // still GRANTED the tier — a delayed resubscription checkout could mint a
    // SECOND trial.
    it('does NOT grant an ineligible trialing RECLAIM: cancels + opens ineligible_trial_rejected instead', async () => {
      // Stale stored id ≠ incoming ⇒ this transition UPDATE affects 0 rows and
      // the handler falls through to the exclusivity claim (then reclaim).
      activationClaimExecute
        .mockResolvedValueOnce({ affected: 0 }) // activation-transition claim
        .mockResolvedValueOnce({ affected: 0 }); // reclaim UPDATE loses the eligibility guard
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
          buildUser({
            stripe_customer_id: 'cus_123',
            stripe_subscription_id: 'sub_old',
            subscription_tier: 'free',
            subscription_status: 'canceled',
            billing_trial_used_at: new Date('2026-01-01T00:00:00Z'),
          }),
        )
        // The reclaim path re-reads the CURRENTLY-stored id fresh from the DB.
        .mockResolvedValueOnce(buildUser({ stripe_subscription_id: 'sub_old' }))
        // Post-reclaim re-read: the slot still holds the stale id (the reclaim
        // UPDATE never landed) and the marker is already set — the ineligible
        // shape, not a stale-id race.
        .mockResolvedValueOnce(
          buildUser({
            subscription_status: 'canceled',
            subscription_provider: null,
            stripe_subscription_id: 'sub_old',
            billing_trial_used_at: new Date('2026-01-01T00:00:00Z'),
          }),
        );
      // The STORED (old) subscription is terminal → legitimate resubscription
      // shape, but the incoming trialing rider is not eligible for a trial.
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

      // The tier is NOT granted.
      const qb = userRepo.createQueryBuilder.mock.results.at(-1)!.value as {
        andWhere: jest.Mock;
      };
      expect(qb.andWhere).toHaveBeenCalledWith('billing_trial_used_at IS NULL');
      // Cancelled via the reversible P0 cancel (trial has no charge → not
      // refund, and NOT the exclusivity-conflict cancel+refund pair).
      expect(stripe.setCancelAtPeriodEnd).toHaveBeenCalledWith('sub_new', true);
      expect(stripe.cancelSubscription).not.toHaveBeenCalled();
      expect(stripe.refundOrVoidLatestInvoice).not.toHaveBeenCalled();
      // A durable, deduped reconciliation is opened for ops — the SAME reason
      // round 25 uses for the normal activation path.
      expect(storeReconciliation.openConflict).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-1',
          provider: 'stripe',
          stripeSubscriptionId: 'sub_new',
          reason: 'ineligible_trial_rejected',
        }),
        expect.anything(),
      );
      // No confirmation email — nothing was granted.
      expect(notifyCalls('confirmed')).toHaveLength(0);
    });

    // Finding (round 27): the DELAYED-TERMINAL variant of the ineligible reclaim.
    // Stripe reports the old subscription has ENDED (so the reclaim proceeds), but
    // its terminal `customer.subscription.deleted` webhook has not landed yet, so
    // `postReclaim` STILL shows the stale id (`sub_old`) as `active`. A liveness
    // check keyed on the stored row's STATUS would call the old sub "already live",
    // suppress the ineligible-trial branch, and fall through to the exclusivity
    // path — which would wrongly cancel/refund the charge-free incoming trial.
    // Keying liveness on the INCOMING subscription id fixes it: the stale-id row
    // is not the incoming purchase, so this is correctly an ineligible trial.
    it('rejects an ineligible trialing RECLAIM even when the stale sub still shows active (delayed terminal webhook)', async () => {
      activationClaimExecute
        .mockResolvedValueOnce({ affected: 0 }) // activation-transition claim
        .mockResolvedValueOnce({ affected: 0 }); // reclaim UPDATE loses the eligibility guard
      providerClaim.claimForStripe.mockResolvedValueOnce('conflict');
      userRepo
        .findOne!.mockResolvedValueOnce(
          buildUser({
            stripe_customer_id: 'cus_123',
            stripe_subscription_id: 'sub_old',
            subscription_tier: 'premium',
            subscription_status: 'active',
            billing_trial_used_at: new Date('2026-01-01T00:00:00Z'),
          }),
        )
        .mockResolvedValueOnce(
          buildUser({
            stripe_customer_id: 'cus_123',
            stripe_subscription_id: 'sub_old',
            subscription_tier: 'premium',
            subscription_status: 'active',
            billing_trial_used_at: new Date('2026-01-01T00:00:00Z'),
          }),
        )
        // Reclaim re-reads the currently-stored id fresh.
        .mockResolvedValueOnce(buildUser({ stripe_subscription_id: 'sub_old' }))
        // Post-reclaim re-read: the stale id is STILL stored AND STILL shows
        // `active` because its terminal webhook is delayed — the DELAYED-TERMINAL
        // shape. Marker already set; slot still holds the stale id.
        .mockResolvedValueOnce(
          buildUser({
            subscription_status: 'active',
            subscription_provider: 'stripe',
            stripe_subscription_id: 'sub_old',
            billing_trial_used_at: new Date('2026-01-01T00:00:00Z'),
          }),
        );
      // Stripe reports the OLD subscription has ended → reclaim proceeds even
      // though the DB row hasn't been updated by the terminal webhook yet.
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

      // Classified as an ineligible trial (CAUSE 1), NOT the exclusivity path:
      // reversible cancel of the incoming trial, deduped ineligible reconciliation,
      // and crucially NO refund / NO exclusivity_conflict.
      expect(stripe.setCancelAtPeriodEnd).toHaveBeenCalledWith('sub_new', true);
      expect(stripe.refundOrVoidLatestInvoice).not.toHaveBeenCalled();
      expect(storeReconciliation.openConflict).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-1',
          provider: 'stripe',
          stripeSubscriptionId: 'sub_new',
          reason: 'ineligible_trial_rejected',
        }),
        expect.anything(),
      );
      expect(storeReconciliation.openConflict).not.toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'exclusivity_conflict' }),
        expect.anything(),
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
        .mockResolvedValueOnce(
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
        {},
        expect.anything(),
      );
      expect(storeReconciliation.openConflict).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-1',
          provider: 'stripe',
          stripeSubscriptionId: 'sub_new',
          reason: 'deletion_cancel_failed',
        }),
        expect.anything(),
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
        expect.anything(),
      );
      expect(notifyCalls('confirmed')).toHaveLength(0);
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
        .mockResolvedValueOnce(
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
      expect(notifyCalls('confirmed')).toHaveLength(0);
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
        expect.anything(),
      );
      expect(notifyCalls('confirmed')).toHaveLength(0);
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
        expect.anything(),
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
        {},
        expect.anything(),
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

      expect(notifyCalls('confirmed')).toHaveLength(0);
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
      expect(notifyCalls('confirmed')).toHaveLength(1);
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
      expect(notifyCalls('confirmed')).toHaveLength(1);
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

      // The billing-failed push is ENQUEUED (fence-revalidated delivery covered
      // elsewhere) carrying the rider id + this flow's fence token.
      expect(notifyCalls('billing_failed')).toHaveLength(1);
      expect(notifyCalls('billing_failed')[0]).toMatchObject({
        kind: 'billing_failed',
        userId: expect.any(String),
      });
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

      expect(notifyCalls('billing_failed')).toHaveLength(0);
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
        expect.objectContaining({ id: 'user-1' }),
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
        expect.objectContaining({ id: 'user-1' }),
        expect.not.objectContaining({ subscription_status: expect.anything() }),
      );
      // The confirmation still goes out exactly once for the winning activation.
      expect(notifyCalls('confirmed')).toHaveLength(1);
    });

    // Finding 5a: a paid tier must be persisted ONLY for an entitling raw
    // Stripe status. These statuses all mean "no successful payment", so the
    // rider must land on `free` even though the subscription carries a paid
    // price.
    //
    // `incomplete`/`incomplete_expired` collapse (via `statusFromSubscription`)
    // into the STORED status `canceled`, which neither transition claim below
    // owns, so the write goes through the `claimForStripe` follow-up — assert
    // there. `unpaid` collapses into stored `past_due` instead, which DOES own
    // a transition claim and is asserted separately below (see that test for
    // why).
    it.each([
      ['incomplete', 'initial payment never succeeded'],
      ['incomplete_expired', 'initial payment window expired'],
    ])(
      'persists `free` for the non-entitling Stripe status %s (%s)',
      async (rawStatus) => {
        userRepo.findOne!.mockResolvedValueOnce(
          buildUser({
            stripe_customer_id: 'cus_123',
            stripe_subscription_id: 'sub_1',
            subscription_tier: 'free',
            subscription_status: 'canceled',
          }),
        );
        stripe.constructWebhookEvent.mockReturnValueOnce({
          type: 'customer.subscription.updated',
          data: {
            object: {
              id: 'sub_1',
              customer: 'cus_123',
              status: rawStatus,
              cancel_at_period_end: false,
              current_period_end: 1779537600,
              items: { data: [{ price: { lookup_key: 'pro' } }] },
            },
          },
        });

        await service.handleWebhook(Buffer.from('payload'), 'stripe-signature');

        expect(providerClaim.claimForStripe).toHaveBeenCalledWith(
          expect.any(String),
          'sub_1',
          expect.objectContaining({ tier: 'free', planSource: null }),
          expect.anything(),
        );
        // Non-entitling means no activation transition, so no confirmation mail.
        expect(notifyQueue.add).not.toHaveBeenCalled();
      },
    );

    // `unpaid` collapses (via `statusFromSubscription`) into the STORED status
    // `past_due`, so — unlike `incomplete`/`incomplete_expired` above — it wins
    // the atomic past-due transition claim (the mocked query builder always
    // resolves `{ affected: 1 }` unless a test overrides it) and the tier lands
    // via THAT claim's own `.set()` call. The transition winner then skips the
    // follow-up `claimForStripe` entirely (see the comment above the
    // exclusivity claim in `applyStripeSubscriptionEvent`), so this must assert
    // on the transition write instead of `claimForStripe`. The billing-failed
    // push still fires from that same claim — that is Stripe's ordinary
    // past-due retry alert and is orthogonal to entitlement, so it is
    // intentionally not asserted either way here.
    it('persists `free` for the non-entitling Stripe status unpaid (retries exhausted)', async () => {
      userRepo.findOne!.mockResolvedValueOnce(
        buildUser({
          stripe_customer_id: 'cus_123',
          stripe_subscription_id: 'sub_1',
          subscription_tier: 'free',
          subscription_status: 'canceled',
        }),
      );
      stripe.constructWebhookEvent.mockReturnValueOnce({
        type: 'customer.subscription.updated',
        data: {
          object: {
            id: 'sub_1',
            customer: 'cus_123',
            status: 'unpaid',
            cancel_at_period_end: false,
            current_period_end: 1779537600,
            items: { data: [{ price: { lookup_key: 'pro' } }] },
          },
        },
      });

      await service.handleWebhook(Buffer.from('payload'), 'stripe-signature');

      expect(lastTransitionClaimSet()).toHaveBeenCalledWith(
        expect.objectContaining({
          subscription_tier: 'free',
          plan_source: null,
        }),
      );
      // Non-entitling means no activation transition, so no confirmation mail.
      expect(notifyCalls('confirmed')).toHaveLength(0);
    });

    // Guard against the fix over-reaching: `past_due` IS Stripe's grace window
    // (it is still retrying), so it must KEEP the paid tier.
    //
    // All three statuses win their atomic transition claim by default in this
    // harness, so — like the `unpaid` case above — the tier is persisted via
    // that claim's own `.set()` call (matching the existing "lets the
    // configured price ID beat a stale pre-swap lookup key" case elsewhere in
    // this file), never via the follow-up `claimForStripe`, which the
    // transition winner skips entirely.
    it.each([['active'], ['trialing'], ['past_due']])(
      'keeps the paid tier for the entitling Stripe status %s',
      async (rawStatus) => {
        userRepo.findOne!.mockResolvedValueOnce(
          buildUser({
            stripe_customer_id: 'cus_123',
            stripe_subscription_id: 'sub_1',
            subscription_tier: 'free',
            subscription_status: 'canceled',
          }),
        );
        stripe.constructWebhookEvent.mockReturnValueOnce({
          type: 'customer.subscription.updated',
          data: {
            object: {
              id: 'sub_1',
              customer: 'cus_123',
              status: rawStatus,
              cancel_at_period_end: false,
              current_period_end: 1779537600,
              items: { data: [{ price: { lookup_key: 'pro' } }] },
            },
          },
        });

        await service.handleWebhook(Buffer.from('payload'), 'stripe-signature');

        expect(lastTransitionClaimSet()).toHaveBeenCalledWith(
          expect.objectContaining({
            subscription_tier: 'pro',
            plan_source: 'subscription',
          }),
        );
      },
    );
  });
});
