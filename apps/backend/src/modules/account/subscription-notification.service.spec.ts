/* eslint-disable @typescript-eslint/unbound-method */
import { ConfigService } from '@nestjs/config';
import type { Repository } from 'typeorm';
import { SubscriptionNotificationService } from './subscription-notification.service.js';
import type { EmailService } from '../email/email.service.js';
import type { PushService } from '../push/index.js';
import { User } from '../../entities/user.entity.js';

// The fence-revalidated delivery is the whole point of the durable queue: a
// notification decided under the lock but delivered later must be DROPPED if a
// newer event has since advanced the rider's fence, so a cancellation can't
// outlive a reactivation (or a confirmation a deletion).
describe('SubscriptionNotificationService', () => {
  const buildUser = (overrides: Partial<User> = {}): User =>
    ({
      id: 'user-1',
      email: 'rider@tarmoto.app',
      display_name: 'Test Rider',
      language: 'en',
      subscription_lock_fence: 5,
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
    const service = new SubscriptionNotificationService(
      userRepo,
      email,
      pushService,
      config,
    );
    return { service, findOne, email, pushService };
  }

  it('sends the confirmation email when the enqueued fence still matches the row', async () => {
    const { service, email } = setup(
      buildUser({ subscription_lock_fence: 5, language: 'cs' }),
    );

    await service.deliver({
      kind: 'confirmed',
      userId: 'user-1',
      tier: 'pro',
      periodEnd: '2026-09-01T00:00:00.000Z',
      fenceToken: 5,
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

  it('DROPS a superseded notification when a newer event advanced the fence', async () => {
    // Current fence (7) is strictly greater than the enqueued token (5): a newer
    // serialized event committed after this one, so it must not be delivered.
    const { service, email, pushService } = setup(
      buildUser({ subscription_lock_fence: 7 }),
    );

    await service.deliver({
      kind: 'cancelled',
      userId: 'user-1',
      planName: 'Pro',
      periodEnd: null,
      fenceToken: 5,
    });

    expect(email.sendSubscriptionCancelled).not.toHaveBeenCalled();
    expect(pushService.sendToUser).not.toHaveBeenCalled();
  });

  it('still delivers when the fence is unchanged (equal token — the enqueuing flow itself)', async () => {
    const { service, email } = setup(buildUser({ subscription_lock_fence: 5 }));

    await service.deliver({
      kind: 'cancelled',
      userId: 'user-1',
      planName: 'Premium',
      periodEnd: null,
      fenceToken: 5,
    });

    expect(email.sendSubscriptionCancelled).toHaveBeenCalledWith(
      'rider@tarmoto.app',
      expect.objectContaining({ planName: 'Premium' }),
      'en',
    );
  });

  it('sends the billing-failed push when current', async () => {
    const { service, pushService } = setup(
      buildUser({ subscription_lock_fence: 5 }),
    );

    await service.deliver({
      kind: 'billing_failed',
      userId: 'user-1',
      fenceToken: 5,
    });

    expect(pushService.sendToUser).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ category: 'subscription_billing' }),
    );
  });

  it('no-ops when the rider was deleted between enqueue and delivery', async () => {
    const { service, email, pushService } = setup(null);

    await service.deliver({
      kind: 'confirmed',
      userId: 'gone',
      tier: 'pro',
      periodEnd: null,
      fenceToken: 5,
    });

    expect(email.sendSubscriptionConfirmed).not.toHaveBeenCalled();
    expect(pushService.sendToUser).not.toHaveBeenCalled();
  });
});
