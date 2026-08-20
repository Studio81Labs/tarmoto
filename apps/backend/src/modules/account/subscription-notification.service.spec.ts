import { ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { EntityManager, Repository } from 'typeorm';
import { SubscriptionNotificationService } from './subscription-notification.service.js';
import type { EmailService } from '../email/email.service.js';
import type { PushService } from '../push/index.js';
import type { SubscriptionMutationLockService } from './subscription-mutation-lock.service.js';
import { StoreChainWriterService } from './store-chain-writer.service.js';
import { User } from '../../entities/user.entity.js';
import { StoreSubscription } from '../../entities/store-subscription.entity.js';

// Delivery runs under the per-rider lock and gates on TWO things read under it:
// the rider's notification GENERATION still equals the job's (so an ABA
// re-activation, which bumps the generation, drops the stale earlier job while a
// same-state redelivery keeps matching), AND the current STATE still matches the
// announced transition. The lease is reasserted before the (bounded) send.
describe('SubscriptionNotificationService', () => {
  // `unknown`-valued overrides: the entity narrows `language` to the
  // English-only literal, but these tests deliberately exercise a cs-locale
  // recipient through the per-recipient translation path.
  const buildUser = (
    overrides: Partial<{ [K in keyof User]: unknown }> = {},
  ): User =>
    ({
      id: 'user-1',
      email: 'rider@tarmoto.app',
      display_name: 'Test Rider',
      language: 'en',
      subscription_provider: 'stripe',
      subscription_status: 'active',
      subscription_tier: 'pro',
      subscription_notify_generation: 5,
      ...overrides,
    }) as User;

  /** A chain row for the store-source delivery gates, overridable per test. */
  const buildChain = (
    overrides: Partial<StoreSubscription> = {},
  ): StoreSubscription => ({
    id: 'chain-1',
    user_id: 'user-1',
    provider: 'google',
    original_transaction_id: 'GPA.root-1',
    target_key: 'GPA.root-1',
    target_key_provisional: false,
    product_id: 'tarmoto_pro_monthly',
    original_purchase_date: null,
    tier: 'pro',
    status: 'active',
    current_period_end: new Date(Date.now() + 30 * 24 * 3600_000),
    cancel_at_period_end: false,
    store_signed_date: new Date(),
    lock_fence: 1,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  });

  function setup(user: User | null, chain: StoreSubscription | null = null) {
    const findOne = jest.fn().mockResolvedValue(user);
    const userRepo = { findOne } as unknown as Repository<User>;
    const chainFindOne = jest.fn().mockResolvedValue(chain);
    const chainRepo = {
      findOne: chainFindOne,
    } as unknown as Repository<StoreSubscription>;
    // Real liveness rules with a fixed 35-day fallback window — the config
    // default — so the store gates below are judged by the production
    // predicates rather than a re-implementation in the mock.
    const storeChains = {
      isChainCurrentlyLive: (row: StoreSubscription) =>
        (row.current_period_end ??
          new Date(row.store_signed_date.getTime() + 35 * 24 * 3600_000)) >
        new Date(),
      isChainFutureBilling: (row: StoreSubscription) =>
        row.status !== 'canceled' &&
        !row.cancel_at_period_end &&
        (row.current_period_end ??
          new Date(row.store_signed_date.getTime() + 35 * 24 * 3600_000)) >
          new Date(),
    } as unknown as StoreChainWriterService;
    const email = {
      sendSubscriptionConfirmed: jest.fn().mockResolvedValue(null),
      sendSubscriptionCancelled: jest.fn().mockResolvedValue(null),
    } as unknown as jest.Mocked<EmailService>;
    const pushService = {
      sendToUser: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<PushService>;
    const config = {
      get: jest.fn().mockReturnValue(undefined),
    } as unknown as ConfigService;
    const assertHeld = jest.fn().mockResolvedValue(undefined);
    const assertFenceCurrent = jest.fn().mockResolvedValue(undefined);
    // Passthrough lock: runs the callback on a manager whose getRepository(User)
    // returns the mocked repo, with a lease whose assertHeld/assertFenceCurrent are
    // observable. The real serialization is verified by the lock's own spec.
    const runExclusive = jest.fn(
      <T>(
        _userId: string,
        fn: (
          m: EntityManager,
          lease: {
            assertHeld: () => Promise<void>;
            assertFenceCurrent: () => Promise<void>;
          },
        ) => Promise<T>,
      ): Promise<T> =>
        fn(
          {
            getRepository: (entity: unknown) =>
              entity === StoreSubscription ? chainRepo : userRepo,
          } as unknown as EntityManager,
          {
            assertHeld,
            assertFenceCurrent,
          },
        ),
    );
    const subscriptionLock = {
      runExclusive,
    } as unknown as SubscriptionMutationLockService;
    const service = new SubscriptionNotificationService(
      userRepo,
      email,
      pushService,
      config,
      subscriptionLock,
      storeChains,
    );
    return {
      service,
      email,
      pushService,
      runExclusive,
      assertHeld,
      assertFenceCurrent,
      chainFindOne,
    };
  }

  it('delivers under the per-rider lock, publishing the fence and reasserting the lease before sending', async () => {
    const { service, runExclusive, assertHeld, assertFenceCurrent, email } =
      setup(buildUser());
    await service.deliver({
      kind: 'confirmed',
      userId: 'user-1',
      tier: 'pro',
      periodEnd: null,
      generation: 5,
    });
    expect(runExclusive).toHaveBeenCalledWith('user-1', expect.any(Function));
    // Fence published (fences out lower-token stragglers) before the send, and
    // the lease reasserted immediately before it.
    expect(assertFenceCurrent).toHaveBeenCalledTimes(1);
    expect(assertHeld).toHaveBeenCalledTimes(1);
    expect(email.sendSubscriptionConfirmed).toHaveBeenCalledTimes(1);
  });

  it('sends the confirmation when generation + state still match', async () => {
    const { service, email } = setup(
      buildUser({
        subscription_status: 'active',
        subscription_tier: 'pro',
        subscription_notify_generation: 5,
        language: 'cs',
      }),
    );

    await service.deliver({
      kind: 'confirmed',
      userId: 'user-1',
      tier: 'pro',
      periodEnd: '2026-09-01T00:00:00.000Z',
      generation: 5,
    });

    expect(email.sendSubscriptionConfirmed).toHaveBeenCalledWith(
      'rider@tarmoto.app',
      expect.objectContaining({
        planName: 'Pro',
        renewsAt: new Date('2026-09-01T00:00:00.000Z'),
      }),
      'cs',
    );
  });

  it('DROPS a confirmation superseded by a newer transition (ABA): generation advanced even though state matches', async () => {
    // Rider cancelled + re-activated Pro before this job drained → generation is
    // now 7; even though the row is again (active, pro), the stale gen-5 job must
    // not be delivered (the re-activation has its own gen-7 job).
    const { service, email } = setup(
      buildUser({
        subscription_status: 'active',
        subscription_tier: 'pro',
        subscription_notify_generation: 7,
      }),
    );

    await service.deliver({
      kind: 'confirmed',
      userId: 'user-1',
      tier: 'pro',
      periodEnd: null,
      generation: 5,
    });

    expect(email.sendSubscriptionConfirmed).not.toHaveBeenCalled();
  });

  it('DROPS a confirmation when the rider moved to a DIFFERENT tier (state gate, generation unchanged)', async () => {
    // A tier change that did not itself enqueue leaves the generation untouched,
    // so the STATE gate catches it.
    const { service, email } = setup(
      buildUser({
        subscription_status: 'active',
        subscription_tier: 'premium',
        subscription_notify_generation: 5,
      }),
    );

    await service.deliver({
      kind: 'confirmed',
      userId: 'user-1',
      tier: 'pro',
      periodEnd: null,
      generation: 5,
    });

    expect(email.sendSubscriptionConfirmed).not.toHaveBeenCalled();
  });

  it('DROPS a cancellation when the rider is currently entitled again (reactivation)', async () => {
    const { service, email } = setup(
      buildUser({
        subscription_status: 'active',
        subscription_notify_generation: 5,
      }),
    );

    await service.deliver({
      kind: 'cancelled',
      userId: 'user-1',
      planName: 'Pro',
      periodEnd: null,
      generation: 5,
    });

    expect(email.sendSubscriptionCancelled).not.toHaveBeenCalled();
  });

  it('sends the cancellation when generation matches and the rider is NOT entitled', async () => {
    const { service, email } = setup(
      buildUser({
        subscription_status: 'canceled',
        subscription_tier: 'free',
        subscription_notify_generation: 5,
      }),
    );

    await service.deliver({
      kind: 'cancelled',
      userId: 'user-1',
      planName: 'Premium',
      periodEnd: null,
      generation: 5,
    });

    expect(email.sendSubscriptionCancelled).toHaveBeenCalledWith(
      'rider@tarmoto.app',
      expect.objectContaining({ planName: 'Premium' }),
      'en',
    );
  });

  it('sends the billing-failed push only while past_due and generation matches', async () => {
    const { service, pushService } = setup(
      buildUser({
        subscription_status: 'past_due',
        subscription_notify_generation: 5,
      }),
    );

    await service.deliver({
      kind: 'billing_failed',
      userId: 'user-1',
      generation: 5,
    });

    expect(pushService.sendToUser).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ category: 'subscription_billing' }),
    );
  });

  it('DROPS the billing-failed push once the rider has recovered to active', async () => {
    const { service, pushService } = setup(
      buildUser({
        subscription_status: 'active',
        subscription_notify_generation: 5,
      }),
    );

    await service.deliver({
      kind: 'billing_failed',
      userId: 'user-1',
      generation: 5,
    });

    expect(pushService.sendToUser).not.toHaveBeenCalled();
  });

  it('aborts (no send) when the lease was lost — assertHeld rejects', async () => {
    const { service, email, assertHeld } = setup(buildUser());
    assertHeld.mockRejectedValue(
      new ServiceUnavailableException({ retryable: true }),
    );

    await expect(
      service.deliver({
        kind: 'confirmed',
        userId: 'user-1',
        tier: 'pro',
        periodEnd: null,
        generation: 5,
      }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(email.sendSubscriptionConfirmed).not.toHaveBeenCalled();
  });

  it('no-ops when the rider was deleted between enqueue and delivery', async () => {
    const { service, email, pushService, assertHeld } = setup(null);

    await service.deliver({
      kind: 'confirmed',
      userId: 'gone',
      tier: 'pro',
      periodEnd: null,
      generation: 5,
    });

    expect(email.sendSubscriptionConfirmed).not.toHaveBeenCalled();
    expect(pushService.sendToUser).not.toHaveBeenCalled();
    // Deleted rider is caught before the lease reassert.
    expect(assertHeld).not.toHaveBeenCalled();
  });

  // ── Source-aware delivery (#1191 item 6) ────────────────────────────────
  //
  // The job payload names the billing source (provider + identity), and the
  // state gate judges THAT source. Rider-level state cannot: the
  // `users.subscription_*` columns are the STRIPE side, so a store purchase
  // looks `canceled`/`free` there, and a store cancellation under a live
  // Stripe representative looks "still entitled". The legacy jobs above carry
  // no `source` and keep the old rider-level gate — the rolling-deploy skew
  // path, pinned by their continued passing.
  describe('source-aware delivery', () => {
    it('DELIVERS a store-only purchase confirmation the rider-level gate would discard', async () => {
      // The rider's Stripe side is free/canceled — exactly what a store-only
      // payer looks like — while their chain is active Pro. The old gate read
      // the users columns and dropped this as superseded, so the mobile
      // activation flow purchased successfully and never got its email.
      const { service, email } = setup(
        buildUser({
          subscription_status: 'canceled',
          subscription_tier: 'free',
        }),
        buildChain({ status: 'active', tier: 'pro' }),
      );

      await service.deliver({
        kind: 'confirmed',
        userId: 'user-1',
        tier: 'pro',
        periodEnd: null,
        generation: 5,
        source: { provider: 'google', identity: 'GPA.root-1' },
      });

      expect(email.sendSubscriptionConfirmed).toHaveBeenCalledTimes(1);
    });

    it('DELIVERS a cancelled-Apple-chain notice under a live Stripe representative', async () => {
      // Stripe Premium keeps the rider entitled, so the resolved state never
      // changes when the Apple chain ends — validating against it discards a
      // real cancellation. The chain itself is what the notice is about.
      const { service, email } = setup(
        buildUser({
          subscription_status: 'active',
          subscription_tier: 'premium',
        }),
        buildChain({ provider: 'apple', status: 'canceled', tier: 'pro' }),
      );

      await service.deliver({
        kind: 'cancelled',
        userId: 'user-1',
        planName: 'Pro',
        periodEnd: null,
        generation: 5,
        source: { provider: 'apple', identity: 'GPA.root-1' },
      });

      expect(email.sendSubscriptionCancelled).toHaveBeenCalledTimes(1);
    });

    it('DROPS a store cancellation once the chain is future-billing again', async () => {
      const { service, email } = setup(
        buildUser(),
        buildChain({ status: 'active', cancel_at_period_end: false }),
      );

      await service.deliver({
        kind: 'cancelled',
        userId: 'user-1',
        planName: 'Pro',
        periodEnd: null,
        generation: 5,
        source: { provider: 'google', identity: 'GPA.root-1' },
      });

      expect(email.sendSubscriptionCancelled).not.toHaveBeenCalled();
    });

    it('DROPS a store confirmation whose chain has lapsed (no row found is fail-closed)', async () => {
      const { service, email } = setup(buildUser(), null);

      await service.deliver({
        kind: 'confirmed',
        userId: 'user-1',
        tier: 'pro',
        periodEnd: null,
        generation: 5,
        source: { provider: 'google', identity: 'GPA.root-1' },
      });

      expect(email.sendSubscriptionConfirmed).not.toHaveBeenCalled();
    });

    it('gates a store billing-failed push on the CHAIN being past_due', async () => {
      const { service, pushService, chainFindOne } = setup(
        buildUser({ subscription_status: 'active' }),
        buildChain({ status: 'past_due' }),
      );

      await service.deliver({
        kind: 'billing_failed',
        userId: 'user-1',
        generation: 5,
        source: { provider: 'google', identity: 'GPA.root-1' },
      });

      expect(pushService.sendToUser).toHaveBeenCalledTimes(1);
      expect(chainFindOne).toHaveBeenCalledWith({
        where: {
          user_id: 'user-1',
          provider: 'google',
          target_key: 'GPA.root-1',
        },
      });
    });

    it('scopes a stripe-source confirmation to the subscription it names', async () => {
      // The rider is actively subscribed at the announced tier — but under a
      // DIFFERENT subscription id than the job names. The source the job is
      // about is gone, so the confirmation is stale.
      const { service, email } = setup(
        buildUser({
          subscription_status: 'active',
          subscription_tier: 'pro',
          stripe_subscription_id: 'sub_other',
        }),
      );

      await service.deliver({
        kind: 'confirmed',
        userId: 'user-1',
        tier: 'pro',
        periodEnd: null,
        generation: 5,
        source: { provider: 'stripe', identity: 'sub_named' },
      });

      expect(email.sendSubscriptionConfirmed).not.toHaveBeenCalled();
    });

    it('delivers a stripe-source cancellation after the terminal clear nulled the stored id', async () => {
      // `clearStripeTerminal` nulls `stripe_subscription_id`, so the named
      // subscription is no longer the rider's entitling Stripe side — the
      // notice still describes reality and must go out.
      const { service, email } = setup(
        buildUser({
          subscription_status: 'canceled',
          subscription_tier: 'free',
          stripe_subscription_id: null,
        }),
      );

      await service.deliver({
        kind: 'cancelled',
        userId: 'user-1',
        planName: 'Pro',
        periodEnd: null,
        generation: 5,
        source: { provider: 'stripe', identity: 'sub_named' },
      });

      expect(email.sendSubscriptionCancelled).toHaveBeenCalledTimes(1);
    });
  });
});
