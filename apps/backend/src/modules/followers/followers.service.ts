import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UserFollow } from '../../entities/user-follow.entity.js';
import { User } from '../../entities/user.entity.js';
import { SharedRide } from '../../entities/shared-ride.entity.js';
import {
  FollowUserResponseDto,
  FollowerDto,
  FollowingDto,
  FeedRideDto,
} from './dto/followers.dto.js';

@Injectable()
export class FollowersService {
  constructor(
    @InjectRepository(UserFollow)
    private readonly followRepo: Repository<UserFollow>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    @InjectRepository(SharedRide)
    private readonly sharedRideRepo: Repository<SharedRide>,
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

    return {
      following_id: followingId,
      display_name: target.display_name,
      followed_at: follow.created_at.toISOString(),
    };
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
