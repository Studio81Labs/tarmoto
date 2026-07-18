import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { UserBadge } from '../../entities/user-badge.entity.js';
import { Ride } from '../../entities/ride.entity.js';
import { RideSegment } from '../../entities/ride-segment.entity.js';
import { HazardReport } from '../../entities/hazard-report.entity.js';
import { RoadReview } from '../../entities/road-review.entity.js';
import { SharedRide } from '../../entities/shared-ride.entity.js';
import { BADGE_DEFINITIONS, computeTier } from './badge-definitions.js';
import { deriveProgression } from './progression-definitions.js';
import { BadgeDto, CheckBadgesResponseDto } from './dto/badges.dto.js';
import { ProgressionDto } from './dto/progression.dto.js';
import { FeatureResolver } from '../features/feature-resolver.service.js';

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
    private readonly dataSource: DataSource,
    private readonly featureResolver: FeatureResolver,
  ) {}

  async listBadges(userId: string): Promise<BadgeDto[]> {
    if (
      !(await this.featureResolver.isSystemSwitchEnabled('sys_gamification'))
    ) {
      return [];
    }

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
    if (
      !(await this.featureResolver.isSystemSwitchEnabled('sys_gamification'))
    ) {
      throw new ServiceUnavailableException(
        'Gamification is temporarily unavailable',
      );
    }

    const stats = await this.computeStats(userId);

    const newlyEarned = await this.dataSource.transaction(async (manager) => {
      const existing = await manager.find(UserBadge, {
        where: { user_id: userId },
      });
      const existingMap = new Map(existing.map((e) => [e.badge_key, e]));
      const earned: string[] = [];
      const tierOrder = ['bronze', 'silver', 'gold'];

      for (const def of BADGE_DEFINITIONS) {
        const current = stats[def.key] ?? 0;
        const newTier = computeTier(current, def.tiers);

        if (!newTier) continue;

        const badge = existingMap.get(def.key);
        if (badge) {
          if (tierOrder.indexOf(newTier) > tierOrder.indexOf(badge.tier)) {
            badge.tier = newTier;
            badge.earned_at = new Date();
            await manager.save(UserBadge, badge);
            earned.push(`${def.key}:${newTier}`);
          }
        } else {
          const created = manager.create(UserBadge, {
            user_id: userId,
            badge_key: def.key,
            tier: newTier,
          });
          await manager.save(UserBadge, created);
          earned.push(`${def.key}:${newTier}`);
        }
      }

      return earned;
    });

    return { newly_earned: newlyEarned };
  }

  /**
   * Rider progression (XP / level / tier) derived from current lifetime stats.
   * No persistence — recomputed on read so it always reflects real
   * achievements (see `progression-definitions.ts`).
   */
  async computeProgression(userId: string): Promise<ProgressionDto> {
    if (
      !(await this.featureResolver.isSystemSwitchEnabled('sys_gamification'))
    ) {
      return deriveProgression({});
    }

    const stats = await this.computeStats(userId);
    return deriveProgression(stats);
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
        .andWhere("r.status = 'completed'")
        .getRawOne<{ count: string }>(),
      this.reviewRepo.count({
        where: { user_id: userId, moderation_status: 'visible' },
      }),
      this.hazardRepo.count({
        where: { user_id: userId, moderation_status: 'visible' },
      }),
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
