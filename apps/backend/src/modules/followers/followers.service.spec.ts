/* eslint-disable @typescript-eslint/no-unsafe-return */
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import {
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { Repository } from 'typeorm';
import { FollowersService } from './followers.service.js';
import { UserFollow } from '../../entities/user-follow.entity.js';
import { User } from '../../entities/user.entity.js';
import { SharedRide } from '../../entities/shared-ride.entity.js';
import { Ride } from '../../entities/ride.entity.js';
import { PushService } from '../push/index.js';
import { PrivacyPreferencesService } from '../account/privacy-preferences.service.js';
import { DEFAULT_PRIVACY_PREFERENCES } from '@tarmoto/shared';

describe('FollowersService', () => {
  let service: FollowersService;
  let followRepo: Partial<jest.Mocked<Repository<UserFollow>>>;
  let userRepo: Partial<jest.Mocked<Repository<User>>>;
  let sharedRideRepo: Partial<jest.Mocked<Repository<SharedRide>>>;
  let privacy: { loadPreferences: jest.Mock };

  const mockUser = {
    id: 'user-2',
    display_name: 'Jane Rider',
  } as unknown as User;

  const mockFollow = {
    id: 'follow-1',
    follower_id: 'user-1',
    following_id: 'user-2',
    created_at: new Date('2026-04-14T10:00:00Z'),
    follower: { display_name: 'John Rider' },
    following: { display_name: 'Jane Rider' },
  } as unknown as UserFollow;

  const mockRide = {
    id: 'ride-1',
    ride_type: 'free',
    started_at: new Date('2026-04-14T09:00:00Z'),
    ended_at: new Date('2026-04-14T10:30:00Z'),
    distance_km: 42.5,
    avg_speed: 65.3,
    avg_road_quality: 4.2,
  } as unknown as Ride;

  const mockSharedRide = {
    share_token: 'token123',
    user_id: 'user-2',
    ride: mockRide,
    user: { display_name: 'Jane Rider' },
  } as unknown as SharedRide;

  const mockQueryBuilder = {
    innerJoinAndSelect: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    getMany: jest.fn().mockResolvedValue([mockSharedRide]),
  };

  beforeEach(async () => {
    followRepo = {
      find: jest.fn().mockResolvedValue([mockFollow]),
      findOne: jest.fn().mockResolvedValue(mockFollow),
      create: jest
        .fn()
        .mockImplementation((data) => ({ ...mockFollow, ...data })),
      save: jest.fn().mockImplementation((entity) => Promise.resolve(entity)),
      remove: jest.fn().mockResolvedValue(undefined),
    };
    userRepo = {
      findOne: jest.fn().mockResolvedValue(mockUser),
    };
    sharedRideRepo = {
      createQueryBuilder: jest.fn().mockReturnValue(mockQueryBuilder),
    };
    privacy = {
      loadPreferences: jest
        .fn()
        .mockResolvedValue({ ...DEFAULT_PRIVACY_PREFERENCES }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FollowersService,
        { provide: getRepositoryToken(UserFollow), useValue: followRepo },
        { provide: getRepositoryToken(User), useValue: userRepo },
        { provide: getRepositoryToken(SharedRide), useValue: sharedRideRepo },
        {
          provide: PushService,
          useValue: { sendToUser: jest.fn().mockResolvedValue(undefined) },
        },
        { provide: PrivacyPreferencesService, useValue: privacy },
      ],
    }).compile();

    service = module.get<FollowersService>(FollowersService);
    jest.clearAllMocks();
  });

  describe('follow', () => {
    it('should follow a user', async () => {
      const result = await service.follow('user-1', 'user-2');

      expect(userRepo.findOne).toHaveBeenCalledWith({
        where: { id: 'user-2' },
      });
      expect(followRepo.create).toHaveBeenCalledWith({
        follower_id: 'user-1',
        following_id: 'user-2',
      });
      expect(result.following_id).toBe('user-2');
      expect(result.display_name).toBe('Jane Rider');
    });

    it('should throw BadRequestException when following yourself', async () => {
      await expect(service.follow('user-1', 'user-1')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should throw NotFoundException when target user not found', async () => {
      userRepo.findOne!.mockResolvedValueOnce(null);

      await expect(service.follow('user-1', 'missing')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw ConflictException on duplicate follow', async () => {
      followRepo.save!.mockRejectedValueOnce({ code: '23505' });

      await expect(service.follow('user-1', 'user-2')).rejects.toThrow(
        ConflictException,
      );
    });

    it('should rethrow non-unique-constraint errors', async () => {
      followRepo.save!.mockRejectedValueOnce(new Error('connection lost'));

      await expect(service.follow('user-1', 'user-2')).rejects.toThrow(
        'connection lost',
      );
    });
  });

  describe('unfollow', () => {
    it('should unfollow a user', async () => {
      await service.unfollow('user-1', 'user-2');

      expect(followRepo.findOne).toHaveBeenCalledWith({
        where: { follower_id: 'user-1', following_id: 'user-2' },
      });
      expect(followRepo.remove).toHaveBeenCalledWith(mockFollow);
    });

    it('should throw NotFoundException when not following', async () => {
      followRepo.findOne!.mockResolvedValueOnce(null);

      await expect(service.unfollow('user-1', 'user-2')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('listFollowers', () => {
    it('should return followers of a user', async () => {
      const result = await service.listFollowers('user-2');

      expect(followRepo.find).toHaveBeenCalledWith({
        where: { following_id: 'user-2' },
        relations: ['follower'],
        order: { created_at: 'DESC' },
      });
      expect(result).toHaveLength(1);
      expect(result[0]!.user_id).toBe('user-1');
      expect(result[0]!.display_name).toBe('John Rider');
    });

    it('should return empty array when no followers', async () => {
      followRepo.find!.mockResolvedValueOnce([]);

      const result = await service.listFollowers('user-3');

      expect(result).toHaveLength(0);
    });
  });

  describe('listFollowing', () => {
    it('should return users being followed', async () => {
      const result = await service.listFollowing('user-1');

      expect(followRepo.find).toHaveBeenCalledWith({
        where: { follower_id: 'user-1' },
        relations: ['following'],
        order: { created_at: 'DESC' },
      });
      expect(result).toHaveLength(1);
      expect(result[0]!.user_id).toBe('user-2');
      expect(result[0]!.display_name).toBe('Jane Rider');
    });
  });

  describe('getFeed', () => {
    it('should return shared rides from followed users', async () => {
      const result = await service.getFeed('user-1');

      expect(followRepo.find).toHaveBeenCalledWith({
        where: { follower_id: 'user-1' },
        select: ['following_id'],
      });
      expect(mockQueryBuilder.where).toHaveBeenCalledWith(
        'sr.is_public = true',
      );
      expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith(
        'sr.user_id IN (:...followingIds)',
        { followingIds: ['user-2'] },
      );
      expect(result).toHaveLength(1);
      expect(result[0]!.rider_name).toBe('Jane Rider');
      expect(result[0]!.share_token).toBe('token123');
      expect(result[0]!.duration_min).toBe(90);
    });

    it('should return empty array when not following anyone', async () => {
      followRepo.find!.mockResolvedValueOnce([]);

      const result = await service.getFeed('user-1');

      expect(result).toHaveLength(0);
      expect(sharedRideRepo.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('should apply spatial filter when lat/lng provided', async () => {
      const result = await service.getFeed('user-1', 49.2, 16.6, 30);

      expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith(
        'ride.route_geom IS NOT NULL',
      );
      expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith(
        expect.stringContaining('ST_DWithin'),
        { lng: 16.6, lat: 49.2, radius: 30000 },
      );
      expect(result).toHaveLength(1);
    });

    it('should default radius to 50km when not specified', async () => {
      await service.getFeed('user-1', 49.2, 16.6);

      expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith(
        expect.stringContaining('ST_DWithin'),
        expect.objectContaining({ radius: 50000 }),
      );
    });

    it('should not apply spatial filter when lat/lng missing', async () => {
      await service.getFeed('user-1');

      const andWhereCalls = mockQueryBuilder.andWhere.mock.calls.map(
        (c: unknown[]) => c[0],
      );
      expect(andWhereCalls).not.toContainEqual(
        expect.stringContaining('ST_DWithin'),
      );
    });

    it('should respect limit parameter', async () => {
      await service.getFeed('user-1', undefined, undefined, undefined, 10);

      expect(mockQueryBuilder.limit).toHaveBeenCalledWith(10);
    });

    it('should calculate null duration for rides without ended_at', async () => {
      const activeRide = { ...mockRide, ended_at: null } as unknown as Ride;
      const sr = {
        ...mockSharedRide,
        ride: activeRide,
      };
      mockQueryBuilder.getMany.mockResolvedValueOnce([sr]);

      const result = await service.getFeed('user-1');

      expect(result[0]!.duration_min).toBeNull();
    });
  });

  describe('getSuggestions', () => {
    it('maps ranked candidate rows to suggestion DTOs', async () => {
      // Capture predicates; for the `andWhere(cb)` form, run the callback with
      // a sub-query-builder so we can assert the NOT-IN clause is parenthesised
      // (a bare getQuery() would yield invalid `NOT IN SELECT …`).
      const predicates: string[] = [];
      const subQb = {
        select: jest.fn().mockReturnThis(),
        from: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        getQuery: jest
          .fn()
          .mockReturnValue('(SELECT "uf"."following_id" FROM "user_follows")'),
      };
      const suggestQb = {
        leftJoin: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        subQuery: jest.fn().mockReturnValue(subQb),
        andWhere: jest.fn(function (
          this: unknown,
          arg: string | ((qb: typeof suggestQb) => string),
        ) {
          predicates.push(typeof arg === 'function' ? arg(suggestQb) : arg);
          return this;
        }),
        groupBy: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        addOrderBy: jest.fn().mockReturnThis(),
        setParameter: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue([
          {
            id: 'user-9',
            display_name: 'Matteo Ferri',
            avatar_url: null,
            home_region: 'Bergamo · IT',
            ride_count: '312',
          },
        ]),
      };
      userRepo.findOne = jest
        .fn()
        .mockResolvedValue({ home_region: 'Bergamo · IT' });
      userRepo.createQueryBuilder = jest.fn().mockReturnValue(suggestQb);

      const result = await service.getSuggestions('user-1', 6);

      expect(privacy.loadPreferences).toHaveBeenCalledWith('user-1');
      // The follow-graph exclusion must be `NOT IN (SELECT …)`, not
      // `NOT IN SELECT …` (which Postgres rejects with a syntax error).
      expect(predicates.some((p) => /NOT IN \(SELECT/i.test(p))).toBe(true);
      expect(result).toEqual([
        {
          id: 'user-9',
          display_name: 'Matteo Ferri',
          avatar_url: null,
          home_region: 'Bergamo · IT',
          ride_count: 312,
        },
      ]);
    });

    it('returns nothing when the rider opted out of personalised recs', async () => {
      privacy.loadPreferences.mockResolvedValueOnce({
        ...DEFAULT_PRIVACY_PREFERENCES,
        personalized_recommendations_consent: false,
      });
      userRepo.createQueryBuilder = jest.fn();

      const result = await service.getSuggestions('user-1', 6);

      expect(result).toEqual([]);
      // Short-circuits before building the ranking query.
      expect(userRepo.createQueryBuilder).not.toHaveBeenCalled();
    });
  });
});
