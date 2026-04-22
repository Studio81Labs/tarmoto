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

    const shared = await this.sharedRideRepo.findOne({
      where: { ride_id: rideId },
    });

    if (shared) {
      // Targeted `update` of just the toggled column — a full `save` of
      // the loaded entity would write `view_count` back too and clobber
      // any increments that landed between the `findOne` above and the
      // write (lost-update race against concurrent `getByToken` hits).
      await this.sharedRideRepo.update(
        { id: shared.id },
        { is_public: isPublic },
      );
      shared.is_public = isPublic;
      return this.toShareResponse(shared);
    }

    // Fresh row — no concurrent writer can be incrementing view_count
    // on something that doesn't exist yet, so the create branch stays
    // on `save`.
    const created = await this.sharedRideRepo.save(
      this.sharedRideRepo.create({
        ride_id: rideId,
        user_id: userId,
        share_token: randomBytes(16).toString('hex'),
        is_public: isPublic,
      }),
    );
    return this.toShareResponse(created);
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

    // Atomic UPDATE ... SET view_count = view_count + 1 — safe under
    // concurrent fetches, unlike read-modify-write. The in-memory `shared`
    // is already loaded so we bump its `view_count` by one for the
    // response rather than round-tripping a re-select.
    await this.sharedRideRepo.increment({ id: shared.id }, 'view_count', 1);
    shared.view_count = (shared.view_count ?? 0) + 1;

    return this.toDetailResponse(shared);
  }

  /**
   * Browse the public community feed (US-53).
   *
   * Filters and pagination are all optional — the default is "newest 20
   * public rides globally". When `lat`/`lng` are supplied the result set is
   * narrowed to rides with a stored `route_geom` within `radius_km` (default
   * 25 km). When `sort = 'nearest'` the centre point is required (enforced
   * by the DTO) and the result is ordered by distance from it.
   *
   * Each sort uses `ride.id` as a stable secondary key so paging is
   * reproducible across requests when the primary sort key ties.
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
      .where('sr.is_public = true');

    if (hasCentre) {
      // Only the spatial branch needs the geometry. The global feed
      // intentionally keeps rides without a stored track so they can still
      // appear as stats-only cards.
      qb.andWhere('ride.route_geom IS NOT NULL').andWhere(
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

    this.applySort(qb, sort, query.lng, query.lat);

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
    lng: number | undefined,
    lat: number | undefined,
  ): void {
    // `ride.id` acts as a stable secondary sort so paging stays reproducible
    // when the primary key ties (common with `distance_km` and
    // `avg_road_quality`; rare but possible on microsecond `started_at`).
    switch (sort) {
      case 'oldest':
        qb.orderBy('ride.started_at', 'ASC').addOrderBy('ride.id', 'ASC');
        break;
      case 'longest':
        // NULLS LAST so rides that haven't computed a distance yet sink to
        // the bottom rather than masquerading as the longest.
        qb.orderBy('ride.distance_km', 'DESC', 'NULLS LAST').addOrderBy(
          'ride.id',
          'DESC',
        );
        break;
      case 'shortest':
        qb.orderBy('ride.distance_km', 'ASC', 'NULLS LAST').addOrderBy(
          'ride.id',
          'ASC',
        );
        break;
      case 'highest_quality':
        qb.orderBy('ride.avg_road_quality', 'DESC', 'NULLS LAST').addOrderBy(
          'ride.id',
          'DESC',
        );
        break;
      case 'most_popular':
        // `view_count` is NOT NULL (defaulted to 0 in the migration) so no
        // NULLS LAST is needed here. Unshared-then-reshared rides restart
        // at 0, which matches the intuition: popularity follows the
        // current share token.
        qb.orderBy('sr.view_count', 'DESC').addOrderBy('ride.id', 'DESC');
        break;
      case 'nearest':
        // DTO validation guarantees both coordinates are set when
        // `sort = 'nearest'`, so we can go straight to the spatial ORDER BY.
        qb.orderBy(
          'ST_Distance(ride.route_geom::geography, ST_SetSRID(ST_MakePoint(:sortLng, :sortLat), 4326)::geography)',
          'ASC',
        )
          .addOrderBy('ride.id', 'ASC')
          .setParameters({ sortLng: lng, sortLat: lat });
        break;
      case 'newest':
      default:
        qb.orderBy('ride.started_at', 'DESC').addOrderBy('ride.id', 'DESC');
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
      view_count: shared.view_count ?? 0,
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
      view_count: sr.view_count ?? 0,
    };
  }

  private calcDurationMin(ride: Ride): number | null {
    if (!ride.ended_at) return null;
    return Math.round(
      (ride.ended_at.getTime() - ride.started_at.getTime()) / 60000,
    );
  }
}
