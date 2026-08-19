import { ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { EntityManager, Repository } from 'typeorm';
import { SubscriptionNotificationService } from './subscription-notification.service.js';
import type { EmailService } from '../email/email.service.js';
import type { PushService } from '../push/index.js';
import type { SubscriptionMutationLockService } from './subscription-mutation-lock.service.js';
import { User } from '../../entities/user.entity.js';

// Delivery runs under the per-rider lock and gates on TWO things read under it:
// the rider's notification GENERATION still equals the job's (so an ABA
// re-activation, which bumps the generation, drops the stale earlier job while a
// same-state redelivery keeps matching), AND the current STATE still matches the
// announced transition. The lease is reasserted before the (bounded) send.
describe('SubscriptionNotificationService', () => {
  const buildUser = (overrides: Partial<User> = {}): User =>
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

  function setup(user: User | null) {
    const findOne = jest.fn().mockResolvedValue(user);
    const userRepo = { findOne } as unknown as Repository<User>;
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
        fn({ getRepository: () => userRepo } as unknown as EntityManager, {
          assertHeld,
          assertFenceCurrent,
        }),
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
    );
    return {
      service,
      email,
      pushService,
      runExclusive,
      assertHeld,
      assertFenceCurrent,
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
});
