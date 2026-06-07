import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { canShowPersonalizedRecommendations } from '@tarmoto/shared';
import { UserFollow } from '../../entities/user-follow.entity.js';
import { User } from '../../entities/user.entity.js';
import { SharedRide } from '../../entities/shared-ride.entity.js';
import { PushService } from '../push/index.js';
import { PrivacyPreferencesService } from '../account/privacy-preferences.service.js';
import {
  FollowUserResponseDto,
  FollowerDto,
  FollowingDto,
  FeedRideDto,
  SuggestedRiderDto,
} from './dto/followers.dto.js';

@Injectable()
export class FollowersService {
  private readonly logger = new Logger(FollowersService.name);

  constructor(
    @InjectRepository(UserFollow)
    private readonly followRepo: Repository<UserFollow>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    @InjectRepository(SharedRide)
    private readonly sharedRideRepo: Repository<SharedRide>,
    private readonly pushService: PushService,
    private readonly privacy: PrivacyPreferencesService,
  ) {}

  async follow(
    followerId: string,
    followingId: string,
  ): Promise<FollowUserResponseDto> {
    if (followerId === followingId) {
      throw new BadRequestException('You cannot follow yourself');
    }

    const target = await this.userRepo.findOne({
      where: { id: followingId },
    });
    if (!target || target.deleted_at != null) {
      throw new NotFoundException('User not found');
    }

    const follow = this.followRepo.create({
      follower_id: followerId,
      following_id: followingId,
    });

    try {
      await this.followRepo.save(follow);
    } catch (err: unknown) {
      if (
        typeof err === 'object' &&
        err !== null &&
        'code' in err &&
        (err as { code: string }).code === '23505'
      ) {
        throw new ConflictException('Already following this user');
      }
      throw err;
    }

    // Best-effort follower-notification push. Resolve the follower's
    // display_name for a richer message; fall back to "Someone" if the
    // lookup fails so a missing user row never blocks the follow itself.
    void this.notifyNewFollower(followerId, target);

    return {
      following_id: followingId,
      display_name: target.display_name,
      followed_at: follow.created_at.toISOString(),
    };
  }

  private async notifyNewFollower(
    followerId: string,
    target: User,
  ): Promise<void> {
    try {
      const follower = await this.userRepo.findOne({
        where: { id: followerId },
        select: { id: true, display_name: true },
      });
      const followerName = follower?.display_name ?? 'Someone';
      await this.pushService.sendToUser(target.id, {
        category: 'new_follower',
        title: 'New follower',
        body: `${followerName} started following you`,
        data: {
          type: 'new_follower',
          follower_id: followerId,
        },
      });
    } catch (err) {
      // Push is best-effort — never let a notifier failure surface
      // back to the user-facing follow response.
      this.logger.warn(
        `new_follower push failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async unfollow(followerId: string, followingId: string): Promise<void> {
    const follow = await this.followRepo.findOne({
      where: { follower_id: followerId, following_id: followingId },
    });
    if (!follow) {
      throw new NotFoundException('Not following this user');
    }
    await this.followRepo.remove(follow);
  }

  async listFollowers(userId: string): Promise<FollowerDto[]> {
    const follows = await this.followRepo.find({
      where: { following_id: userId },
      relations: ['follower'],
      order: { created_at: 'DESC' },
    });

    return follows
      .filter((f) => f.follower != null && f.follower.deleted_at == null)
      .map((f) => ({
        user_id: f.follower_id,
        display_name: f.follower.display_name,
        followed_at: f.created_at.toISOString(),
      }));
  }

  async listFollowing(userId: string): Promise<FollowingDto[]> {
    const follows = await this.followRepo.find({
      where: { follower_id: userId },
      relations: ['following'],
      order: { created_at: 'DESC' },
    });

    return follows
      .filter((f) => f.following != null && f.following.deleted_at == null)
      .map((f) => ({
        user_id: f.following_id,
        display_name: f.following.display_name,
        followed_at: f.created_at.toISOString(),
      }));
  }

  /**
   * "People you might follow" — riders the caller doesn't already follow,
   * ranked by activity (ride count) then recency. Excludes self, deleted
   * accounts and riders whose profile is private (#279). Same-region riders
   * float up so the suggestions feel local without needing a heavy model.
   */
  async getSuggestions(
    userId: string,
    limit = 6,
  ): Promise<SuggestedRiderDto[]> {
    // "People you might follow" is an inherently personal recommendation
    // (ranked by the caller's region + follow graph), so it returns nothing
    // when the rider has opted out of personalised recommendations (#279).
    const prefs = await this.privacy.loadPreferences(userId);
    if (!canShowPersonalizedRecommendations(prefs)) return [];

    const me = await this.userRepo.findOne({
      where: { id: userId },
      select: { home_region: true },
    });
    const homeRegion = me?.home_region ?? null;

    const rows = await this.userRepo
      .createQueryBuilder('u')
      .leftJoin('privacy_preferences', 'pp', 'pp.user_id = u.id')
      .leftJoin('rides', 'r', 'r.user_id = u.id')
      .select('u.id', 'id')
      .addSelect('u.display_name', 'display_name')
      .addSelect('u.avatar_url', 'avatar_url')
      .addSelect('u.home_region', 'home_region')
      .addSelect('COUNT(r.id)', 'ride_count')
      .where('u.id <> :userId', { userId })
      .andWhere('u.deleted_at IS NULL')
      .andWhere(
        "(pp.profile_visibility IS NULL OR pp.profile_visibility <> 'private')",
      )
      // Exclude riders the caller already follows. `qb.subQuery()` wraps the
      // SELECT in parentheses, so the predicate is a valid `NOT IN (SELECT …)`
      // (a bare `getQuery()` omits the parens → `NOT IN SELECT …` syntax error).
      .andWhere((qb) => {
        const sub = qb
          .subQuery()
          .select('uf.following_id')
          .from(UserFollow, 'uf')
          .where('uf.follower_id = :userId')
          .getQuery();
        return `u.id NOT IN ${sub}`;
      })
      .groupBy('u.id')
      // Same-region riders first, then most active, then newest.
      .orderBy(homeRegion ? '(u.home_region = :homeRegion)' : 'TRUE', 'DESC')
      .addOrderBy('COUNT(r.id)', 'DESC')
      .addOrderBy('u.created_at', 'DESC')
      .setParameter('homeRegion', homeRegion)
      .limit(limit)
      .getRawMany<{
        id: string;
        display_name: string;
        avatar_url: string | null;
        home_region: string | null;
        ride_count: string;
      }>();

    return rows.map((r) => ({
      id: r.id,
      display_name: r.display_name,
      avatar_url: r.avatar_url,
      home_region: r.home_region,
      ride_count: parseInt(r.ride_count, 10) || 0,
    }));
  }

  async getFeed(
    userId: string,
    lat?: number,
    lng?: number,
    radiusKm?: number,
    limit?: number,
  ): Promise<FeedRideDto[]> {
    const feedLimit = limit ?? 20;

    // Get IDs of users I follow
    const follows = await this.followRepo.find({
      where: { follower_id: userId },
      select: ['following_id'],
    });

    if (follows.length === 0) {
      return [];
    }

    const followingIds = follows.map((f) => f.following_id);

    const qb = this.sharedRideRepo
      .createQueryBuilder('sr')
      .innerJoinAndSelect('sr.ride', 'ride')
      .innerJoinAndSelect('sr.user', 'user')
      .where('sr.is_public = true')
      .andWhere('user.deleted_at IS NULL')
      .andWhere('sr.user_id IN (:...followingIds)', { followingIds });

    if (lat != null && lng != null) {
      const radiusM = (radiusKm ?? 50) * 1000;
      qb.andWhere('ride.route_geom IS NOT NULL').andWhere(
        'ST_DWithin(ride.route_geom::geography, ST_SetSRID(ST_MakePoint(:lng, :lat), 4326)::geography, :radius)',
        { lng, lat, radius: radiusM },
      );
    }

    const results = await qb
      .orderBy('ride.started_at', 'DESC')
      .limit(feedLimit)
      .getMany();

    return results.map((sr) => this.toFeedRide(sr));
  }

  private toFeedRide(sr: SharedRide): FeedRideDto {
    const ride = sr.ride;
    let durationMin: number | null = null;
    if (ride.ended_at) {
      durationMin = Math.round(
        (ride.ended_at.getTime() - ride.started_at.getTime()) / 60000,
      );
    }

    return {
      ride_id: ride.id,
      share_token: sr.share_token,
      rider_id: sr.user_id,
      rider_name: sr.user?.display_name ?? 'Unknown',
      ride_type: ride.ride_type,
      started_at: ride.started_at.toISOString(),
      distance_km: ride.distance_km,
      avg_speed: ride.avg_speed,
      avg_road_quality: ride.avg_road_quality,
      duration_min: durationMin,
    };
  }
}
