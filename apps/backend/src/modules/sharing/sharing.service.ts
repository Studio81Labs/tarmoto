import { randomBytes } from 'node:crypto';
import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, SelectQueryBuilder } from 'typeorm';
import { SharedRide } from '../../entities/shared-ride.entity.js';
import { Ride } from '../../entities/ride.entity.js';
import {
  SharedRideResponseDto,
  SharedRideDetailDto,
  CommunityRideDto,
  CommunityRidesResponseDto,
  CommunityRidesQueryDto,
  type CommunityRideSort,
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

  /**
   * Browse the public community feed (US-53).
   *
   * Filters and pagination are all optional — the default is "newest 20
   * public rides globally". When `lat`/`lng` are supplied the result set is
   * narrowed to rides whose `route_geom` is within `radius_km` (default
   * 25 km). When `sort = 'nearest'` the centre point is required and the
   * result is ordered by distance from it.
   *
   * Returns the same `total` count for the filter regardless of `limit` /
   * `offset` so the client can render "page X of N" cards.
   */
  async listCommunityRides(
    query: CommunityRidesQueryDto,
  ): Promise<CommunityRidesResponseDto> {
    const limit = query.limit ?? 20;
    const offset = query.offset ?? 0;
    const sort: CommunityRideSort = query.sort ?? 'newest';
    const radiusKm = query.radius_km ?? 25;
    const hasCentre = query.lat !== undefined && query.lng !== undefined;

    const qb = this.sharedRideRepo
      .createQueryBuilder('sr')
      .innerJoinAndSelect('sr.ride', 'ride')
      .innerJoinAndSelect('sr.user', 'user')
      .where('sr.is_public = true')
      .andWhere('ride.route_geom IS NOT NULL');

    if (hasCentre) {
      qb.andWhere(
        'ST_DWithin(ride.route_geom::geography, ST_SetSRID(ST_MakePoint(:lng, :lat), 4326)::geography, :radius)',
        { lng: query.lng, lat: query.lat, radius: radiusKm * 1000 },
      );
    }

    if (query.min_distance_km !== undefined) {
      qb.andWhere('ride.distance_km >= :min_distance', {
        min_distance: query.min_distance_km,
      });
    }
    if (query.max_distance_km !== undefined) {
      qb.andWhere('ride.distance_km <= :max_distance', {
        max_distance: query.max_distance_km,
      });
    }
    if (query.min_quality !== undefined) {
      qb.andWhere('ride.avg_road_quality >= :min_quality', {
        min_quality: query.min_quality,
      });
    }
    if (query.ride_type !== undefined) {
      qb.andWhere('ride.ride_type = :ride_type', {
        ride_type: query.ride_type,
      });
    }

    this.applySort(qb, sort, hasCentre, query.lng, query.lat);

    qb.skip(offset).take(limit);

    const [rows, total] = await qb.getManyAndCount();

    return {
      items: rows.map((sr) =>
        this.toCommunityDto(
          sr as SharedRide & { ride: Ride; user: { display_name: string } },
        ),
      ),
      total,
      limit,
      offset,
    };
  }

  private applySort(
    qb: SelectQueryBuilder<SharedRide>,
    sort: CommunityRideSort,
    hasCentre: boolean,
    lng: number | undefined,
    lat: number | undefined,
  ): void {
    switch (sort) {
      case 'oldest':
        qb.orderBy('ride.started_at', 'ASC');
        break;
      case 'longest':
        // NULLS LAST so rides that haven't computed a distance yet sink to
        // the bottom rather than masquerading as the longest.
        qb.orderBy('ride.distance_km', 'DESC', 'NULLS LAST');
        break;
      case 'shortest':
        qb.orderBy('ride.distance_km', 'ASC', 'NULLS LAST');
        break;
      case 'highest_quality':
        qb.orderBy('ride.avg_road_quality', 'DESC', 'NULLS LAST');
        break;
      case 'nearest':
        // Validated upstream by the DTO, but defend in depth: silently fall
        // back to `newest` if the centre is missing so we don't issue an
        // ST_Distance against null.
        if (hasCentre) {
          qb.orderBy(
            'ST_Distance(ride.route_geom::geography, ST_SetSRID(ST_MakePoint(:sortLng, :sortLat), 4326)::geography)',
            'ASC',
          ).setParameters({ sortLng: lng, sortLat: lat });
          break;
        }
        qb.orderBy('ride.started_at', 'DESC');
        break;
      case 'newest':
      default:
        qb.orderBy('ride.started_at', 'DESC');
    }
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
