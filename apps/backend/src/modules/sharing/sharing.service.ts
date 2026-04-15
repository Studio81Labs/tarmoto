import { randomBytes } from 'node:crypto';
import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SharedRide } from '../../entities/shared-ride.entity.js';
import { Ride } from '../../entities/ride.entity.js';
import {
  SharedRideResponseDto,
  SharedRideDetailDto,
  CommunityRideDto,
} from './dto/sharing.dto.js';

@Injectable()
export class SharingService {
  constructor(
    @InjectRepository(SharedRide)
    private readonly sharedRideRepo: Repository<SharedRide>,
    @InjectRepository(Ride)
    private readonly rideRepo: Repository<Ride>,
  ) {}

  async toggleShare(
    userId: string,
    rideId: string,
    isPublic: boolean,
  ): Promise<SharedRideResponseDto> {
    // Verify ride belongs to user and is completed
    const ride = await this.rideRepo.findOne({
      where: { id: rideId, user_id: userId },
    });
    if (!ride) {
      throw new NotFoundException('Ride not found');
    }
    if (ride.status !== 'completed') {
      throw new BadRequestException('Only completed rides can be shared');
    }

    let shared = await this.sharedRideRepo.findOne({
      where: { ride_id: rideId },
    });

    if (shared) {
      // Update existing share
      shared.is_public = isPublic;
      shared = await this.sharedRideRepo.save(shared);
    } else {
      // Create new share
      shared = this.sharedRideRepo.create({
        ride_id: rideId,
        user_id: userId,
        share_token: randomBytes(16).toString('hex'),
        is_public: isPublic,
      });
      shared = await this.sharedRideRepo.save(shared);
    }

    return this.toShareResponse(shared);
  }

  async unshare(userId: string, rideId: string): Promise<void> {
    const shared = await this.sharedRideRepo.findOne({
      where: { ride_id: rideId, user_id: userId },
    });
    if (!shared) {
      throw new NotFoundException('Shared ride not found');
    }
    await this.sharedRideRepo.remove(shared);
  }

  async getByToken(token: string): Promise<SharedRideDetailDto> {
    const shared = await this.sharedRideRepo.findOne({
      where: { share_token: token },
      relations: ['ride', 'user'],
    });
    if (!shared) {
      throw new NotFoundException('Shared ride not found');
    }

    return this.toDetailResponse(shared);
  }

  async listCommunityRides(
    lat: number,
    lng: number,
    radiusKm: number,
    limit: number,
  ): Promise<CommunityRideDto[]> {
    const radiusM = radiusKm * 1000;

    const results: Array<
      SharedRide & { ride: Ride; user: { display_name: string } }
    > = await this.sharedRideRepo
      .createQueryBuilder('sr')
      .innerJoinAndSelect('sr.ride', 'ride')
      .innerJoinAndSelect('sr.user', 'user')
      .where('sr.is_public = true')
      .andWhere('ride.route_geom IS NOT NULL')
      .andWhere(
        'ST_DWithin(ride.route_geom::geography, ST_SetSRID(ST_MakePoint(:lng, :lat), 4326)::geography, :radius)',
        { lng, lat, radius: radiusM },
      )
      .orderBy('ride.started_at', 'DESC')
      .limit(limit)
      .getMany();

    return results.map((sr) => this.toCommunityDto(sr));
  }

  private toShareResponse(shared: SharedRide): SharedRideResponseDto {
    return {
      share_token: shared.share_token,
      is_public: shared.is_public,
      share_url: `/rides/shared/${shared.share_token}`,
    };
  }

  private toDetailResponse(shared: SharedRide): SharedRideDetailDto {
    const ride = shared.ride;
    let routeGeometry: Array<{ lat: number; lng: number }> | null = null;
    if (ride.route_geom) {
      const geom = ride.route_geom as unknown as {
        coordinates: number[][];
      };
      if (geom.coordinates) {
        routeGeometry = geom.coordinates.map((c) => ({
          lat: c[1],
          lng: c[0],
        }));
      }
    }

    const durationMin = this.calcDurationMin(ride);

    return {
      id: ride.id,
      rider_name: shared.user?.display_name ?? 'Unknown',
      ride_type: ride.ride_type,
      started_at: ride.started_at.toISOString(),
      ended_at: ride.ended_at?.toISOString() ?? null,
      distance_km: ride.distance_km,
      avg_speed: ride.avg_speed,
      max_speed: ride.max_speed,
      avg_road_quality: ride.avg_road_quality,
      duration_min: durationMin,
      route_geometry: routeGeometry,
    };
  }

  private toCommunityDto(
    sr: SharedRide & { ride: Ride; user: { display_name: string } },
  ): CommunityRideDto {
    const ride = sr.ride;
    return {
      id: ride.id,
      share_token: sr.share_token,
      rider_name: sr.user?.display_name ?? 'Unknown',
      ride_type: ride.ride_type,
      started_at: ride.started_at.toISOString(),
      distance_km: ride.distance_km,
      avg_speed: ride.avg_speed,
      avg_road_quality: ride.avg_road_quality,
      duration_min: this.calcDurationMin(ride),
    };
  }

  private calcDurationMin(ride: Ride): number | null {
    if (!ride.ended_at) return null;
    return Math.round(
      (ride.ended_at.getTime() - ride.started_at.getTime()) / 60000,
    );
  }
}
