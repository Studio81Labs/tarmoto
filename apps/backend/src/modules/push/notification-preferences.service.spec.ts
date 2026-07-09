import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { NotificationPreferencesRow } from '../../entities/notification-preferences.entity.js';
import { NotificationPreferencesService } from './notification-preferences.service.js';

const USER_ID = '11111111-1111-1111-1111-111111111111';

describe('NotificationPreferencesService', () => {
  let service: NotificationPreferencesService;
  let repo: jest.Mocked<
    Pick<
      Repository<NotificationPreferencesRow>,
      'findOne' | 'create' | 'save' | 'query'
    >
  >;

  beforeEach(async () => {
    repo = {
      findOne: jest.fn(),
      query: jest.fn().mockResolvedValue([]),
      create: jest
        .fn()
        .mockImplementation((data: Partial<NotificationPreferencesRow>) => ({
          ...data,
        })),
      save: jest.fn().mockImplementation((entity: NotificationPreferencesRow) =>
        Promise.resolve({
          ...entity,
          created_at: new Date('2026-04-25T10:00:00Z'),
          updated_at: new Date('2026-04-25T10:00:00Z'),
        }),
      ),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationPreferencesService,
        {
          provide: getRepositoryToken(NotificationPreferencesRow),
          useValue: repo,
        },
      ],
    }).compile();

    service = module.get<NotificationPreferencesService>(
      NotificationPreferencesService,
    );
  });

  describe('get', () => {
    it('returns canonical defaults when no row exists', async () => {
      repo.findOne.mockResolvedValue(null);
      const prefs = await service.get(USER_ID);
      expect(prefs.email_digest).toBe('weekly');
      expect(prefs.categories.crash_followup.push).toBe(true);
      expect(prefs.quiet_hours_start).toBe(0);
    });
  });

  describe('update', () => {
    it('creates a fresh row applying the patch', async () => {
      repo.findOne.mockResolvedValue(null);

      const result = await service.update(USER_ID, {
        marketing_emails: true,
        categories: {
          new_follower: { email: false, push: false, in_app: false },
        },
      });

      expect(result.marketing_emails).toBe(true);
      expect(result.categories.new_follower.push).toBe(false);
      // Untouched categories retain their defaults.
      expect(result.categories.crash_followup.push).toBe(true);
    });

    it('merges updates onto an existing row instead of replacing', async () => {
      const existing = {
        user_id: USER_ID,
        email_digest: 'never' as const,
        marketing_emails: false,
        quiet_hours_start: 0,
        quiet_hours_end: 0,
        quiet_hours_timezone: 'UTC',
        categories: {
          new_follower: { email: false, push: false, in_app: true },
        },
        created_at: new Date(),
        updated_at: new Date(),
      } as unknown as NotificationPreferencesRow;
      repo.findOne.mockResolvedValue(existing);

      const result = await service.update(USER_ID, {
        quiet_hours_start: 22 * 60,
        quiet_hours_end: 6 * 60,
      });

      expect(result.email_digest).toBe('never');
      // The earlier override sticks because we only patched quiet hours.
      expect(result.categories.new_follower.push).toBe(false);
      expect(result.quiet_hours_start).toBe(22 * 60);
      expect(result.quiet_hours_end).toBe(6 * 60);
    });

    it('writes a timezone-only patch atomically, never a full read-modify-write', async () => {
      // The mobile/companion background timezone sync sends only the timezone.
      // If it took the read-modify-write path it could clobber a concurrent full
      // save's email_digest/categories, so it must upsert just that column.
      repo.findOne.mockResolvedValue({
        user_id: USER_ID,
        email_digest: 'never' as const,
        marketing_emails: false,
        quiet_hours_start: 0,
        quiet_hours_end: 0,
        quiet_hours_timezone: 'Europe/Prague',
        categories: {},
        created_at: new Date(),
        updated_at: new Date(),
      } as unknown as NotificationPreferencesRow);

      const result = await service.update(USER_ID, {
        quiet_hours_timezone: 'Europe/Prague',
      });

      // No full-row save — the atomic upsert path only.
      expect(repo.save).not.toHaveBeenCalled();
      expect(repo.query).toHaveBeenCalledTimes(1);
      const [sql, params] = repo.query.mock.calls[0] as [string, unknown[]];
      expect(sql).toMatch(/ON CONFLICT \(user_id\) DO UPDATE/);
      expect(sql).toMatch(
        /quiet_hours_timezone = EXCLUDED\.quiet_hours_timezone/,
      );
      expect(params).toEqual([USER_ID, 'Europe/Prague']);
      // A concurrent save's email_digest is untouched by the tz-only write.
      expect(result.email_digest).toBe('never');
      expect(result.quiet_hours_timezone).toBe('Europe/Prague');
    });
  });
});
