import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UserBadge } from '../../entities/user-badge.entity.js';
import { Ride } from '../../entities/ride.entity.js';
import { RideSegment } from '../../entities/ride-segment.entity.js';
import { HazardReport } from '../../entities/hazard-report.entity.js';
import { RoadReview } from '../../entities/road-review.entity.js';
import { SharedRide } from '../../entities/shared-ride.entity.js';
import { BADGE_DEFINITIONS, computeTier } from './badge-definitions.js';
import { BadgeDto, CheckBadgesResponseDto } from './dto/badges.dto.js';

@Injectable()
export class BadgesService {
  constructor(
    @InjectRepository(UserBadge)
    private readonly userBadgeRepo: Repository<UserBadge>,
    @InjectRepository(Ride)
    private readonly rideRepo: Repository<Ride>,
    @InjectRepository(RideSegment)
    private readonly rideSegmentRepo: Repository<RideSegment>,
    @InjectRepository(HazardReport)
    private readonly hazardRepo: Repository<HazardReport>,
    @InjectRepository(RoadReview)
    private readonly reviewRepo: Repository<RoadReview>,
    @InjectRepository(SharedRide)
    private readonly sharedRideRepo: Repository<SharedRide>,
  ) {}

  async listBadges(userId: string): Promise<BadgeDto[]> {
    const [earned, stats] = await Promise.all([
      this.userBadgeRepo.find({ where: { user_id: userId } }),
      this.computeStats(userId),
    ]);

    const earnedMap = new Map(earned.map((e) => [e.badge_key, e]));

    return BADGE_DEFINITIONS.map((def) => {
      const userBadge = earnedMap.get(def.key);
      const current = stats[def.key] ?? 0;

      return {
        key: def.key,
        name: def.name,
        description: def.description,
        category: def.category,
        tier: userBadge?.tier ?? null,
        earned_at: userBadge?.earned_at.toISOString() ?? null,
        progress: {
          current,
          bronze: def.tiers.bronze,
          silver: def.tiers.silver,
          gold: def.tiers.gold,
        },
      };
    });
  }

  async checkAndAward(userId: string): Promise<CheckBadgesResponseDto> {
    const [existing, stats] = await Promise.all([
      this.userBadgeRepo.find({ where: { user_id: userId } }),
      this.computeStats(userId),
    ]);

    const existingMap = new Map(existing.map((e) => [e.badge_key, e]));
    const newlyEarned: string[] = [];

    for (const def of BADGE_DEFINITIONS) {
      const current = stats[def.key] ?? 0;
      const newTier = computeTier(current, def.tiers);

      if (!newTier) continue;

      const existing = existingMap.get(def.key);
      if (existing) {
        // Upgrade tier if higher
        const tierOrder = ['bronze', 'silver', 'gold'];
        if (tierOrder.indexOf(newTier) > tierOrder.indexOf(existing.tier)) {
          existing.tier = newTier;
          await this.userBadgeRepo.save(existing);
          newlyEarned.push(`${def.key}:${newTier}`);
        }
      } else {
        // Award new badge
        const badge = this.userBadgeRepo.create({
          user_id: userId,
          badge_key: def.key,
          tier: newTier,
        });
        await this.userBadgeRepo.save(badge);
        newlyEarned.push(`${def.key}:${newTier}`);
      }
    }

    return { newly_earned: newlyEarned };
  }

  async computeStats(userId: string): Promise<Record<string, number>> {
    const [
      distanceResult,
      longestResult,
      rideCountResult,
      roadsResult,
      reviewCount,
      hazardCount,
      sharedCount,
    ] = await Promise.all([
      this.rideRepo
        .createQueryBuilder('r')
        .select('COALESCE(SUM(r.distance_km), 0)', 'total')
        .where('r.user_id = :userId', { userId })
        .andWhere("r.status = 'completed'")
        .getRawOne<{ total: string }>(),
      this.rideRepo
        .createQueryBuilder('r')
        .select('COALESCE(MAX(r.distance_km), 0)', 'max')
        .where('r.user_id = :userId', { userId })
        .andWhere("r.status = 'completed'")
        .getRawOne<{ max: string }>(),
      this.rideRepo.count({
        where: { user_id: userId, status: 'completed' },
      }),
      this.rideSegmentRepo
        .createQueryBuilder('rs')
        .select('COUNT(DISTINCT rs.road_segment_id)', 'count')
        .innerJoin('rs.ride', 'r')
        .where('r.user_id = :userId', { userId })
        .getRawOne<{ count: string }>(),
      this.reviewRepo.count({ where: { user_id: userId } }),
      this.hazardRepo.count({ where: { user_id: userId } }),
      this.sharedRideRepo.count({ where: { user_id: userId } }),
    ]);

    return {
      total_distance: parseFloat(distanceResult?.total ?? '0'),
      single_ride: parseFloat(longestResult?.max ?? '0'),
      ride_count: rideCountResult,
      roads_discovered: parseInt(roadsResult?.count ?? '0', 10),
      reviews_written: reviewCount,
      hazards_reported: hazardCount,
      rides_shared: sharedCount,
    };
  }
}
