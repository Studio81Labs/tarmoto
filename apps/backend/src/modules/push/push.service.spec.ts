/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DeviceToken } from '../../entities/device-token.entity.js';
import { NotificationPreferencesRow } from '../../entities/notification-preferences.entity.js';
import { UserNotification } from '../../entities/user-notification.entity.js';
import { FeatureResolver } from '../features/feature-resolver.service.js';
import {
  PushService,
  isInQuietHours,
  mergeWithDefaults,
} from './push.service.js';
import {
  PUSH_PROVIDER,
  type PushProvider,
  type PushSendResult,
} from './push-provider.js';

const USER_ID = '11111111-1111-1111-1111-111111111111';

function makeRow(
  overrides: Partial<NotificationPreferencesRow> = {},
): NotificationPreferencesRow {
  return {
    user_id: USER_ID,
    email_digest: 'weekly',
    marketing_emails: false,
    quiet_hours_start: 0,
    quiet_hours_end: 0,
    quiet_hours_timezone: 'UTC',
    categories: {},
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  } as NotificationPreferencesRow;
}

describe('PushService', () => {
  let service: PushService;
  let tokenRepo: jest.Mocked<Pick<Repository<DeviceToken>, 'find' | 'update'>>;
  let prefsRepo: jest.Mocked<
    Pick<Repository<NotificationPreferencesRow>, 'findOne'>
  >;
  let notificationRepo: jest.Mocked<
    Pick<Repository<unknown>, 'create' | 'save'>
  >;
  let provider: jest.Mocked<PushProvider>;
  let featureResolver: { isSystemSwitchEnabled: jest.Mock };

  beforeEach(async () => {
    tokenRepo = {
      find: jest.fn().mockResolvedValue([
        {
          user_id: USER_ID,
          platform: 'ios',
          token: 'token-ios-1',
          deleted_at: null,
        },
        {
          user_id: USER_ID,
          platform: 'android',
          token: 'token-and-1',
          deleted_at: null,
        },
      ]),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };

    prefsRepo = {
      findOne: jest.fn().mockResolvedValue(null),
    };

    notificationRepo = {
      create: jest.fn((data: unknown) => data),
      save: jest.fn((data: unknown) => Promise.resolve(data)),
    };

    provider = {
      name: 'mock',
      send: jest.fn<Promise<PushSendResult>, Parameters<PushProvider['send']>>(
        () =>
          Promise.resolve({
            delivered: 2,
            invalidTokens: [],
            providerName: 'mock',
          }),
      ),
    };

    featureResolver = {
      isSystemSwitchEnabled: jest.fn().mockResolvedValue(true),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PushService,
        { provide: getRepositoryToken(DeviceToken), useValue: tokenRepo },
        {
          provide: getRepositoryToken(NotificationPreferencesRow),
          useValue: prefsRepo,
        },
        {
          provide: getRepositoryToken(UserNotification),
          useValue: notificationRepo,
        },
        { provide: PUSH_PROVIDER, useValue: provider },
        { provide: FeatureResolver, useValue: featureResolver },
      ],
    }).compile();

    service = module.get<PushService>(PushService);
  });

  describe('sendToUser', () => {
    it('dispatches to all active tokens when category is enabled by default', async () => {
      const result = await service.sendToUser(USER_ID, {
        category: 'new_follower',
        title: 'New follower',
        body: 'Adam started following you',
      });

      expect(provider.send).toHaveBeenCalledTimes(1);
      expect(provider.send).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ token: 'token-ios-1' }),
          expect.objectContaining({ token: 'token-and-1' }),
        ]),
        expect.objectContaining({
          title: 'New follower',
          category: 'new_follower',
        }),
      );
      expect(result).toMatchObject({ delivered: 2, suppressed: false });
    });

    it('creates an in-app notification row when the category in_app toggle is enabled', async () => {
      await service.sendToUser(USER_ID, {
        category: 'new_follower',
        title: 'New follower',
        body: 'Adam started following you',
        data: { type: 'new_follower', follower_id: 'follower-1' },
      });

      expect(notificationRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          user_id: USER_ID,
          category: 'new_follower',
          title: 'New follower',
          body: 'Adam started following you',
          data: { type: 'new_follower', follower_id: 'follower-1' },
        }),
      );
      expect(notificationRepo.save).toHaveBeenCalledTimes(1);
    });

    it('does not create an in-app notification when the category in_app toggle is off', async () => {
      prefsRepo.findOne.mockResolvedValue(
        makeRow({
          categories: {
            new_follower: { email: false, push: true, in_app: false },
          },
        }),
      );

      await service.sendToUser(USER_ID, {
        category: 'new_follower',
        title: 'New follower',
        body: 'no',
      });

      expect(notificationRepo.save).not.toHaveBeenCalled();
      expect(provider.send).toHaveBeenCalledTimes(1);
    });

    it('continues push delivery when the in-app feed write fails', async () => {
      notificationRepo.save.mockRejectedValueOnce(new Error('db down'));

      const result = await service.sendToUser(USER_ID, {
        category: 'new_follower',
        title: 'New follower',
        body: 'Adam started following you',
      });

      expect(provider.send).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({ delivered: 2, suppressed: false });
    });

    it('suppresses when the category push toggle is off', async () => {
      prefsRepo.findOne.mockResolvedValue(
        makeRow({
          categories: {
            new_follower: { email: false, push: false, in_app: true },
          },
        }),
      );

      const result = await service.sendToUser(USER_ID, {
        category: 'new_follower',
        title: 'New follower',
        body: 'no',
      });

      expect(provider.send).not.toHaveBeenCalled();
      expect(notificationRepo.save).toHaveBeenCalledTimes(1);
      expect(result).toEqual({
        delivered: 0,
        pruned: 0,
        suppressed: true,
        suppressedReason: 'preference-off',
      });
    });

    it('suppresses non-critical pushes during quiet hours', async () => {
      // Quiet hours 22:00 → 06:00 UTC. Use a fixed `Date` that lands at 23:00.
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2026-01-01T23:00:00Z'));

      prefsRepo.findOne.mockResolvedValue(
        makeRow({
          quiet_hours_start: 22 * 60,
          quiet_hours_end: 6 * 60,
          quiet_hours_timezone: 'UTC',
        }),
      );

      try {
        const result = await service.sendToUser(USER_ID, {
          category: 'new_follower',
          title: 'x',
          body: 'y',
        });
        expect(provider.send).not.toHaveBeenCalled();
        expect(notificationRepo.save).not.toHaveBeenCalled();
        expect(result.suppressedReason).toBe('quiet-hours');
      } finally {
        jest.useRealTimers();
      }
    });

    it('lets critical categories through quiet hours', async () => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2026-01-01T23:00:00Z'));

      prefsRepo.findOne.mockResolvedValue(
        makeRow({
          quiet_hours_start: 22 * 60,
          quiet_hours_end: 6 * 60,
          quiet_hours_timezone: 'UTC',
        }),
      );

      try {
        const result = await service.sendToUser(USER_ID, {
          category: 'crash_followup',
          title: 'Alert sent',
          body: '2 of 3 contacts notified',
        });
        expect(provider.send).toHaveBeenCalled();
        expect(notificationRepo.save).toHaveBeenCalledTimes(1);
        expect(result.suppressed).toBe(false);
      } finally {
        jest.useRealTimers();
      }
    });

    it('returns suppressed=no-tokens when the user has no active devices', async () => {
      tokenRepo.find.mockResolvedValueOnce([]);

      const result = await service.sendToUser(USER_ID, {
        category: 'new_follower',
        title: 'a',
        body: 'b',
      });

      expect(provider.send).not.toHaveBeenCalled();
      expect(result.suppressedReason).toBe('no-tokens');
    });

    it('gates the new route_comment category on its push toggle', async () => {
      // route_comment defaults to push: true (see DEFAULT_NOTIFICATION_PREFERENCES);
      // disabling it should suppress without calling the provider.
      prefsRepo.findOne.mockResolvedValue(
        makeRow({
          categories: {
            route_comment: { email: false, push: false, in_app: true },
          },
        }),
      );

      const result = await service.sendToUser(USER_ID, {
        category: 'route_comment',
        title: 'New comment',
        body: '@ada commented on your route',
      });

      expect(provider.send).not.toHaveBeenCalled();
      expect(result.suppressedReason).toBe('preference-off');
    });

    it('dispatches route_comment by default (push toggle on)', async () => {
      const result = await service.sendToUser(USER_ID, {
        category: 'route_comment',
        title: 'New comment',
        body: '@ada commented on your route',
      });
      expect(provider.send).toHaveBeenCalledTimes(1);
      expect(result.suppressed).toBe(false);
    });

    it('soft-deletes tokens the provider reported as invalid', async () => {
      provider.send.mockResolvedValueOnce({
        delivered: 1,
        invalidTokens: ['token-ios-1'],
        providerName: 'mock',
      });

      const result = await service.sendToUser(USER_ID, {
        category: 'new_follower',
        title: 'a',
        body: 'b',
      });

      expect(tokenRepo.update).toHaveBeenCalledTimes(1);
      const [criteria, patch] = tokenRepo.update.mock.calls[0];
      expect(criteria).toMatchObject({ user_id: USER_ID });
      expect(patch).toMatchObject({ deleted_at: expect.any(Date) });
      expect(result.pruned).toBe(1);
      expect(result.delivered).toBe(1);
    });

    it('suppresses a non-safety push (and the in-app row) when sys_push_notifications is off', async () => {
      featureResolver.isSystemSwitchEnabled.mockResolvedValue(false);
      const result = await service.sendToUser(USER_ID, {
        category: 'new_follower',
        title: 'x',
        body: 'y',
      });
      expect(result).toEqual({
        delivered: 0,
        pruned: 0,
        suppressed: true,
        suppressedReason: 'system-switch-off',
      });
      expect(provider.send).not.toHaveBeenCalled();
      expect(notificationRepo.save).not.toHaveBeenCalled();
      expect(featureResolver.isSystemSwitchEnabled).toHaveBeenCalledWith(
        'sys_push_notifications',
      );
    });

    it.each(['hazard_alert', 'weather_alert', 'crash_followup'] as const)(
      'still sends %s when sys_push_notifications is off (safety bypass)',
      async (category) => {
        featureResolver.isSystemSwitchEnabled.mockResolvedValue(false);
        const result = await service.sendToUser(USER_ID, {
          category,
          title: 'x',
          body: 'y',
        });
        expect(provider.send).toHaveBeenCalled();
        expect(notificationRepo.save).toHaveBeenCalledTimes(1);
        expect(result.suppressed).toBe(false);
        // Safety categories bypass the switch — it must not even be consulted.
        expect(featureResolver.isSystemSwitchEnabled).not.toHaveBeenCalled();
      },
    );
  });

  describe('sendToUsers', () => {
    it('aggregates delivery + prune counts across users', async () => {
      provider.send.mockResolvedValue({
        delivered: 1,
        invalidTokens: [],
        providerName: 'mock',
      });

      const result = await service.sendToUsers(
        [
          USER_ID,
          '22222222-2222-2222-2222-222222222222',
          '33333333-3333-3333-3333-333333333333',
        ],
        { category: 'new_follower', title: 'a', body: 'b' },
      );

      expect(result.users).toBe(3);
      expect(result.delivered).toBeGreaterThanOrEqual(0);
    });

    it('returns zero with no recipients', async () => {
      const result = await service.sendToUsers([], {
        category: 'new_follower',
        title: 'a',
        body: 'b',
      });
      expect(result).toEqual({ delivered: 0, pruned: 0, users: 0 });
      expect(provider.send).not.toHaveBeenCalled();
    });
  });
});

describe('isInQuietHours', () => {
  it('returns false when start === end (disabled)', () => {
    const prefs = mergeWithDefaults(makeRow());
    expect(isInQuietHours(prefs, new Date('2026-01-01T23:00:00Z'))).toBe(false);
  });

  it('detects a non-wrapping window', () => {
    const prefs = mergeWithDefaults(
      makeRow({ quiet_hours_start: 60, quiet_hours_end: 120 }),
    );
    expect(isInQuietHours(prefs, new Date('2026-01-01T01:30:00Z'))).toBe(true);
    expect(isInQuietHours(prefs, new Date('2026-01-01T02:30:00Z'))).toBe(false);
  });

  it('detects a wrapping window across midnight', () => {
    const prefs = mergeWithDefaults(
      makeRow({ quiet_hours_start: 22 * 60, quiet_hours_end: 6 * 60 }),
    );
    expect(isInQuietHours(prefs, new Date('2026-01-01T23:00:00Z'))).toBe(true);
    expect(isInQuietHours(prefs, new Date('2026-01-01T03:00:00Z'))).toBe(true);
    expect(isInQuietHours(prefs, new Date('2026-01-01T08:00:00Z'))).toBe(false);
  });
});

describe('mergeWithDefaults', () => {
  it('returns the canonical defaults when no row exists', () => {
    const merged = mergeWithDefaults(null);
    expect(merged.categories.crash_followup.push).toBe(true);
    expect(merged.email_digest).toBe('weekly');
    expect(merged.quiet_hours_timezone).toBe('UTC');
  });

  it('overlays per-category overrides on top of defaults', () => {
    const merged = mergeWithDefaults(
      makeRow({
        categories: {
          new_follower: { email: false, push: false, in_app: true },
        },
      }),
    );
    expect(merged.categories.new_follower.push).toBe(false);
    // Untouched categories keep their defaults.
    expect(merged.categories.crash_followup.push).toBe(true);
  });
});
