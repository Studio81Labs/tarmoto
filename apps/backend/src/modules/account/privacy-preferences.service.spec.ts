import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PrivacyPreferencesRow } from '../../entities/privacy-preferences.entity.js';
import { PrivacyPreferencesService } from './privacy-preferences.service.js';

const USER_ID = '11111111-1111-1111-1111-111111111111';

describe('PrivacyPreferencesService', () => {
  let service: PrivacyPreferencesService;
  let repo: jest.Mocked<
    Pick<Repository<PrivacyPreferencesRow>, 'findOne' | 'create' | 'save'>
  >;

  beforeEach(async () => {
    repo = {
      findOne: jest.fn(),
      create: jest
        .fn()
        .mockImplementation((data: Partial<PrivacyPreferencesRow>) => ({
          ...data,
        })),
      save: jest.fn().mockImplementation((entity: PrivacyPreferencesRow) =>
        Promise.resolve({
          ...entity,
          created_at: new Date('2026-05-01T10:00:00Z'),
          updated_at: new Date('2026-05-01T10:00:00Z'),
        }),
      ),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PrivacyPreferencesService,
        {
          provide: getRepositoryToken(PrivacyPreferencesRow),
          useValue: repo,
        },
      ],
    }).compile();

    service = module.get<PrivacyPreferencesService>(PrivacyPreferencesService);
  });

  describe('get', () => {
    it('returns canonical defaults when no row exists', async () => {
      repo.findOne.mockResolvedValue(null);
      const prefs = await service.get(USER_ID);
      expect(prefs.profile_visibility).toBe('riders-only');
      expect(prefs.default_ride_sharing).toBe('private');
      expect(prefs.road_data_contribution).toBe(true);
      expect(prefs.location_retention).toBe('1year');
      expect(prefs.analytics_consent).toBe(true);
      expect(prefs.personalized_recommendations_consent).toBe(true);
    });

    it('returns the persisted row when present', async () => {
      repo.findOne.mockResolvedValue({
        user_id: USER_ID,
        profile_visibility: 'private',
        default_ride_sharing: 'public',
        road_data_contribution: false,
        location_retention: '3months',
        analytics_consent: false,
        personalized_recommendations_consent: false,
        created_at: new Date(),
        updated_at: new Date(),
      } as PrivacyPreferencesRow);

      const prefs = await service.get(USER_ID);
      expect(prefs.profile_visibility).toBe('private');
      expect(prefs.road_data_contribution).toBe(false);
      expect(prefs.location_retention).toBe('3months');
    });
  });

  describe('update', () => {
    it('creates a fresh row applying the patch and merging with defaults', async () => {
      repo.findOne.mockResolvedValue(null);

      const result = await service.update(USER_ID, {
        profile_visibility: 'private',
        road_data_contribution: false,
      });

      expect(result.profile_visibility).toBe('private');
      expect(result.road_data_contribution).toBe(false);
      // Untouched fields keep their defaults.
      expect(result.default_ride_sharing).toBe('private');
      expect(result.location_retention).toBe('1year');
      expect(result.analytics_consent).toBe(true);
    });

    it('merges updates onto an existing row instead of replacing', async () => {
      const existing = {
        user_id: USER_ID,
        profile_visibility: 'public',
        default_ride_sharing: 'public',
        road_data_contribution: false,
        location_retention: 'forever',
        analytics_consent: false,
        personalized_recommendations_consent: false,
        created_at: new Date(),
        updated_at: new Date(),
      } as PrivacyPreferencesRow;
      repo.findOne.mockResolvedValue(existing);

      const result = await service.update(USER_ID, {
        location_retention: '6months',
      });

      // Only the patched field changed.
      expect(result.location_retention).toBe('6months');
      // Earlier overrides survive.
      expect(result.profile_visibility).toBe('public');
      expect(result.road_data_contribution).toBe(false);
      expect(result.analytics_consent).toBe(false);
    });

    it('coerces boolean toggles defensively (truthy → true, falsy → false)', async () => {
      repo.findOne.mockResolvedValue(null);

      const result = await service.update(USER_ID, {
        // The DTO already restricts to boolean via class-validator, but
        // the service must not silently round-trip e.g. `1`/`0` as
        // truthy strings if a future caller bypasses validation.
        analytics_consent: false,
      });

      expect(result.analytics_consent).toBe(false);
      expect(typeof result.analytics_consent).toBe('boolean');
    });
  });

  describe('loadPreferences', () => {
    it('exposes the same canonical-defaults fallback as get()', async () => {
      repo.findOne.mockResolvedValue(null);
      const prefs = await service.loadPreferences(USER_ID);
      expect(prefs.location_retention).toBe('1year');
    });
  });

  describe('loadPrivateUserIds (#279 / #501)', () => {
    let findMock: jest.Mock;

    beforeEach(() => {
      // Repo isn't typed for the `find` method in the existing
      // fixture — extend it for this suite.
      findMock = jest.fn();
      (repo as unknown as { find: jest.Mock }).find = findMock;
    });

    it('returns the subset of supplied ids whose row is private', async () => {
      findMock.mockResolvedValueOnce([{ user_id: 'a' }, { user_id: 'c' }]);
      const result = await service.loadPrivateUserIds(['a', 'b', 'c']);
      expect(result).toEqual(new Set(['a', 'c']));
    });

    it('dedupes the input before querying', async () => {
      findMock.mockResolvedValueOnce([]);
      await service.loadPrivateUserIds(['a', 'a', 'b']);
      const calls = findMock.mock.calls as Array<
        [{ where: { user_id: { _value: string[] } } }]
      >;
      const where = calls[0]![0].where;
      // typeorm's `In(...)` carries the array on `_value`; assert
      // we deduped before sending.
      expect(where.user_id._value).toHaveLength(2);
      expect(new Set(where.user_id._value)).toEqual(new Set(['a', 'b']));
    });

    it('skips the query and returns an empty set when no ids supplied', async () => {
      const result = await service.loadPrivateUserIds([]);
      expect(result).toEqual(new Set());
      expect(findMock).not.toHaveBeenCalled();
    });

    it('fails closed: a transient DB error returns every supplied id', async () => {
      // Cursor Bugbot review on PR #513 — better to over-mask once
      // than leak a private rider's identity on a lookup hiccup.
      findMock.mockRejectedValueOnce(new Error('db down'));
      const result = await service.loadPrivateUserIds(['a', 'b']);
      expect(result).toEqual(new Set(['a', 'b']));
    });
  });
});
