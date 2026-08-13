/* eslint-disable @typescript-eslint/no-unsafe-return, @typescript-eslint/unbound-method */
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Logger, NotFoundException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { Readable } from 'node:stream';
import { plainToInstance } from 'class-transformer';
import {
  DEFAULT_PRIVACY_PREFERENCES,
  buildFeatureSnapshot,
} from '@tarmoto/shared';
import { UsersService } from './users.service.js';
import { UpdateProfileDto } from './dto/update-profile.dto.js';
import { Ride } from '../../entities/ride.entity.js';
import { SharedRide } from '../../entities/shared-ride.entity.js';
import { User } from '../../entities/user.entity.js';
import { UserBadge } from '../../entities/user-badge.entity.js';
import { UserContact } from '../../entities/user-contact.entity.js';
import { UserFollow } from '../../entities/user-follow.entity.js';
import { OBJECT_STORAGE } from '../storage/storage.tokens.js';
import type { ObjectStorage } from '../storage/object-storage.interface.js';
import { PrivacyPreferencesService } from '../account/privacy-preferences.service.js';
import { BadgesService } from '../badges/badges.service.js';
import { FeatureResolver } from '../features/feature-resolver.service.js';

describe('UsersService', () => {
  let service: UsersService;
  let userRepo: Partial<jest.Mocked<Repository<User>>> & {
    createQueryBuilder: jest.Mock;
  };
  let preferencesQb: {
    update: jest.Mock;
    set: jest.Mock;
    where: jest.Mock;
    setParameter: jest.Mock;
    execute: jest.Mock;
  };
  let contactRepo: Partial<jest.Mocked<Repository<UserContact>>>;
  let userFollowRepo: Partial<jest.Mocked<Repository<UserFollow>>>;
  let userBadgeRepo: Partial<jest.Mocked<Repository<UserBadge>>>;
  let rideRepo: Partial<jest.Mocked<Repository<Ride>>> & {
    createQueryBuilder: jest.Mock;
  };
  let rideHoursQb: {
    select: jest.Mock;
    where: jest.Mock;
    andWhere: jest.Mock;
    getRawOne: jest.Mock;
  };
  let sharedRideRepo: { count: jest.Mock };
  let storage: jest.Mocked<ObjectStorage>;
  let privacy: { loadPreferences: jest.Mock };
  let badgesService: { computeStats: jest.Mock };
  let featureResolver: {
    resolveEntitlementsForLoadedUser: jest.Mock;
    resolveForUser: jest.Mock;
    isSystemSwitchEnabled: jest.Mock;
  };

  // Factory, not a shared instance — updateProfile mutates the entity it
  // loads via findOne, so any two tests sharing the same object would leak
  // state (and make ordering matter).
  const buildMockUser = (): User =>
    ({
      id: 'user-1',
      email: 'rider@tarmoto.app',
      display_name: 'TestRider',
      phone: null,
      avatar_url: null,
      bio: null,
      language: 'en',
      home_region: null,
      home_location: null,
      work_location: null,
      preferences: { units: 'metric' },
      subscription_tier: 'free',
      created_at: new Date('2026-04-13T10:00:00Z'),
      updated_at: new Date('2026-04-13T10:00:00Z'),
    }) as unknown as User;

  const mockFeatureSnapshot = buildFeatureSnapshot('free', {}, {});
  const mockEntitlements = {
    features: mockFeatureSnapshot,
    limits: { max_active_trips: null },
  };

  const mockContact = {
    id: 'contact-1',
    user_id: 'user-1',
    name: 'Jane Doe',
    phone: '+420123456789',
    is_emergency: true,
    created_at: new Date('2026-04-13T10:00:00Z'),
  } as UserContact;

  beforeEach(async () => {
    jest.clearAllMocks();

    storage = {
      put: jest.fn().mockResolvedValue({ byteSize: 12 }),
      read: jest.fn().mockResolvedValue(Readable.from(Buffer.from(''))),
      delete: jest.fn().mockResolvedValue(undefined),
      exists: jest.fn().mockResolvedValue(true),
      // Default: build a relative LocalStorage-style URL from the
      // key so tests can assert on either the key or the URL.
      publicUrl: jest
        .fn()
        .mockImplementation((key: string) => `/uploads/${key}`),
      signedUrl: jest
        .fn()
        .mockImplementation((key: string) =>
          Promise.resolve(`/uploads/${key}`),
        ),
    };

    preferencesQb = {
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      setParameter: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    userRepo = {
      findOne: jest
        .fn()
        .mockImplementation(() => Promise.resolve(buildMockUser())),
      save: jest.fn().mockImplementation((entity) => Promise.resolve(entity)),
      query: jest.fn(),
      createQueryBuilder: jest.fn(() => preferencesQb),
    } as unknown as Partial<jest.Mocked<Repository<User>>> & {
      createQueryBuilder: jest.Mock;
    };
    contactRepo = {
      find: jest.fn().mockResolvedValue([mockContact]),
      findOne: jest.fn().mockResolvedValue(mockContact),
      create: jest
        .fn()
        .mockImplementation((data) => ({ ...mockContact, ...data })),
      save: jest.fn().mockImplementation((entity) => Promise.resolve(entity)),
      remove: jest.fn().mockResolvedValue(undefined),
    };
    userFollowRepo = {
      count: jest.fn().mockResolvedValue(0),
      findOne: jest.fn().mockResolvedValue(null),
    };
    userBadgeRepo = {
      count: jest.fn().mockResolvedValue(0),
    };
    rideHoursQb = {
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getRawOne: jest.fn().mockResolvedValue({ hours: '0' }),
    };
    rideRepo = {
      createQueryBuilder: jest.fn(() => rideHoursQb),
    } as unknown as Partial<jest.Mocked<Repository<Ride>>> & {
      createQueryBuilder: jest.Mock;
    };
    sharedRideRepo = {
      count: jest.fn().mockResolvedValue(0),
    };
    privacy = {
      loadPreferences: jest
        .fn()
        .mockResolvedValue({ ...DEFAULT_PRIVACY_PREFERENCES }),
    };
    badgesService = {
      computeStats: jest.fn().mockResolvedValue({
        total_distance: 0,
        single_ride: 0,
        ride_count: 0,
        roads_discovered: 0,
        reviews_written: 0,
        hazards_reported: 0,
        rides_shared: 0,
      }),
    };
    featureResolver = {
      resolveEntitlementsForLoadedUser: jest
        .fn()
        .mockResolvedValue(mockEntitlements),
      // Default: entitled to advanced_ride_stats, so the existing lean-angle
      // assertions see the real values. The gating tests override this.
      resolveForUser: jest
        .fn()
        .mockResolvedValue({ advanced_ride_stats: true }),
      isSystemSwitchEnabled: jest.fn().mockResolvedValue(true),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: getRepositoryToken(User), useValue: userRepo },
        { provide: getRepositoryToken(UserContact), useValue: contactRepo },
        { provide: getRepositoryToken(UserFollow), useValue: userFollowRepo },
        { provide: getRepositoryToken(UserBadge), useValue: userBadgeRepo },
        { provide: getRepositoryToken(Ride), useValue: rideRepo },
        { provide: getRepositoryToken(SharedRide), useValue: sharedRideRepo },
        { provide: OBJECT_STORAGE, useValue: storage },
        { provide: PrivacyPreferencesService, useValue: privacy },
        { provide: BadgesService, useValue: badgesService },
        { provide: FeatureResolver, useValue: featureResolver },
      ],
    }).compile();

    service = module.get<UsersService>(UsersService);
  });

  describe('getProfile', () => {
    it('should return user profile', async () => {
      const result = await service.getProfile('user-1');

      expect(result.id).toBe('user-1');
      expect(result.email).toBe('rider@tarmoto.app');
      expect(result.display_name).toBe('TestRider');
      expect(result.home_location).toBeNull();
      expect(result.language).toBe('en');
      expect(result.limits).toEqual({ max_active_trips: null });
    });

    it('serves the STORE tier the activation poll waits for', async () => {
      // The mobile purchase flow polls /users/me until subscription_tier
      // reflects the purchase. A store claim writes only a chain plus the
      // rollup, so a regression in loadStoreRollup or the mapper's new argument
      // returns `free` here — and the purchase looks like it failed while the
      // backend has already granted the features. The pure resolveBilledTier
      // tests stay green through exactly that break, which is why this asserts
      // it through the service.
      userRepo.findOne!.mockReset();
      userRepo.findOne!.mockResolvedValue({
        ...buildMockUser(),
        // Stripe-owned column unchanged by a store purchase.
        subscription_tier: 'free',
        store_subscription_tier: 'pro',
        store_subscription_tier_expires_at: new Date(Date.now() + 86_400_000),
      });

      const result = await service.getProfile('user-1');

      expect(result.subscription_tier).toBe('pro');
    });

    it('reports free again once the store rollup has lapsed', async () => {
      // Same expiry as enforcement: reporting paid here after the guards stop
      // honouring it is the told-Pro-then-denied-Pro split, via the projection.
      userRepo.findOne!.mockReset();
      userRepo.findOne!.mockResolvedValue({
        ...buildMockUser(),
        subscription_tier: 'free',
        store_subscription_tier: 'pro',
        store_subscription_tier_expires_at: new Date(Date.now() - 1),
      });

      const result = await service.getProfile('user-1');

      expect(result.subscription_tier).toBe('free');
    });

    it('should throw NotFoundException for missing user', async () => {
      userRepo.findOne!.mockResolvedValueOnce(null);

      await expect(service.getProfile('missing')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should convert geometry Point to lat/lng', async () => {
      userRepo.findOne!.mockResolvedValueOnce({
        ...buildMockUser(),
        home_location: { type: 'Point', coordinates: [16.75, 49.1] },
      });

      const result = await service.getProfile('user-1');

      expect(result.home_location).toEqual({ lat: 49.1, lng: 16.75 });
    });
  });

  describe('getPublicProfile', () => {
    it('returns counts and is_following=true when viewer follows target', async () => {
      userFollowRepo.count!.mockResolvedValueOnce(7).mockResolvedValueOnce(3);
      userFollowRepo.findOne!.mockResolvedValueOnce({
        follower_id: 'viewer-1',
      } as UserFollow);

      const result = await service.getPublicProfile('viewer-1', 'user-1');

      expect(result).toEqual({
        id: 'user-1',
        display_name: 'TestRider',
        avatar_url: null,
        bio: null,
        home_region: null,
        created_at: '2026-04-13T10:00:00.000Z',
        follower_count: 7,
        following_count: 3,
        total_distance_km: 0,
        shared_ride_count: 0,
        is_following: true,
        follows_you: false,
        is_self: false,
      });
    });

    it('returns follows_you=true when the target follows the viewer back', async () => {
      userFollowRepo.count!.mockResolvedValueOnce(1).mockResolvedValueOnce(1);
      // First findOne is the viewer→target edge (is_following), second is the
      // target→viewer edge (follows_you).
      userFollowRepo
        .findOne!.mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ follower_id: 'user-1' } as UserFollow);

      const result = await service.getPublicProfile('viewer-1', 'user-1');

      expect(result.is_following).toBe(false);
      expect(result.follows_you).toBe(true);
    });

    it('surfaces lifetime distance and public-share count', async () => {
      // Distance is the rounded SUM of completed-ride km; the share count is
      // the rider's public-share total (viewer-independent).
      rideHoursQb.getRawOne.mockResolvedValueOnce({ km: '7733.4' });
      sharedRideRepo.count.mockResolvedValueOnce(5);

      const result = await service.getPublicProfile('viewer-1', 'user-1');

      expect(result.total_distance_km).toBe(7733);
      expect(result.shared_ride_count).toBe(5);
      expect(sharedRideRepo.count).toHaveBeenCalledWith({
        where: { user_id: 'user-1', is_public: true },
      });
    });

    it('returns is_following=false when viewer does not follow target', async () => {
      userFollowRepo.count!.mockResolvedValueOnce(2).mockResolvedValueOnce(0);
      userFollowRepo.findOne!.mockResolvedValueOnce(null);

      const result = await service.getPublicProfile('viewer-1', 'user-1');

      expect(result.is_following).toBe(false);
      expect(result.is_self).toBe(false);
      expect(result.follower_count).toBe(2);
      expect(result.following_count).toBe(0);
    });

    it('returns is_following=null and is_self=true when viewing own profile', async () => {
      userFollowRepo.count!.mockResolvedValueOnce(5).mockResolvedValueOnce(11);

      const result = await service.getPublicProfile('user-1', 'user-1');

      expect(result.is_following).toBeNull();
      expect(result.follows_you).toBeNull();
      expect(result.is_self).toBe(true);
      // Self check short-circuits both follow lookups so we don't waste queries.
      expect(userFollowRepo.findOne).not.toHaveBeenCalled();
    });

    it('throws NotFoundException for missing user', async () => {
      userRepo.findOne!.mockResolvedValueOnce(null);

      await expect(
        service.getPublicProfile('viewer-1', 'missing'),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws NotFoundException for soft-deleted user', async () => {
      userRepo.findOne!.mockResolvedValueOnce({
        ...buildMockUser(),
        deleted_at: new Date('2026-04-30T10:00:00Z'),
      });

      await expect(
        service.getPublicProfile('viewer-1', 'user-1'),
      ).rejects.toThrow(NotFoundException);
    });

    it('hides private profiles from non-self viewers (#279)', async () => {
      privacy.loadPreferences.mockResolvedValueOnce({
        ...DEFAULT_PRIVACY_PREFERENCES,
        profile_visibility: 'private',
      });

      await expect(
        service.getPublicProfile('viewer-1', 'user-1'),
      ).rejects.toThrow(NotFoundException);
    });

    it('shows private profile to the owner themselves', async () => {
      privacy.loadPreferences.mockResolvedValueOnce({
        ...DEFAULT_PRIVACY_PREFERENCES,
        profile_visibility: 'private',
      });
      userFollowRepo.count!.mockResolvedValueOnce(0).mockResolvedValueOnce(0);

      const result = await service.getPublicProfile('user-1', 'user-1');

      expect(result.is_self).toBe(true);
      // Self lookup short-circuits before the privacy check, so the
      // privacy mock isn't even consulted — the call count is zero.
      expect(privacy.loadPreferences).not.toHaveBeenCalled();
    });

    it('shows public profile to other riders', async () => {
      privacy.loadPreferences.mockResolvedValueOnce({
        ...DEFAULT_PRIVACY_PREFERENCES,
        profile_visibility: 'public',
      });
      userFollowRepo.count!.mockResolvedValueOnce(1).mockResolvedValueOnce(2);

      const result = await service.getPublicProfile('viewer-1', 'user-1');

      expect(result.id).toBe('user-1');
      expect(privacy.loadPreferences).toHaveBeenCalledWith('user-1');
    });
  });

  describe('getMeProfile', () => {
    it('returns joined_at, total_hours, and basic counts for the rider', async () => {
      badgesService.computeStats.mockResolvedValueOnce({
        total_distance: 1234.5,
        single_ride: 412,
        ride_count: 18,
        roads_discovered: 73,
        reviews_written: 4,
        hazards_reported: 6,
        rides_shared: 2,
      });
      rideHoursQb.getRawOne.mockResolvedValueOnce({ hours: '42.5' });
      userFollowRepo
        .count!.mockResolvedValueOnce(11) // followers (following_id = userId)
        .mockResolvedValueOnce(7); // following (follower_id = userId)
      userBadgeRepo.count!.mockResolvedValueOnce(5);

      const result = await service.getMeProfile('user-1');

      expect(result).toEqual({
        joined_at: '2026-04-13T10:00:00.000Z',
        total_hours: 42.5,
        total_rides: 18,
        total_distance_km: 1234.5,
        roads_discovered: 73,
        hazards_reported: 6,
        follower_count: 11,
        following_count: 7,
        badges_earned: 5,
      });
      expect(badgesService.computeStats).toHaveBeenCalledWith('user-1');
      // Followers count uses the target as `following_id`; the inverse
      // (`follower_id`) gives the following count. Lock the two queries
      // in this order so a future refactor can't silently swap them.
      expect(userFollowRepo.count).toHaveBeenNthCalledWith(1, {
        where: { following_id: 'user-1' },
      });
      expect(userFollowRepo.count).toHaveBeenNthCalledWith(2, {
        where: { follower_id: 'user-1' },
      });
      expect(userBadgeRepo.count).toHaveBeenCalledWith({
        where: { user_id: 'user-1' },
      });
    });

    it('coerces empty aggregations to numeric zero defaults', async () => {
      // Brand-new rider: no rides, no follows, no badges. The hours query
      // returns `'0'` from `COALESCE(SUM(...), 0)` and we must surface
      // that as a number, not a string, so the wire matches `MeProfile`.
      rideHoursQb.getRawOne.mockResolvedValueOnce({ hours: '0' });

      const result = await service.getMeProfile('user-1');

      expect(result.total_hours).toBe(0);
      expect(result.total_rides).toBe(0);
      expect(result.total_distance_km).toBe(0);
      expect(result.roads_discovered).toBe(0);
      expect(result.hazards_reported).toBe(0);
      expect(result.follower_count).toBe(0);
      expect(result.following_count).toBe(0);
      expect(result.badges_earned).toBe(0);
    });

    it('only counts hours from completed rides with an end timestamp', async () => {
      // A ride still in progress (`ended_at IS NULL`) would yield NULL
      // from `EXTRACT(EPOCH ...)` and pull the SUM down to NULL — guard
      // against that with the `ended_at IS NOT NULL` filter.
      await service.getMeProfile('user-1');

      expect(rideHoursQb.where).toHaveBeenCalledWith('r.user_id = :userId', {
        userId: 'user-1',
      });
      const andWhereCalls = (
        rideHoursQb.andWhere.mock.calls as ReadonlyArray<readonly unknown[]>
      ).map((args) => args[0] as string);
      expect(andWhereCalls).toEqual(
        expect.arrayContaining([
          "r.status = 'completed'",
          'r.ended_at IS NOT NULL',
        ]),
      );
    });

    it('throws NotFoundException for missing user', async () => {
      userRepo.findOne!.mockResolvedValueOnce(null);

      await expect(service.getMeProfile('missing')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('zeroes badges_earned but keeps other stats when sys_gamification is off', async () => {
      featureResolver.isSystemSwitchEnabled.mockResolvedValue(false);
      badgesService.computeStats.mockResolvedValueOnce({
        total_distance: 1234.5,
        single_ride: 412,
        ride_count: 18,
        roads_discovered: 73,
        reviews_written: 4,
        hazards_reported: 6,
        rides_shared: 2,
      });
      rideHoursQb.getRawOne.mockResolvedValueOnce({ hours: '42.5' });
      userBadgeRepo.count!.mockResolvedValueOnce(5);

      const result = await service.getMeProfile('user-1');

      expect(result.badges_earned).toBe(0); // gamification field hidden
      expect(result.total_rides).toBe(18); // generic stat stays
      expect(result.total_distance_km).toBe(1234.5);
      expect(featureResolver.isSystemSwitchEnabled).toHaveBeenCalledWith(
        'sys_gamification',
      );
      // The switch is resolved BEFORE the batch, so the user_badges query is
      // SKIPPED entirely (not run-then-masked) — the profile degrades
      // gracefully even if that subsystem is failing/slow. The mock above
      // returns 5, so a 0 result proves the value came from the skip, not a query.
      expect(userBadgeRepo.count).not.toHaveBeenCalled();
    });
  });

  describe('getMonthlyStats', () => {
    // `getMonthlyStats` issues four independent query builders, so unlike
    // `getMeProfile` (one shared builder) the mock must hand back a fresh
    // chainable builder per `createQueryBuilder` call and resolve the
    // terminal `getRawMany`/`getRawOne` in issue order.
    // The service now buckets via `to_char(..., 'YYYY-MM')`, so the mock
    // months rows are keyed by the UTC 'YYYY-MM' string (not an ISO date).
    const utcMonthKey = (offsetMonths: number): string => {
      const now = new Date();
      const d = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offsetMonths, 1),
      );
      return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    };

    const buildQb = (terminal: 'getRawMany' | 'getRawOne', value: unknown) => {
      const qb: Record<string, jest.Mock> = {
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        innerJoin: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
      };
      qb[terminal] = jest.fn().mockResolvedValue(value);
      return qb;
    };

    it('returns current + previous month aggregates and the max-lean ride', async () => {
      const builders = [
        // 1) months getRawMany
        buildQb('getRawMany', [
          { month: utcMonthKey(0), km: '1284', hours: '32.4' },
          { month: utcMonthKey(-1), km: '1088', hours: '28.6' },
        ]),
        // 2) lean getRawOne
        buildQb('getRawOne', {
          lean: 41,
          name: 'Passo Gavia',
          started_at: new Date('2026-06-01T08:00:00Z'),
        }),
        // 3) roads getRawOne
        buildQb('getRawOne', { roads: '47' }),
        // 4) sync getRawOne
        buildQb('getRawOne', { synced: new Date('2026-06-02T19:30:00Z') }),
      ];
      let call = 0;
      rideRepo.createQueryBuilder.mockImplementation(() => builders[call++]);

      const result = await service.getMonthlyStats('user-1');

      expect(result.this_month_km).toBe(1284);
      expect(result.prev_month_km).toBe(1088);
      expect(result.ride_hours).toBe(32.4);
      expect(result.prev_ride_hours).toBe(28.6);
      expect(result.new_roads).toBe(47);
      expect(result.max_lean_deg).toBe(41);
      expect(result.max_lean_ride_name).toBe('Passo Gavia');
      expect(result.max_lean_at).toBe('2026-06-01T08:00:00.000Z');
      expect(typeof result.last_synced_at).toBe('string');
      expect(rideRepo.createQueryBuilder).toHaveBeenCalledTimes(4);
    });

    it('caps the month-scoped queries at ride end time, not the month end', async () => {
      const builders = [
        buildQb('getRawMany', []),
        buildQb('getRawOne', undefined),
        buildQb('getRawOne', { roads: '0' }),
        buildQb('getRawOne', { synced: null }),
      ];
      let call = 0;
      rideRepo.createQueryBuilder.mockImplementation(() => builders[call++]);

      await service.getMonthlyStats('user-1');

      // The months, lean and roads builders must each bound on
      // `ended_at <= now()` so a ride that ends in the future (e.g. a
      // clock-skewed GPX) can't inflate the KPIs — and must NOT use the
      // looser `started_at <= now` cap or the next-month boundary.
      for (const idx of [0, 1, 2]) {
        const predicates = builders[idx].andWhere.mock.calls.map(
          (c: unknown[]) => c[0] as string,
        );
        expect(predicates).toContainEqual(
          expect.stringContaining(
            "(r.ended_at AT TIME ZONE 'UTC') <= (now() AT TIME ZONE 'UTC')",
          ),
        );
        expect(predicates).not.toContainEqual(
          expect.stringContaining("(r.started_at AT TIME ZONE 'UTC') <= "),
        );
        expect(predicates).not.toContainEqual(
          expect.stringContaining("+ interval '1 month'"),
        );
      }
    });

    it('coerces empty aggregations to numeric/null defaults', async () => {
      const builders = [
        buildQb('getRawMany', []),
        buildQb('getRawOne', undefined),
        buildQb('getRawOne', { roads: '0' }),
        buildQb('getRawOne', { synced: null }),
      ];
      let call = 0;
      rideRepo.createQueryBuilder.mockImplementation(() => builders[call++]);

      const result = await service.getMonthlyStats('user-1');

      expect(result.this_month_km).toBe(0);
      expect(result.prev_month_km).toBe(0);
      expect(result.ride_hours).toBe(0);
      expect(result.prev_ride_hours).toBe(0);
      expect(result.new_roads).toBe(0);
      expect(result.max_lean_deg).toBeNull();
      expect(result.max_lean_ride_name).toBeNull();
      expect(result.max_lean_at).toBeNull();
      expect(result.last_synced_at).toBeNull();
    });

    it('nulls the max-lean fields when advanced_ride_stats is not entitled', async () => {
      featureResolver.resolveForUser.mockResolvedValue({
        advanced_ride_stats: false,
      });
      const builders = [
        buildQb('getRawMany', [
          { month: '2026-06', km: '1284', hours: '32.4' },
        ]),
        // A real lean row exists — the gate, not the data, must null it out.
        buildQb('getRawOne', {
          lean: 41,
          name: 'Passo Gavia',
          started_at: new Date('2026-06-01T08:00:00Z'),
        }),
        buildQb('getRawOne', { roads: '47' }),
        buildQb('getRawOne', { synced: new Date('2026-06-02T19:30:00Z') }),
      ];
      let call = 0;
      rideRepo.createQueryBuilder.mockImplementation(() => builders[call++]);

      const result = await service.getMonthlyStats('user-1');

      // Non-lean KPIs are unaffected by the advanced-stats gate.
      expect(result.new_roads).toBe(47);
      // Lean is a Premium-only stat — withheld despite the row being present.
      expect(result.max_lean_deg).toBeNull();
      expect(result.max_lean_ride_name).toBeNull();
      expect(result.max_lean_at).toBeNull();
    });
  });

  describe('getContribution', () => {
    it('returns km/segments + the regional rank for a contributor', async () => {
      (userRepo.query as jest.Mock)
        .mockResolvedValueOnce([{ segments: 12, km: '4284.4' }])
        .mockResolvedValueOnce([{ rank: 3, total: 40, behind: 37 }]);
      userRepo.findOne!.mockResolvedValueOnce({
        ...buildMockUser(),
        home_region: 'Lombardy',
      });

      const result = await service.getContribution('user-1');

      expect(result).toMatchObject({
        km_mapped: 4284.4,
        segments_mapped: 12,
        home_region: 'Lombardy',
        rank_in_region: 3,
        region_rider_count: 40,
        region_riders_behind: 37,
        // ceil(3 / 40 * 100) = 8 → "Top 8%"
        percentile: 8,
      });
      expect(userRepo.query).toHaveBeenCalledTimes(2);
    });

    it('reports region_riders_behind = 0 for a last-place rider tied behind others', async () => {
      // DENSE_RANK gives rank 2 of 3 when two riders tie above the last one;
      // `behind = 0` is what tells the client the rider is genuinely last.
      (userRepo.query as jest.Mock)
        .mockResolvedValueOnce([{ segments: 4, km: '40' }])
        .mockResolvedValueOnce([{ rank: 2, total: 3, behind: 0 }]);
      userRepo.findOne!.mockResolvedValueOnce({
        ...buildMockUser(),
        home_region: 'Lombardy',
      });

      const result = await service.getContribution('user-1');

      expect(result.region_riders_behind).toBe(0);
      expect(result.rank_in_region).toBe(2);
      expect(result.region_rider_count).toBe(3);
    });

    it('skips ranking when the rider has no home region', async () => {
      (userRepo.query as jest.Mock).mockResolvedValueOnce([
        { segments: 5, km: '120' },
      ]);
      userRepo.findOne!.mockResolvedValueOnce({
        ...buildMockUser(),
        home_region: null,
      });

      const result = await service.getContribution('user-1');

      expect(result.km_mapped).toBe(120);
      expect(result.rank_in_region).toBeNull();
      expect(result.region_rider_count).toBeNull();
      expect(result.percentile).toBeNull();
      // Only the totals query ran — no rank query.
      expect(userRepo.query).toHaveBeenCalledTimes(1);
    });

    it('skips ranking when the rider has contributed nothing', async () => {
      (userRepo.query as jest.Mock).mockResolvedValueOnce([
        { segments: 0, km: '0' },
      ]);
      userRepo.findOne!.mockResolvedValueOnce({
        ...buildMockUser(),
        home_region: 'Lombardy',
      });

      const result = await service.getContribution('user-1');

      expect(result.segments_mapped).toBe(0);
      expect(result.rank_in_region).toBeNull();
      expect(result.percentile).toBeNull();
      expect(userRepo.query).toHaveBeenCalledTimes(1);
    });
  });

  describe('updateProfile', () => {
    it('should update display_name', async () => {
      const result = await service.updateProfile('user-1', {
        display_name: 'NewName',
      });

      expect(userRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ display_name: 'NewName' }),
      );
      expect(result.display_name).toBe('NewName');
      expect(result.limits).toEqual({ max_active_trips: null });
    });

    it('should update phone', async () => {
      await service.updateProfile('user-1', { phone: '+420999888777' });

      expect(userRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ phone: '+420999888777' }),
      );
    });

    it('should update and persist language', async () => {
      const result = await service.updateProfile('user-1', {
        language: 'en',
      });

      expect(userRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ language: 'en' }),
      );
      expect(result.language).toBe('en');
    });

    it('should not assign language when the dto sends null (NOT NULL column guard)', async () => {
      // DTO validation should already reject `null` (see
      // update-profile.dto.spec.ts), but the service guard is
      // defense-in-depth: `language` is NOT NULL, so if a `null` ever
      // reached here the naive `!== undefined` check would still assign
      // it and crash the save. `!= null` must skip it, leaving the
      // fixture's existing value untouched.
      await service.updateProfile('user-1', { language: null as never });

      const saved = userRepo.save!.mock.calls[0][0] as Record<string, unknown>;
      expect(saved.language).toBe('en');
    });

    it('should convert home_location to Point geometry', async () => {
      await service.updateProfile('user-1', {
        home_location: { lat: 49.1, lng: 16.75 },
      });

      expect(userRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          home_location: {
            type: 'Point',
            coordinates: [16.75, 49.1],
          },
        }),
      );
    });

    it('should clear home_location when null is sent', async () => {
      await service.updateProfile('user-1', {
        home_location: null as never,
      });

      expect(userRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ home_location: null }),
      );
    });

    it('should clear work_location when null is sent', async () => {
      await service.updateProfile('user-1', {
        work_location: null as never,
      });

      expect(userRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ work_location: null }),
      );
    });

    it('should merge preferences atomically in the database, never via save()', async () => {
      // save() must not carry the preferences column at all — a whole-object
      // snapshot save is exactly the lost-update race the atomic merge
      // exists to prevent (a concurrent writer's key would be silently
      // overwritten by this request's stale read). Capture the column AT
      // CALL TIME: jest records arguments by reference, and the service
      // legitimately restores a merged view onto the same entity afterwards
      // for the response, which would defeat a toHaveBeenCalledWith check.
      let preferencesAtSaveTime: unknown = 'not-captured';
      userRepo.save!.mockImplementationOnce((entity) => {
        // save()'s overloaded mock types the param as `any`; narrow it.
        preferencesAtSaveTime = (entity as User).preferences;
        return Promise.resolve(entity as User);
      });

      const result = await service.updateProfile('user-1', {
        preferences: { daily_km: 300 },
      });

      expect(preferencesAtSaveTime).toBeUndefined();
      expect(preferencesQb.set).toHaveBeenCalledWith({
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- expect.any() returns any; asymmetric matcher is intentional
        preferences: expect.any(Function),
      });
      expect(preferencesQb.setParameter).toHaveBeenCalledWith(
        'prefsPatch',
        JSON.stringify({ daily_km: 300 }),
      );
      expect(preferencesQb.where).toHaveBeenCalledWith('id = :id', {
        id: 'user-1',
      });
      expect(preferencesQb.execute).toHaveBeenCalledTimes(1);
      // The response reflects this request's merged view.
      expect(result.preferences).toEqual({ units: 'metric', daily_km: 300 });
    });

    it('skips the atomic merge entirely when no preferences are patched', async () => {
      await service.updateProfile('user-1', { bio: 'No prefs touched.' });

      expect(preferencesQb.execute).not.toHaveBeenCalled();
    });

    it('should preserve unsent preference keys when the dto is built via plainToInstance', async () => {
      // Regression: with the backend's ES2024 target, `useDefineForClassFields`
      // defaults to true, so `plainToInstance` materializes EVERY declared
      // optional field of `UserPreferencesDto` as an own `undefined` property
      // on the instance — not just the two keys the caller actually sent. A
      // hand-built plain object literal (as above) does NOT have those extra
      // own-undefined keys and would NOT reproduce the bug; only a dto built
      // through `plainToInstance` does. Naively spreading that dto over the
      // stored preferences would overwrite `units` and `daily_km` with
      // `undefined`, which JSONB then drops on save.
      userRepo.findOne!.mockResolvedValueOnce({
        ...buildMockUser(),
        preferences: { units: 'imperial', daily_km: 250 },
      });
      const dto = plainToInstance(UpdateProfileDto, {
        preferences: {
          format_locale: 'cs-CZ',
          timezone: 'Europe/Prague',
        },
      });

      const result = await service.updateProfile('user-1', dto);

      // The own-undefined dto keys must be stripped from the atomic patch —
      // a JSONB `||` with undefined-turned-null entries would null out the
      // stored `units`/`daily_km` just like the old spread did.
      expect(preferencesQb.setParameter).toHaveBeenCalledWith(
        'prefsPatch',
        JSON.stringify({
          format_locale: 'cs-CZ',
          timezone: 'Europe/Prague',
        }),
      );
      expect(result.preferences).toEqual({
        units: 'imperial',
        daily_km: 250,
        format_locale: 'cs-CZ',
        timezone: 'Europe/Prague',
      });
    });

    it('should update avatar_url, bio, and home_region together', async () => {
      const result = await service.updateProfile('user-1', {
        avatar_url: 'https://cdn.example.com/u/1.png',
        bio: 'Weekend rider, Beskydy regular.',
        home_region: 'Beskydy, Czech Republic',
      });

      expect(userRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          avatar_url: 'https://cdn.example.com/u/1.png',
          bio: 'Weekend rider, Beskydy regular.',
          home_region: 'Beskydy, Czech Republic',
        }),
      );
      expect(result.avatar_url).toBe('https://cdn.example.com/u/1.png');
      expect(result.bio).toBe('Weekend rider, Beskydy regular.');
      expect(result.home_region).toBe('Beskydy, Czech Republic');
    });

    it('should clear bio and home_region when null is sent', async () => {
      await service.updateProfile('user-1', {
        bio: null,
        home_region: null,
        avatar_url: null,
      });

      expect(userRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          bio: null,
          home_region: null,
          avatar_url: null,
        }),
      );
    });

    it('should leave profile fields untouched when the dto omits them', async () => {
      await service.updateProfile('user-1', { display_name: 'OnlyName' });

      const saved = userRepo.save!.mock.calls[0][0] as Record<string, unknown>;
      // The DTO omits these keys, so the service must leave the fixture's
      // values (null, from buildMockUser) intact — not blank them or
      // replace them with undefined / empty strings.
      expect(saved.avatar_url).toBeNull();
      expect(saved.bio).toBeNull();
      expect(saved.home_region).toBeNull();
      // Same guard for `language`: an unconditional `user.language =
      // dto.language` would wipe the column to `undefined` on every
      // profile update that doesn't touch the locale switcher.
      expect(saved.language).toBe('en');
    });

    it('should throw NotFoundException for missing user', async () => {
      userRepo.findOne!.mockResolvedValueOnce(null);

      await expect(
        service.updateProfile('missing', { display_name: 'X' }),
      ).rejects.toThrow(NotFoundException);
    });

    it('should not delete files outside the managed avatar upload directory', async () => {
      userRepo.findOne!.mockResolvedValueOnce({
        ...buildMockUser(),
        avatar_url: '/uploads/avatars/..%2F..%2Fsecrets.txt',
      });

      await service.updateProfile('user-1', {
        avatar_url: 'https://cdn.example.com/u/1.png',
      });

      expect(storage.delete).not.toHaveBeenCalled();
    });

    it('should ignore decoded avatar filenames with null bytes', async () => {
      userRepo.findOne!.mockResolvedValueOnce({
        ...buildMockUser(),
        avatar_url: '/uploads/avatars/%00avatar.png',
      });

      await service.updateProfile('user-1', {
        avatar_url: 'https://cdn.example.com/u/1.png',
      });

      expect(storage.delete).not.toHaveBeenCalled();
    });

    it('should ignore decoded avatar filenames that resolve to dot segments', async () => {
      userRepo.findOne!.mockResolvedValueOnce({
        ...buildMockUser(),
        avatar_url: '/uploads/avatars/%2e%2e',
      });

      await service.updateProfile('user-1', {
        avatar_url: 'https://cdn.example.com/u/1.png',
      });

      expect(storage.delete).not.toHaveBeenCalled();
    });

    it('returns the updated profile when the previous-avatar cleanup fails after save (best-effort, logged)', async () => {
      // Same contract as `uploadAvatar`: from the caller's
      // perspective the profile change is already saved, so a
      // transient storage failure on cleanup of the orphaned
      // previous avatar must not propagate as a 500. With S3 in
      // play this is realistic, not theoretical.
      userRepo.findOne!.mockResolvedValueOnce({
        ...buildMockUser(),
        avatar_url: 'https://app.tarmoto.test/uploads/avatars/old-avatar.png',
      });
      const warnSpy = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      storage.delete.mockRejectedValueOnce(
        Object.assign(new Error('S3 5xx'), { code: 'InternalError' }),
      );

      const result = await service.updateProfile('user-1', {
        avatar_url: 'https://cdn.example.com/u/1.png',
      });

      expect(result.avatar_url).toBe('https://cdn.example.com/u/1.png');
      expect(storage.delete).toHaveBeenCalledTimes(1);
      expect(storage.delete).toHaveBeenCalledWith('avatars/old-avatar.png');
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to clean up previous avatar'),
      );
      warnSpy.mockRestore();
    });
  });

  describe('uploadAvatar', () => {
    const file = {
      mimetype: 'image/png',
      buffer: Buffer.from('avatar-bytes'),
    } as Express.Multer.File;

    it('writes the uploaded avatar via the storage backend and embeds an absolute URL built from the request base URL', async () => {
      userRepo.findOne!.mockResolvedValueOnce({
        ...buildMockUser(),
        avatar_url: 'https://app.tarmoto.test/uploads/avatars/old-avatar.png',
      });

      const result = await service.uploadAvatar(
        'user-1',
        file,
        'https://app.tarmoto.test',
      );

      // The new avatar lands in storage under `avatars/<userId>-...`
      // — we don't pin the random filename, just the prefix and
      // content type contract.
      expect(storage.put).toHaveBeenCalledTimes(1);
      const putArg = storage.put.mock.calls[0][0];
      expect(putArg.key).toMatch(/^avatars\/user-1-\d+-[0-9a-f-]+\.png$/);
      expect(putArg.body).toBe(file.buffer);
      expect(putArg.contentType).toBe('image/png');

      // For LocalStorage-style relative URLs, the service prefixes
      // the request's public base so mobile clients (which don't
      // resolve relative URLs) can render the image directly.
      const savedUser = userRepo.save!.mock.calls[0]?.[0] as User;
      expect(savedUser.avatar_url).toMatch(
        /^https:\/\/app\.tarmoto\.test\/uploads\/avatars\/user-1-/,
      );
      expect(result.avatar_url).toMatch(
        /^https:\/\/app\.tarmoto\.test\/uploads\/avatars\/user-1-/,
      );
      expect(result.limits).toEqual({ max_active_trips: null });

      // The old avatar is removed by storage key, not by absolute
      // path — the storage-key helper turns the legacy URL into a
      // managed key.
      expect(storage.delete).toHaveBeenCalledWith('avatars/old-avatar.png');
    });

    it('preserves an absolute URL returned by the storage backend (S3 / CDN case)', async () => {
      userRepo.findOne!.mockResolvedValueOnce({
        ...buildMockUser(),
        avatar_url: null,
      });
      // S3Storage returns an absolute URL. The service should use
      // it verbatim — prefixing the request base URL would yield
      // an obvious nonsense double-host.
      storage.publicUrl.mockImplementationOnce(
        (key: string) => `https://cdn.tarmoto.app/${key}`,
      );

      const result = await service.uploadAvatar(
        'user-1',
        file,
        'https://app.tarmoto.test',
      );

      expect(result.avatar_url).toMatch(
        /^https:\/\/cdn\.tarmoto\.app\/avatars\/user-1-/,
      );
    });

    it('rejects an unsupported MIME type before calling storage', async () => {
      const badFile = {
        mimetype: 'image/gif',
        buffer: Buffer.from('gif87a'),
      } as Express.Multer.File;

      await expect(
        service.uploadAvatar('user-1', badFile, 'https://app.tarmoto.test'),
      ).rejects.toThrow(/PNG, JPEG, or WebP/);
      expect(storage.put).not.toHaveBeenCalled();
    });

    it('returns the updated profile when the previous-avatar cleanup fails after save (best-effort, logged)', async () => {
      userRepo.findOne!.mockResolvedValueOnce({
        ...buildMockUser(),
        avatar_url: 'https://app.tarmoto.test/uploads/avatars/old-avatar.png',
      });
      // From the caller's perspective the upload already succeeded —
      // the row is saved, the new object is in storage. A flaky
      // delete of the now-orphaned previous object must NOT turn
      // into a 500. Suppress logger output so the test isn't noisy.
      const warnSpy = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      storage.delete.mockRejectedValueOnce(
        Object.assign(new Error('permission denied'), { code: 'EACCES' }),
      );

      const result = await service.uploadAvatar(
        'user-1',
        file,
        'https://app.tarmoto.test',
      );

      expect(result.avatar_url).toMatch(
        /^https:\/\/app\.tarmoto\.test\/uploads\/avatars\/user-1-/,
      );
      // Exactly one delete: the old avatar. The new one stays put.
      expect(storage.delete).toHaveBeenCalledTimes(1);
      expect(storage.delete).toHaveBeenCalledWith('avatars/old-avatar.png');
      // The failure is observable in logs so an operator can spot
      // a leaking-cleanup pattern.
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to clean up previous avatar'),
      );
      warnSpy.mockRestore();
    });

    it('rolls back the new object when the DB save fails', async () => {
      userRepo.findOne!.mockResolvedValueOnce({
        ...buildMockUser(),
        avatar_url: null,
      });
      userRepo.save!.mockRejectedValueOnce(new Error('db down'));

      await expect(
        service.uploadAvatar('user-1', file, 'https://app.tarmoto.test'),
      ).rejects.toThrow('db down');

      // The just-uploaded avatar is best-effort deleted so a
      // failed save doesn't leak orphaned objects on every retry.
      expect(storage.delete).toHaveBeenCalledTimes(1);
      const deletedKey = storage.delete.mock.calls[0][0];
      expect(deletedKey).toMatch(/^avatars\/user-1-/);
    });
  });

  describe('listContacts', () => {
    it('should return contacts for user', async () => {
      const result = await service.listContacts('user-1');

      expect(contactRepo.find).toHaveBeenCalledWith({
        where: { user_id: 'user-1' },
        order: { created_at: 'DESC' },
      });
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('Jane Doe');
      expect(result[0].is_emergency).toBe(true);
    });
  });

  describe('addContact', () => {
    it('should create contact with default is_emergency=true', async () => {
      const result = await service.addContact('user-1', {
        name: 'John',
        phone: '+420111222333',
      });

      expect(contactRepo.create).toHaveBeenCalledWith({
        user_id: 'user-1',
        name: 'John',
        phone: '+420111222333',
        is_emergency: true,
      });
      expect(result.name).toBe('John');
    });

    it('should respect explicit is_emergency=false', async () => {
      await service.addContact('user-1', {
        name: 'Bob',
        phone: '+420999',
        is_emergency: false,
      });

      expect(contactRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ is_emergency: false }),
      );
    });
  });

  describe('updateContact', () => {
    it('should update name only when name is provided', async () => {
      const result = await service.updateContact('user-1', 'contact-1', {
        name: 'Janet',
      });

      expect(contactRepo.findOne).toHaveBeenCalledWith({
        where: { id: 'contact-1', user_id: 'user-1' },
      });
      expect(contactRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'contact-1',
          name: 'Janet',
          phone: '+420123456789',
          is_emergency: true,
        }),
      );
      expect(result.name).toBe('Janet');
    });

    it('should update is_emergency=false', async () => {
      await service.updateContact('user-1', 'contact-1', {
        is_emergency: false,
      });

      expect(contactRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ is_emergency: false }),
      );
    });

    it('should throw NotFoundException for missing contact', async () => {
      contactRepo.findOne!.mockResolvedValueOnce(null);

      await expect(
        service.updateContact('user-1', 'missing', { name: 'X' }),
      ).rejects.toThrow(NotFoundException);
    });

    it('should not update contact belonging to another user', async () => {
      contactRepo.findOne!.mockResolvedValueOnce(null);

      await expect(
        service.updateContact('other-user', 'contact-1', { name: 'X' }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('deleteContact', () => {
    it('should delete contact belonging to user', async () => {
      await service.deleteContact('user-1', 'contact-1');

      expect(contactRepo.findOne).toHaveBeenCalledWith({
        where: { id: 'contact-1', user_id: 'user-1' },
      });
      expect(contactRepo.remove).toHaveBeenCalledWith(mockContact);
    });

    it('should throw NotFoundException for missing contact', async () => {
      contactRepo.findOne!.mockResolvedValueOnce(null);

      await expect(service.deleteContact('user-1', 'missing')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should not delete contact belonging to another user', async () => {
      contactRepo.findOne!.mockResolvedValueOnce(null);

      await expect(
        service.deleteContact('other-user', 'contact-1'),
      ).rejects.toThrow(NotFoundException);
    });
  });
});
