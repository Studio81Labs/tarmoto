/* eslint-disable @typescript-eslint/no-unsafe-return */
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import {
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { Repository } from 'typeorm';
import { DEFAULT_PRIVACY_PREFERENCES } from '@tarmoto/shared';
import { SharingService } from './sharing.service.js';
import { TripsService } from '../trips/trips.service.js';
import { SharedRide } from '../../entities/shared-ride.entity.js';
import { RideLike } from '../../entities/ride-like.entity.js';
import { Ride } from '../../entities/ride.entity.js';
import { User } from '../../entities/user.entity.js';
import { Trip } from '../../entities/trip.entity.js';
import { TripDay } from '../../entities/trip-day.entity.js';
import { TripMember } from '../../entities/trip-member.entity.js';
import { PrivacyPreferencesService } from '../account/privacy-preferences.service.js';
import { FeatureResolver } from '../features/feature-resolver.service.js';

describe('SharingService', () => {
  let service: SharingService;
  let sharedRideRepo: Partial<jest.Mocked<Repository<SharedRide>>>;
  let rideLikeRepo: Partial<jest.Mocked<Repository<RideLike>>>;
  let likeBuilder: {
    values: jest.Mock;
    orIgnore: jest.Mock;
    execute: jest.Mock;
    [key: string]: jest.Mock;
  };
  let rideRepo: Partial<jest.Mocked<Repository<Ride>>>;
  let userRepo: Partial<jest.Mocked<Repository<User>>>;
  let tripRepo: Partial<jest.Mocked<Repository<Trip>>>;
  let tripDayRepo: Partial<jest.Mocked<Repository<TripDay>>>;
  let tripMemberRepo: Partial<jest.Mocked<Repository<TripMember>>>;
  let txManager: { save: jest.Mock; increment: jest.Mock; findOne: jest.Mock };
  let tripsService: {
    withTripTransaction: jest.Mock;
    assertCanMintOpenTrip: jest.Mock;
  };
  let privacy: { loadPreferences: jest.Mock };
  let featureResolver: jest.Mocked<
    Pick<FeatureResolver, 'isSystemSwitchEnabled'>
  >;

  const mockOwner = {
    id: 'user-1',
    display_name: 'John Rider',
    deleted_at: null,
  } as unknown as User;

  const mockRide = {
    id: 'ride-1',
    user_id: 'user-1',
    status: 'completed',
    name: 'Sunday switchbacks',
    ride_type: 'free',
    started_at: new Date('2026-04-14T09:00:00Z'),
    ended_at: new Date('2026-04-14T10:30:00Z'),
    distance_km: 42.5,
    avg_speed: 65.3,
    max_speed: 120.0,
    avg_road_quality: 4.2,
    avg_curviness: 3.1,
    route_geom: {
      type: 'LineString',
      coordinates: [
        [16.6, 49.2],
        [16.7, 49.15],
        [16.75, 49.1],
      ],
    },
  } as unknown as Ride;

  const mockShared = {
    id: 'shared-1',
    ride_id: 'ride-1',
    user_id: 'user-1',
    share_token: 'abc123def456abc123def456abc12345',
    is_public: true,
    view_count: 7,
    created_at: new Date('2026-04-14T11:00:00Z'),
    ride: mockRide,
    user: { display_name: 'John Rider' },
  } as unknown as SharedRide;

  const mockQueryBuilder = {
    innerJoinAndSelect: jest.fn().mockReturnThis(),
    leftJoin: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    addOrderBy: jest.fn().mockReturnThis(),
    setParameters: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    getManyAndCount: jest.fn().mockResolvedValue([[mockShared], 1]),
    // `listForUser` runs a second builder to SUM view_count across the
    // visible share set for the profile's "total views" figure.
    getRawOne: jest.fn().mockResolvedValue({ views: '42' }),
  };

  beforeEach(async () => {
    // Reset mutable fields because the service mutates the loaded row
    // (e.g. `getByToken` bumps view_count, `toggleShare` flips is_public)
    // and the mock row is shared by reference across `findOne` returns.
    mockShared.view_count = 7;
    mockShared.is_public = true;

    sharedRideRepo = {
      findOne: jest.fn().mockResolvedValue(mockShared),
      create: jest
        .fn()
        .mockImplementation((data) => ({ ...mockShared, ...data })),
      save: jest.fn().mockImplementation((entity) => Promise.resolve(entity)),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      remove: jest.fn().mockResolvedValue(undefined),
      increment: jest.fn().mockResolvedValue({ affected: 1 }),
      createQueryBuilder: jest.fn().mockReturnValue(mockQueryBuilder),
    };
    const likeQb = {
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue([]),
      // Insert (ON CONFLICT DO NOTHING) builder chain used by likeRide.
      insert: jest.fn().mockReturnThis(),
      values: jest.fn().mockReturnThis(),
      orIgnore: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({}),
    };
    likeBuilder = likeQb;
    rideLikeRepo = {
      createQueryBuilder: jest.fn().mockReturnValue(likeQb),
      find: jest.fn().mockResolvedValue([]),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
      count: jest.fn().mockResolvedValue(0),
    };
    rideRepo = {
      findOne: jest.fn().mockResolvedValue(mockRide),
    };
    userRepo = {
      findOne: jest.fn().mockResolvedValue(mockOwner),
    };
    tripRepo = {
      create: jest.fn().mockImplementation((d) => d),
      save: jest
        .fn()
        .mockImplementation((e) => Promise.resolve({ id: 'trip-1', ...e })),
    };
    tripDayRepo = {
      create: jest.fn().mockImplementation((d) => d),
      save: jest.fn().mockImplementation((e) => Promise.resolve(e)),
    };
    tripMemberRepo = {
      create: jest.fn().mockImplementation((d) => d),
      save: jest.fn().mockImplementation((e) => Promise.resolve(e)),
    };
    txManager = {
      save: jest
        .fn()
        .mockImplementation((e) => Promise.resolve({ id: 'trip-1', ...e })),
      increment: jest.fn().mockResolvedValue({ affected: 1 }),
      // Post-increment re-read of the committed clone counter.
      findOne: jest.fn().mockResolvedValue({ id: 'shared-1', clone_count: 8 }),
    };
    tripsService = {
      // Runs the persist callback against the tx-manager stub — stands in
      // for the real transaction boundary without a live DB.
      withTripTransaction: jest
        .fn()
        .mockImplementation((cb: (m: typeof txManager) => unknown) =>
          cb(txManager),
        ),
      // Cloning routes through the shared max_active_trips gate; default to
      // unlimited (no-op) so existing clone tests are unaffected.
      assertCanMintOpenTrip: jest.fn().mockResolvedValue(undefined),
    };
    privacy = {
      loadPreferences: jest
        .fn()
        .mockResolvedValue({ ...DEFAULT_PRIVACY_PREFERENCES }),
    };
    // Default ON so every pre-existing toggleShare test is unaffected; the
    // off-case tests below override with mockResolvedValue(false).
    featureResolver = {
      isSystemSwitchEnabled: jest.fn().mockResolvedValue(true),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SharingService,
        { provide: getRepositoryToken(SharedRide), useValue: sharedRideRepo },
        { provide: getRepositoryToken(RideLike), useValue: rideLikeRepo },
        { provide: getRepositoryToken(Ride), useValue: rideRepo },
        { provide: getRepositoryToken(User), useValue: userRepo },
        { provide: getRepositoryToken(Trip), useValue: tripRepo },
        { provide: getRepositoryToken(TripDay), useValue: tripDayRepo },
        { provide: getRepositoryToken(TripMember), useValue: tripMemberRepo },
        { provide: TripsService, useValue: tripsService },
        { provide: PrivacyPreferencesService, useValue: privacy },
        { provide: FeatureResolver, useValue: featureResolver },
      ],
    }).compile();

    service = module.get<SharingService>(SharingService);
    jest.clearAllMocks();
  });

  describe('toggleShare', () => {
    it('should create a new share for a completed ride', async () => {
      sharedRideRepo.findOne!.mockResolvedValueOnce(null); // no existing share

      const result = await service.toggleShare('user-1', 'ride-1', true);

      expect(rideRepo.findOne).toHaveBeenCalledWith({
        where: { id: 'ride-1', user_id: 'user-1' },
      });
      expect(sharedRideRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          ride_id: 'ride-1',
          user_id: 'user-1',
          is_public: true,
        }),
      );
      expect(result.is_public).toBe(true);
      expect(result.share_token).toBeDefined();
      expect(result.share_url).toContain('/rides/shared/');
    });

    it('should update existing share when already shared', async () => {
      const result = await service.toggleShare('user-1', 'ride-1', false);

      expect(sharedRideRepo.create).not.toHaveBeenCalled();
      // Targeted `update` (not `save`) so a full-row write can't clobber
      // concurrent `view_count` increments from `getByToken`.
      expect(sharedRideRepo.update).toHaveBeenCalledWith(
        { id: 'shared-1' },
        { is_public: false },
      );
      expect(sharedRideRepo.save).not.toHaveBeenCalled();
      expect(result.is_public).toBe(false);
    });

    it('should throw NotFoundException when ride not found', async () => {
      rideRepo.findOne!.mockResolvedValueOnce(null);

      await expect(
        service.toggleShare('user-1', 'missing', true),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw BadRequestException for active ride', async () => {
      rideRepo.findOne!.mockResolvedValueOnce({
        ...mockRide,
        status: 'active',
      });

      await expect(
        service.toggleShare('user-1', 'ride-1', true),
      ).rejects.toThrow(BadRequestException);
    });

    it('should generate a 32-char hex token', async () => {
      sharedRideRepo.findOne!.mockResolvedValueOnce(null);

      await service.toggleShare('user-1', 'ride-1', true);

      const createCall = sharedRideRepo.create!.mock.calls[0]![0] as {
        share_token: string;
      };
      expect(createCall.share_token).toMatch(/^[a-f0-9]{32}$/);
    });

    // sys_ride_publishing (operator kill switch) — directional: only the
    // publish direction is gated. Unpublishing must always work so a kill
    // can't trap an already-public ride.
    it('coerces a publish to private when sys_ride_publishing is off', async () => {
      featureResolver.isSystemSwitchEnabled.mockResolvedValue(false);

      const result = await service.toggleShare('user-1', 'ride-1', true); // request public

      expect(result.is_public).toBe(false); // coerced private, no throw
      expect(featureResolver.isSystemSwitchEnabled).toHaveBeenCalledWith(
        'sys_ride_publishing',
      );
    });

    it('still allows unpublishing when sys_ride_publishing is off', async () => {
      featureResolver.isSystemSwitchEnabled.mockResolvedValue(false);

      const result = await service.toggleShare('user-1', 'ride-1', false);

      expect(result.is_public).toBe(false); // unpublish works
    });
  });

  describe('unshare', () => {
    it('should remove shared ride', async () => {
      await service.unshare('user-1', 'ride-1');

      expect(sharedRideRepo.findOne).toHaveBeenCalledWith({
        where: { ride_id: 'ride-1', user_id: 'user-1' },
      });
      expect(sharedRideRepo.remove).toHaveBeenCalledWith(mockShared);
    });

    it('should throw NotFoundException when not shared', async () => {
      sharedRideRepo.findOne!.mockResolvedValueOnce(null);

      await expect(service.unshare('user-1', 'ride-1')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('getByToken', () => {
    it('should return shared ride detail', async () => {
      const result = await service.getByToken(
        'abc123def456abc123def456abc12345',
      );

      expect(sharedRideRepo.findOne).toHaveBeenCalledWith({
        where: {
          share_token: 'abc123def456abc123def456abc12345',
        },
        relations: ['ride', 'user'],
      });
      expect(result.id).toBe('ride-1');
      expect(result.rider_name).toBe('John Rider');
      expect(result.distance_km).toBe(42.5);
      expect(result.avg_curviness).toBe(3.1);
      expect(result.duration_min).toBe(90);
      expect(result.route_geometry).toHaveLength(3);
      expect(result.route_geometry![0]).toEqual({ lat: 49.2, lng: 16.6 });
    });

    it('atomically increments view_count and reflects the new value in the response', async () => {
      const result = await service.getByToken(
        'abc123def456abc123def456abc12345',
      );

      expect(sharedRideRepo.increment).toHaveBeenCalledWith(
        { id: 'shared-1' },
        'view_count',
        1,
      );
      expect(result.view_count).toBe(8);
    });

    it('treats a missing view_count as 0 before incrementing', async () => {
      const noCountShared = {
        ...mockShared,
        view_count: undefined,
      } as unknown as SharedRide;
      sharedRideRepo.findOne!.mockResolvedValueOnce(noCountShared);

      const result = await service.getByToken('abc');

      expect(result.view_count).toBe(1);
    });

    it('should return private shared rides by token', async () => {
      const privateShared = {
        ...mockShared,
        is_public: false,
      };
      sharedRideRepo.findOne!.mockResolvedValueOnce(privateShared);

      const result = await service.getByToken(
        'abc123def456abc123def456abc12345',
      );

      expect(result.id).toBe('ride-1');
    });

    it('should throw NotFoundException for invalid token', async () => {
      sharedRideRepo.findOne!.mockResolvedValueOnce(null);

      await expect(service.getByToken('invalid')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should return null route_geometry when ride has no geom', async () => {
      const noGeomShared = {
        ...mockShared,
        ride: { ...mockRide, route_geom: null },
      } as unknown as SharedRide;
      sharedRideRepo.findOne!.mockResolvedValueOnce(noGeomShared);

      const result = await service.getByToken('abc123');

      expect(result.route_geometry).toBeNull();
    });

    it('should default rider_name to Unknown when user is null', async () => {
      const noUserShared = {
        ...mockShared,
        user: undefined,
      } as unknown as SharedRide;
      sharedRideRepo.findOne!.mockResolvedValueOnce(noUserShared);

      const result = await service.getByToken('abc123');

      expect(result.rider_name).toBe('Unknown');
    });

    it('hides shared rides whose owner has requested account deletion (US-62 grace window)', async () => {
      const deletedOwnerShared = {
        ...mockShared,
        user: {
          ...(mockShared as { user: object }).user,
          deleted_at: new Date(),
        },
      } as unknown as SharedRide;
      sharedRideRepo.findOne!.mockResolvedValueOnce(deletedOwnerShared);

      // 404 — same response as an unknown token, so a share-link visitor
      // can't tell whether the rider deleted their account or the link
      // was always invalid.
      await expect(service.getByToken('abc123')).rejects.toThrow(
        NotFoundException,
      );
      // The view-count side-effect must not fire for hidden rides.
      expect(sharedRideRepo.increment).not.toHaveBeenCalled();
    });
  });

  describe('listCommunityRides', () => {
    it('queries nearby public rides with the spatial filter when lat/lng are set', async () => {
      const result = await service.listCommunityRides({
        lat: 49.2,
        lng: 16.6,
        radius_km: 25,
        limit: 20,
      });

      expect(mockQueryBuilder.where).toHaveBeenCalledWith(
        'sr.is_public = true',
      );
      expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith(
        'ride.route_geom IS NOT NULL',
      );
      expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith(
        expect.stringContaining('ST_DWithin'),
        { lng: 16.6, lat: 49.2, radius: 25_000 },
      );
      expect(mockQueryBuilder.skip).toHaveBeenCalledWith(0);
      expect(mockQueryBuilder.take).toHaveBeenCalledWith(20);
      expect(result.items).toHaveLength(1);
      expect(result.items[0]!.rider_name).toBe('John Rider');
      expect(result.items[0]!.share_token).toBe(
        'abc123def456abc123def456abc12345',
      );
      expect(result.total).toBe(1);
      expect(result.limit).toBe(20);
      expect(result.offset).toBe(0);
    });

    it('restricts anonymous viewers to public-profile owners', async () => {
      await service.listCommunityRides({});
      expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith(
        "pp.profile_visibility = 'public'",
      );
    });

    it('shows public + riders-only owners to a signed-in viewer', async () => {
      await service.listCommunityRides({}, 'viewer-9');
      expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith(
        "(pp.profile_visibility IS NULL OR pp.profile_visibility <> 'private')",
      );
    });

    it('returns an empty page when nothing matches', async () => {
      mockQueryBuilder.getManyAndCount.mockResolvedValueOnce([[], 0]);

      const result = await service.listCommunityRides({
        lat: 0,
        lng: 0,
        radius_km: 10,
      });

      expect(result.items).toHaveLength(0);
      expect(result.total).toBe(0);
    });

    it('converts radius_km to meters in the spatial filter', async () => {
      await service.listCommunityRides({ lat: 49.2, lng: 16.6, radius_km: 50 });

      expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith(
        expect.stringContaining('ST_DWithin'),
        expect.objectContaining({ radius: 50_000 }),
      );
    });

    it('calculates duration_min on each card', async () => {
      const result = await service.listCommunityRides({});

      expect(result.items[0]!.duration_min).toBe(90);
    });

    it('includes rider identity and route geometry for mini-preview cards', async () => {
      const result = await service.listCommunityRides({});

      expect(result.items[0]!.rider_id).toBe('user-1');
      expect(result.items[0]!.rider_avatar_url).toBeNull();
      expect(result.items[0]!.route_geometry).toEqual([
        { lat: 49.2, lng: 16.6 },
        { lat: 49.15, lng: 16.7 },
        { lat: 49.1, lng: 16.75 },
      ]);
    });

    it('returns null route_geometry on cards when the ride has no stored track', async () => {
      mockQueryBuilder.getManyAndCount.mockResolvedValueOnce([
        [
          {
            ...mockShared,
            ride: { ...mockRide, route_geom: null },
          },
        ],
        1,
      ]);

      const result = await service.listCommunityRides({});

      expect(result.items[0]!.route_geometry).toBeNull();
    });

    it('downsamples long route geometry for feed-card previews', async () => {
      const coordinates = Array.from({ length: 80 }, (_, index) => [
        16.6 + index * 0.01,
        49.2 - index * 0.005,
      ]);

      mockQueryBuilder.getManyAndCount.mockResolvedValueOnce([
        [
          {
            ...mockShared,
            ride: {
              ...mockRide,
              route_geom: {
                type: 'LineString',
                coordinates,
              },
            },
          },
        ],
        1,
      ]);

      const result = await service.listCommunityRides({});

      expect(result.items[0]!.route_geometry).toHaveLength(32);
      expect(result.items[0]!.route_geometry?.[0]).toEqual({
        lat: coordinates[0]![1],
        lng: coordinates[0]![0],
      });
      expect(result.items[0]!.route_geometry?.at(-1)).toEqual({
        lat: coordinates.at(-1)?.[1],
        lng: coordinates.at(-1)?.[0],
      });
    });

    it('skips the spatial filter and the route_geom guard on the global feed', async () => {
      await service.listCommunityRides({});

      expect(mockQueryBuilder.andWhere).not.toHaveBeenCalledWith(
        expect.stringContaining('ST_DWithin'),
        expect.anything(),
      );
      // The global feed keeps rides without stored geometry so they can
      // still appear as stats-only cards.
      expect(mockQueryBuilder.andWhere).not.toHaveBeenCalledWith(
        'ride.route_geom IS NOT NULL',
      );
      // Default sort is newest with a stable id tiebreaker.
      expect(mockQueryBuilder.orderBy).toHaveBeenCalledWith(
        'ride.started_at',
        'DESC',
      );
      expect(mockQueryBuilder.addOrderBy).toHaveBeenCalledWith(
        'ride.id',
        'DESC',
      );
    });

    it('honours min/max distance and min_quality filters', async () => {
      await service.listCommunityRides({
        min_distance_km: 50,
        max_distance_km: 300,
        min_quality: 3.5,
      });

      expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith(
        'ride.distance_km >= :min_distance',
        { min_distance: 50 },
      );
      expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith(
        'ride.distance_km <= :max_distance',
        { max_distance: 300 },
      );
      expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith(
        'ride.avg_road_quality >= :min_quality',
        { min_quality: 3.5 },
      );
    });

    it('honours the minimum popularity filter', async () => {
      await service.listCommunityRides({ min_popularity: 250 });

      expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith(
        'sr.view_count >= :min_popularity',
        { min_popularity: 250 },
      );
    });

    it('min_curviness filter drops rides with a null aggregate', async () => {
      await service.listCommunityRides({ min_curviness: 2.5 });

      // Explicit IS NOT NULL guard — "unknown" is not "not curvy", so
      // including null rides in a "curvy rides" filter would be misleading.
      expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith(
        'ride.avg_curviness IS NOT NULL',
      );
      expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith(
        'ride.avg_curviness >= :min_curviness',
        { min_curviness: 2.5 },
      );
    });

    it('max_curviness filter drops rides with a null aggregate', async () => {
      await service.listCommunityRides({ max_curviness: 4 });

      expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith(
        'ride.avg_curviness IS NOT NULL',
      );
      expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith(
        'ride.avg_curviness <= :max_curviness',
        { max_curviness: 4 },
      );
    });

    it('does not add curviness predicates when neither bound is set', async () => {
      await service.listCommunityRides({});

      expect(mockQueryBuilder.andWhere).not.toHaveBeenCalledWith(
        'ride.avg_curviness IS NOT NULL',
      );
      expect(mockQueryBuilder.andWhere).not.toHaveBeenCalledWith(
        expect.stringContaining('avg_curviness >='),
        expect.anything(),
      );
    });

    it('honours the ride_type filter', async () => {
      await service.listCommunityRides({ ride_type: 'trip' });

      expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith(
        'ride.ride_type = :ride_type',
        { ride_type: 'trip' },
      );
    });

    it('sort=longest orders by distance DESC with NULLS LAST + id tiebreaker', async () => {
      await service.listCommunityRides({ sort: 'longest' });

      expect(mockQueryBuilder.orderBy).toHaveBeenCalledWith(
        'ride.distance_km',
        'DESC',
        'NULLS LAST',
      );
      expect(mockQueryBuilder.addOrderBy).toHaveBeenCalledWith(
        'ride.id',
        'DESC',
      );
    });

    it('sort=shortest orders by distance ASC with NULLS LAST + id tiebreaker', async () => {
      await service.listCommunityRides({ sort: 'shortest' });

      expect(mockQueryBuilder.orderBy).toHaveBeenCalledWith(
        'ride.distance_km',
        'ASC',
        'NULLS LAST',
      );
      expect(mockQueryBuilder.addOrderBy).toHaveBeenCalledWith(
        'ride.id',
        'ASC',
      );
    });

    it('sort=highest_quality orders by avg_road_quality DESC + id tiebreaker', async () => {
      await service.listCommunityRides({ sort: 'highest_quality' });

      expect(mockQueryBuilder.orderBy).toHaveBeenCalledWith(
        'ride.avg_road_quality',
        'DESC',
        'NULLS LAST',
      );
      expect(mockQueryBuilder.addOrderBy).toHaveBeenCalledWith(
        'ride.id',
        'DESC',
      );
    });

    it('sort=curviest orders by avg_curviness DESC NULLS LAST + id tiebreaker', async () => {
      await service.listCommunityRides({ sort: 'curviest' });

      expect(mockQueryBuilder.orderBy).toHaveBeenCalledWith(
        'ride.avg_curviness',
        'DESC',
        'NULLS LAST',
      );
      expect(mockQueryBuilder.addOrderBy).toHaveBeenCalledWith(
        'ride.id',
        'DESC',
      );
    });

    it('exposes avg_curviness on each community card', async () => {
      const result = await service.listCommunityRides({});

      expect(result.items[0]!.avg_curviness).toBe(3.1);
    });

    it('sort=most_popular orders by view_count DESC + id tiebreaker', async () => {
      await service.listCommunityRides({ sort: 'most_popular' });

      expect(mockQueryBuilder.orderBy).toHaveBeenCalledWith(
        'sr.view_count',
        'DESC',
      );
      expect(mockQueryBuilder.addOrderBy).toHaveBeenCalledWith(
        'ride.id',
        'DESC',
      );
    });

    it('exposes view_count on each community card', async () => {
      const result = await service.listCommunityRides({});

      expect(result.items[0]!.view_count).toBe(7);
    });

    it('sort=oldest orders by started_at ASC + id tiebreaker', async () => {
      await service.listCommunityRides({ sort: 'oldest' });

      expect(mockQueryBuilder.orderBy).toHaveBeenCalledWith(
        'ride.started_at',
        'ASC',
      );
      expect(mockQueryBuilder.addOrderBy).toHaveBeenCalledWith(
        'ride.id',
        'ASC',
      );
    });

    it('sort=nearest orders by ST_Distance using the centre + id tiebreaker', async () => {
      await service.listCommunityRides({
        sort: 'nearest',
        lat: 49.2,
        lng: 16.6,
      });

      expect(mockQueryBuilder.orderBy).toHaveBeenCalledWith(
        expect.stringContaining('ST_Distance'),
        'ASC',
      );
      expect(mockQueryBuilder.addOrderBy).toHaveBeenCalledWith(
        'ride.id',
        'ASC',
      );
      expect(mockQueryBuilder.setParameters).toHaveBeenCalledWith({
        sortLng: 16.6,
        sortLat: 49.2,
      });
    });

    it('paginates via skip/take', async () => {
      await service.listCommunityRides({ offset: 40, limit: 10 });

      expect(mockQueryBuilder.skip).toHaveBeenCalledWith(40);
      expect(mockQueryBuilder.take).toHaveBeenCalledWith(10);
    });
  });

  describe('listForUser', () => {
    it('returns the rider page with default pagination and newest-first order', async () => {
      const result = await service.listForUser('viewer-1', 'user-1', {});

      expect(userRepo.findOne).toHaveBeenCalledWith({
        where: { id: 'user-1' },
      });
      expect(mockQueryBuilder.where).toHaveBeenCalledWith(
        'sr.user_id = :userId',
        { userId: 'user-1' },
      );
      // Non-self viewer: only public shares are returned.
      expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith(
        'sr.is_public = true',
      );
      expect(mockQueryBuilder.orderBy).toHaveBeenCalledWith(
        'sr.created_at',
        'DESC',
      );
      // Stable secondary sort so paging is reproducible when two
      // shares land in the same microsecond.
      expect(mockQueryBuilder.addOrderBy).toHaveBeenCalledWith('sr.id', 'DESC');
      expect(mockQueryBuilder.skip).toHaveBeenCalledWith(0);
      expect(mockQueryBuilder.take).toHaveBeenCalledWith(20);
      expect(result.items).toHaveLength(1);
      expect(result.items[0]).toEqual(
        expect.objectContaining({
          id: 'ride-1',
          share_token: 'abc123def456abc123def456abc12345',
          name: 'Sunday switchbacks',
          ride_type: 'free',
          is_public: true,
          distance_km: 42.5,
          duration_min: 90,
          view_count: 7,
          shared_at: '2026-04-14T11:00:00.000Z',
        }),
      );
      expect(result.items[0]!.route_geometry).toHaveLength(3);
      expect(result.total).toBe(1);
      // Aggregate view total comes from the second (SUM) builder.
      expect(result.total_views).toBe(42);
      expect(result.limit).toBe(20);
      expect(result.offset).toBe(0);
    });

    it('does not filter by is_public when the viewer is the rider themselves', async () => {
      // Self viewer should see private shares too so they can spot a
      // ride they shared then later flipped to private.
      await service.listForUser('user-1', 'user-1', {});

      const isPublicCalls = mockQueryBuilder.andWhere.mock.calls.filter(
        (call: unknown[]) => call[0] === 'sr.is_public = true',
      );
      expect(isPublicCalls).toHaveLength(0);
    });

    it('applies caller-specified limit and offset', async () => {
      await service.listForUser('viewer-1', 'user-1', {
        limit: 5,
        offset: 10,
      });

      expect(mockQueryBuilder.skip).toHaveBeenCalledWith(10);
      expect(mockQueryBuilder.take).toHaveBeenCalledWith(5);
    });

    it('throws NotFoundException when the rider does not exist', async () => {
      userRepo.findOne!.mockResolvedValueOnce(null);

      await expect(
        service.listForUser('viewer-1', 'missing', {}),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws NotFoundException for a soft-deleted rider (US-62 grace window)', async () => {
      userRepo.findOne!.mockResolvedValueOnce({
        ...mockOwner,
        deleted_at: new Date('2026-04-30T10:00:00Z'),
      });

      await expect(
        service.listForUser('viewer-1', 'user-1', {}),
      ).rejects.toThrow(NotFoundException);
    });

    it('hides the list from non-self viewers when the rider has set their profile to private (#279)', async () => {
      privacy.loadPreferences.mockResolvedValueOnce({
        ...DEFAULT_PRIVACY_PREFERENCES,
        profile_visibility: 'private',
      });

      // 404 — same response as a missing rider so non-self callers
      // can't side-channel "exists but hidden" vs "doesn't exist".
      await expect(
        service.listForUser('viewer-1', 'user-1', {}),
      ).rejects.toThrow(NotFoundException);
    });

    it('still returns the list to the rider themselves when their profile is private', async () => {
      privacy.loadPreferences.mockResolvedValueOnce({
        ...DEFAULT_PRIVACY_PREFERENCES,
        profile_visibility: 'private',
      });

      const result = await service.listForUser('user-1', 'user-1', {});

      expect(result.items).toHaveLength(1);
      // Self-lookup short-circuits the privacy check, so the privacy
      // service mock isn't even consulted.
      expect(privacy.loadPreferences).not.toHaveBeenCalled();
    });

    it('passes the riders-only audience through (every caller is authenticated)', async () => {
      privacy.loadPreferences.mockResolvedValueOnce({
        ...DEFAULT_PRIVACY_PREFERENCES,
        profile_visibility: 'riders-only',
      });

      const result = await service.listForUser('viewer-1', 'user-1', {});

      expect(result.items).toHaveLength(1);
    });

    it('returns an empty page when the rider has no shared rides', async () => {
      mockQueryBuilder.getManyAndCount.mockResolvedValueOnce([[], 0]);

      const result = await service.listForUser('viewer-1', 'user-1', {});

      expect(result.items).toEqual([]);
      expect(result.total).toBe(0);
    });
  });

  describe('likeRide / unlikeRide', () => {
    it('inserts a like (ON CONFLICT DO NOTHING) and returns fresh state', async () => {
      rideLikeRepo.count!.mockResolvedValueOnce(5);

      const result = await service.likeRide('viewer-2', 'ride-1');

      expect(likeBuilder.values).toHaveBeenCalledWith({
        ride_id: 'ride-1',
        user_id: 'viewer-2',
      });
      expect(likeBuilder.orIgnore).toHaveBeenCalled();
      expect(likeBuilder.execute).toHaveBeenCalled();
      expect(result).toEqual({ like_count: 5, viewer_has_liked: true });
    });

    it('lets a real insert failure surface instead of a phantom like', async () => {
      likeBuilder.execute.mockRejectedValueOnce(new Error('db down'));

      await expect(service.likeRide('viewer-2', 'ride-1')).rejects.toThrow(
        'db down',
      );
    });

    it('rejects a like against a non-public / unknown ride', async () => {
      sharedRideRepo.findOne!.mockResolvedValueOnce(null);

      await expect(service.likeRide('viewer-2', 'ride-x')).rejects.toThrow(
        NotFoundException,
      );
      expect(likeBuilder.execute).not.toHaveBeenCalled();
    });

    it('removes a like idempotently', async () => {
      rideLikeRepo.count!.mockResolvedValueOnce(4);

      const result = await service.unlikeRide('viewer-2', 'ride-1');

      expect(rideLikeRepo.delete).toHaveBeenCalledWith({
        ride_id: 'ride-1',
        user_id: 'viewer-2',
      });
      expect(result).toEqual({ like_count: 4, viewer_has_liked: false });
    });
  });

  describe('cloneRide', () => {
    it('creates a draft trip + day + owner membership and bumps clone_count', async () => {
      const result = await service.cloneRide('viewer-2', 'ride-1');

      // The clone runs through the shared trip-transaction wrapper — all
      // writes commit atomically inside one transaction.
      expect(tripsService.withTripTransaction).toHaveBeenCalledTimes(1);
      expect(tripRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ owner_id: 'viewer-2', status: 'draft' }),
      );
      expect(tripDayRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ route_geom: mockRide.route_geom }),
      );
      // Trip + member + day persisted, then the counter bumped, all via the
      // transaction's entity manager.
      expect(txManager.save).toHaveBeenCalledTimes(3);
      expect(txManager.increment).toHaveBeenCalledWith(
        SharedRide,
        { id: 'shared-1' },
        'clone_count',
        1,
      );
      expect(result.trip_id).toBe('trip-1');
      // Reports the committed-within-tx counter, not a stale `old + 1`.
      expect(result.clone_count).toBe(8);
    });

    it('rejects cloning a route with no geometry', async () => {
      sharedRideRepo.findOne!.mockResolvedValueOnce({
        ...mockShared,
        ride: { ...mockRide, route_geom: null },
      });

      await expect(service.cloneRide('viewer-2', 'ride-1')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('rejects at the max_active_trips cap and never opens the transaction', async () => {
      // A clone mints a new open trip owned by the caller, so it routes
      // through the shared cap gate. Simulate the caller being at cap.
      tripsService.assertCanMintOpenTrip.mockRejectedValueOnce(
        new ForbiddenException({ code: 'FEATURE_LIMIT_EXCEEDED' }),
      );

      await expect(
        service.cloneRide('viewer-2', 'ride-1'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(tripsService.assertCanMintOpenTrip).toHaveBeenCalledWith(
        'viewer-2',
      );
      // Rejected before any write — the transaction wrapper never runs.
      expect(tripsService.withTripTransaction).not.toHaveBeenCalled();
    });
  });
});
