/* eslint-disable @typescript-eslint/unbound-method */
import { ConfigService } from '@nestjs/config';
import type { EntityManager, Repository } from 'typeorm';
import { SubscriptionNotificationService } from './subscription-notification.service.js';
import type { EmailService } from '../email/email.service.js';
import type { PushService } from '../push/index.js';
import type { SubscriptionMutationLockService } from './subscription-mutation-lock.service.js';
import { User } from '../../entities/user.entity.js';

// Delivery runs under the per-rider lock and gates on the rider's CURRENT state
// (NOT a fence token): a notification is sent iff it still describes the live
// state, so a benign same-state webhook redelivery never drops a valid one, and
// an opposite transition suppresses a now-stale one.
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
    // Passthrough lock: runs the callback on a manager whose getRepository(User)
    // returns the mocked repo. The real serialization is verified by reasoning +
    // the lock's own spec.
    const runExclusive = jest.fn(
      <T>(_userId: string, fn: (m: EntityManager) => Promise<T>): Promise<T> =>
        fn({
          getRepository: () => userRepo,
        } as unknown as EntityManager),
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
    return { service, email, pushService, runExclusive };
  }

  it('delivers under the per-rider lock', async () => {
    const { service, runExclusive } = setup(buildUser());
    await service.deliver({
      kind: 'confirmed',
      userId: 'user-1',
      tier: 'pro',
      periodEnd: null,
    });
    expect(runExclusive).toHaveBeenCalledWith('user-1', expect.any(Function));
  });

  it('sends the confirmation when the rider is currently active on the announced tier', async () => {
    const { service, email } = setup(
      buildUser({
        subscription_status: 'active',
        subscription_tier: 'pro',
        language: 'cs',
      }),
    );

    await service.deliver({
      kind: 'confirmed',
      userId: 'user-1',
      tier: 'pro',
      periodEnd: '2026-09-01T00:00:00.000Z',
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

  it('DROPS a confirmation when the rider has since moved to a DIFFERENT tier', async () => {
    // An upgrade to premium committed before delivery → the pro confirmation is
    // stale and must not be sent.
    const { service, email } = setup(
      buildUser({
        subscription_status: 'active',
        subscription_tier: 'premium',
      }),
    );

    await service.deliver({
      kind: 'confirmed',
      userId: 'user-1',
      tier: 'pro',
      periodEnd: null,
    });

    expect(email.sendSubscriptionConfirmed).not.toHaveBeenCalled();
  });

  it('DROPS a cancellation when the rider is currently entitled again (reactivation)', async () => {
    const { service, email } = setup(
      buildUser({ subscription_status: 'active', subscription_tier: 'pro' }),
    );

    await service.deliver({
      kind: 'cancelled',
      userId: 'user-1',
      planName: 'Pro',
      periodEnd: null,
    });

    expect(email.sendSubscriptionCancelled).not.toHaveBeenCalled();
  });

  it('sends the cancellation when the rider is currently NOT entitled', async () => {
    const { service, email } = setup(
      buildUser({ subscription_status: 'canceled', subscription_tier: 'free' }),
    );

    await service.deliver({
      kind: 'cancelled',
      userId: 'user-1',
      planName: 'Premium',
      periodEnd: null,
    });

    expect(email.sendSubscriptionCancelled).toHaveBeenCalledWith(
      'rider@tarmoto.app',
      expect.objectContaining({ planName: 'Premium' }),
      'en',
    );
  });

  it('sends the billing-failed push only while the rider is past_due', async () => {
    const { service, pushService } = setup(
      buildUser({ subscription_status: 'past_due' }),
    );

    await service.deliver({
      kind: 'billing_failed',
      userId: 'user-1',
    });

    expect(pushService.sendToUser).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ category: 'subscription_billing' }),
    );
  });

  it('DROPS the billing-failed push once the rider has recovered to active', async () => {
    const { service, pushService } = setup(
      buildUser({ subscription_status: 'active' }),
    );

    await service.deliver({
      kind: 'billing_failed',
      userId: 'user-1',
    });

    expect(pushService.sendToUser).not.toHaveBeenCalled();
  });

  it('no-ops when the rider was deleted between enqueue and delivery', async () => {
    const { service, email, pushService } = setup(null);

    await service.deliver({
      kind: 'confirmed',
      userId: 'gone',
      tier: 'pro',
      periodEnd: null,
    });

    expect(email.sendSubscriptionConfirmed).not.toHaveBeenCalled();
    expect(pushService.sendToUser).not.toHaveBeenCalled();
  });
});
