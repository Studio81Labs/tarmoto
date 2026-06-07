import { randomBytes } from 'node:crypto';
import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, SelectQueryBuilder, In } from 'typeorm';
import { SharedRide } from '../../entities/shared-ride.entity.js';
import { RideLike } from '../../entities/ride-like.entity.js';
import { Ride } from '../../entities/ride.entity.js';
import { User } from '../../entities/user.entity.js';
import { Trip } from '../../entities/trip.entity.js';
import { TripDay } from '../../entities/trip-day.entity.js';
import { TripMember } from '../../entities/trip-member.entity.js';
import { PrivacyPreferencesService } from '../account/privacy-preferences.service.js';
import { TripsService } from '../trips/trips.service.js';
import {
  SharedRideResponseDto,
  SharedRideDetailDto,
  CommunityRideDto,
  CommunityRidesResponseDto,
  CommunityRidesQueryDto,
  type CommunityRideSort,
  RideLikeResponseDto,
  CloneRideResponseDto,
  UserSharedRideDto,
  UserSharedRidesQueryDto,
  UserSharedRidesResponseDto,
} from './dto/sharing.dto.js';

@Injectable()
export class SharingService {
  constructor(
    @InjectRepository(SharedRide)
    private readonly sharedRideRepo: Repository<SharedRide>,
    @InjectRepository(RideLike)
    private readonly rideLikeRepo: Repository<RideLike>,
    @InjectRepository(Ride)
    private readonly rideRepo: Repository<Ride>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    @InjectRepository(Trip)
    private readonly tripRepo: Repository<Trip>,
    @InjectRepository(TripDay)
    private readonly tripDayRepo: Repository<TripDay>,
    @InjectRepository(TripMember)
    private readonly tripMemberRepo: Repository<TripMember>,
    private readonly tripsService: TripsService,
    private readonly privacy: PrivacyPreferencesService,
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
    // Soft-deleted owners (US-62) — pretend the share doesn't exist so
    // share-link traffic during the grace window can't surface the
    // rider's identity.
    if (!shared || shared.user?.deleted_at != null) {
      throw new NotFoundException('Shared ride not found');
    }

    // #279: rider privacy. A `private` profile means "don't show me
    // anywhere" — including via shared-ride link, which is the most
    // accidentally-leaky surface (anyone with the URL gets the rider
    // name). 404 mirrors the deleted-owner gate so callers can't
    // side-channel the difference between "doesn't exist" and "owner
    // hidden". `riders-only` and `public` both pass — the link is an
    // intentional disclosure by the rider and overrides the
    // signed-in-only audience hint.
    const ownerPrefs = await this.privacy.loadPreferences(shared.user_id);
    if (ownerPrefs.profile_visibility === 'private') {
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

  async trackEmbedClick(token: string): Promise<void> {
    const shared = await this.sharedRideRepo.findOne({
      where: { share_token: token },
      relations: ['user'],
    });
    // Same deleted-owner gate as `getByToken` (US-62) — without it a
    // caller can probe `/embed-click` to side-channel whether a token
    // belongs to a deleted owner vs. an unknown share.
    if (!shared || shared.user?.deleted_at != null) {
      throw new NotFoundException('Shared ride not found');
    }

    // #279: same private-profile gate as `getByToken`. Without it a
    // caller could probe `/embed-click` to confirm that a hidden
    // share token exists, AND we'd record engagement against content
    // that's supposed to be hidden — both are inconsistent with the
    // 404 the read path returns for the same token.
    const ownerPrefs = await this.privacy.loadPreferences(shared.user_id);
    if (ownerPrefs.profile_visibility === 'private') {
      throw new NotFoundException('Shared ride not found');
    }

    await this.sharedRideRepo.increment(
      { id: shared.id },
      'embed_click_count',
      1,
    );
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
    viewerId?: string,
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
      // Drop `private` profiles outright — the privacy gate (#279) is the
      // user's explicit "do not show me anywhere", and the community feed
      // is the most public surface in the app. Done with a LEFT JOIN so
      // riders without a row (defaults apply, not private) still pass.
      .leftJoin('privacy_preferences', 'pp', 'pp.user_id = sr.user_id')
      .where('sr.is_public = true')
      // Hide rides owned by accounts that have requested deletion (US-62).
      // The hard-delete sweep removes the rows entirely; this filter
      // covers the 30-day grace window in between.
      .andWhere('user.deleted_at IS NULL');

    if (viewerId) {
      // Signed-in viewers see public + riders-only owners (NULL = the
      // riders-only default); only `private` profiles are hidden.
      qb.andWhere(
        "(pp.profile_visibility IS NULL OR pp.profile_visibility <> 'private')",
      );
    } else {
      // Anonymous (no token) viewers only see public-profile owners — the
      // response carries `rider_id`/`rider_name`, so `riders-only` (and the
      // NULL default) is a signed-in-only audience that must not leak.
      qb.andWhere("pp.profile_visibility = 'public'");
    }

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
    if (query.min_popularity !== undefined) {
      qb.andWhere('sr.view_count >= :min_popularity', {
        min_popularity: query.min_popularity,
      });
    }
    if (query.min_curviness !== undefined) {
      // Exclude rides without a computed aggregate — a null `avg_curviness`
      // means "unknown", not "not curvy", and letting them through would
      // contaminate "show me the twisty rides" results.
      qb.andWhere('ride.avg_curviness IS NOT NULL').andWhere(
        'ride.avg_curviness >= :min_curviness',
        { min_curviness: query.min_curviness },
      );
    }
    if (query.max_curviness !== undefined) {
      qb.andWhere('ride.avg_curviness IS NOT NULL').andWhere(
        'ride.avg_curviness <= :max_curviness',
        { max_curviness: query.max_curviness },
      );
    }
    if (query.ride_type !== undefined) {
      qb.andWhere('ride.ride_type = :ride_type', {
        ride_type: query.ride_type,
      });
    }

    this.applySort(qb, sort, query.lng, query.lat);

    qb.skip(offset).take(limit);

    const [rows, total] = await qb.getManyAndCount();

    // Batch the heart counts (+ the viewer's own likes) for the page's rides
    // in two small queries rather than a per-row correlated subquery.
    const rideIds = rows.map((sr) => sr.ride.id);
    const [likeCounts, likedRideIds] = await Promise.all([
      this.likeCountsFor(rideIds),
      viewerId ? this.likedRideIds(viewerId, rideIds) : Promise.resolve(null),
    ]);

    return {
      items: rows.map((sr) =>
        this.toCommunityDto(
          sr as SharedRide & { ride: Ride; user: { display_name: string } },
          likeCounts.get(sr.ride.id) ?? 0,
          likedRideIds?.has(sr.ride.id) ?? false,
        ),
      ),
      total,
      limit,
      offset,
    };
  }

  private async likeCountsFor(
    rideIds: readonly string[],
  ): Promise<Map<string, number>> {
    if (rideIds.length === 0) return new Map();
    const rows = await this.rideLikeRepo
      .createQueryBuilder('rl')
      .select('rl.ride_id', 'ride_id')
      .addSelect('COUNT(*)', 'cnt')
      .where('rl.ride_id IN (:...ids)', { ids: rideIds })
      .groupBy('rl.ride_id')
      .getRawMany<{ ride_id: string; cnt: string }>();
    return new Map(rows.map((r) => [r.ride_id, parseInt(r.cnt, 10)]));
  }

  private async likedRideIds(
    userId: string,
    rideIds: readonly string[],
  ): Promise<Set<string>> {
    if (rideIds.length === 0) return new Set();
    const rows = await this.rideLikeRepo.find({
      where: { user_id: userId, ride_id: In(rideIds as string[]) },
      select: { ride_id: true },
    });
    return new Set(rows.map((r) => r.ride_id));
  }

  /**
   * Per-rider list of shared rides for the profile screen (#336).
   *
   * Privacy gates mirror the read paths elsewhere in this module:
   *   - soft-deleted owners 404 (don't surface identity during the
   *     30-day grace window — same gate as `getByToken`)
   *   - non-self viewer + `profile_visibility === 'private'` 404 so
   *     callers can't side-channel "exists but hidden" vs "doesn't
   *     exist"
   *   - `riders-only` and `public` both pass — every caller of this
   *     endpoint is authenticated (route is behind AuthGuard), so a
   *     `riders-only` audience is always satisfied
   *
   * Per-share visibility:
   *   - non-self viewers only see `is_public = true` rows (a private
   *     share is the rider's "off" toggle on a per-ride basis)
   *   - the rider viewing themselves sees both, so they can spot a
   *     ride they shared but later flipped to private
   *
   * Sorted newest-first by `shared_at` (sr.created_at) with `sr.id`
   * as a stable secondary key — paging stays reproducible if two
   * shares land in the same microsecond.
   */
  async listForUser(
    viewerId: string,
    userId: string,
    query: UserSharedRidesQueryDto,
  ): Promise<UserSharedRidesResponseDto> {
    const limit = query.limit ?? 20;
    const offset = query.offset ?? 0;
    const isSelf = viewerId === userId;

    const owner = await this.userRepo.findOne({ where: { id: userId } });
    if (!owner || owner.deleted_at != null) {
      throw new NotFoundException('User not found');
    }

    if (!isSelf) {
      const ownerPrefs = await this.privacy.loadPreferences(userId);
      if (ownerPrefs.profile_visibility === 'private') {
        throw new NotFoundException('User not found');
      }
    }

    const qb = this.sharedRideRepo
      .createQueryBuilder('sr')
      .innerJoinAndSelect('sr.ride', 'ride')
      .where('sr.user_id = :userId', { userId });

    if (!isSelf) {
      qb.andWhere('sr.is_public = true');
    }

    qb.orderBy('sr.created_at', 'DESC')
      .addOrderBy('sr.id', 'DESC')
      .skip(offset)
      .take(limit);

    const [rows, total] = await qb.getManyAndCount();

    return {
      items: rows.map((sr) => this.toUserSharedRideDto(sr)),
      total,
      limit,
      offset,
    };
  }

  /** Heart a community route (idempotent). Returns the new count + state. */
  async likeRide(userId: string, rideId: string): Promise<RideLikeResponseDto> {
    await this.assertCommunityRide(rideId);
    // ON CONFLICT DO NOTHING — a double-tap (the unique (ride_id, user_id)
    // collision) is a no-op, but any *real* write failure (FK drift, transient
    // DB error, constraint issue) still throws rather than reporting a phantom
    // "liked" state to the client.
    await this.rideLikeRepo
      .createQueryBuilder()
      .insert()
      .values({ ride_id: rideId, user_id: userId })
      .orIgnore()
      .execute();
    return {
      like_count: await this.rideLikeRepo.count({ where: { ride_id: rideId } }),
      viewer_has_liked: true,
    };
  }

  /** Remove a heart (idempotent). */
  async unlikeRide(
    userId: string,
    rideId: string,
  ): Promise<RideLikeResponseDto> {
    await this.assertCommunityRide(rideId);
    await this.rideLikeRepo.delete({ ride_id: rideId, user_id: userId });
    return {
      like_count: await this.rideLikeRepo.count({ where: { ride_id: rideId } }),
      viewer_has_liked: false,
    };
  }

  /** Clone a shared route into a new draft trip owned by the caller. */
  async cloneRide(
    userId: string,
    rideId: string,
  ): Promise<CloneRideResponseDto> {
    const shared = await this.assertCommunityRide(rideId);
    const ride =
      shared.ride ?? (await this.rideRepo.findOne({ where: { id: rideId } }));
    if (!ride) {
      throw new NotFoundException('Shared ride not found');
    }
    if (!ride.route_geom) {
      throw new BadRequestException(
        'This route has no recorded geometry to clone',
      );
    }

    const title = ride.name?.trim() || 'Cloned route';
    // Atomic: the trip, its owner membership, the day, and the clone-count
    // bump all commit together — a mid-sequence failure leaves no orphan or
    // half-built trip (mirrors the trip create/duplicate paths). Allocate the
    // invite code through TripsService so a rare `idx_trips_invite_code`
    // collision retries with a fresh code instead of 500-ing the clone.
    return this.tripsService.withInviteCodeAllocation(
      async (manager, inviteCode) => {
        const trip = await manager.save(
          this.tripRepo.create({
            owner_id: userId,
            title,
            num_days: 1,
            status: 'draft',
            invite_code: inviteCode,
          }),
        );
        await manager.save(
          this.tripMemberRepo.create({
            trip_id: trip.id,
            user_id: userId,
            role: 'owner',
          }),
        );
        await manager.save(
          this.tripDayRepo.create({
            trip_id: trip.id,
            day_number: 1,
            title,
            distance_km: ride.distance_km,
            route_geom: ride.route_geom,
            avg_quality: ride.avg_road_quality,
            curviness_score: ride.avg_curviness ?? null,
          }),
        );
        await manager.increment(
          SharedRide,
          { id: shared.id },
          'clone_count',
          1,
        );
        // Read the post-increment value within the same transaction so two
        // concurrent clones don't each report a stale `old + 1`.
        const updated = await manager.findOne(SharedRide, {
          where: { id: shared.id },
          select: { id: true, clone_count: true },
        });
        return {
          trip_id: trip.id,
          clone_count: updated?.clone_count ?? (shared.clone_count ?? 0) + 1,
        };
      },
    );
  }

  /**
   * Resolve a ride that's actually in the community feed (publicly shared,
   * owner not deleted or private). Likes/clones target the public route, not
   * an arbitrary ride id, so a private/unshared ride 404s like the read path.
   */
  private async assertCommunityRide(rideId: string): Promise<SharedRide> {
    const shared = await this.sharedRideRepo.findOne({
      where: { ride_id: rideId, is_public: true },
      relations: { ride: true, user: true },
    });
    if (!shared || shared.user?.deleted_at != null) {
      throw new NotFoundException('Shared ride not found');
    }
    const prefs = await this.privacy.loadPreferences(shared.user_id);
    if (prefs.profile_visibility === 'private') {
      throw new NotFoundException('Shared ride not found');
    }
    return shared;
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
      case 'curviest':
        qb.orderBy('ride.avg_curviness', 'DESC', 'NULLS LAST').addOrderBy(
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
    const routeGeometry = this.toRouteGeometry(ride);

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
      avg_curviness: ride.avg_curviness ?? null,
      duration_min: durationMin,
      view_count: shared.view_count ?? 0,
      embed_click_count: shared.embed_click_count ?? 0,
      route_geometry: routeGeometry,
    };
  }

  private toCommunityDto(
    sr: SharedRide & {
      ride: Ride;
      user: { display_name: string; avatar_url?: string | null };
    },
    likeCount: number,
    viewerHasLiked: boolean,
  ): CommunityRideDto {
    const ride = sr.ride;
    return {
      id: ride.id,
      share_token: sr.share_token,
      rider_id: sr.user_id,
      rider_name: sr.user?.display_name ?? 'Unknown',
      rider_avatar_url: sr.user?.avatar_url ?? null,
      name: ride.name ?? null,
      ride_type: ride.ride_type,
      started_at: ride.started_at.toISOString(),
      distance_km: ride.distance_km,
      avg_speed: ride.avg_speed,
      avg_road_quality: ride.avg_road_quality,
      avg_curviness: ride.avg_curviness ?? null,
      duration_min: this.calcDurationMin(ride),
      view_count: sr.view_count ?? 0,
      description: sr.caption ?? null,
      like_count: likeCount,
      viewer_has_liked: viewerHasLiked,
      clone_count: sr.clone_count ?? 0,
      route_geometry: this.toRoutePreviewGeometry(ride),
    };
  }

  private toUserSharedRideDto(
    sr: SharedRide & { ride: Ride },
  ): UserSharedRideDto {
    const ride = sr.ride;
    return {
      id: ride.id,
      share_token: sr.share_token,
      ride_type: ride.ride_type,
      is_public: sr.is_public,
      started_at: ride.started_at.toISOString(),
      ended_at: ride.ended_at?.toISOString() ?? null,
      distance_km: ride.distance_km,
      avg_speed: ride.avg_speed,
      avg_road_quality: ride.avg_road_quality,
      avg_curviness: ride.avg_curviness ?? null,
      duration_min: this.calcDurationMin(ride),
      view_count: sr.view_count ?? 0,
      shared_at: sr.created_at.toISOString(),
      route_geometry: this.toRoutePreviewGeometry(ride),
    };
  }

  private toRouteGeometry(
    ride: Ride,
  ): Array<{ lat: number; lng: number }> | null {
    if (!ride.route_geom) return null;
    const geom = ride.route_geom as unknown as {
      coordinates?: number[][];
    };
    if (!geom.coordinates) return null;
    return geom.coordinates.map((c) => ({
      lat: c[1],
      lng: c[0],
    }));
  }

  private toRoutePreviewGeometry(
    ride: Ride,
    maxPoints = 32,
  ): Array<{ lat: number; lng: number }> | null {
    const geometry = this.toRouteGeometry(ride);
    if (!geometry || geometry.length <= maxPoints) return geometry;

    const step = (geometry.length - 1) / (maxPoints - 1);
    return Array.from({ length: maxPoints }, (_, index) => {
      const pointIndex = Math.round(index * step);
      return geometry[pointIndex];
    });
  }

  private calcDurationMin(ride: Ride): number | null {
    if (!ride.ended_at) return null;
    return Math.round(
      (ride.ended_at.getTime() - ride.started_at.getTime()) / 60000,
    );
  }
}
