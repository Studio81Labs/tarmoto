/* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
import { ServiceUnavailableException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { BadgesService } from './badges.service.js';
import { UserBadge } from '../../entities/user-badge.entity.js';
import { Ride } from '../../entities/ride.entity.js';
import { RideSegment } from '../../entities/ride-segment.entity.js';
import { HazardReport } from '../../entities/hazard-report.entity.js';
import { RoadReview } from '../../entities/road-review.entity.js';
import { SharedRide } from '../../entities/shared-ride.entity.js';
import { FeatureResolver } from '../features/feature-resolver.service.js';

describe('BadgesService', () => {
  let service: BadgesService;
  let userBadgeRepo: Partial<jest.Mocked<Repository<UserBadge>>>;
  let rideRepo: Partial<jest.Mocked<Repository<Ride>>>;
  let hazardRepo: { count: jest.Mock };
  let reviewRepo: { count: jest.Mock };
  let sharedRideRepo: { count: jest.Mock };
  let featureResolver: { isSystemSwitchEnabled: jest.Mock };

  const mockQb = {
    select: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    innerJoin: jest.fn().mockReturnThis(),
    getRawOne: jest
      .fn()
      .mockResolvedValue({ total: '150', max: '60', count: '30' }),
  };

  const mockExistingBadge = {
    id: 'badge-1',
    user_id: 'user-1',
    badge_key: 'total_distance',
    tier: 'bronze',
    earned_at: new Date('2026-04-10T10:00:00Z'),
  } as unknown as UserBadge;

  const mockTransactionManager = {
    find: jest.fn().mockResolvedValue([]),
    create: jest.fn().mockImplementation((_entity: unknown, data: unknown) => ({
      id: 'badge-new',
      earned_at: new Date('2026-04-15T10:00:00Z'),
      ...(data as Record<string, unknown>),
    })),
    save: jest
      .fn()
      .mockImplementation((_entity: unknown, data: unknown) =>
        Promise.resolve(data),
      ),
  };

  beforeEach(async () => {
    userBadgeRepo = {
      find: jest.fn().mockResolvedValue([mockExistingBadge]),
      create: jest.fn().mockImplementation((data) => ({
        id: 'badge-new',
        earned_at: new Date('2026-04-15T10:00:00Z'),
        ...data,
      })),
      save: jest.fn().mockImplementation((entity) => Promise.resolve(entity)),
    };
    rideRepo = {
      createQueryBuilder: jest.fn().mockReturnValue(mockQb),
      count: jest.fn().mockResolvedValue(15),
    };

    const rideSegmentRepo = {
      createQueryBuilder: jest.fn().mockReturnValue(mockQb),
    };
    hazardRepo = { count: jest.fn().mockResolvedValue(0) };
    reviewRepo = { count: jest.fn().mockResolvedValue(0) };
    sharedRideRepo = { count: jest.fn().mockResolvedValue(0) };
    featureResolver = {
      isSystemSwitchEnabled: jest.fn().mockResolvedValue(true),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BadgesService,
        { provide: getRepositoryToken(UserBadge), useValue: userBadgeRepo },
        { provide: getRepositoryToken(Ride), useValue: rideRepo },
        { provide: getRepositoryToken(RideSegment), useValue: rideSegmentRepo },
        { provide: getRepositoryToken(HazardReport), useValue: hazardRepo },
        { provide: getRepositoryToken(RoadReview), useValue: reviewRepo },
        { provide: getRepositoryToken(SharedRide), useValue: sharedRideRepo },
        {
          provide: DataSource,
          useValue: {
            transaction: jest
              .fn()
              .mockImplementation(
                (
                  cb: (
                    manager: typeof mockTransactionManager,
                  ) => Promise<unknown>,
                ) => cb(mockTransactionManager),
              ),
          },
        },
        { provide: FeatureResolver, useValue: featureResolver },
      ],
    }).compile();

    service = module.get<BadgesService>(BadgesService);
    jest.clearAllMocks();
  });

  describe('listBadges', () => {
    it('should return all badge definitions with progress', async () => {
      userBadgeRepo.find!.mockResolvedValueOnce([mockExistingBadge]);
      mockQb.getRawOne
        .mockResolvedValueOnce({ total: '150' }) // total_distance
        .mockResolvedValueOnce({ max: '60' }) // single_ride
        .mockResolvedValueOnce({ count: '30' }); // roads_discovered
      rideRepo.count!.mockResolvedValueOnce(15); // ride_count

      const result = await service.listBadges('user-1');

      expect(result).toHaveLength(7);
      // total_distance has existing bronze badge
      const distBadge = result.find((b) => b.key === 'total_distance');
      expect(distBadge?.tier).toBe('bronze');
      expect(distBadge?.progress.current).toBe(150);
      expect(distBadge?.progress.bronze).toBe(100);
    });

    it('should return null tier and earned_at for unearned badges', async () => {
      userBadgeRepo.find!.mockResolvedValueOnce([]);
      mockQb.getRawOne
        .mockResolvedValueOnce({ total: '0' })
        .mockResolvedValueOnce({ max: '0' })
        .mockResolvedValueOnce({ count: '0' });
      rideRepo.count!.mockResolvedValueOnce(0);

      const result = await service.listBadges('user-1');

      expect(result[0]!.tier).toBeNull();
      expect(result[0]!.earned_at).toBeNull();
    });

    it('returns [] without querying when sys_gamification is off', async () => {
      featureResolver.isSystemSwitchEnabled.mockResolvedValue(false);
      const result = await service.listBadges('user-1');
      expect(result).toEqual([]);
      expect(featureResolver.isSystemSwitchEnabled).toHaveBeenCalledWith(
        'sys_gamification',
      );
      expect(userBadgeRepo.find).not.toHaveBeenCalled();
    });
  });

  describe('checkAndAward', () => {
    it('should award new badges when thresholds met', async () => {
      // Transaction manager: no existing badges
      mockTransactionManager.find.mockResolvedValueOnce([]);
      // Stats: 150km total, 60km longest, 15 rides, 30 roads, 6 reviews, 8 hazards, 4 shared
      mockQb.getRawOne
        .mockResolvedValueOnce({ total: '150' })
        .mockResolvedValueOnce({ max: '60' })
        .mockResolvedValueOnce({ count: '30' });
      rideRepo.count!.mockResolvedValueOnce(15);
      reviewRepo.count.mockResolvedValueOnce(6);
      hazardRepo.count.mockResolvedValueOnce(8);
      sharedRideRepo.count.mockResolvedValueOnce(4);

      const result = await service.checkAndAward('user-1');

      expect(result.newly_earned).toContain('total_distance:bronze');
      expect(result.newly_earned).toContain('single_ride:bronze');
      expect(result.newly_earned).toContain('ride_count:bronze');
      expect(result.newly_earned).toContain('roads_discovered:bronze');
      expect(result.newly_earned).toContain('reviews_written:bronze');
      expect(result.newly_earned).toContain('hazards_reported:bronze');
      expect(result.newly_earned).toContain('rides_shared:bronze');
    });

    it('should upgrade tier and update earned_at when higher threshold met', async () => {
      // Existing bronze badge for total_distance
      const existingBadge = { ...mockExistingBadge };
      mockTransactionManager.find.mockResolvedValueOnce([existingBadge]);
      // Stats: 1500km — qualifies for silver
      mockQb.getRawOne
        .mockResolvedValueOnce({ total: '1500' })
        .mockResolvedValueOnce({ max: '10' })
        .mockResolvedValueOnce({ count: '2' });
      rideRepo.count!.mockResolvedValueOnce(3);

      const result = await service.checkAndAward('user-1');

      expect(result.newly_earned).toContain('total_distance:silver');
      expect(mockTransactionManager.save).toHaveBeenCalledWith(
        UserBadge,
        expect.objectContaining({
          tier: 'silver',
          earned_at: expect.any(Date),
        }),
      );
      // earned_at should be updated to now, not the original bronze date
      const savedBadge = mockTransactionManager.save.mock.calls[0][1];
      expect(savedBadge.earned_at.getTime()).toBeGreaterThan(
        mockExistingBadge.earned_at.getTime(),
      );
    });

    it('should not re-award same tier', async () => {
      // Existing bronze badge
      mockTransactionManager.find.mockResolvedValueOnce([
        { ...mockExistingBadge },
      ]);
      // Stats: 150km — still bronze
      mockQb.getRawOne
        .mockResolvedValueOnce({ total: '150' })
        .mockResolvedValueOnce({ max: '10' })
        .mockResolvedValueOnce({ count: '2' });
      rideRepo.count!.mockResolvedValueOnce(3);

      const result = await service.checkAndAward('user-1');

      expect(result.newly_earned).not.toContain('total_distance:bronze');
    });

    it('should return empty array when no thresholds met', async () => {
      mockTransactionManager.find.mockResolvedValueOnce([]);
      mockQb.getRawOne
        .mockResolvedValueOnce({ total: '0' })
        .mockResolvedValueOnce({ max: '0' })
        .mockResolvedValueOnce({ count: '0' });
      rideRepo.count!.mockResolvedValueOnce(0);

      const result = await service.checkAndAward('user-1');

      expect(result.newly_earned).toEqual([]);
    });

    it('should award gold tier directly if threshold met', async () => {
      mockTransactionManager.find.mockResolvedValueOnce([]);
      // 15000km total — straight to gold
      mockQb.getRawOne
        .mockResolvedValueOnce({ total: '15000' })
        .mockResolvedValueOnce({ max: '600' })
        .mockResolvedValueOnce({ count: '600' });
      rideRepo.count!.mockResolvedValueOnce(250);

      const result = await service.checkAndAward('user-1');

      expect(result.newly_earned).toContain('total_distance:gold');
      expect(result.newly_earned).toContain('single_ride:gold');
      expect(result.newly_earned).toContain('ride_count:gold');
      expect(result.newly_earned).toContain('roads_discovered:gold');
    });

    it('throws 503 when sys_gamification is off', async () => {
      featureResolver.isSystemSwitchEnabled.mockResolvedValue(false);
      await expect(service.checkAndAward('user-1')).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      expect(featureResolver.isSystemSwitchEnabled).toHaveBeenCalledWith(
        'sys_gamification',
      );
    });
  });

  describe('computeStats', () => {
    it('should aggregate all stat categories', async () => {
      mockQb.getRawOne
        .mockResolvedValueOnce({ total: '250.5' })
        .mockResolvedValueOnce({ max: '85.3' })
        .mockResolvedValueOnce({ count: '42' });
      rideRepo.count!.mockResolvedValueOnce(20);
      reviewRepo.count.mockResolvedValueOnce(6);
      hazardRepo.count.mockResolvedValueOnce(8);
      sharedRideRepo.count.mockResolvedValueOnce(4);

      const stats = await service.computeStats('user-1');

      expect(stats.total_distance).toBe(250.5);
      expect(stats.single_ride).toBe(85.3);
      expect(stats.ride_count).toBe(20);
      expect(stats.roads_discovered).toBe(42);
      expect(stats.reviews_written).toBe(6);
      expect(stats.hazards_reported).toBe(8);
      expect(stats.rides_shared).toBe(4);
    });

    it('should filter roads_discovered by completed rides', async () => {
      mockQb.getRawOne
        .mockResolvedValueOnce({ total: '0' })
        .mockResolvedValueOnce({ max: '0' })
        .mockResolvedValueOnce({ count: '10' });
      rideRepo.count!.mockResolvedValueOnce(0);

      await service.computeStats('user-1');

      // The roads_discovered query builder should have andWhere for completed status
      expect(mockQb.andWhere).toHaveBeenCalledWith("r.status = 'completed'");
    });

    it('should handle null/zero stats gracefully', async () => {
      mockQb.getRawOne
        .mockResolvedValueOnce({ total: null })
        .mockResolvedValueOnce({ max: null })
        .mockResolvedValueOnce({ count: null });
      rideRepo.count!.mockResolvedValueOnce(0);

      const stats = await service.computeStats('user-1');

      expect(stats.total_distance).toBe(0);
      expect(stats.single_ride).toBe(0);
      expect(stats.ride_count).toBe(0);
      expect(stats.roads_discovered).toBe(0);
    });
  });

  describe('moderation filter on review / hazard counts', () => {
    it('reviews_written count passes moderation_status=visible so hidden reviews are excluded', async () => {
      mockQb.getRawOne
        .mockResolvedValueOnce({ total: '0' })
        .mockResolvedValueOnce({ max: '0' })
        .mockResolvedValueOnce({ count: '0' });
      rideRepo.count!.mockResolvedValueOnce(0);
      reviewRepo.count.mockResolvedValueOnce(0);
      hazardRepo.count.mockResolvedValueOnce(0);
      sharedRideRepo.count.mockResolvedValueOnce(0);

      await service.computeStats('user-1');

      expect(reviewRepo.count).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ moderation_status: 'visible' }),
        }),
      );
    });

    it('hazards_reported count passes moderation_status=visible so hidden hazards are excluded', async () => {
      mockQb.getRawOne
        .mockResolvedValueOnce({ total: '0' })
        .mockResolvedValueOnce({ max: '0' })
        .mockResolvedValueOnce({ count: '0' });
      rideRepo.count!.mockResolvedValueOnce(0);
      reviewRepo.count.mockResolvedValueOnce(0);
      hazardRepo.count.mockResolvedValueOnce(0);
      sharedRideRepo.count.mockResolvedValueOnce(0);

      await service.computeStats('user-1');

      expect(hazardRepo.count).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ moderation_status: 'visible' }),
        }),
      );
    });
  });

  describe('computeProgression', () => {
    it('derives XP / level / tier from the rider stats', async () => {
      jest.spyOn(service, 'computeStats').mockResolvedValueOnce({
        total_distance: 22750,
        single_ride: 0,
        ride_count: 0,
        roads_discovered: 0,
        reviews_written: 0,
        hazards_reported: 0,
        rides_shared: 0,
      });

      const progression = await service.computeProgression('user-1');

      // 22,750 km → 22,750 XP + gold Road Warrior bonus (1,000) = 23,750.
      expect(progression.xp).toBe(23750);
      expect(progression.level).toBe(14);
      expect(progression.tier).toBe('Curve Hunter');
      expect(progression.next_tier).toBe('Mountain Goat');
    });

    it('returns the floor progression when sys_gamification is off', async () => {
      featureResolver.isSystemSwitchEnabled.mockResolvedValue(false);
      const result = await service.computeProgression('user-1');
      // Floor = deriveProgression({}) — level clamps to a minimum of 1.
      expect(result.level).toBeGreaterThanOrEqual(1);
      expect(result.xp).toBe(0);
      expect(featureResolver.isSystemSwitchEnabled).toHaveBeenCalledWith(
        'sys_gamification',
      );
    });
  });
});
