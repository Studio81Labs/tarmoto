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
  type BillingStatus,
  type BillingTier,
  type StripeBillingClient,
} from './stripe-billing.client.js';
import type { PlanSource } from '@tarmoto/shared';
import { QUEUE_NAMES } from '../jobs/jobs.constants.js';
import { ProviderClaimService } from './provider-claim.service.js';
import { StoreReconciliationService } from './store-reconciliation.service.js';
import { SubscriptionMutationLockService } from './subscription-mutation-lock.service.js';
import { User } from '../../entities/user.entity.js';

describe('AccountService', () => {
  let service: AccountService;
  let userRepo: Partial<jest.Mocked<Repository<User>>> & {
    createQueryBuilder: jest.Mock;
    query: jest.Mock;
    manager: { transaction: jest.Mock };
  };
  let stripe: jest.Mocked<StripeBillingClient>;
  let providerClaim: {
    claimForStripe: jest.Mock;
    clearStripeTerminal: jest.Mock;
  };
  let storeReconciliation: {
    openConflict: jest.Mock;
    findOpen: jest.Mock;
    findOpenWith: jest.Mock;
    retireOpenWith: jest.Mock;
    resolveWith: jest.Mock;
  };
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

  // The SHARED `.set` mock returned by EVERY `userRepo.createQueryBuilder()`
  // call — NOT "the last one" despite this helper's former name
  // (`lastTransitionClaimSet`): `createQueryBuilder` is
  // `jest.fn().mockReturnValue({...})`, a singleton, so `.mock.results.at(-1)`
  // and `.at(0)` are the SAME object reference and `.set` is shared by every
  // builder constructed in a test. Used to inspect what a WINNING atomic
  // transition claim (activation or past-due) persisted, for the cases where
  // that claim — not the `claimForStripe` follow-up it skips on a win — is
  // the actual writer (see the finding-5a entitling-status tests below).
  // Because the mock is shared, a passing assertion only proves SOME builder
  // in the test was `.set()` with these fields, not that THIS claim was —
  // harmless today because every test below drives exactly one builder, but
  // it would silently degrade to an any-of match the moment a test exercises
  // a second builder in the same run (e.g. the resubscription-reclaim path's
  // `reclaimQb`). Throws instead of non-null-asserting: a missing result
  // means `createQueryBuilder` was never called at all, which is itself a
  // real regression this should surface clearly rather than mask behind a
  // generic "cannot read property of undefined".
  const transitionClaimSet = (): jest.Mock => {
    const result = userRepo.createQueryBuilder.mock.results.at(-1);
    if (!result) {
      throw new Error(
        'userRepo.createQueryBuilder was not called — no transition claim ran',
      );
    }
    return (result.value as { set: jest.Mock }).set;
  };

  let activationClaimExecute: jest.Mock;
  /**
   * The manager `userRepo.manager.transaction` hands its callback. Tagged and
   * rebuilt per test so a test can assert that BOTH the claim and the retirement
   * received exactly this object — see the wiring test below.
   */
  let txManager: Record<string, unknown>;

  beforeEach(async () => {
    activationClaimExecute = jest.fn().mockResolvedValue({ affected: 1 });
    txManager = {
      __kind: 'tx',
      getRepository: () => userRepo,
      find: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
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
      // Raw path used by `getPurchaseIdentity`'s single-statement mint.
      query: jest.fn(),
      // `claimForStripe` + retirement run in ONE transaction. The mock runs the
      // callback inline with a manager that delegates to the same repo mocks, so
      // the statements are observable exactly as before — what is NOT modelled is
      // rollback, which the e2e suite covers against real PostgreSQL.
      //
      // The manager is a STABLE, TAGGED object rather than a fresh literal per
      // call, so tests can assert the production call site passed *this* manager
      // to both collaborators. `expect.anything()` would accept the pool manager
      // in either slot — a wiring error that defeats the transaction entirely
      // while every rollback test still passes.
      manager: {
        transaction: jest.fn((cb: (tx: unknown) => Promise<unknown>) =>
          cb(txManager),
        ),
      },
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
      // Finding 5b: `applyStripeSubscriptionEvent` re-queries the live
      // subscription and applies THAT, not the event snapshot. The default
      // echoes the most recently constructed event's object, i.e. the re-query
      // AGREES with the event — the common case, so existing tests are
      // unaffected. Out-of-order tests override with `mockResolvedValueOnce`.
      getSubscription: jest.fn((id: string) => {
        const lastEvent = stripe.constructWebhookEvent.mock.results.at(-1)
          ?.value as { data?: { object?: { id?: string } } } | undefined;
        const object = lastEvent?.data?.object;
        return Promise.resolve(object && object.id === id ? object : 'missing');
      }),
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
      // Transaction-bound pair used by retirement-on-claim: by default a winning
      // claim finds nothing to retire, so existing tests are unaffected.
      findOpenWith: jest.fn().mockResolvedValue([]),
      // Returns the number of rows actually retired.
      retireOpenWith: jest.fn().mockResolvedValue(0),
      resolveWith: jest.fn().mockResolvedValue(undefined),
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
                  assertFenceCurrent: () => Promise<void>;
                },
              ) => Promise<T>,
            ): Promise<T> =>
              fn(
                {
                  __kind: 'pool',
                  getRepository: () => userRepo,
                  // nextNotifyGeneration()'s atomic, fence-guarded
                  // increment-returning (overridable per-test via `genQuery`).
                  query: genQuery,
                } as unknown as EntityManager,
                {
                  assertHeld: () => Promise.resolve(),
                  fenceToken: 1,
                  assertFenceCurrent: () => Promise.resolve(),
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
          entitling: true,
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
          entitling: true,
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

    // Finding 5a follow-up (P1): the live snapshot's `tier` is the BILLED
    // PRODUCT (derived from the price alone) and its `status` is normalized, so
    // `unpaid` — which entitles nothing — is indistinguishable from `past_due`,
    // Stripe's entitling grace window. Preferring that live tier made
    // `GET /account/subscription` advertise Pro/Premium (and the companion
    // render those features as "Included right now") while
    // `FeatureResolverService` correctly denied them from the persisted tier.
    it('reports the entitlement tier, not the billed price tier, when the live Stripe subscription is unpaid', async () => {
      // Ingestion has already persisted `free` for this non-entitling
      // subscription (finding 5a); the resolver reads that column alone.
      const stored = buildUser({
        stripe_customer_id: 'cus_123',
        stripe_subscription_id: 'sub_unpaid',
        subscription_provider: 'stripe',
        subscription_tier: 'free',
        subscription_status: 'past_due',
        plan_source: null,
      });
      userRepo.findOne!.mockResolvedValueOnce(stored);
      stripe.getBillingSnapshot.mockResolvedValueOnce({
        currentPlan: {
          // The subscription still carries the paid price...
          tier: 'pro',
          // ...and `unpaid` has already collapsed into `past_due` here, which
          // is exactly why the raw-status verdict has to be carried separately.
          status: 'past_due',
          entitling: false,
          renewsAt: '2026-05-23T12:00:00.000Z',
          cancelAtPeriodEnd: false,
        },
        paymentMethod: null,
        invoices: [],
      });

      const snapshot = await service.getSubscription('user-1');

      expect(snapshot.current_plan.tier).toBe('free');
      // The invariant, not just the literal: the served tier is EXACTLY the
      // column `FeatureResolverService` resolves entitlements from, so the
      // billing screen can never advertise a feature the resolver denies.
      expect(snapshot.current_plan.tier).toBe(stored.subscription_tier);
      // The billed product's own facts still come from the live read — only
      // the entitlement claim is corrected.
      expect(snapshot.current_plan.status).toBe('past_due');
      expect(snapshot.current_plan.renews_at).toBe('2026-05-23T12:00:00.000Z');
    });

    // The fallback is to the STORED tier, NOT a hardcoded `free`: a
    // founder/promo/admin grant deliberately carries a paid tier that no Stripe
    // subscription backs, and the resolver keeps granting it. Forcing `free`
    // for a non-entitling live state would revoke it on screen — the same
    // mistake a resolver-side status gate would make.
    it('falls back to the STORED grant tier (not free) when the live Stripe subscription is non-entitling', async () => {
      const stored = buildUser({
        stripe_customer_id: 'cus_123',
        stripe_subscription_id: 'sub_incomplete',
        subscription_provider: 'stripe',
        subscription_tier: 'premium',
        subscription_status: 'canceled',
        plan_source: 'founder',
      });
      userRepo.findOne!.mockResolvedValueOnce(stored);
      stripe.getBillingSnapshot.mockResolvedValueOnce({
        currentPlan: {
          // A failed Checkout for the OTHER paid tier: neither this billed
          // tier nor `free` is the rider's entitlement.
          tier: 'pro',
          status: 'canceled',
          entitling: false,
          renewsAt: null,
          cancelAtPeriodEnd: false,
        },
        paymentMethod: null,
        invoices: [],
      });

      const snapshot = await service.getSubscription('user-1');

      expect(snapshot.current_plan.tier).toBe('premium');
      expect(snapshot.current_plan.tier).toBe(stored.subscription_tier);
    });

    // Guard against the fix over-reaching into "always use the stored tier":
    // while the live subscription DOES entitle, it stays authoritative, so a
    // rider who just checked out sees their new plan before the webhook lands.
    it('still prefers the LIVE tier over a stale stored tier while the subscription entitles', async () => {
      userRepo.findOne!.mockResolvedValueOnce(
        buildUser({
          stripe_customer_id: 'cus_123',
          stripe_subscription_id: 'sub_fresh',
          subscription_provider: 'stripe',
          // The activation webhook has not been processed yet.
          subscription_tier: 'free',
          subscription_status: 'canceled',
        }),
      );
      stripe.getBillingSnapshot.mockResolvedValueOnce({
        currentPlan: {
          tier: 'premium',
          status: 'active',
          entitling: true,
          renewsAt: '2026-05-23T12:00:00.000Z',
          cancelAtPeriodEnd: false,
        },
        paymentMethod: null,
        invoices: [],
      });

      const snapshot = await service.getSubscription('user-1');

      expect(snapshot.current_plan.tier).toBe('premium');
      expect(snapshot.current_plan.status).toBe('active');
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
          entitling: true,
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

    // The trial STAMP is decoupled from the trial-GRANT eligibility check
    // (`consumedIntroTrial` vs `isTrialActivation`). Stripe redelivers for up to
    // ~3 days, so a `trialing` event can be processed AFTER the trial converted:
    // the live re-query then says `active`, a status-only flag is false, and NO
    // stamp lands — leaving the rider `trial_eligible` for a SECOND trial on
    // Stripe/Apple/Google. The stamp therefore keys off `trial_start`, which
    // survives the conversion. Snapshot and live state genuinely DIVERGE here,
    // so the default echo mock cannot mask a regression.
    it('stamps billing_trial_used_at when a delayed `trialing` event re-queries to an already-CONVERTED active subscription', async () => {
      userRepo.findOne!.mockResolvedValue(
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
            // The STALE snapshot still says trialing...
            status: 'trialing',
            trial_start: 1779000000,
            cancel_at_period_end: false,
            current_period_end: 1779537600,
            items: { data: [{ price: { lookup_key: 'pro' } }] },
          },
        },
      });
      // ...but the trial has already converted: live status `active`, with
      // `trial_start` still set (Stripe keeps it for the subscription's life).
      stripe.getSubscription.mockResolvedValueOnce({
        id: 'sub_123',
        customer: 'cus_123',
        status: 'active',
        trial_start: 1779000000,
        cancel_at_period_end: false,
        current_period_end: 1779537600,
        items: { data: [{ price: { lookup_key: 'pro' } }] },
      });

      await service.handleWebhook(Buffer.from('payload'), 'stripe-signature');

      const transitionQb = userRepo.createQueryBuilder.mock.results.at(-1)!
        .value as { set: jest.Mock; andWhere: jest.Mock };
      const transitionSet = (
        transitionQb.set.mock.calls as unknown as Array<
          [Record<string, unknown>]
        >
      ).at(-1)?.[0];
      // The LIVE state stays authoritative for entitlement.
      expect(transitionSet).toMatchObject({
        subscription_status: 'active',
        subscription_tier: 'pro',
      });
      // ...and the consumed trial IS stamped, atomically in that same grant.
      const trialStamp = transitionSet?.billing_trial_used_at as () => string;
      expect(typeof trialStamp).toBe('function');
      expect(trialStamp()).toBe('COALESCE(billing_trial_used_at, NOW())');
      // The eligibility half must NOT be armed: the live state says this is an
      // ordinary paid activation, not a new trial grant to vet.
      expect(transitionQb.andWhere).not.toHaveBeenCalledWith(
        'billing_trial_used_at IS NULL',
      );
      expect(stripe.setCancelAtPeriodEnd).not.toHaveBeenCalled();
      expect(storeReconciliation.openConflict).not.toHaveBeenCalled();
      // The grant winner stamped atomically, so no separate follow-up write.
      expect(userRepo.update).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'user-1' }),
        expect.not.objectContaining({
          billing_trial_used_at: expect.anything(),
        }),
      );
    });

    // The trap the two-flag split exists to avoid: OR-ing the EVENT snapshot's
    // `trialing` into ONE shared boolean would also arm the
    // `billing_trial_used_at IS NULL` eligibility guard, so this
    // already-marked rider's legitimate paid activation would match 0 rows and
    // be misrouted into the second-trial rejection (cancelled + reconciled)
    // instead of entitled. The stamp still fires — COALESCE keeps it
    // idempotent, never re-dating the existing marker.
    it('does NOT misroute a converted trial into the rejection path when the rider is already marked', async () => {
      userRepo.findOne!.mockResolvedValue(
        buildUser({
          stripe_customer_id: 'cus_123',
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
            trial_start: 1779000000,
            cancel_at_period_end: false,
            current_period_end: 1779537600,
            items: { data: [{ price: { lookup_key: 'pro' } }] },
          },
        },
      });
      stripe.getSubscription.mockResolvedValueOnce({
        id: 'sub_123',
        customer: 'cus_123',
        status: 'active',
        trial_start: 1779000000,
        cancel_at_period_end: false,
        current_period_end: 1779537600,
        items: { data: [{ price: { lookup_key: 'pro' } }] },
      });

      await service.handleWebhook(Buffer.from('payload'), 'stripe-signature');

      const transitionQb = userRepo.createQueryBuilder.mock.results.at(-1)!
        .value as { set: jest.Mock; andWhere: jest.Mock };
      const transitionSet = (
        transitionQb.set.mock.calls as unknown as Array<
          [Record<string, unknown>]
        >
      ).at(-1)?.[0];
      // Entitlement is granted, not rejected.
      expect(transitionSet).toMatchObject({
        subscription_status: 'active',
        subscription_tier: 'pro',
      });
      expect(transitionQb.andWhere).not.toHaveBeenCalledWith(
        'billing_trial_used_at IS NULL',
      );
      expect(stripe.setCancelAtPeriodEnd).not.toHaveBeenCalled();
      expect(storeReconciliation.openConflict).not.toHaveBeenCalled();
      expect(notifyCalls('confirmed')).toHaveLength(1);
      // Idempotent re-stamp: COALESCE preserves the January marker.
      const trialStamp = transitionSet?.billing_trial_used_at as () => string;
      expect(trialStamp()).toBe('COALESCE(billing_trial_used_at, NOW())');
    });

    // The other side of keying the stamp off `trial_start`: an `incomplete`
    // subscription (initial payment never succeeded) can carry `trial_start`
    // for a trial that never took effect. Stamping there would burn the rider's
    // single intro trial for nothing, so `NEVER_ENTITLED_STRIPE_STATUSES`
    // suppresses it — and the tier stays `free`, so nothing was granted either.
    it('does NOT stamp billing_trial_used_at for an `incomplete` subscription whose trial never took effect', async () => {
      userRepo.findOne!.mockResolvedValue(
        buildUser({
          stripe_customer_id: 'cus_123',
          stripe_subscription_id: 'sub_1',
          billing_trial_used_at: null,
        }),
      );
      stripe.constructWebhookEvent.mockReturnValueOnce({
        type: 'customer.subscription.updated',
        data: {
          object: {
            id: 'sub_1',
            customer: 'cus_123',
            status: 'incomplete',
            trial_start: 1779000000,
            cancel_at_period_end: false,
            current_period_end: 1779537600,
            items: { data: [{ price: { lookup_key: 'pro' } }] },
          },
        },
      });

      await service.handleWebhook(Buffer.from('payload'), 'stripe-signature');

      // Non-entitling: no paid tier granted...
      expect(providerClaim.claimForStripe).toHaveBeenCalledWith(
        expect.any(String),
        'sub_1',
        expect.objectContaining({ tier: 'free' }),
        expect.anything(),
      );
      // ...and the fallback stamp (the only stamp site this path reaches) is
      // suppressed, so the rider keeps their intro trial.
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

    // `plan_source: 'subscription'` — a genuinely BILLED row, which is what
    // this test has always been about ("clears the tier and plan provenance").
    // The fixture previously said `founder`, which was incidental noise from
    // before grants had semantics here; a founder row now deliberately keeps
    // its tier and sends no notice, which is the round-5 case covered
    // separately below.
    it('clears the tier and plan provenance when the subscription is deleted', async () => {
      userRepo
        .findOne!.mockResolvedValueOnce(
          buildUser({
            stripe_customer_id: 'cus_123',
            stripe_subscription_id: 'sub_123',
            subscription_tier: 'pro',
            plan_source: 'subscription',
            subscription_status: 'active',
          }),
        )
        .mockResolvedValueOnce(
          buildUser({
            stripe_customer_id: 'cus_123',
            stripe_subscription_id: 'sub_123',
            subscription_tier: 'pro',
            plan_source: 'subscription',
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
      // only invoked for the event's exact subscription id, and for a billed
      // row it performs the FULL reset (no grant to preserve).
      expect(providerClaim.clearStripeTerminal).toHaveBeenCalledWith(
        'user-1',
        'sub_123',
        expect.any(Number),
        expect.objectContaining({ preserveGrant: false }),
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
    // Stripe status. `incomplete` means "no successful payment", so the rider
    // must land on `free` even though the subscription carries a paid price.
    //
    // `incomplete` collapses (via `statusFromSubscription`) into the STORED
    // status `canceled`, which neither transition claim below owns, so the
    // write goes through the `claimForStripe` follow-up — assert there.
    // `unpaid` collapses into stored `past_due` instead, which DOES own a
    // transition claim and is asserted separately below (see that test for
    // why). `incomplete_expired` is NOT a case here: Finding 5b (below)
    // reclassifies it as a TERMINAL status — the re-query's `isDeleted`
    // derivation routes it through `clearStripeTerminal` before this tier
    // gate is ever reached, so it is covered there instead.
    it('persists `free` for the non-entitling Stripe status incomplete (initial payment never succeeded)', async () => {
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
            status: 'incomplete',
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
    });

    // `unpaid` collapses (via `statusFromSubscription`) into the STORED status
    // `past_due`, so — unlike `incomplete` above — it wins the atomic
    // past-due transition claim (the mocked query builder always
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

      expect(transitionClaimSet()).toHaveBeenCalledWith(
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

        expect(transitionClaimSet()).toHaveBeenCalledWith(
          expect.objectContaining({
            subscription_tier: 'pro',
            plan_source: 'subscription',
          }),
        );
      },
    );

    // Finding 5b: Stripe does not guarantee delivery order. A delayed
    // `updated: active` arriving AFTER the subscription was canceled must not
    // resurrect it — the live re-query, not the event snapshot, is authoritative.
    it('routes a delayed `updated` whose live state is terminal through the terminal clear', async () => {
      userRepo.findOne!.mockResolvedValueOnce(
        buildUser({
          stripe_customer_id: 'cus_123',
          stripe_subscription_id: 'sub_1',
          subscription_tier: 'pro',
          subscription_status: 'active',
        }),
      );
      stripe.constructWebhookEvent.mockReturnValueOnce({
        type: 'customer.subscription.updated',
        data: {
          object: {
            id: 'sub_1',
            customer: 'cus_123',
            // The STALE snapshot says active...
            status: 'active',
            cancel_at_period_end: false,
            current_period_end: 1779537600,
            items: { data: [{ price: { lookup_key: 'pro' } }] },
          },
        },
      });
      // ...but the live subscription is already canceled.
      stripe.getSubscription.mockResolvedValueOnce({
        id: 'sub_1',
        customer: 'cus_123',
        status: 'canceled',
        cancel_at_period_end: false,
        current_period_end: 1779537600,
        items: { data: [{ price: { lookup_key: 'pro' } }] },
      });

      await service.handleWebhook(Buffer.from('payload'), 'stripe-signature');

      // Must go through the identity-guarded terminal clear, which releases
      // `subscription_provider`. `claimForStripe` would have kept Stripe owning
      // the slot and blocked a later Apple/Google claim.
      expect(providerClaim.clearStripeTerminal).toHaveBeenCalledWith(
        expect.any(String),
        'sub_1',
        expect.any(Number),
        expect.anything(),
      );
      expect(providerClaim.claimForStripe).not.toHaveBeenCalled();
    });

    it('routes a delayed `updated` for a subscription Stripe has purged through the terminal clear', async () => {
      userRepo.findOne!.mockResolvedValueOnce(
        buildUser({
          stripe_customer_id: 'cus_123',
          stripe_subscription_id: 'sub_1',
          subscription_tier: 'pro',
          subscription_status: 'active',
        }),
      );
      stripe.constructWebhookEvent.mockReturnValueOnce({
        type: 'customer.subscription.updated',
        data: {
          object: {
            id: 'sub_1',
            customer: 'cus_123',
            status: 'active',
            cancel_at_period_end: false,
            current_period_end: 1779537600,
            items: { data: [{ price: { lookup_key: 'pro' } }] },
          },
        },
      });
      stripe.getSubscription.mockResolvedValueOnce('missing');

      await service.handleWebhook(Buffer.from('payload'), 'stripe-signature');

      expect(providerClaim.clearStripeTerminal).toHaveBeenCalled();
      expect(providerClaim.claimForStripe).not.toHaveBeenCalled();
    });

    // `incomplete_expired` is the OTHER member of `TERMINAL_STRIPE_STATUSES`
    // (alongside `canceled`, covered above): the initial-payment window
    // expired for good, so the slot must be released via the terminal clear
    // rather than merely dropping to `free` while Stripe keeps the slot (that
    // would block a later Apple/Google claim). This is what the Finding-5a
    // `incomplete` test above deliberately no longer covers.
    it('routes a live-status `incomplete_expired` through the terminal clear', async () => {
      userRepo.findOne!.mockResolvedValueOnce(
        buildUser({
          stripe_customer_id: 'cus_123',
          stripe_subscription_id: 'sub_1',
          subscription_tier: 'pro',
          subscription_status: 'active',
        }),
      );
      stripe.constructWebhookEvent.mockReturnValueOnce({
        type: 'customer.subscription.updated',
        data: {
          object: {
            id: 'sub_1',
            customer: 'cus_123',
            status: 'incomplete_expired',
            cancel_at_period_end: false,
            current_period_end: 1779537600,
            items: { data: [{ price: { lookup_key: 'pro' } }] },
          },
        },
      });

      await service.handleWebhook(Buffer.from('payload'), 'stripe-signature');

      expect(providerClaim.clearStripeTerminal).toHaveBeenCalledWith(
        expect.any(String),
        'sub_1',
        expect.any(Number),
        expect.anything(),
      );
      expect(providerClaim.claimForStripe).not.toHaveBeenCalled();
    });

    it('applies the LIVE state, not the stale event snapshot, on a same-subscription write', async () => {
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
            status: 'past_due',
            cancel_at_period_end: false,
            current_period_end: 1779537600,
            items: { data: [{ price: { lookup_key: 'pro' } }] },
          },
        },
      });
      // The rider has since recovered — the live state is `active` on premium.
      stripe.getSubscription.mockResolvedValueOnce({
        id: 'sub_1',
        customer: 'cus_123',
        status: 'active',
        cancel_at_period_end: false,
        current_period_end: 1779537600,
        items: { data: [{ price: { lookup_key: 'premium' } }] },
      });

      await service.handleWebhook(Buffer.from('payload'), 'stripe-signature');

      // The re-queried status is `active` with a non-free tier, so this wins
      // the atomic activation-transition claim (default `{ affected: 1 }` in
      // this harness) — which then SKIPS the follow-up `claimForStripe`
      // entirely (see the comment above the exclusivity claim in
      // `applyStripeSubscriptionEvent`). Assert on the transition claim's own
      // `.set()`, the actual writer here — not `claimForStripe`, which never
      // runs. Tier/status come from the RE-QUERIED price and status, not the
      // stale event's `past_due`/`pro`.
      expect(providerClaim.claimForStripe).not.toHaveBeenCalled();
      expect(transitionClaimSet()).toHaveBeenCalledWith(
        expect.objectContaining({
          subscription_tier: 'premium',
          subscription_status: 'active',
        }),
      );
    });

    // `unpaid` is non-entitling (Task 1) but NOT terminal — the rider can still
    // recover, so Stripe must keep the slot rather than releasing it. This is
    // the narrower-than-non-entitling half of the `TERMINAL_STRIPE_STATUSES`
    // decision, so the snapshot and the live state are made to genuinely
    // DIVERGE (unlike a same-status fixture, which the default echo mock
    // would make indistinguishable from a reverted fix): a regression that
    // fell back to applying the event snapshot directly would read the
    // snapshot's `active` (entitling) instead of the live `unpaid`
    // (non-entitling) and wrongly grant `pro`.
    it('drops the tier but RETAINS the Stripe slot for a non-terminal, non-entitling live state', async () => {
      userRepo.findOne!.mockResolvedValueOnce(
        buildUser({
          stripe_customer_id: 'cus_123',
          stripe_subscription_id: 'sub_1',
          subscription_tier: 'pro',
          subscription_status: 'active',
        }),
      );
      stripe.constructWebhookEvent.mockReturnValueOnce({
        type: 'customer.subscription.updated',
        data: {
          object: {
            id: 'sub_1',
            customer: 'cus_123',
            // The STALE snapshot says active (entitling)...
            status: 'active',
            cancel_at_period_end: false,
            current_period_end: 1779537600,
            items: { data: [{ price: { lookup_key: 'pro' } }] },
          },
        },
      });
      // ...but the live subscription has since gone unpaid (non-entitling,
      // but NOT terminal — contrast with the `canceled`/`incomplete_expired`
      // terminal-clear tests above).
      stripe.getSubscription.mockResolvedValueOnce({
        id: 'sub_1',
        customer: 'cus_123',
        status: 'unpaid',
        cancel_at_period_end: false,
        current_period_end: 1779537600,
        items: { data: [{ price: { lookup_key: 'pro' } }] },
      });

      await service.handleWebhook(Buffer.from('payload'), 'stripe-signature');

      // Not terminal: the slot stays Stripe's, so a later Apple/Google claim
      // must NOT be able to take it. (Also guards the OTHER direction: if
      // `TERMINAL_STRIPE_STATUSES` were ever mistakenly widened to include
      // `unpaid`, this would start failing here.)
      expect(providerClaim.clearStripeTerminal).not.toHaveBeenCalled();
      // `unpaid` collapses (via `statusFromSubscription`) into stored
      // `past_due`, which DOES own a transition claim (same collapse as the
      // Finding-5a `unpaid` test above) — it wins by default in this harness
      // and skips the follow-up `claimForStripe` entirely, so assert on the
      // transition claim's own `.set()`, the actual writer here. Tier comes
      // from the RE-QUERIED (`unpaid`, non-entitling) status, not the stale
      // event's `active`.
      expect(providerClaim.claimForStripe).not.toHaveBeenCalled();
      expect(transitionClaimSet()).toHaveBeenCalledWith(
        expect.objectContaining({ subscription_tier: 'free' }),
      );
    });

    // Finding 5a follow-up (P2): the drop to `free` must be scoped to BILLED
    // provenance. A founder/promo/admin-granted rider holds a paid tier no
    // Stripe subscription backs; when they follow the companion's supported
    // grant-to-Checkout flow and the initial payment leaves the subscription
    // `incomplete`, the unconditional fallback revoked that grant (and
    // `claimForStripe` cleared `plan_source` with it) even though nothing was
    // ever paid.
    //
    // `incomplete` collapses (via `statusFromSubscription`) into stored
    // `canceled`, which no transition claim owns, so `claimForStripe` is the
    // writer — assert there. The event's price is deliberately the OTHER paid
    // tier so a pass proves the tier came from the GRANT, not from the price.
    //
    // `mockResolvedValue` (not `...Once`): the preserved provenance is read
    // from the RE-READ under the lock, so BOTH the pre-lock resolve and that
    // re-read must return the granted row.
    it.each([['founder'], ['promo'], ['admin']])(
      'preserves a %s grant when the checkout leaves the subscription incomplete',
      async (planSource) => {
        userRepo.findOne!.mockResolvedValue(
          buildUser({
            stripe_customer_id: 'cus_123',
            stripe_subscription_id: null,
            subscription_tier: 'pro',
            subscription_status: 'canceled',
            plan_source: planSource as 'founder' | 'promo' | 'admin',
          }),
        );
        stripe.constructWebhookEvent.mockReturnValueOnce({
          type: 'customer.subscription.updated',
          data: {
            object: {
              id: 'sub_1',
              customer: 'cus_123',
              status: 'incomplete',
              cancel_at_period_end: false,
              items: { data: [{ price: { lookup_key: 'premium' } }] },
            },
          },
        });

        await service.handleWebhook(Buffer.from('payload'), 'stripe-signature');

        expect(providerClaim.claimForStripe).toHaveBeenCalledWith(
          expect.any(String),
          'sub_1',
          expect.objectContaining({
            tier: 'pro',
            planSource,
            // The failed checkout still reports its own status; only the
            // grant's tier/provenance are shielded from it.
            status: 'canceled',
          }),
          expect.anything(),
        );
        // A checkout that never entitled anything must not look like a
        // conversion: no activation transition, so no confirmation mail.
        expect(notifyQueue.add).not.toHaveBeenCalled();
      },
    );

    // Guard against the fix over-reaching: a genuinely BILLED subscription
    // going non-entitling always drops to `free` (the entitlement fix, asserted
    // for every case). What differs is the PROVENANCE written alongside it —
    // the historical billed-plan signal the terminal handler reads once the
    // tier can no longer answer "was this rider on a paid plan?":
    //
    //   subscription + paid tier -> stays `subscription`
    //   null + PAID tier         -> RECORDED as `subscription` (round 4): a
    //                               legacy rider predating the column
    //                               (migration 1796000000000 added it with no
    //                               backfill) demonstrably held a paid plan, and
    //                               `PLAN_SOURCES` documents null as
    //                               indistinguishable from `subscription`
    //   null + FREE tier         -> stays null: an aborted free->paid checkout
    //                               that never entitled anything, which must
    //                               keep the terminal handler silent
    //
    // The last two are the whole point: both carry null, so only the
    // pre-transition tier separates them.
    it.each([
      ['subscription', 'pro', 'subscription'],
      [null, 'pro', 'subscription'],
      [null, 'free', null],
    ])(
      'drops a billed subscription (plan_source=%s, tier=%s) to free on a non-entitling status',
      async (planSource, preTier, expectedPlanSource) => {
        userRepo.findOne!.mockResolvedValue(
          buildUser({
            stripe_customer_id: 'cus_123',
            stripe_subscription_id: 'sub_1',
            subscription_tier: preTier as 'pro' | 'free',
            subscription_status: 'active',
            plan_source: planSource as 'subscription' | null,
          }),
        );
        stripe.constructWebhookEvent.mockReturnValueOnce({
          type: 'customer.subscription.updated',
          data: {
            object: {
              id: 'sub_1',
              customer: 'cus_123',
              status: 'incomplete',
              cancel_at_period_end: false,
              items: { data: [{ price: { lookup_key: 'pro' } }] },
            },
          },
        });

        await service.handleWebhook(Buffer.from('payload'), 'stripe-signature');

        expect(providerClaim.claimForStripe).toHaveBeenCalledWith(
          expect.any(String),
          'sub_1',
          expect.objectContaining({
            tier: 'free',
            planSource: expectedPlanSource,
          }),
          expect.anything(),
        );
      },
    );

    // The other downstream branch the preserved values reach: `unpaid`
    // collapses into stored `past_due`, which DOES own a transition claim (it
    // wins by default in this harness and then skips `claimForStripe`), so the
    // grant must survive that writer too. The billing-failed push is Stripe's
    // ordinary payment-retry alert and is orthogonal to entitlement; what must
    // NOT appear is a confirmation for a conversion that never happened.
    it('preserves a founder grant through the past_due transition claim when the checkout goes unpaid', async () => {
      userRepo.findOne!.mockResolvedValue(
        buildUser({
          stripe_customer_id: 'cus_123',
          stripe_subscription_id: 'sub_1',
          subscription_tier: 'pro',
          subscription_status: 'canceled',
          plan_source: 'founder',
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
            items: { data: [{ price: { lookup_key: 'premium' } }] },
          },
        },
      });

      await service.handleWebhook(Buffer.from('payload'), 'stripe-signature');

      expect(transitionClaimSet()).toHaveBeenCalledWith(
        expect.objectContaining({
          subscription_tier: 'pro',
          plan_source: 'founder',
          subscription_status: 'past_due',
        }),
      );
      expect(notifyCalls('confirmed')).toHaveLength(0);
    });

    // The intended founder→paying transition is UNAFFECTED: an entitling
    // status still derives the tier from the price and re-stamps the
    // provenance as `subscription`, so a converting founder becomes a paying
    // customer in the admin view.
    it('converts a founder grant to a paid subscription on an entitling status', async () => {
      userRepo.findOne!.mockResolvedValue(
        buildUser({
          stripe_customer_id: 'cus_123',
          stripe_subscription_id: null,
          subscription_tier: 'pro',
          subscription_status: 'canceled',
          plan_source: 'founder',
        }),
      );
      stripe.constructWebhookEvent.mockReturnValueOnce({
        type: 'customer.subscription.updated',
        data: {
          object: {
            id: 'sub_1',
            customer: 'cus_123',
            status: 'active',
            cancel_at_period_end: false,
            items: { data: [{ price: { lookup_key: 'premium' } }] },
          },
        },
      });

      await service.handleWebhook(Buffer.from('payload'), 'stripe-signature');

      expect(transitionClaimSet()).toHaveBeenCalledWith(
        expect.objectContaining({
          subscription_tier: 'premium',
          plan_source: 'subscription',
          subscription_status: 'active',
        }),
      );
      expect(notifyCalls('confirmed')).toHaveLength(1);
    });

    // FOLLOW-ON TERMINAL EVENT (round 2 of the P2 finding). Preserving the tier
    // and `plan_source` on the immediate `incomplete` write is not enough on its
    // own: if that never-entitling subscription is recorded as the row's Stripe
    // OWNER, the terminal event Stripe emits roughly a day later
    // (`incomplete_expired`, or `customer.subscription.deleted` for an abandoned
    // checkout) matches `clearStripeTerminal`'s guard and resets the tier and
    // `plan_source` to free anyway — and, because the cancellation mail is gated
    // on that clear having happened, tells the rider the preserved plan was
    // cancelled. The previous round's tests stopped at the first event and could
    // not see this.
    //
    // The default `providerClaim` mock always succeeds, which cannot express
    // "the terminal clear matched nothing" — the exact behaviour under test. So
    // these drive a stateful stand-in that mirrors the two real WHERE clauses:
    //   claimForStripe:      provider IS NULL OR 'stripe'  AND  id IS NULL OR = sub
    //   clearStripeTerminal: provider = 'stripe'           AND  id = sub
    // The STRICT provider equality in the second one is what makes leaving the
    // provider NULL sufficient, and it is pinned independently by
    // provider-claim.service.spec (including a negative assertion that it never
    // becomes an `IS NULL OR` match like its Apple sibling).
    type StubQueryBuilder = {
      update: jest.Mock;
      set: jest.Mock;
      where: jest.Mock;
      andWhere: jest.Mock;
      execute: jest.Mock;
    };

    const withStatefulProviderClaim = (row: User): void => {
      userRepo.findOne!.mockImplementation(() => Promise.resolve(row));
      providerClaim.claimForStripe.mockImplementation(
        (
          _userId: string,
          subId: string,
          fields: {
            tier: BillingTier;
            status: BillingStatus;
            planSource: PlanSource | null;
          },
          options?: { skipStatus?: boolean; skipOwnership?: boolean },
        ) => {
          if (
            row.subscription_provider != null &&
            row.subscription_provider !== 'stripe'
          ) {
            return Promise.resolve('conflict');
          }
          if (
            row.stripe_subscription_id != null &&
            row.stripe_subscription_id !== subId
          ) {
            return Promise.resolve('conflict');
          }
          row.subscription_tier = fields.tier;
          row.plan_source = fields.planSource;
          if (!options?.skipStatus) row.subscription_status = fields.status;
          if (!options?.skipOwnership) {
            row.subscription_provider = 'stripe';
            row.stripe_subscription_id = subId;
          }
          return Promise.resolve('claimed');
        },
      );
      // The activation / past-due transitions are RAW query builders rather
      // than `ProviderClaimService` calls, so the stand-in has to apply those
      // writes to the row as well — otherwise the `unpaid` step of a lifecycle
      // leaves the row untouched and the sequence under test never happens.
      // The WHERE guards are deliberately NOT modelled: each test drives one
      // deterministic sequence, and race arbitration is covered by the
      // dedicated transition-claim tests elsewhere in this file. Raw-SQL
      // function values (the `COALESCE` trial stamp) are skipped.
      // Explicitly typed: the chainable methods return the builder itself, so
      // an inferred type would be circular and silently collapse to `any`.
      userRepo.createQueryBuilder.mockImplementation((): StubQueryBuilder => {
        let applied: Record<string, unknown> = {};
        const builder: StubQueryBuilder = {
          update: jest.fn(() => builder),
          set: jest.fn((payload: Record<string, unknown>) => {
            applied = payload;
            return builder;
          }),
          where: jest.fn(() => builder),
          andWhere: jest.fn(() => builder),
          execute: jest.fn(() => {
            const target = row as unknown as Record<string, unknown>;
            for (const [column, value] of Object.entries(applied)) {
              if (typeof value === 'function') continue;
              target[column] = value;
            }
            return Promise.resolve({ affected: 1 });
          }),
        };
        return builder;
      });
      providerClaim.clearStripeTerminal.mockImplementation(
        (
          _userId: string,
          subId: string,
          _fenceToken: number,
          options?: { preserveGrant?: boolean },
        ) => {
          if (
            row.subscription_provider !== 'stripe' ||
            row.stripe_subscription_id !== subId
          ) {
            return Promise.resolve(false);
          }
          // The slot is released either way; only the entitlement fields are
          // conditional (mirrors the real `preserveGrant` SET).
          row.subscription_provider = null;
          row.stripe_subscription_id = null;
          row.subscription_status = 'canceled';
          if (!options?.preserveGrant) {
            row.plan_source = null;
            row.subscription_tier = 'free';
          }
          return Promise.resolve(true);
        },
      );
    };

    const subscriptionEvent = (
      status: string,
      deleted = false,
    ): Record<string, unknown> => ({
      type: deleted
        ? 'customer.subscription.deleted'
        : 'customer.subscription.updated',
      data: {
        object: {
          id: 'sub_1',
          customer: 'cus_123',
          status,
          cancel_at_period_end: false,
          items: { data: [{ price: { lookup_key: 'premium' } }] },
        },
      },
    });

    it.each([
      ['incomplete_expired', false],
      ['canceled', true],
    ])(
      'keeps a founder grant intact through the full incomplete → %s sequence',
      async (terminalStatus, deletedEvent) => {
        const row = buildUser({
          stripe_customer_id: 'cus_123',
          // `handleCheckoutCompleted` records the checkout's subscription id
          // under its OWN ownership guard before this event arrives. That guard
          // passes for a grant row (provider IS NULL), so the id is present —
          // which is safe precisely because the id ALONE cannot satisfy the
          // terminal clear's provider guard.
          stripe_subscription_id: 'sub_1',
          subscription_tier: 'pro',
          subscription_status: 'canceled',
          plan_source: 'founder',
        });
        withStatefulProviderClaim(row);

        // 1. The checkout's initial payment never succeeds.
        stripe.constructWebhookEvent.mockReturnValueOnce(
          subscriptionEvent('incomplete'),
        );
        await service.handleWebhook(Buffer.from('payload'), 'stripe-signature');

        // The grant survives the immediate write (previous round) AND the slot
        // was not taken, which is what makes the terminal event below harmless.
        expect(row.subscription_tier).toBe('pro');
        expect(row.plan_source).toBe('founder');
        expect(row.subscription_provider).toBeNull();

        // 2. Roughly a day later Stripe ends the dead checkout.
        stripe.constructWebhookEvent.mockReturnValueOnce(
          subscriptionEvent(terminalStatus, deletedEvent),
        );
        await service.handleWebhook(Buffer.from('payload'), 'stripe-signature');

        // The terminal handler DID run — it simply matched no Stripe-owned row.
        expect(providerClaim.clearStripeTerminal).toHaveBeenCalledWith(
          'user-1',
          'sub_1',
          expect.any(Number),
          expect.anything(),
        );
        expect(row.subscription_tier).toBe('pro');
        expect(row.plan_source).toBe('founder');
        // No clear means no "your Pro plan was cancelled" mail for a rider whose
        // plan we just preserved — the second half of the same bug.
        expect(notifyCalls('cancelled')).toHaveLength(0);
        expect(notifyQueue.add).not.toHaveBeenCalled();
      },
    );

    // ROUND 3 — the full active → unpaid → canceled lifecycle, end to end.
    //
    // This is the ordinary "the rider's card finally stopped working" shape,
    // and it is the sequence the entitling-status gate regressed: the `unpaid`
    // transition drops the stored tier to `free`, so by the time the terminal
    // event arrives `subscription_tier` reads `free` and the cancellation mail
    // was silently swallowed — for exactly the riders who had been paying
    // longest. A rider cancelled straight from `active` still got one, which is
    // why the two halves passed separately while the chain was broken.
    it.each([
      ['canceled', true],
      ['canceled', false],
    ])(
      'still notifies the rider when a paid subscription ends via active → unpaid → %s (deleted event: %s)',
      async (terminalStatus, deletedEvent) => {
        const row = buildUser({
          stripe_customer_id: 'cus_123',
          stripe_subscription_id: 'sub_1',
          subscription_provider: 'stripe',
          subscription_tier: 'premium',
          subscription_status: 'active',
          plan_source: 'subscription',
        });
        withStatefulProviderClaim(row);

        // 1. Retries are exhausted: entitlement is correctly withdrawn...
        stripe.constructWebhookEvent.mockReturnValueOnce(
          subscriptionEvent('unpaid'),
        );
        await service.handleWebhook(Buffer.from('payload'), 'stripe-signature');
        // ...the tier drops (the entitlement fix this branch exists for)...
        expect(row.subscription_tier).toBe('free');
        // ...but the row still remembers it was a BILLED plan. Without this the
        // terminal event below has no evidence a paid plan ever existed.
        expect(row.plan_source).toBe('subscription');

        // 2. The subscription finally ends.
        stripe.constructWebhookEvent.mockReturnValueOnce(
          subscriptionEvent(terminalStatus, deletedEvent),
        );
        await service.handleWebhook(Buffer.from('payload'), 'stripe-signature');

        // The rider IS told their paid plan ended, named from the ending
        // subscription's own price rather than the already-dropped tier.
        expect(notifyCalls('cancelled')).toHaveLength(1);
        expect(notifyCalls('cancelled')[0]).toMatchObject({
          kind: 'cancelled',
          planName: 'Premium',
        });
        // The row is still fully reset by the terminal clear.
        expect(row.subscription_tier).toBe('free');
        expect(row.plan_source).toBeNull();
      },
    );

    // ROUND 6 — a `trialing` webhook FIRST PROCESSED once the trial is already
    // over. The re-query returns a terminal state, which routes into the
    // terminal branch and returns above every other stamp site — so the rider
    // who genuinely received (and cancelled) a trial stayed `trial_eligible`
    // and a later Checkout could mint a SECOND one. The terminal twin of the
    // trial→active delayed delivery covered above.
    //
    // Asserted on `userRepo.update`, the only writer on this path, because the
    // stamp must land BEFORE the early return rather than in a transition
    // claim.
    const terminalTrialStampArg = (): Record<string, unknown> | undefined => {
      const calls = userRepo.update!.mock.calls as unknown as Array<
        [unknown, Record<string, unknown>]
      >;
      return calls
        .map(([, payload]) => payload)
        .find((payload) => payload?.billing_trial_used_at != null);
    };

    it.each([
      // The re-query resolves the subscription as already cancelled...
      ['canceled', false],
      // ...or Stripe has purged it entirely, so the flag reads the EVENT
      // snapshot, which still says `trialing`.
      ['missing', true],
    ])(
      'stamps the consumed trial when a delayed `trialing` event re-queries to %s',
      async (freshStatus, purged) => {
        userRepo.findOne!.mockResolvedValue(
          buildUser({
            stripe_customer_id: 'cus_123',
            stripe_subscription_id: 'sub_1',
            subscription_provider: 'stripe',
            subscription_tier: 'pro',
            subscription_status: 'trialing',
            plan_source: 'subscription',
            billing_trial_used_at: null,
          }),
        );
        stripe.constructWebhookEvent.mockReturnValueOnce({
          type: 'customer.subscription.updated',
          data: {
            object: {
              id: 'sub_1',
              customer: 'cus_123',
              // The snapshot still says trialing — this delivery is late.
              status: 'trialing',
              trial_start: 1779000000,
              cancel_at_period_end: false,
              items: { data: [{ price: { lookup_key: 'pro' } }] },
            },
          },
        });
        stripe.getSubscription.mockResolvedValueOnce(
          purged
            ? 'missing'
            : {
                id: 'sub_1',
                customer: 'cus_123',
                status: freshStatus,
                // Stripe keeps `trial_start` for the subscription's life,
                // including after cancellation.
                trial_start: 1779000000,
                cancel_at_period_end: false,
                items: { data: [{ price: { lookup_key: 'pro' } }] },
              },
        );

        await service.handleWebhook(Buffer.from('payload'), 'stripe-signature');

        // The terminal path still ran (this is the early-return branch)...
        expect(providerClaim.clearStripeTerminal).toHaveBeenCalled();
        // ...and the consumed trial was recorded before it returned, so the
        // rider is no longer `trial_eligible` (which reads this column) and a
        // later Checkout cannot mint a second intro trial.
        const stamp = terminalTrialStampArg();
        expect(stamp).toBeDefined();
        const stampFn = stamp?.billing_trial_used_at as () => string;
        expect(typeof stampFn).toBe('function');
        // COALESCE, so a redelivery or a post-503 retry never re-dates an
        // earlier trial.
        expect(stampFn()).toBe('COALESCE(billing_trial_used_at, NOW())');
      },
    );

    // The carve-out that makes the above safe, and it matters MORE on this path:
    // `incomplete_expired` is BOTH terminal and never-entitled, so an aborted
    // checkout whose trial never actually delivered must still leave the rider
    // eligible. Without `NEVER_ENTITLED_STRIPE_STATUSES` the `trial_start` on
    // this object would burn their single, unrecoverable intro trial.
    it('does NOT stamp a trial for an aborted checkout that expired without ever entitling', async () => {
      userRepo.findOne!.mockResolvedValue(
        buildUser({
          stripe_customer_id: 'cus_123',
          stripe_subscription_id: 'sub_1',
          subscription_provider: 'stripe',
          subscription_tier: 'free',
          subscription_status: 'canceled',
          billing_trial_used_at: null,
        }),
      );
      stripe.constructWebhookEvent.mockReturnValueOnce({
        type: 'customer.subscription.updated',
        data: {
          object: {
            id: 'sub_1',
            customer: 'cus_123',
            status: 'incomplete_expired',
            // Present, but the trial never delivered anything.
            trial_start: 1779000000,
            cancel_at_period_end: false,
            items: { data: [{ price: { lookup_key: 'pro' } }] },
          },
        },
      });

      await service.handleWebhook(Buffer.from('payload'), 'stripe-signature');

      expect(providerClaim.clearStripeTerminal).toHaveBeenCalled();
      expect(terminalTrialStampArg()).toBeUndefined();
    });

    // ROUND 5 — the same lifecycle for a grant on a row that was ALREADY
    // Stripe-owned. Round 2 kept a never-entitling checkout from TAKING the
    // slot, which made the terminal clear a no-op — but that only holds when
    // the grant row started with a null provider. A rider who was already a
    // paying Stripe subscriber when a promo/admin grant was applied carries
    // `subscription_provider = 'stripe'` before any of this runs, and not
    // writing ownership cannot unset what is already there: the terminal clear
    // still matched and revoked the grant, with a cancellation notice for a
    // plan that was never cancelled.
    //
    // The suite already asserted this shape was legitimate (see the snapshot
    // test "falls back to the STORED grant tier…", which pins a Stripe-owned
    // founder grant) while never driving it through the terminal path.
    it.each([['promo'], ['admin'], ['founder']])(
      'preserves a Stripe-owned %s grant through the terminal event that ends the subscription',
      async (planSource) => {
        const row = buildUser({
          stripe_customer_id: 'cus_123',
          stripe_subscription_id: 'sub_1',
          // ALREADY Stripe-owned: the rider was a paying subscriber before the
          // grant was applied on top.
          subscription_provider: 'stripe',
          subscription_tier: 'premium',
          subscription_status: 'active',
          plan_source: planSource as 'promo' | 'admin' | 'founder',
        });
        withStatefulProviderClaim(row);

        // The subscription stops entitling...
        stripe.constructWebhookEvent.mockReturnValueOnce(
          subscriptionEvent('incomplete'),
        );
        await service.handleWebhook(Buffer.from('payload'), 'stripe-signature');
        expect(row.subscription_tier).toBe('premium');
        expect(row.plan_source).toBe(planSource);

        // ...and then ends for good.
        stripe.constructWebhookEvent.mockReturnValueOnce(
          subscriptionEvent('canceled', true),
        );
        await service.handleWebhook(Buffer.from('payload'), 'stripe-signature');

        // The clear DID match this time (the row really was Stripe-owned), so
        // the protection has to come from the clear itself, not from a no-op.
        expect(providerClaim.clearStripeTerminal).toHaveBeenCalledWith(
          'user-1',
          'sub_1',
          expect.any(Number),
          expect.objectContaining({ preserveGrant: true }),
        );
        // The slot is released...
        expect(row.subscription_provider).toBeNull();
        expect(row.stripe_subscription_id).toBeNull();
        // ...but the grant survives, and nothing was cancelled for the rider.
        expect(row.subscription_tier).toBe('premium');
        expect(row.plan_source).toBe(planSource);
        expect(notifyCalls('cancelled')).toHaveLength(0);
      },
    );

    // ROUND 4 — the SAME lifecycle for a LEGACY rider whose paid tier predates
    // the `plan_source` column (migration 1796000000000 added it with no
    // backfill, and it is the only migration that touches the column). Their
    // row carries null, so the round-3 fix — which only reconstructed the
    // ending tier for an explicit `subscription` — still swallowed their
    // notice. Null covers both this rider and an aborted checkout, so the
    // pre-transition tier is what tells them apart.
    it('still notifies a LEGACY paid rider (plan_source null) whose subscription ends after unpaid', async () => {
      const row = buildUser({
        stripe_customer_id: 'cus_123',
        stripe_subscription_id: 'sub_1',
        subscription_provider: 'stripe',
        subscription_tier: 'premium',
        subscription_status: 'active',
        // Predates the column: never backfilled, so null despite being paid.
        plan_source: null,
      });
      withStatefulProviderClaim(row);

      stripe.constructWebhookEvent.mockReturnValueOnce(
        subscriptionEvent('unpaid'),
      );
      await service.handleWebhook(Buffer.from('payload'), 'stripe-signature');
      // Entitlement is still withdrawn...
      expect(row.subscription_tier).toBe('free');
      // ...and the row now RECORDS what its null could not prove on its own:
      // this rider held a billed plan. Captured from the pre-transition paid
      // tier, while that evidence still exists.
      expect(row.plan_source).toBe('subscription');

      stripe.constructWebhookEvent.mockReturnValueOnce(
        subscriptionEvent('canceled', true),
      );
      await service.handleWebhook(Buffer.from('payload'), 'stripe-signature');

      expect(notifyCalls('cancelled')).toHaveLength(1);
      expect(notifyCalls('cancelled')[0]).toMatchObject({
        kind: 'cancelled',
        planName: 'Premium',
      });
    });

    // The case the notification gate was ORIGINALLY written for must stay
    // silent: a free→paid checkout aborted before activation never reached an
    // entitling status, so its row never got a `plan_source` and the fallback
    // must not fire. Without the null-provenance exclusion this would mail a
    // cancellation for a plan the rider never had. It is ALSO the guard that
    // keeps round 4's paid-tier discriminator honest: this row is free at the
    // moment the checkout aborts, so no provenance is recorded for it.
    it('still sends nothing when a never-entitling checkout is cleaned up', async () => {
      const row = buildUser({
        stripe_customer_id: 'cus_123',
        stripe_subscription_id: 'sub_1',
        // A free rider: no provenance, no tier.
        subscription_tier: 'free',
        subscription_status: 'canceled',
        plan_source: null,
      });
      withStatefulProviderClaim(row);

      stripe.constructWebhookEvent.mockReturnValueOnce(
        subscriptionEvent('incomplete'),
      );
      await service.handleWebhook(Buffer.from('payload'), 'stripe-signature');
      // The aborted checkout took the slot (it is a billed row, not a grant),
      // so the terminal clear below DOES match — the silence has to come from
      // the notification gate, not from a no-op clear.
      expect(row.subscription_provider).toBe('stripe');

      stripe.constructWebhookEvent.mockReturnValueOnce(
        subscriptionEvent('incomplete_expired'),
      );
      await service.handleWebhook(Buffer.from('payload'), 'stripe-signature');

      expect(providerClaim.clearStripeTerminal).toHaveBeenCalled();
      expect(row.subscription_provider).toBeNull();
      expect(notifyCalls('cancelled')).toHaveLength(0);
    });

    // Guard against the fix over-reaching: a genuinely BILLED subscription must
    // still be cleared by its terminal event, tier and provenance reset, with
    // the cancellation mail sent exactly once.
    it('still clears a genuinely billed subscription on its terminal event', async () => {
      const row = buildUser({
        stripe_customer_id: 'cus_123',
        stripe_subscription_id: 'sub_1',
        subscription_provider: 'stripe',
        subscription_tier: 'pro',
        subscription_status: 'active',
        plan_source: 'subscription',
      });
      withStatefulProviderClaim(row);

      stripe.constructWebhookEvent.mockReturnValueOnce(
        subscriptionEvent('canceled', true),
      );
      await service.handleWebhook(Buffer.from('payload'), 'stripe-signature');

      expect(row.subscription_tier).toBe('free');
      expect(row.plan_source).toBeNull();
      expect(row.subscription_provider).toBeNull();
      expect(notifyCalls('cancelled')).toHaveLength(1);
    });

    // The founder→paying conversion across the SAME subscription the failed
    // checkout created: the first event left the slot unowned, so the later
    // entitling event must still be able to claim it.
    it('lets a later successful payment on the same subscription claim the slot', async () => {
      const row = buildUser({
        stripe_customer_id: 'cus_123',
        stripe_subscription_id: 'sub_1',
        subscription_tier: 'pro',
        subscription_status: 'canceled',
        plan_source: 'founder',
      });
      withStatefulProviderClaim(row);

      stripe.constructWebhookEvent.mockReturnValueOnce(
        subscriptionEvent('incomplete'),
      );
      await service.handleWebhook(Buffer.from('payload'), 'stripe-signature');
      expect(row.subscription_provider).toBeNull();

      // The rider fixes their card; the SAME subscription becomes active.
      stripe.constructWebhookEvent.mockReturnValueOnce(
        subscriptionEvent('active'),
      );
      await service.handleWebhook(Buffer.from('payload'), 'stripe-signature');

      // The activation transition claim is the writer here (it owns an
      // entitling status and then skips `claimForStripe`), and its guard
      // `stripe_subscription_id IS NULL OR = :sub` is satisfied by the id
      // `handleCheckoutCompleted` recorded — so ownership IS taken now.
      expect(transitionClaimSet()).toHaveBeenCalledWith(
        expect.objectContaining({
          subscription_provider: 'stripe',
          stripe_subscription_id: 'sub_1',
          subscription_tier: 'premium',
          plan_source: 'subscription',
        }),
      );
      expect(notifyCalls('confirmed')).toHaveLength(1);
    });
  });

  /**
   * Stripe lifecycle transitions — the leg of #1141 that applies to code already
   * on `main`. Renewal and cancellation for the STORE providers wait on step 5;
   * Stripe's path is merged and was untested for the one transition most likely
   * to be got wrong.
   *
   * The invariant: **cancellation before period end PRESERVES the paid tier.**
   * Stripe keeps the subscription `active` and flips `cancel_at_period_end`; the
   * tier drops only when the period actually ends. Treating the cancellation
   * event as terminal revokes access the rider has already paid for, and the
   * mistake is invisible in an end-state test — after expiry both the correct and
   * the broken implementation land on `free`. So these assert the INTERMEDIATE
   * state, which is the only place they differ.
   */
  describe('Stripe lifecycle transitions (#1141)', () => {
    const activePaidRider = () =>
      buildUser({
        subscription_tier: 'pro',
        subscription_status: 'active',
        subscription_provider: 'stripe',
        stripe_customer_id: 'cus_123',
        stripe_subscription_id: 'sub_123',
        plan_source: 'subscription',
        subscription_current_period_end: new Date('2026-09-01T00:00:00Z'),
      });

    // `subscriptionPeriodEnd` reads the PER-ITEM `current_period_end`, not the
    // object-level one — a fixture that sets only the outer field yields null and
    // would make a period assertion vacuous.
    const lifecycleEvent = (over: {
      cancelAtPeriodEnd: boolean;
      periodEnd: number;
      status?: string;
    }) => ({
      type: 'customer.subscription.updated' as const,
      data: {
        object: {
          id: 'sub_123',
          customer: 'cus_123',
          status: over.status ?? 'active',
          cancel_at_period_end: over.cancelAtPeriodEnd,
          items: {
            data: [
              {
                price: { lookup_key: 'pro' },
                current_period_end: over.periodEnd,
              },
            ],
          },
        },
      },
    });

    /**
     * An ALREADY-ACTIVE rider is the whole point of these cases, and the shared
     * mock does not model it: the activation transition guards on
     * `subscription_status NOT IN ('active','trialing')`, so against a real row
     * it matches nothing and `claimForStripe` becomes the writer. The default
     * mock reports `affected: 1` regardless of the WHERE, which would make every
     * assertion below describe a transition that cannot happen for this rider.
     */
    const alreadyActive = () =>
      activationClaimExecute.mockResolvedValue({ affected: 0 });

    const claimFields = () =>
      (
        providerClaim.claimForStripe.mock.calls as Array<
          [string, string, Record<string, unknown>]
        >
      )[0]?.[2];

    it('cancellation mid-period keeps the rider ENTITLED, flag set, period unchanged', async () => {
      const PERIOD_END = 1788220800; // 2026-09-01T00:00:00Z
      alreadyActive();
      userRepo.findOne!.mockResolvedValue(activePaidRider());
      stripe.constructWebhookEvent.mockReturnValueOnce(
        lifecycleEvent({ cancelAtPeriodEnd: true, periodEnd: PERIOD_END }),
      );

      await service.handleWebhook(Buffer.from('payload'), 'stripe-signature');

      const fields = claimFields();
      // The regression this exists for: `free` here means a rider who cancelled
      // on day 2 of a paid month loses access on day 2.
      expect(fields?.tier).toBe('pro');
      expect(fields?.status).toBe('active');
      expect(fields?.cancelAtPeriodEnd).toBe(true);
      // Converted to a Date on the way in; the epoch seconds are the wire form.
      expect(fields?.currentPeriodEnd).toEqual(new Date(PERIOD_END * 1000));
    });

    it('un-cancelling before the period ends clears the flag and keeps the tier', async () => {
      // The reverse transition, which Stripe sends as the same event shape. If
      // the flag were write-once the rider would stay scheduled for cancellation
      // after explicitly resuming.
      const PERIOD_END = 1788220800;
      alreadyActive();
      userRepo.findOne!.mockResolvedValue(
        buildUser({
          ...activePaidRider(),
          subscription_cancel_at_period_end: true,
        }),
      );
      stripe.constructWebhookEvent.mockReturnValueOnce(
        lifecycleEvent({ cancelAtPeriodEnd: false, periodEnd: PERIOD_END }),
      );

      await service.handleWebhook(Buffer.from('payload'), 'stripe-signature');

      const fields = claimFields();
      expect(fields?.tier).toBe('pro');
      expect(fields?.cancelAtPeriodEnd).toBe(false);
    });

    it('runs the FULL sequence in order: cancel keeps the tier, expiry then drops it', async () => {
      // The ordering is the assertion. A test that only checks the end state
      // passes on both the correct implementation and one that revokes at
      // cancellation time — after expiry they agree. Only the intermediate leg
      // separates them, so it is asserted BEFORE the terminal event is sent.
      const PERIOD_END = 1788220800;
      alreadyActive();
      userRepo.findOne!.mockResolvedValue(activePaidRider());

      // Leg 1 — cancellation. Still entitled.
      stripe.constructWebhookEvent.mockReturnValueOnce(
        lifecycleEvent({ cancelAtPeriodEnd: true, periodEnd: PERIOD_END }),
      );
      await service.handleWebhook(Buffer.from('payload'), 'stripe-signature');

      expect(claimFields()?.tier).toBe('pro');
      expect(claimFields()?.cancelAtPeriodEnd).toBe(true);
      expect(providerClaim.clearStripeTerminal).not.toHaveBeenCalled();

      // Leg 2 — the period ends. Stripe sends the terminal event, and only NOW
      // does the slot clear.
      stripe.constructWebhookEvent.mockReturnValueOnce({
        type: 'customer.subscription.deleted',
        data: {
          object: {
            id: 'sub_123',
            customer: 'cus_123',
            status: 'canceled',
            cancel_at_period_end: true,
            items: { data: [{ price: { lookup_key: 'pro' } }] },
          },
        },
      });
      await service.handleWebhook(Buffer.from('payload'), 'stripe-signature');

      expect(providerClaim.clearStripeTerminal).toHaveBeenCalledWith(
        'user-1',
        'sub_123',
        expect.any(Number),
        expect.objectContaining({ preserveGrant: false }),
      );
    });

    it('renewal advances the period without re-granting a trial', async () => {
      // A renewal is an ordinary `active` update carrying a LATER period end. The
      // trial marker must not be re-stamped: `billing_trial_used_at` is
      // once-per-rider, and re-stamping on every renewal would move the date
      // forward and re-open eligibility windows keyed off it.
      const NEXT_PERIOD = 1790899200; // one month on
      alreadyActive();
      userRepo.findOne!.mockResolvedValue(activePaidRider());
      stripe.constructWebhookEvent.mockReturnValueOnce(
        lifecycleEvent({ cancelAtPeriodEnd: false, periodEnd: NEXT_PERIOD }),
      );

      await service.handleWebhook(Buffer.from('payload'), 'stripe-signature');

      const fields = claimFields();
      expect(fields?.currentPeriodEnd).toEqual(new Date(NEXT_PERIOD * 1000));
      expect(fields?.tier).toBe('pro');
      // No trial marker anywhere in the claim — a renewal is not a trial grant.
      expect(fields).not.toHaveProperty('billingTrialUsedAt');
    });
  });

  describe('retirement on a successful Stripe claim (#1138)', () => {
    it('retires an open conflict for the subscription that just WON the slot', async () => {
      storeReconciliation.retireOpenWith.mockResolvedValueOnce(2);

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

      // Scoped to THIS subscription: a conflict row for a different one still
      // records a genuine loss and must stay open.
      // BOTH filters are load-bearing. The rider one especially: a conflict row
      // is filed against the rider whose event LOST, so an open row carrying
      // this subscription id can belong to someone else — and that row records a
      // real cross-rider anomaly that this rider's claim does not make moot.
      expect(storeReconciliation.retireOpenWith).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          userId: 'user-1',
          provider: 'stripe',
          reason: 'exclusivity_conflict',
          stripeSubscriptionId: 'sub_123',
        }),
        'superseded_by_claim',
      );
    });

    it('scopes the retirement to THIS rider, never a bare subscription match', async () => {
      // "State supersedes, identity disposes": across riders, ownership is
      // exclusive, so rider A winning the slot back does not resolve rider B's
      // conflict — B is still billed for a subscription bound to someone else,
      // and retiring it would delete the only record of that.
      //
      // The filtering itself is now SQL inside `retireOpenWith`, so this layer
      // can only prove the rider filter is PASSED. That another rider's row
      // actually survives is proven against a real database in
      // `test/claim-retirement-atomicity.e2e-spec.ts`.
      storeReconciliation.retireOpenWith.mockResolvedValueOnce(0);

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

      const filter = (
        storeReconciliation.retireOpenWith.mock.calls as Array<
          [unknown, { userId?: string }, string]
        >
      )[0]?.[1];
      expect(filter?.userId).toBe('user-1');
    });

    it('runs the claim and the retirement in ONE transaction', async () => {
      // Reach the `claimForStripe` path rather than the transition shortcut.
      // The transition UPDATE is the authoritative status writer when it wins;
      // only when it matches no row does `claimForStripe` run, and only that
      // path opens a transaction.
      activationClaimExecute.mockResolvedValue({ affected: 0 });
      storeReconciliation.retireOpenWith.mockResolvedValueOnce(1);

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

      // Atomicity is the point: retiring before the claim commits could close a
      // row for a claim that then fails, and retiring after could leave it open
      // if the process dies between. The mock runs the callback inline and does
      // NOT model rollback, so this asserts only that both happen inside the
      // transaction callback — it would still pass if the two used DIFFERENT
      // managers. The rollback behaviour, and that both services honour the
      // caller's manager, are pinned against real PostgreSQL in
      // `test/claim-retirement-atomicity.e2e-spec.ts`.
      expect(userRepo.manager.transaction).toHaveBeenCalledTimes(1);
      expect(storeReconciliation.retireOpenWith).toHaveBeenCalled();
    });

    /**
     * A `preservesGrant` event reports success WITHOUT taking the slot: both the
     * transition UPDATE (empty `ownershipFields` spread) and `claimForStripe`
     * (`skipOwnership`) deliberately omit `stripe_subscription_id`, so a
     * founder/promo/admin grant is not armed for `clearStripeTerminal` to wipe.
     * Nothing was superseded, so nothing may be retired — the conflict row is
     * still the durable record of a subscription with no valid home.
     */
    const preservedGrantRider = () =>
      buildUser({
        plan_source: 'founder',
        subscription_tier: 'pro',
        subscription_status: 'active',
      });

    // Two different raw statuses, because the two paths are reached differently
    // and `past_due` reaches NEITHER — it is an entitling grace status, so
    // `preservesGrant` is false for it.
    //
    //  - `unpaid`     — non-entitling, but `statusFromSubscription` maps it to
    //                   `past_due`, so the past-due TRANSITION runs (with an
    //                   empty `ownershipFields` spread) and can win.
    //  - `incomplete` — non-entitling and maps to `canceled`, so no transition
    //                   is attempted and the flow falls through to
    //                   `claimForStripe` with `skipOwnership`.
    //
    // Neither is terminal, so the slot is not released either way.
    const stripeEvent = (status: 'unpaid' | 'incomplete') => ({
      type: 'customer.subscription.updated' as const,
      data: {
        object: {
          id: 'sub_123',
          customer: 'cus_123',
          status,
          cancel_at_period_end: false,
          current_period_end: 1779537600,
          items: { data: [{ price: { lookup_key: 'pro' } }] },
        },
      },
    });

    it('retires NOTHING when a preserved grant wins the transition without taking the slot', async () => {
      userRepo.findOne!.mockResolvedValue(preservedGrantRider());
      storeReconciliation.retireOpenWith.mockResolvedValue(1);
      stripe.constructWebhookEvent.mockReturnValueOnce(stripeEvent('unpaid'));

      await service.handleWebhook(Buffer.from('payload'), 'stripe-signature');

      // Pin the PATH, not just the outcome: without this the scenario can drift
      // to the claim path and keep passing while the transition branch goes
      // uncovered — which is exactly what an earlier version of this test did.
      expect(providerClaim.claimForStripe).not.toHaveBeenCalled();
      expect(storeReconciliation.retireOpenWith).not.toHaveBeenCalled();
    });

    it('retires NOTHING when a preserved grant CLAIMS with skipOwnership', async () => {
      // Transition loses, so the flow falls through to `claimForStripe`, which
      // returns 'claimed' while skipping the ownership writes.
      activationClaimExecute.mockResolvedValue({ affected: 0 });
      userRepo.findOne!.mockResolvedValue(preservedGrantRider());
      storeReconciliation.retireOpenWith.mockResolvedValue(1);
      stripe.constructWebhookEvent.mockReturnValueOnce(
        stripeEvent('incomplete'),
      );

      await service.handleWebhook(Buffer.from('payload'), 'stripe-signature');

      expect(providerClaim.claimForStripe).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.objectContaining({ skipOwnership: true }),
      );
      expect(storeReconciliation.retireOpenWith).not.toHaveBeenCalled();
    });

    it('hands the SAME transaction manager to the claim and the retirement', async () => {
      // The wiring assertion the e2e spec cannot make. That spec proves both
      // services honour whatever manager they are given; this proves the
      // production call site gives both of them the TRANSACTION's manager. Pass
      // the pool manager to either one and the writes commit independently —
      // every rollback test would still pass, because nothing there ever
      // observes which manager the call site chose.
      activationClaimExecute.mockResolvedValue({ affected: 0 });
      storeReconciliation.retireOpenWith.mockResolvedValueOnce(1);

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

      // `toBe`, not `objectContaining`: object IDENTITY is the whole point.
      const claimCalls = providerClaim.claimForStripe.mock.calls as Array<
        [string, string, unknown, { manager?: unknown } | undefined]
      >;
      const claimManager = claimCalls[0]?.[3]?.manager;
      expect(claimManager).toBe(txManager);

      const retireCalls = storeReconciliation.retireOpenWith.mock
        .calls as Array<[unknown, unknown, string]>;
      expect(retireCalls[0]?.[0]).toBe(txManager);

      // And it is genuinely the transaction's, not the pool manager the flow was
      // handed by `runExclusive`.
      expect((claimManager as { __kind?: string } | undefined)?.__kind).toBe(
        'tx',
      );
    });

    it('retires NOTHING when the claim conflicts', async () => {
      // A losing claim invalidates no prior judgement — it creates one.
      activationClaimExecute.mockResolvedValue({ affected: 0 });
      providerClaim.claimForStripe.mockResolvedValueOnce('conflict');
      // A row MUST be available to retire, otherwise this test passes for the
      // wrong reason: with `findOpenWith` empty, `resolveWith` goes uncalled
      // whether the retirement is guarded on the claim result or not.
      storeReconciliation.retireOpenWith.mockResolvedValueOnce(1);
      userRepo.createQueryBuilder.mockReturnValue({
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({ affected: 0 }),
      });

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

      expect(storeReconciliation.retireOpenWith).not.toHaveBeenCalled();
    });
  });

  describe('getPurchaseIdentity — open item (j): the app user id must not be the rider id', () => {
    const TOKEN = '11111111-2222-4333-8444-555555555555';

    /**
     * TypeORM returns `[rows, affectedCount]` from `UPDATE ... RETURNING`, not
     * `rows`. These mocks originally returned the flat shape, which is why they
     * passed while the endpoint threw `NotFoundException` for every real caller
     * — the bug was only found by an e2e test hitting a real database. Mock the
     * shape the driver actually produces, and keep the e2e coverage: a mock that
     * agrees with the code instead of with PostgreSQL proves nothing.
     */
    const RETURNING = (rows: unknown[]) => [rows, rows.length];

    it('mints a token on first request and returns it', async () => {
      userRepo.query.mockResolvedValueOnce(
        RETURNING([{ purchase_account_token: TOKEN }]),
      );

      await expect(service.getPurchaseIdentity('user-1')).resolves.toEqual({
        purchase_account_token: TOKEN,
      });
    });

    it('returns the SAME token on a second request — it never rotates', async () => {
      userRepo.query
        .mockResolvedValueOnce(RETURNING([{ purchase_account_token: TOKEN }]))
        .mockResolvedValueOnce(RETURNING([{ purchase_account_token: TOKEN }]));

      const first = await service.getPurchaseIdentity('user-1');
      const second = await service.getPurchaseIdentity('user-1');

      // Rotation is not a cosmetic bug: a purchase already made under the old
      // token would be orphaned, since ingestion resolves riders by this value.
      expect(second.purchase_account_token).toBe(first.purchase_account_token);
    });

    it('mints with ONE COALESCE statement, so concurrent first requests cannot both win', async () => {
      userRepo.query.mockResolvedValueOnce(
        RETURNING([{ purchase_account_token: TOKEN }]),
      );

      await service.getPurchaseIdentity('user-1');

      // Asserting on SQL shape rather than behaviour, deliberately: the property
      // under test is atomicity, and a mocked repository cannot exhibit a race.
      // A read-then-write refactor would pass every other test in this block
      // while letting two concurrent requests mint different tokens and one
      // overwrite the other. Real concurrency belongs in a DB-backed test.
      const [sql] = userRepo.query.mock.calls[0] as [string, unknown[]];
      expect(sql).toMatch(/COALESCE\(purchase_account_token/i);
      expect(sql).toMatch(/RETURNING purchase_account_token/i);
    });

    it('scopes the mint to the CALLING rider', async () => {
      userRepo.query.mockResolvedValueOnce(
        RETURNING([{ purchase_account_token: TOKEN }]),
      );

      await service.getPurchaseIdentity('user-42');

      const [, params] = userRepo.query.mock.calls[0] as [string, unknown[]];
      expect(params[1]).toBe('user-42');
    });

    it('throws when the rider no longer exists rather than returning an unowned token', async () => {
      // Deleted between authentication and this statement → zero rows. Returning
      // a token here would let a client bind a purchase to a row nobody owns.
      userRepo.query.mockResolvedValueOnce(RETURNING([]));

      await expect(service.getPurchaseIdentity('ghost')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('refuses to mint for a SOFT-deleted rider, in the same statement', async () => {
      // `AuthGuard` rejects a soft-deleted account, but deletion can commit
      // between that check and this write. A pre-check would not close that
      // race — the predicate has to be part of the atomic UPDATE, which is also
      // what `AccountDeletionService` does (`{ id, deleted_at: IsNull() }`).
      //
      // Asserting the predicate rather than only the zero-row outcome: without
      // it the UPDATE still matches the soft-deleted row and mints, and every
      // other test in this block passes. A locked-out rider could then bind a
      // purchase that the deletion workflow does not cancel (#1140).
      userRepo.query.mockResolvedValueOnce(RETURNING([]));

      await expect(service.getPurchaseIdentity('locked-out')).rejects.toThrow(
        NotFoundException,
      );

      const [sql] = userRepo.query.mock.calls[0] as [string, unknown[]];
      expect(sql).toMatch(/deleted_at IS NULL/i);
    });
  });
});
