import {
  BadGatewayException,
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, In, Repository } from 'typeorm';
import { haversineKm, latLngToPoint, pointToLatLng } from '@tarmoto/shared';
import { Trip } from '../../entities/trip.entity.js';
import { TripDay } from '../../entities/trip-day.entity.js';
import { TripFolder } from '../../entities/trip-folder.entity.js';
import { TripMember } from '../../entities/trip-member.entity.js';
import { TripInvite } from '../../entities/trip-invite.entity.js';
import { TripSuggestion } from '../../entities/trip-suggestion.entity.js';
import { TripWaypoint } from '../../entities/trip-waypoint.entity.js';
import { RouteCollectionItem } from '../../entities/route-collection-item.entity.js';
import { User } from '../../entities/user.entity.js';
import { getCompanionUrl } from '../../common/companion-url.js';
import { EmailService } from '../email/email.service.js';
import { EventsGateway } from '../events/events.gateway.js';
import { TripActivityService } from '../trip-activity/trip-activity.service.js';
import { TripSharesService } from '../trip-shares/trip-shares.service.js';
import { PrivacyPreferencesService } from '../account/privacy-preferences.service.js';
import {
  ROUTING_PROVIDER,
  type RoutingProvider,
} from '../commute/routing-provider.interface.js';
import { RouteEnrichmentService } from '../routing/route-enrichment.service.js';
import { CreateTripDto } from './dto/create-trip.dto.js';
import { FromShareTripDto } from './dto/from-share-trip.dto.js';
import { ImportTripDto } from './dto/import-trip.dto.js';
import { InviteTripDto } from './dto/invite-trip.dto.js';
import { generateInviteCode } from './invite-code.js';
import type { TripCollaboratorsDto } from './dto/collaborators.dto.js';
import { ListTripsDto } from './dto/list-trips.dto.js';
import { SaveRouteDayDto, SaveRouteDto } from './dto/save-route.dto.js';
import type { RoutePreferenceOption } from '../routing/dto/route.dto.js';
import { UpdateTripDto } from './dto/update-trip.dto.js';
import {
  PublicTripDetailDto,
  TripDayDto,
  TripDetailDto,
  TripMemberDto,
  TripSummaryDto,
  TripWaypointDto,
  type TripStatus,
  type TripRoadPreference,
  type TripMemberRole,
  type TripWaypointType,
} from './dto/trip-response.dto.js';

const DEFAULT_DAILY_KM_MIN = 150;
const DEFAULT_DAILY_KM_MAX = 350;
const DEFAULT_MIN_QUALITY = 3.0;
const DEFAULT_ROAD_PREFERENCE = 'curvy';

// Roles allowed to mutate trip-wide metadata. Keeping this in one place
// so role checks stay consistent if we ever grow the role vocabulary.
// `editor` replaced the old `admin`/`member` pair (migration 1793):
// editors co-plan the route; `viewer` is the read-and-comment tier that
// anonymous link-joiners start in.
const PRIVILEGED_ROLES = new Set(['owner', 'editor']);

@Injectable()
export class TripsService {
  private readonly logger = new Logger(TripsService.name);

  constructor(
    @InjectRepository(Trip)
    private readonly tripRepo: Repository<Trip>,
    @InjectRepository(TripDay)
    private readonly tripDayRepo: Repository<TripDay>,
    @InjectRepository(TripMember)
    private readonly memberRepo: Repository<TripMember>,
    @InjectRepository(TripFolder)
    private readonly folderRepo: Repository<TripFolder>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    @InjectRepository(TripInvite)
    private readonly inviteRepo: Repository<TripInvite>,
    @InjectRepository(RouteCollectionItem)
    private readonly collectionItemRepo: Repository<RouteCollectionItem>,
    private readonly events: EventsGateway,
    private readonly activity: TripActivityService,
    private readonly tripShares: TripSharesService,
    private readonly email: EmailService,
    private readonly config: ConfigService,
    private readonly privacy: PrivacyPreferencesService,
    @Inject(ROUTING_PROVIDER)
    private readonly routingProvider: RoutingProvider,
    private readonly enrichment: RouteEnrichmentService,
  ) {}

  async create(userId: string, dto: CreateTripDto): Promise<TripDetailDto> {
    // Validate against the EFFECTIVE values after defaults apply, so that
    // a partial input like `{ daily_km_min: 500 }` is caught against the
    // default `daily_km_max: 350` instead of silently persisting an
    // invalid `min > max` row.
    const dailyKmMin = dto.daily_km_min ?? DEFAULT_DAILY_KM_MIN;
    const dailyKmMax = dto.daily_km_max ?? DEFAULT_DAILY_KM_MAX;
    if (dailyKmMin > dailyKmMax) {
      throw new BadRequestException(
        'daily_km_min must be less than or equal to daily_km_max',
      );
    }

    // US-37 — folder ownership: a non-null `folder_id` must reference
    // one of the caller's folders. Cross-user references 404 (not
    // 403) so the endpoint stays a non-channel for enumerating other
    // riders' folder ids. This is the same guard the trip update path
    // applies; pulling it forward to create lets the companion's
    // "Duplicate" action keep a filed trip in its folder without the
    // global `ValidationPipe` (forbidNonWhitelisted) 400-ing the body.
    if (dto.folder_id != null) {
      const folder = await this.folderRepo.findOne({
        where: { id: dto.folder_id, user_id: userId },
      });
      if (!folder) throw new NotFoundException('Folder not found');
    }

    // Trip + owner-membership go in a single transaction so we can never
    // commit an orphan trip the owner can't see (visibility is gated on
    // the membership row). On any error inside the callback the entire
    // unit rolls back.
    //
    // The invite code is generated inside the retry loop and the DB
    // unique index is the source of truth for collisions. A pre-check
    // would be racy: two concurrent creates can both pass it with the
    // same code, then the loser hits `23505` after the trip insert and
    // the caller gets a 500. With ~6.5e11 codes a real collision is
    // vanishingly rare; this loop just keeps the failure mode invisible.
    const savedId = await this.allocateAndPersistTrip(userId, dto, {
      dailyKmMin,
      dailyKmMax,
    });

    return this.getDetail(userId, savedId);
  }

  async duplicate(userId: string, tripId: string): Promise<TripDetailDto> {
    const source = await this.tripRepo.findOne({
      where: { id: tripId },
      relations: { days: { waypoints: true }, members: true },
    });
    if (!source) throw new NotFoundException('Trip not found');

    const isMember = source.members.some((m) => m.user_id === userId);
    if (source.owner_id !== userId && !isMember) {
      throw new NotFoundException('Trip not found');
    }

    // US-37 — only carry the source folder forward when the duplicating
    // user actually owns it. The companion's "Duplicate" action is
    // available to all members, but folders are private per-user, so
    // copying the original `folder_id` blindly would leak the owner's
    // folder layout into a co-collaborator's library (and the FK
    // ownership check on the row would fail at insert anyway). When
    // the duplicator isn't the source's owner, the duplicate lands
    // unfiled — that matches how every other folder-aware op gates
    // ownership.
    const carryFolderId =
      source.folder_id != null && source.owner_id === userId
        ? source.folder_id
        : null;

    const dupId = await this.withTripTransaction(async (em) => {
      const dup = await em.save(
        em.create(Trip, {
          owner_id: userId,
          title: nextCopyName(source.title),
          region: source.region,
          num_days: source.num_days,
          daily_km_min: source.daily_km_min,
          daily_km_max: source.daily_km_max,
          min_quality: source.min_quality,
          road_preference: source.road_preference,
          status: 'draft',
          folder_id: carryFolderId,
        }),
      );

      // Owner membership — required for visibility (every other creation
      // path adds it, and getDetail gates on it).
      await em.save(
        em.create(TripMember, {
          trip_id: dup.id,
          user_id: userId,
          role: 'owner',
        }),
      );

      for (const day of source.days) {
        const savedDay = await em.save(
          em.create(TripDay, {
            trip_id: dup.id,
            day_number: day.day_number,
            title: day.title,
            distance_km: day.distance_km,
            route_geom: day.route_geom,
            avg_quality: day.avg_quality,
            elevation_gain: day.elevation_gain,
            elevation_loss: day.elevation_loss,
            curviness_score: day.curviness_score,
            scenic_score: day.scenic_score,
            estimated_time: day.estimated_time,
            start_linked: day.start_linked,
            // Custom per-leg road characters travel with the copy —
            // dropping them would let the next edit/save reroute the
            // duplicate with the trip-wide preference.
            leg_preferences: day.leg_preferences,
          }),
        );

        if (day.waypoints?.length) {
          const waypoints = day.waypoints.map((wp) =>
            em.create(TripWaypoint, {
              trip_day_id: savedDay.id,
              location: wp.location,
              sequence: wp.sequence,
              name: wp.name,
              waypoint_type: wp.waypoint_type,
              road_segment_id: wp.road_segment_id,
              notes: wp.notes,
              duration_min: wp.duration_min,
            }),
          );
          await em.save(waypoints);
        }
      }

      return dup.id;
    });

    return this.getDetail(userId, dupId);
  }

  private async allocateAndPersistTrip(
    userId: string,
    dto: CreateTripDto,
    bounds: { dailyKmMin: number; dailyKmMax: number },
  ): Promise<string> {
    return this.withTripTransaction(async (manager) => {
      const trip = manager.create(Trip, {
        owner_id: userId,
        title: dto.title,
        region: dto.region ?? null,
        num_days: dto.num_days,
        daily_km_min: bounds.dailyKmMin,
        daily_km_max: bounds.dailyKmMax,
        min_quality: dto.min_quality ?? DEFAULT_MIN_QUALITY,
        road_preference: dto.road_preference ?? DEFAULT_ROAD_PREFERENCE,
        status: 'draft',
        folder_id: dto.folder_id ?? null,
      });
      const saved = await manager.save(trip);

      await manager.save(
        manager.create(TripMember, {
          trip_id: saved.id,
          user_id: userId,
          role: 'owner',
        }),
      );

      return saved.id;
    });
  }

  /**
   * Transactional wrapper shared by every trip-persist path
   * (`POST /trips`, `POST /trips/import`, duplication, ride cloning in
   * SharingService): the trip row, its owner membership, and any seeded
   * days/waypoints commit atomically so a mid-sequence failure leaves no
   * orphan or half-built trip. Public so sibling services reuse the same
   * transaction boundary.
   */
  async withTripTransaction<T>(
    persist: (manager: EntityManager) => Promise<T>,
  ): Promise<T> {
    return this.tripRepo.manager.transaction((manager) => persist(manager));
  }

  /**
   * US-20: create a trip seeded from a GPX/KML file. The mobile/companion
   * client parses the file locally (see `@tarmoto/shared/gpx-kml-import`)
   * and posts the normalised geometry + waypoints; we persist them as a
   * single planned day so the trip lands ready to ride instead of in
   * draft state. We do not invoke the route generator — the imported
   * file IS the route and overwriting it would defeat the import.
   */
  async importFromRoute(
    userId: string,
    dto: ImportTripDto,
  ): Promise<TripDetailDto> {
    const totalKm = totalDistanceKm(dto.geometry);
    // Imported trips are 1-day routes — daily_km_{min,max} both
    // represent the actual distance. The 1 km floor protects the
    // schema's positive-number constraint when the file is a
    // microscopic stub (zero or sub-km tracks have already been
    // rejected by the parser, but defending in depth here costs
    // nothing).
    const dailyKm = Math.max(1, Math.round(totalKm));
    const tripId = await this.allocateAndPersistImportedTrip(userId, dto, {
      totalKm,
      dailyKmMin: dailyKm,
      dailyKmMax: dailyKm,
    });
    return this.getDetail(userId, tripId);
  }

  async replaceWithImportedRoute(
    userId: string,
    tripId: string,
    dto: ImportTripDto,
  ): Promise<TripDetailDto> {
    const membership = await this.memberRepo.findOne({
      where: { trip_id: tripId, user_id: userId },
    });
    if (!membership || !PRIVILEGED_ROLES.has(membership.role)) {
      throw new NotFoundException('Trip not found');
    }

    const totalKm = totalDistanceKm(dto.geometry);
    const dailyKm = Math.max(1, Math.round(totalKm));

    await this.tripRepo.manager.transaction(async (manager) => {
      const locked = await manager.findOne(Trip, {
        where: { id: tripId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!locked) throw new NotFoundException('Trip not found');

      await manager.update(
        Trip,
        { id: tripId },
        {
          title: dto.title,
          region: dto.region ?? null,
          num_days: 1,
          daily_km_min: dailyKm,
          daily_km_max: dailyKm,
          status: 'planned',
        },
      );
      await manager.update(
        TripSuggestion,
        { trip_id: tripId },
        { trip_day_id: null },
      );
      await manager.delete(TripDay, { trip_id: tripId });
      await this.persistImportedRouteDay(manager, tripId, dto, totalKm);
    });

    const detail = await this.getDetail(userId, tripId);
    this.events.emitToTrip(tripId, 'trip:updated', detail);
    await this.activity.recordSafe(tripId, userId, 'trip_updated', {
      fields: ['imported_route'],
    });
    return detail;
  }

  private async allocateAndPersistImportedTrip(
    userId: string,
    dto: ImportTripDto,
    bounds: { totalKm: number; dailyKmMin: number; dailyKmMax: number },
  ): Promise<string> {
    return this.withTripTransaction(async (manager) => {
      const trip = manager.create(Trip, {
        owner_id: userId,
        title: dto.title,
        region: dto.region ?? null,
        num_days: 1,
        daily_km_min: bounds.dailyKmMin,
        daily_km_max: bounds.dailyKmMax,
        min_quality: DEFAULT_MIN_QUALITY,
        road_preference: DEFAULT_ROAD_PREFERENCE,
        // Imported files are routes the rider already has — surface
        // them as `planned` so they appear alongside generated trips
        // rather than in the "draft" bucket that needs another step.
        status: 'planned',
      });
      const savedTrip = await manager.save(trip);

      await manager.save(
        manager.create(TripMember, {
          trip_id: savedTrip.id,
          user_id: userId,
          role: 'owner',
        }),
      );

      await this.persistImportedRouteDay(
        manager,
        savedTrip.id,
        dto,
        bounds.totalKm,
      );

      return savedTrip.id;
    });
  }

  private async persistImportedRouteDay(
    manager: EntityManager,
    tripId: string,
    dto: ImportTripDto,
    totalKm: number,
  ): Promise<void> {
    const day = manager.create(TripDay, {
      trip_id: tripId,
      day_number: 1,
      title: dto.title,
      distance_km: Number(totalKm.toFixed(2)),
      // Rough estimate at 55 km/h — same heuristic the companion
      // uses for imported routes. Floor at 30 minutes so very
      // short test imports don't render as "0 min".
      estimated_time: `${Math.max(30, Math.round((totalKm / 55) * 60))} minutes`,
      avg_quality: null,
      curviness_score: null,
      scenic_score: null,
      elevation_gain: null,
      elevation_loss: null,
      route_geom: {
        type: 'LineString',
        coordinates: dto.geometry.map((p) => [p.lng, p.lat]),
      },
    });
    const savedDay = await manager.save(day);

    const waypoints = buildImportedWaypoints(dto);
    if (waypoints.length > 0) {
      const rows = waypoints.map((w, idx) =>
        manager.create(TripWaypoint, {
          trip_day_id: savedDay.id,
          sequence: idx,
          location: latLngToPoint({ lat: w.lat, lng: w.lng }),
          name: w.name ?? null,
          waypoint_type: w.waypoint_type,
        }),
      );
      await manager.save(rows);
    }
  }

  /**
   * #357 — materialise a shared trip into the caller's library while
   * preserving its multi-day structure.
   *
   * The web companion mints a trip share via `POST /trip-shares` whose
   * snapshot contains the full `days[]` array with per-day route geometry
   * and waypoints. The legacy mobile path (`POST /trips/import`) flattens
   * those days into a single planned day because `ImportTripDto` only
   * carries one geometry. This method reads the snapshot directly from
   * the shares row (so the request body is just a token — no chance of
   * client-side tampering between fetch and import) and creates one
   * `trip_days` row per snapshot day with the original day_number,
   * geometry, distance, and waypoints intact.
   *
   * Snapshot validation is intentionally lenient: the snapshot is opaque
   * JSONB the companion writes verbatim, so this method tolerates
   * partially-malformed days (missing geometry, unknown waypoint type)
   * by skipping the offending field rather than 400-ing the whole
   * import. A snapshot with NO usable days (all empty/malformed) is
   * rejected so the rider sees a clear error instead of an empty trip.
   */
  async importFromShare(
    userId: string,
    dto: FromShareTripDto,
  ): Promise<TripDetailDto> {
    const share = await this.tripShares.findActiveByToken(dto.share_token);
    const days = parseSnapshotDays(share.snapshot);
    if (days.length === 0) {
      // Empty array means we found `days[]` but couldn't extract a single
      // usable day (no geometry, no waypoints, all malformed). Surface a
      // distinct error from the 404 the share-lookup throws so the
      // mobile error banner can give riders an actionable hint.
      throw new BadRequestException(
        'Shared trip has no usable route data — ask the planner to re-export it.',
      );
    }

    const totalKm = days.reduce((sum, d) => sum + d.distance_km, 0);
    const dailyKms = days.map((d) => d.distance_km);
    // Snapshot may have zero-distance days (e.g. waypoint-only fallbacks).
    // Floor each at 1 km when computing the trip's daily-bounds bookends
    // so the schema's positive-number constraint isn't tripped, and so a
    // mixed snapshot (one fat day + one stub day) doesn't collapse to
    // (0, x) with min < 1.
    const bounds = {
      totalKm,
      dailyKmMin: Math.max(1, Math.round(Math.min(...dailyKms))),
      dailyKmMax: Math.max(1, Math.round(Math.max(...dailyKms))),
    };

    const tripId = await this.allocateAndPersistSharedTrip(
      userId,
      share.title,
      days,
      bounds,
    );
    return this.getDetail(userId, tripId);
  }

  private async allocateAndPersistSharedTrip(
    userId: string,
    title: string,
    days: ParsedSnapshotDay[],
    bounds: { totalKm: number; dailyKmMin: number; dailyKmMax: number },
  ): Promise<string> {
    return this.withTripTransaction(async (manager) => {
      const trip = manager.create(Trip, {
        owner_id: userId,
        title,
        region: null,
        num_days: days.length,
        daily_km_min: bounds.dailyKmMin,
        daily_km_max: bounds.dailyKmMax,
        min_quality: DEFAULT_MIN_QUALITY,
        road_preference: DEFAULT_ROAD_PREFERENCE,
        // Snapshot trips are routes the rider already has — surface
        // them as `planned` (matching the GPX/KML import path), not
        // `draft`, so they appear in the trip list ready to ride.
        status: 'planned',
      });
      const savedTrip = await manager.save(trip);

      await manager.save(
        manager.create(TripMember, {
          trip_id: savedTrip.id,
          user_id: userId,
          role: 'owner',
        }),
      );

      // Persist days in snapshot order. We renumber to 1..N rather than
      // honouring snapshot.dayNumber so a snapshot with sparse/duplicate
      // dayNumbers (older companion exports were known to skip numbers
      // when a day was deleted client-side) doesn't trip the
      // `(trip_id, day_number)` unique index or leave gaps that confuse
      // the day-list UI.
      for (let i = 0; i < days.length; i++) {
        const parsed = days[i];
        if (!parsed) continue;
        const dayNumber = i + 1;
        // Normalize the (client-supplied) overnight link like manual saves: day
        // 1 is never linked, and a successor is only linked when its start
        // actually sits on the previous SURVIVING day's end. Empty days were
        // dropped above, so the original predecessor may no longer be adjacent.
        const startWp = parsed.waypoints.find(
          (w) => w.waypoint_type === 'start',
        );
        // A generated predecessor finishes at a terminal accommodation, not an
        // explicit `end` — treat that as the finish so a valid shared link is
        // kept (otherwise the trip reloads with a duplicate overnight marker).
        const prevDay = i > 0 ? days[i - 1] : undefined;
        const prevEndWp = prevDay
          ? snapshotDayFinish(prevDay.waypoints)
          : undefined;
        const startLinked =
          i > 0 &&
          parsed.startLinked === true &&
          !!startWp &&
          !!prevEndWp &&
          startWp.lat === prevEndWp.lat &&
          startWp.lng === prevEndWp.lng;
        const day = manager.create(TripDay, {
          trip_id: savedTrip.id,
          day_number: dayNumber,
          title: parsed.title ?? `Day ${dayNumber}`,
          distance_km: Number(parsed.distance_km.toFixed(2)),
          // 55 km/h heuristic mirrors `importFromRoute` so the two
          // import paths produce comparable estimates. Floor at 30
          // minutes so a sub-km test snapshot doesn't render as "0 min".
          estimated_time:
            parsed.duration_min != null && parsed.duration_min > 0
              ? `${Math.round(parsed.duration_min)} minutes`
              : `${Math.max(30, Math.round((parsed.distance_km / 55) * 60))} minutes`,
          avg_quality: parsed.avg_quality,
          curviness_score: null,
          scenic_score: null,
          elevation_gain: parsed.elevation_gain,
          elevation_loss: null,
          route_geom:
            parsed.geometry.length >= 2
              ? {
                  type: 'LineString',
                  coordinates: parsed.geometry.map((p) => [p.lng, p.lat]),
                }
              : null,
          start_linked: startLinked,
        });
        const savedDay = await manager.save(day);

        if (parsed.waypoints.length > 0) {
          const rows = parsed.waypoints.map((w, idx) =>
            manager.create(TripWaypoint, {
              trip_day_id: savedDay.id,
              sequence: idx,
              location: latLngToPoint({ lat: w.lat, lng: w.lng }),
              name: w.name ?? null,
              // Persist backend vocabulary so the companion remaps stays on
              // reload (a raw `accommodation` would fall through to `via`).
              waypoint_type: canonicalSnapshotWaypointType(w.waypoint_type),
            }),
          );
          await manager.save(rows);
        }
      }

      return savedTrip.id;
    });
  }

  async update(
    userId: string,
    tripId: string,
    dto: UpdateTripDto,
  ): Promise<TripDetailDto> {
    // Role check first so a plain member probing the PATCH surface
    // can't confirm field-level validation rules on trips they have no
    // right to mutate. Non-members and regular members collapse into
    // the same 404 regardless of body shape.
    const membership = await this.memberRepo.findOne({
      where: { trip_id: tripId, user_id: userId },
    });
    if (!membership || !PRIVILEGED_ROLES.has(membership.role)) {
      throw new NotFoundException('Trip not found');
    }

    // Build the supplied-fields-only delta once, outside the txn, so
    // the lock window stays short. Writing the full merged row would
    // quietly revert concurrent edits: two privileged members PATCHing
    // different fields could both read the same pre-image and each
    // rewrite the untouched fields to their read-time values, so the
    // loser of the race loses their co-planner's change even though
    // the two updates don't actually conflict.
    const delta: Record<string, unknown> = {};
    if (dto.title !== undefined) delta.title = dto.title;
    if (dto.region !== undefined) delta.region = dto.region ?? null;
    if (dto.num_days !== undefined) delta.num_days = dto.num_days;
    if (dto.daily_km_min !== undefined) delta.daily_km_min = dto.daily_km_min;
    if (dto.daily_km_max !== undefined) delta.daily_km_max = dto.daily_km_max;
    if (dto.min_quality !== undefined) delta.min_quality = dto.min_quality;
    if (dto.road_preference !== undefined) {
      delta.road_preference = dto.road_preference;
    }
    if (dto.status !== undefined) delta.status = dto.status;
    if (dto.folder_id !== undefined) {
      // Folder visibility is per-user (US-37). The trip owner is the
      // only user who can file it under one of their folders, so we
      // verify ownership against the trip's owner_id rather than the
      // caller — co-collaborators (admins) PATCHing other fields
      // shouldn't accidentally re-file the trip into one of THEIR own
      // folders. Cross-user references collapse into a 404 so the
      // endpoint can't be used to enumerate other riders' folder ids.
      if (dto.folder_id !== null) {
        // Read the trip's owner_id directly (lightweight query) instead
        // of waiting for the locked read inside the txn. The owner_id
        // is immutable, so doing the lookup outside the lock keeps the
        // critical section small.
        const ownerRow = await this.tripRepo.findOne({
          where: { id: tripId },
          select: { owner_id: true },
        });
        if (!ownerRow) {
          throw new NotFoundException('Trip not found');
        }
        const folder = await this.folderRepo.findOne({
          where: { id: dto.folder_id, user_id: ownerRow.owner_id },
        });
        if (!folder) throw new NotFoundException('Folder not found');
      }
      delta.folder_id = dto.folder_id;
    }

    const hasChanges = Object.keys(delta).length > 0;

    // Read-validate-write is serialised on a pessimistic row lock so
    // the cross-field (min, max) check can't race against a concurrent
    // PATCH. Without the lock, two callers each supplying one side
    // could pass validation against the same pre-image and commit a
    // row where min > max. The lock keeps the second PATCH blocked
    // until the first commits, so the second reads (and validates
    // against) the post-first state.
    if (hasChanges) {
      await this.tripRepo.manager.transaction(async (manager) => {
        const locked = await manager.findOne(Trip, {
          where: { id: tripId },
          lock: { mode: 'pessimistic_write' },
        });
        if (!locked) throw new NotFoundException('Trip not found');

        const effectiveMin = dto.daily_km_min ?? locked.daily_km_min;
        const effectiveMax = dto.daily_km_max ?? locked.daily_km_max;
        if (effectiveMin > effectiveMax) {
          throw new BadRequestException(
            'daily_km_min must be less than or equal to daily_km_max',
          );
        }

        await manager.update(Trip, { id: tripId }, delta);
      });
    } else {
      // Empty PATCH — still verify the trip exists so the response is
      // consistent with the hasChanges branch.
      const exists = await this.tripRepo.findOne({
        where: { id: tripId },
        select: { id: true },
      });
      if (!exists) throw new NotFoundException('Trip not found');
    }

    const detail = await this.getDetail(userId, tripId);
    // Don't broadcast on a no-op PATCH — subscribed members shouldn't
    // rerender or refetch just because an author submitted an empty
    // DTO. The response still returns the current detail so the caller
    // can confirm state.
    if (hasChanges) {
      this.events.emitToTrip(tripId, 'trip:updated', detail);
      await this.activity.recordSafe(tripId, userId, 'trip_updated', {
        fields: Object.keys(delta),
      });
    }
    return detail;
  }

  async remove(userId: string, tripId: string): Promise<void> {
    // Owner-only: a 404 covers both "no such trip" and "you are not the
    // owner" so the endpoint cannot be used to enumerate trip ids or to
    // probe roles a caller doesn't have. Cascading FKs on
    // `trip_members`, `trip_days`, `trip_waypoints`, `trip_suggestions`,
    // `trip_messages`, and `trip_activity` clean up dependent rows.
    const membership = await this.memberRepo.findOne({
      where: { trip_id: tripId, user_id: userId },
    });
    if (!membership || membership.role !== 'owner') {
      throw new NotFoundException('Trip not found');
    }

    const result = await this.tripRepo.delete({ id: tripId });

    // Concurrent double-delete: two requests from the same owner can
    // both pass the membership check before either DELETE lands, and
    // the second one will find the row already gone. `affected: 0`
    // means another caller (or a racing manual delete) won that race —
    // fold into a 404 so the late caller gets a consistent response
    // and doesn't broadcast a duplicate `trip:deleted` to live
    // collaborators.
    if (result.affected === 0) {
      throw new NotFoundException('Trip not found');
    }

    // Emit AFTER the delete commits so a failed delete (FK violation,
    // dropped connection, etc.) doesn't broadcast a deletion that
    // didn't actually happen — collaborators would otherwise tear down
    // their subscriptions for a trip that still exists. We don't write
    // to `trip_activity` because the cascade would delete the row in
    // the same transaction.
    this.events.emitToTrip(tripId, 'trip:deleted', { trip_id: tripId });
  }

  /**
   * Send an email invite to a Tarmoto trip. Owner/admin only — plain
   * members can't send invites because the invite code is the same code
   * the owner shares verbally, and we don't want any teammate spamming
   * recipients in the trip's name. The recipient does NOT need a
   * Tarmoto account yet; the email explains how to sign up and join.
   *
   * Mail dispatch is best-effort: a delivery failure is logged inside
   * `EmailService.sendTripInvite` (which never throws), so this method
   * always returns once the activity row is recorded.
   *
   * The activity payload stores only the recipient's email DOMAIN (not
   * the local-part) so a soft-deleted invitee's PII isn't preserved
   * indefinitely in `trip_activity` after they ask Tarmoto to forget
   * them. The inviter's mailbox already has the full address; that
   * trail is sufficient for trip-level questions ("did Adam invite
   * X?") without leaking the recipient's full address to every other
   * trip member.
   */
  async invite(
    userId: string,
    tripId: string,
    dto: InviteTripDto,
  ): Promise<void> {
    // Membership + role check first — collapse "no such trip" and "not
    // privileged" into a 404 so the endpoint can't be used to enumerate
    // trip ids or to probe roles.
    const membership = await this.memberRepo.findOne({
      where: { trip_id: tripId, user_id: userId },
    });
    if (!membership || !PRIVILEGED_ROLES.has(membership.role)) {
      throw new NotFoundException('Trip not found');
    }

    const trip = await this.tripRepo.findOne({ where: { id: tripId } });
    if (!trip) {
      throw new NotFoundException('Trip not found');
    }

    const inviter = await this.userRepo.findOne({ where: { id: userId } });
    const inviterName = inviter?.display_name ?? 'A Tarmoto rider';

    // Self-invite is a no-op (the rider is already a member); rejecting
    // here keeps the activity log honest and avoids paying the email
    // send cost. Distinct from the membership-row "already a teammate"
    // case below — that one we still log a soft warning for, since the
    // inviter may have lost track of who's already on the trip.
    if (
      inviter?.email &&
      inviter.email.toLowerCase() === dto.email.toLowerCase()
    ) {
      throw new BadRequestException('You are already a member of this trip');
    }

    // If the recipient has a Tarmoto account and is already a member,
    // log a warning but DON'T send the email — the invite would land in
    // their inbox with a code that they don't need.
    const existingUser = await this.userRepo.findOne({
      where: { email: dto.email },
    });
    if (existingUser) {
      const alreadyMember = await this.memberRepo.findOne({
        where: { trip_id: tripId, user_id: existingUser.id },
      });
      if (alreadyMember) {
        this.logger.log(
          `Skipped trip-invite email — recipient is already a member ` +
            `(trip=${tripId}, user=${existingUser.id})`,
        );
        // Still record activity so the inviter sees their own action in
        // the timeline; payload flags the no-op so the UI can render
        // "already a member" instead of "invite sent".
        await this.activity.recordSafe(tripId, userId, 'member_invited', {
          recipient_email_domain: emailDomain(dto.email),
          already_member: true,
        });
        return;
      }
    }

    // Record (or refresh) the pending-invite row: it puts the invitee on
    // the roster as `invited`, carries the role they'll receive on
    // acceptance, and mints a PERSONAL invite code for the mail's join
    // link — so revoking this invite invalidates exactly this link.
    // Re-inviting the same address updates role + rotates the code.
    //
    // Two unique constraints can fire here: (trip, email) from a
    // concurrent invite to the same address, and the table-wide
    // invite_code from an (astronomically rare) generated-code
    // collision. Both converge on the same recovery — refetch the row
    // and retry with a fresh code — so the loop doesn't need to
    // disambiguate the constraint. What matters is that the code in
    // the email is ALWAYS the code that actually got persisted.
    const role = dto.role ?? 'editor';
    let personalCode: string;
    for (let attempt = 0; ; attempt++) {
      personalCode = generateInviteCode();
      const existingInvite = await this.inviteRepo.findOne({
        where: { trip_id: tripId, email: dto.email },
      });
      try {
        if (existingInvite) {
          await this.inviteRepo.update(
            { id: existingInvite.id },
            { role, invite_code: personalCode, invited_by: userId },
          );
        } else {
          await this.inviteRepo.insert({
            trip_id: tripId,
            email: dto.email,
            role,
            invite_code: personalCode,
            invited_by: userId,
          });
        }
        break;
      } catch (err: unknown) {
        if (!isUniqueViolation(err) || attempt >= 4) throw err;
      }
    }

    const joinUrl = this.buildInviteUrl(tripId, personalCode);

    await this.email.sendTripInvite(dto.email, {
      inviterDisplayName: inviterName,
      tripTitle: trip.title,
      joinUrl,
      inviteCode: personalCode,
      message: dto.message?.trim() ? dto.message.trim() : null,
    });

    await this.activity.recordSafe(tripId, userId, 'member_invited', {
      recipient_email_domain: emailDomain(dto.email),
      message_provided: Boolean(dto.message?.trim()),
      role,
    });
  }

  private buildInviteUrl(tripId: string, inviteCode: string): string {
    const base = getCompanionUrl(this.config);
    // tripId + invite code BOTH live in the path (rather than as
    // `?trip_id=&code=`) so the companion auth middleware's callback —
    // which only preserves `nextUrl.pathname`, not search params —
    // round-trips an unauthenticated invitee through /login and lands
    // them back on the same join URL with the full invite intact. Both
    // segments are URL-safe today (UUID + Crockford-base32 invite
    // alphabet), but `encodeURIComponent` is cheap defence against any
    // future format change.
    return `${base}/trips/join/${encodeURIComponent(tripId)}/${encodeURIComponent(inviteCode)}`;
  }

  async list(userId: string, query: ListTripsDto): Promise<TripSummaryDto[]> {
    // Trips visible to the caller = trips where they appear in
    // `trip_members` (the `create` flow inserts the owner as a member,
    // so a single membership join covers both owners and joiners).
    //
    // The summary response only needs `member_count`, so map a COUNT()
    // subquery onto the transient `member_count` field instead of
    // hydrating every membership row for every trip in the result set.
    const qb = this.tripRepo
      .createQueryBuilder('trip')
      .innerJoin(
        TripMember,
        'm',
        'm.trip_id = trip.id AND m.user_id = :userId',
        { userId },
      )
      .loadRelationCountAndMap('trip.member_count', 'trip.members')
      .orderBy('trip.created_at', 'DESC');

    if (query.status) {
      qb.andWhere('trip.status = :status', { status: query.status });
    }

    const trips = await qb.getMany();
    if (trips.length === 0) return [];

    const aggById = await this.computeTripAggregates(trips.map((t) => t.id));
    return trips.map((t) => this.toSummary(t, aggById.get(t.id)));
  }

  /**
   * Roll up total distance, distance-weighted quality, and nearby-pass count
   * for a set of trips in one grouped query over `trip_days`. Shared by
   * `list` and `getDetail` so summary cards and any detail-derived summary
   * row (e.g. the optimistic duplicate-trip insert that pushes a
   * `TripDetailDto` into the list before refetch) carry identical metadata.
   * Returns a map keyed by trip id; trips with no `trip_days` rows are
   * absent and the callers fall back to nulls. An empty `ids` short-circuits
   * without touching the DB.
   */
  private async computeTripAggregates(ids: string[]): Promise<
    Map<
      string,
      {
        distance_km: number | null;
        quality_avg: number | null;
        passes_count: number | null;
      }
    >
  > {
    if (ids.length === 0) return new Map();

    const aggRows = await this.tripDayRepo
      .createQueryBuilder('d')
      .select('d.trip_id', 'trip_id')
      .addSelect('SUM(d.distance_km)', 'distance_km')
      // Distance-weighted so a long high-quality day outweighs a short
      // detour. The denominator is FILTERed to scored days only: a day
      // with a distance but NULL avg_quality drops out of the numerator
      // (NULL * x = NULL) and must drop out of the denominator too, or it
      // would dilute the average toward zero for partially-scored trips.
      // Days with quality but no distance can't be weighted, so they fall
      // out of both sums; the ELSE AVG fallback covers trips whose days
      // have quality but no recorded distance at all.
      .addSelect(
        'CASE WHEN SUM(d.distance_km) FILTER (WHERE d.avg_quality IS NOT NULL) > 0 ' +
          'THEN SUM(d.avg_quality * d.distance_km) ' +
          '/ SUM(d.distance_km) FILTER (WHERE d.avg_quality IS NOT NULL) ' +
          'ELSE AVG(d.avg_quality) END',
        'quality_avg',
      )
      // Pass count is an isolated scalar subquery on purpose: joining
      // `mountain_passes` into this grouped query would fan out the
      // `trip_days` rows and inflate the SUM(distance_km) / weighted
      // quality aggregates. Keep it as a correlated EXISTS so the
      // distance/quality rollups stay one-row-per-day. `mountain_passes`
      // is a small curated table; the per-trip scan is acceptable at the
      // own-trips scale this endpoint serves (a handful of trips/days).
      // Note: the ::geography cast means a plain GiST index on
      // trip_days.route_geom wouldn't serve this operator — revisit with a
      // geography expression index only if mountain_passes grows large.
      .addSelect(
        '(SELECT COUNT(DISTINCT mp.id) FROM mountain_passes mp ' +
          'WHERE EXISTS (SELECT 1 FROM trip_days td WHERE td.trip_id = d.trip_id ' +
          'AND td.route_geom IS NOT NULL ' +
          'AND ST_DWithin(mp.location::geography, td.route_geom::geography, 2000)))',
        'passes_count',
      )
      .where('d.trip_id IN (:...ids)', { ids })
      .groupBy('d.trip_id')
      .getRawMany<{
        trip_id: string;
        distance_km: string | null;
        quality_avg: string | null;
        passes_count: string | null;
      }>();

    return new Map(
      aggRows.map((r) => [
        r.trip_id,
        {
          distance_km: r.distance_km != null ? parseFloat(r.distance_km) : null,
          quality_avg: r.quality_avg != null ? parseFloat(r.quality_avg) : null,
          passes_count:
            r.passes_count != null ? parseInt(r.passes_count, 10) : null,
        },
      ]),
    );
  }

  /**
   * Validate ordering, route, and enrich ONE day. Throws
   * BadRequestException / BadGatewayException on failure so a single bad day
   * aborts the whole save before the transaction starts.
   */
  private async buildDayRoute(
    day: SaveRouteDayDto,
    options: SaveRouteDto['options'],
  ): Promise<{
    distance_km: number;
    estimated_time: string;
    avg_quality: number | null;
    curviness_score: number | null;
    scenic_score: number | null;
    elevation_gain: number;
    elevation_loss: number;
    route_geom: { type: 'LineString'; coordinates: number[][] };
  }> {
    const startCount = day.waypoints.filter((w) => w.type === 'start').length;
    const endCount = day.waypoints.filter((w) => w.type === 'end').length;
    if (startCount !== 1 || endCount !== 1) {
      throw new BadRequestException(
        `Day ${day.dayNumber} must have exactly one start and one end waypoint`,
      );
    }
    const routing = day.waypoints.filter((w) =>
      ['start', 'via', 'end'].includes(w.type),
    );
    if (
      routing[0]?.type !== 'start' ||
      routing[routing.length - 1]?.type !== 'end'
    ) {
      throw new BadRequestException(
        `Day ${day.dayNumber} waypoints must be ordered from start to end`,
      );
    }
    const baseOptions = {
      avoidHighways: options?.avoid_highways,
      avoidTolls: options?.avoid_tolls,
      preferQuality: options?.prefer_quality,
      // Same costing as live routing — otherwise Save re-routes the
      // approved preview with default costing and persists a
      // different road character than the rider saw.
      preference: options?.preference,
    };
    const legPreferences = day.leg_preferences;
    if (legPreferences && legPreferences.length !== routing.length - 1) {
      throw new BadRequestException(
        `Day ${day.dayNumber} leg_preferences must have exactly one entry ` +
          `per consecutive routing-waypoint pair (${routing.length - 1})`,
      );
    }
    let route: {
      distance_km: number;
      duration_min: number;
      geometry: { lat: number; lng: number }[];
    };
    if (legPreferences && legPreferences.length > 0) {
      // Per-leg road characters (revision 3 §C): re-route the day with
      // the SAME leg requests the live preview used, or a custom leg
      // (e.g. one Maximum twisty stretch in a Direct trip) would persist
      // a different line than the rider approved.
      const legs = await Promise.all(
        legPreferences.map((preference, i) =>
          this.routingProvider.route(
            [
              { lat: routing[i]!.lat, lng: routing[i]!.lng },
              { lat: routing[i + 1]!.lat, lng: routing[i + 1]!.lng },
            ],
            { ...baseOptions, preference },
          ),
        ),
      );
      const resolved = legs.filter(
        (leg): leg is NonNullable<typeof leg> => leg !== null,
      );
      if (resolved.length !== legs.length) {
        throw new BadGatewayException(`No road route for day ${day.dayNumber}`);
      }
      route = resolved.slice(1).reduce(
        (merged, leg) => ({
          distance_km: merged.distance_km + leg.distance_km,
          duration_min: merged.duration_min + leg.duration_min,
          // Legs share their boundary waypoint — drop the duplicate vertex.
          geometry: [...merged.geometry, ...leg.geometry.slice(1)],
        }),
        {
          distance_km: resolved[0]!.distance_km,
          duration_min: resolved[0]!.duration_min,
          geometry: [...resolved[0]!.geometry],
        },
      );
    } else {
      const whole = await this.routingProvider.route(
        routing.map((w) => ({ lat: w.lat, lng: w.lng })),
        baseOptions,
      );
      if (!whole) {
        throw new BadGatewayException(`No road route for day ${day.dayNumber}`);
      }
      route = whole;
    }
    const m = await this.enrichment.aggregate(route.geometry);
    return {
      distance_km: Number(route.distance_km.toFixed(2)),
      estimated_time: `${Math.round(route.duration_min)} minutes`,
      avg_quality: m.avgQuality,
      curviness_score: m.curvinessScore,
      scenic_score: m.scenicScore,
      elevation_gain: Math.round(m.elevationGain),
      elevation_loss: Math.round(m.elevationLoss),
      route_geom: {
        type: 'LineString',
        coordinates: route.geometry.map((p) => [p.lng, p.lat]),
      },
    };
  }

  /**
   * US-road-route: persist manually-built road routes for all days.
   *
   * The endpoint is the single source of truth — client geometry is never
   * trusted. We accept ordered waypoints per day, re-route them server-side
   * via the configured routing provider (Valhalla), enrich the results via
   * PostGIS, then replace ALL days in a single transaction.
   *
   * Routing happens BEFORE the transaction so a 502 from any day aborts
   * cleanly with no partial writes.
   *
   * Any trip member may call this (not just owner/admin) because the
   * route-building flow is collaborative — all members can contribute a
   * day plan. Privilege-checking is done by verifying membership only;
   * no role filter is applied here.
   */
  async saveManualRoute(
    userId: string,
    tripId: string,
    dto: SaveRouteDto,
  ): Promise<TripDetailDto> {
    // 1. Membership gate: fold "no such trip" and "not a member" into
    //    the same 404 so the endpoint can't enumerate trip ids. Viewers
    //    are read-and-comment only — route writes need editor access.
    const member = await this.memberRepo.findOne({
      where: { trip_id: tripId, user_id: userId },
    });
    if (!member) throw new NotFoundException('Trip not found');
    if (member.role === 'viewer') {
      throw new ForbiddenException(
        'Viewers can view and comment only — ask the trip owner for editor access',
      );
    }

    // Renumber contiguously (defensive — client already drops empties).
    const days = dto.days.map((d, i) => ({ ...d, dayNumber: i + 1 }));

    // 2. Route + enrich each day up front so a routing failure (502) aborts
    //    the whole save before the transaction starts — no partial writes.
    const built = await Promise.all(
      days.map((d) => this.buildDayRoute(d, dto.options)),
    );

    // 3. Replace ALL days + their waypoints in a single transaction.
    await this.tripRepo.manager.transaction(async (manager) => {
      // Take a pessimistic row lock first so concurrent saves to the same
      // trip serialize (last-writer-wins) — mirrors replaceWithImportedRoute.
      // Without it, two callers can both delete + reinsert and race the
      // `(trip_id, day_number)` unique constraint, surfacing a 500 instead.
      const locked = await manager.findOne(Trip, {
        where: { id: tripId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!locked) throw new NotFoundException('Trip not found');

      // Decouple ALL suggestions on this trip's days before deleting them —
      // mirrors Phase 1's day-1 unscoping but across every day. NULLing
      // trip_day_id first prevents the onDelete: CASCADE from permanently
      // removing in-flight collaboration suggestions.
      const existingDays = await manager.find(TripDay, {
        where: { trip_id: tripId },
      });
      if (existingDays.length > 0) {
        await manager.update(
          TripSuggestion,
          { trip_day_id: In(existingDays.map((d) => d.id)) },
          { trip_day_id: null },
        );
        await manager.delete(TripDay, { trip_id: tripId });
      }

      // Insert fresh TripDay + TripWaypoint rows for every submitted day.
      for (let i = 0; i < days.length; i++) {
        const d = days[i];
        const b = built[i];
        if (!d || !b) {
          throw new Error(`saveDays: missing day or built route at index ${i}`);
        }
        // Normalize the overnight-link flag rather than trusting the client:
        // day 1 is never linked, and a successor is only linked if its start
        // actually sits on the previous day's end. A direct/mobile client could
        // otherwise persist an impossible link the companion later trusts to
        // hide markers and resync starts.
        const startWp = d.waypoints.find((w) => w.type === 'start');
        const prevDay = i > 0 ? days[i - 1] : undefined;
        const prevEndWp = prevDay
          ? prevDay.waypoints.find((w) => w.type === 'end')
          : undefined;
        const startLinked =
          i > 0 &&
          d.startLinked === true &&
          !!startWp &&
          !!prevEndWp &&
          startWp.lat === prevEndWp.lat &&
          startWp.lng === prevEndWp.lng;
        const dayRow = await manager.save(
          manager.create(TripDay, {
            trip_id: tripId,
            day_number: d.dayNumber,
            // Title comes from the payload (the companion sends each day's
            // title), so it follows the day through client-side renumbering —
            // a day_number lookup would mis-assign titles after a day removal.
            title: d.title ?? null,
            start_linked: startLinked,
            distance_km: b.distance_km,
            estimated_time: b.estimated_time,
            avg_quality: b.avg_quality,
            curviness_score: b.curviness_score,
            scenic_score: b.scenic_score,
            elevation_gain: b.elevation_gain,
            elevation_loss: b.elevation_loss,
            route_geom: b.route_geom,
            // Persist the leg overrides WITH their day so the planner can
            // re-seed them on reload — otherwise the next edit + save
            // re-routes the approved custom legs with the trip-wide
            // preference.
            leg_preferences: d.leg_preferences ?? null,
          }),
        );
        // Persist ALL submitted waypoints (including non-routing stops such as
        // fuel, food, coffee, hotel, photo) in submission order so riders don't
        // lose stops they placed before hitting Save.
        const waypointRows = d.waypoints.map((w, idx) =>
          manager.create(TripWaypoint, {
            trip_day_id: dayRow.id,
            sequence: idx,
            location: latLngToPoint({ lat: w.lat, lng: w.lng }),
            name: w.name ?? null,
            waypoint_type: w.type,
          }),
        );
        if (waypointRows.length > 0) {
          await manager.save(waypointRows);
        }
      }

      // Flip trip status to planned and update num_days + updated_at.
      await manager.update(
        Trip,
        { id: tripId },
        { status: 'planned', num_days: days.length, updated_at: new Date() },
      );
    });

    // Fetch the persisted detail once and reuse it for both the broadcast
    // and the return value — mirrors replaceWithImportedRoute and update so
    // collaborators watching via WebSocket see the same state the caller
    // receives in the HTTP response.
    const detail = await this.getDetail(userId, tripId);
    this.events.emitToTrip(tripId, 'trip:updated', detail);
    // Audit trail — mirrors update/import/generate so the Activity tab shows
    // who changed the route on a collaborative trip.
    await this.activity.recordSafe(tripId, userId, 'trip_updated', {
      fields: ['manual_route'],
    });
    return detail;
  }

  async getDetail(userId: string, tripId: string): Promise<TripDetailDto> {
    // Push the membership predicate into the SQL via an inner join on
    // `trip_members` filtered by the caller. Non-members get `null`
    // back from the query — and crucially never trigger the deep
    // members/days/waypoints hydration below, which can be expensive
    // for large group trips. The leftJoinAndSelects below still load
    // the full member roster + days + waypoints for the response,
    // because the inner join is an independent JOIN with its own alias.
    const trip = await this.tripRepo
      .createQueryBuilder('trip')
      .innerJoin(
        TripMember,
        'caller',
        'caller.trip_id = trip.id AND caller.user_id = :userId',
        { userId },
      )
      .leftJoinAndSelect('trip.members', 'm')
      .leftJoinAndSelect('m.user', 'mu')
      .leftJoinAndSelect('trip.days', 'd')
      .leftJoinAndSelect('d.waypoints', 'w')
      .where('trip.id = :tripId', { tripId })
      .addOrderBy('d.day_number', 'ASC')
      .addOrderBy('w.sequence', 'ASC')
      .getOne();

    if (!trip) {
      // Folds "no such trip" and "you're not a member" into the same
      // 404 so the endpoint can't be used to enumerate trip ids.
      throw new NotFoundException('Trip not found');
    }

    // Compute the same rollups `list` serves so the inherited summary
    // fields (distance_km / quality_avg / passes_count) aren't null on
    // detail — a detail-derived summary row (optimistic duplicate insert)
    // would otherwise show blank card metadata until a list refetch.
    const aggById = await this.computeTripAggregates([trip.id]);
    return this.toDetail(trip, aggById.get(trip.id));
  }

  /**
   * Read-only trip detail for the community surface (`GET /community/trips/:id`).
   * Unlike {@link getDetail}, this does NOT require trip membership — it is the
   * ONLY path by which a non-member can read a trip, and it is deliberately
   * narrow: a trip has no per-trip public flag (sharing is otherwise
   * token-only), so the sole non-member grant is "this trip is an item in a
   * discoverable (public/unlisted) collection". A member (e.g. the owner
   * reaching their own trip from a private collection) is always allowed.
   *
   * The response masks owner-only fields ({@link PublicTripDetailDto} omits the
   * invite code and the member roster) so following a collection link can never
   * leak the join secret or rider identities.
   */
  async getPublicDetail(
    viewerId: string | null,
    tripId: string,
  ): Promise<PublicTripDetailDto> {
    // Hydrate the trip up-front (no membership join) so we can both
    // authorize on the in-memory roster and build the response from one read.
    const trip = await this.tripRepo
      .createQueryBuilder('trip')
      .leftJoinAndSelect('trip.members', 'm')
      .leftJoinAndSelect('m.user', 'mu')
      .leftJoinAndSelect('trip.days', 'd')
      .leftJoinAndSelect('d.waypoints', 'w')
      .where('trip.id = :tripId', { tripId })
      .addOrderBy('d.day_number', 'ASC')
      .addOrderBy('w.sequence', 'ASC')
      .getOne();

    // Fold "no such trip" and "not visible to you" into the same 404 so the
    // endpoint can't be used to enumerate trip ids — mirrors getDetail.
    if (!trip) {
      throw new NotFoundException('Trip not found');
    }

    const isMember =
      viewerId != null &&
      (trip.members ?? []).some((m) => m.user_id === viewerId);
    if (!isMember) {
      // The trip must be an item in a discoverable (public/unlisted) collection
      // AND the COLLECTION OWNER must be a member of that trip. `addItem` only
      // checks collection ownership + UUID shape — it does NOT verify the owner
      // has access to the trip_id they stored — so without this membership
      // predicate a rider could park an arbitrary private trip_id in their own
      // public collection and read its full geometry/waypoints here. The
      // preview builder enforces the same trip_members scoping for exactly this
      // reason; we mirror it.
      const exposed = await this.collectionItemRepo
        .createQueryBuilder('item')
        .innerJoin('item.collection', 'c')
        // The collection OWNER must be a member of the trip (addItem doesn't
        // verify trip access) AND their account must be live — the collection
        // read paths 404 a soft-deleted owner's collections during the deletion
        // grace window, so a stale link must not keep exposing the trip.
        .innerJoin(
          TripMember,
          'tm',
          'tm.trip_id = item.trip_id AND tm.user_id = c.owner_id',
        )
        .innerJoin(
          User,
          'owner',
          'owner.id = c.owner_id AND owner.deleted_at IS NULL',
        )
        .where('item.trip_id = :tripId', { tripId })
        .andWhere('c.visibility IN (:...visibilities)', {
          visibilities: ['public', 'unlisted'],
        })
        .getExists();
      if (!exposed) {
        throw new NotFoundException('Trip not found');
      }
    }

    // Mask the owner's identity when it must not be surfaced:
    //  - the owner's account is soft-deleted (deletion grace window) — masked
    //    for everyone, matching the public DTO contract and how the rides/
    //    collection read paths hide deleted owners. The exposure join only
    //    proves the COLLECTION owner is live; a collaborator can expose a trip
    //    whose OWNER is mid-deletion, so we check the trip owner here.
    //  - the owner keeps a private profile and the viewer is not a member —
    //    mirroring the collection API (#279 / #501) so the discover→trip link
    //    can't recover an identity the collection deliberately hid.
    const ownerMember = (trip.members ?? []).find(
      (m) => m.user_id === trip.owner_id,
    );
    const ownerIsDeleted = ownerMember?.user?.deleted_at != null;
    const ownerIsPrivate =
      !isMember &&
      (await this.privacy.loadPrivateUserIds([trip.owner_id])).has(
        trip.owner_id,
      );
    const maskOwner = ownerIsDeleted || ownerIsPrivate;

    const aggById = await this.computeTripAggregates([trip.id]);
    return this.toPublicDetail(trip, aggById.get(trip.id), maskOwner);
  }

  async join(
    userId: string,
    tripId: string,
    inviteCode: string,
  ): Promise<TripDetailDto> {
    const normalized = inviteCode.trim().toUpperCase();
    const trip = await this.tripRepo.findOne({ where: { id: tripId } });
    if (!trip) {
      // Fold "wrong trip id" and "wrong code" into one response so the
      // endpoint can't be used to enumerate which trip ids exist.
      throw new ForbiddenException('Invalid trip or invite code');
    }

    // Only PERSONAL invite codes admit — there is no trip-wide code.
    // Every code is minted per invite by `invite()`, so revoking an
    // invite kills exactly that recipient's link.
    //
    // Claim + consume atomically: the invite row is locked, the
    // membership written, and the row deleted in ONE transaction, so
    // two accounts racing the same personal link can't both pass the
    // lookup — the loser blocks on the lock and re-reads nothing after
    // the winner's delete commits.
    const { role, inserted } = await this.tripRepo.manager.transaction(
      async (manager) => {
        const invite = await manager.findOne(TripInvite, {
          where: { trip_id: tripId, invite_code: normalized },
          lock: { mode: 'pessimistic_write' },
        });
        if (!invite) {
          throw new ForbiddenException('Invalid trip or invite code');
        }

        const existing = await manager.findOne(TripMember, {
          where: { trip_id: tripId, user_id: userId },
        });

        let didInsert = false;
        if (!existing) {
          try {
            await manager.save(
              manager.create(TripMember, {
                trip_id: tripId,
                user_id: userId,
                // The invite carries the role the owner picked.
                role: invite.role,
              }),
            );
            didInsert = true;
          } catch (err: unknown) {
            // Concurrent join race — the unique (trip_id, user_id)
            // index rejected the duplicate. Desired post-state still
            // holds; the winner already wrote the activity row.
            if (!isUniqueViolation(err)) throw err;
          }
        }

        // Consume the invite whether or not a new row was inserted —
        // an already-member clicking their invite link shouldn't stay
        // listed as pending forever.
        await manager.delete(TripInvite, { id: invite.id });
        return { role: invite.role, inserted: didInsert };
      },
    );

    // Keep the activity entry OUTSIDE the unique-violation catch so a
    // non-23505 error from the activity path isn't misattributed to a
    // join race — `recordSafe` routes audit failures through a dedicated
    // Logger.warn instead. The member row is already durable by the
    // time we reach this line; a subsequent retry will short-circuit on
    // `existing` and skip the save.
    if (inserted) {
      await this.activity.recordSafe(tripId, userId, 'member_joined', {
        role,
      });
    }

    return this.getDetail(userId, tripId);
  }

  // ── Collaborator management (People tab) ─────────────────────────

  /**
   * Roster for the People tab: joined members plus (for owner/editors)
   * pending email invites. Emails are withheld from viewers so the
   * roster can't be scraped by anyone who got hold of the group link.
   */
  async listCollaborators(
    userId: string,
    tripId: string,
  ): Promise<TripCollaboratorsDto> {
    const membership = await this.memberRepo.findOne({
      where: { trip_id: tripId, user_id: userId },
    });
    if (!membership) throw new NotFoundException('Trip not found');
    const privileged = PRIVILEGED_ROLES.has(membership.role);

    const members = await this.memberRepo.find({
      where: { trip_id: tripId },
      relations: { user: true },
      order: { joined_at: 'ASC' },
    });
    const invites = privileged
      ? await this.inviteRepo.find({
          where: { trip_id: tripId },
          order: { created_at: 'ASC' },
        })
      : [];

    return {
      members: members.map((m) => ({
        user_id: m.user_id,
        display_name: m.user?.display_name ?? 'Rider',
        email: privileged ? (m.user?.email ?? null) : null,
        avatar_url: m.user?.avatar_url ?? null,
        role: m.role,
        joined_at: m.joined_at.toISOString(),
        state: 'joined' as const,
      })),
      invites: invites.map((i) => ({
        id: i.id,
        email: i.email,
        role: i.role,
        created_at: i.created_at.toISOString(),
        state: 'invited' as const,
      })),
    };
  }

  /** Owner-only guard shared by the collaborator-management writes. */
  private async requireOwner(
    userId: string,
    tripId: string,
  ): Promise<TripMember> {
    const membership = await this.memberRepo.findOne({
      where: { trip_id: tripId, user_id: userId },
    });
    // Non-members 404 (don't leak trip existence); members that aren't
    // the owner get an explicit 403 — they can see the roster, so
    // hiding the endpoint from them buys nothing.
    if (!membership) throw new NotFoundException('Trip not found');
    if (membership.role !== 'owner') {
      throw new ForbiddenException(
        'Only the trip owner can manage collaborators',
      );
    }
    return membership;
  }

  async updateMemberRole(
    userId: string,
    tripId: string,
    memberUserId: string,
    role: 'editor' | 'viewer',
  ): Promise<TripCollaboratorsDto> {
    await this.requireOwner(userId, tripId);
    if (memberUserId === userId) {
      throw new BadRequestException('You cannot change your own role');
    }
    const target = await this.memberRepo.findOne({
      where: { trip_id: tripId, user_id: memberUserId },
    });
    if (!target) throw new NotFoundException('Member not found');
    if (target.role === 'owner') {
      throw new BadRequestException('The owner role cannot be changed');
    }

    if (target.role !== role) {
      await this.memberRepo.update({ id: target.id }, { role });
      await this.activity.recordSafe(tripId, userId, 'member_role_changed', {
        member_user_id: memberUserId,
        role,
      });
    }
    return this.listCollaborators(userId, tripId);
  }

  async removeMember(
    userId: string,
    tripId: string,
    memberUserId: string,
  ): Promise<void> {
    await this.requireOwner(userId, tripId);
    if (memberUserId === userId) {
      throw new BadRequestException(
        'The owner cannot be removed from their own trip',
      );
    }
    const target = await this.memberRepo.findOne({
      where: { trip_id: tripId, user_id: memberUserId },
    });
    if (!target) throw new NotFoundException('Member not found');
    if (target.role === 'owner') {
      throw new BadRequestException('The owner cannot be removed');
    }

    await this.memberRepo.delete({ id: target.id });
    // Revoke LIVE access too: the socket room is only membership-checked
    // at subscribe time, so without eviction an open planner would keep
    // receiving trip broadcasts until the next reconnect.
    await this.events.evictFromTrip(tripId, memberUserId);
    // Their past contributions (suggestions, votes, messages, activity)
    // stay — removal only revokes access from now on.
    await this.activity.recordSafe(tripId, userId, 'member_removed', {
      member_user_id: memberUserId,
    });
  }

  /**
   * Withdraw a pending email invite. The personal code in the sent mail
   * stops working immediately (the join lookup misses).
   */
  async revokeInvite(
    userId: string,
    tripId: string,
    inviteId: string,
  ): Promise<void> {
    await this.requireOwner(userId, tripId);
    const result = await this.inviteRepo.delete({
      id: inviteId,
      trip_id: tripId,
    });
    if ((result.affected ?? 0) === 0) {
      throw new NotFoundException('Invite not found');
    }
  }

  private toSummary(
    trip: Trip,
    agg?: {
      distance_km: number | null;
      quality_avg: number | null;
      passes_count: number | null;
    },
  ): TripSummaryDto {
    return {
      id: trip.id,
      owner_id: trip.owner_id,
      title: trip.title,
      region: trip.region,
      num_days: trip.num_days,
      status: trip.status as TripStatus,
      // Prefer the COUNT mapped by `loadRelationCountAndMap` (set by
      // `list`), and fall back to the hydrated relation length when
      // `toSummary` is reached via `toDetail` (where we have the full
      // members[] from the QueryBuilder hydration in `getDetail`).
      member_count: trip.member_count ?? trip.members?.length ?? 0,
      folder_id: trip.folder_id ?? null,
      created_at: trip.created_at.toISOString(),
      // Rolled up from `trip_days` by `computeTripAggregates` — passed in by
      // both `list` and (via `toDetail`) `getDetail`, so summary cards and
      // detail-derived summaries carry the same metadata. Null only when the
      // caller has no aggregate row for this trip (e.g. a trip with no days).
      distance_km: agg?.distance_km ?? null,
      quality_avg: agg?.quality_avg ?? null,
      passes_count: agg?.passes_count ?? null,
    };
  }

  private toDetail(
    trip: Trip,
    agg?: {
      distance_km: number | null;
      quality_avg: number | null;
      passes_count: number | null;
    },
  ): TripDetailDto {
    const members: TripMemberDto[] = (trip.members ?? []).map((m) => ({
      user_id: m.user_id,
      display_name: m.user?.display_name ?? 'Unknown rider',
      role: m.role as TripMemberRole,
      joined_at: m.joined_at.toISOString(),
    }));

    const days: TripDayDto[] = (trip.days ?? []).map((d) => ({
      id: d.id,
      day_number: d.day_number,
      title: d.title,
      distance_km: d.distance_km ?? 0,
      avg_quality: d.avg_quality ?? 0,
      elevation_gain: d.elevation_gain ?? 0,
      elevation_loss: d.elevation_loss ?? 0,
      curviness_score: d.curviness_score ?? 0,
      scenic_score: d.scenic_score ?? 0,
      estimated_time_min: parseIntervalToMinutes(d.estimated_time),
      start_linked: d.start_linked ?? false,
      leg_preferences: (d.leg_preferences ?? null) as
        | RoutePreferenceOption[]
        | null,
      route_geometry: lineStringToLatLngs(d.route_geom),
      waypoints: (d.waypoints ?? []).map((w): TripWaypointDto => {
        // `location` is NOT NULL in the schema, but the shared helper
        // returns null defensively for unexpected shapes. Fall back to
        // (0, 0) so the response stays well-typed instead of leaking a
        // null lat/lng into a contract the mobile UI doesn't handle.
        const latLng = pointToLatLng(w.location) ?? { lat: 0, lng: 0 };
        return {
          id: w.id,
          sequence: w.sequence,
          lat: latLng.lat,
          lng: latLng.lng,
          name: w.name,
          waypoint_type: w.waypoint_type as TripWaypointType,
          road_segment_id: w.road_segment_id,
          notes: w.notes,
          duration_min: w.duration_min,
        };
      }),
    }));

    return {
      ...this.toSummary(trip, agg),
      member_count: members.length,
      daily_km_min: trip.daily_km_min,
      daily_km_max: trip.daily_km_max,
      min_quality: trip.min_quality,
      road_preference: trip.road_preference as TripRoadPreference,
      members,
      days,
    };
  }

  /**
   * Map a hydrated trip to the masked, read-only {@link PublicTripDetailDto}.
   * Derives the owner's display name from the loaded roster but drops the
   * roster and invite code from the response (see the DTO for why). When
   * `ownerIsPrivate` is set, the owner id + name are masked to `null`.
   */
  private toPublicDetail(
    trip: Trip,
    agg:
      | {
          distance_km: number | null;
          quality_avg: number | null;
          passes_count: number | null;
        }
      | undefined,
    ownerIsPrivate: boolean,
  ): PublicTripDetailDto {
    // Reuse the owner mapper for the day/waypoint mapping, then copy fields
    // into the public shape with an explicit ALLOW-LIST. An allow-list (rather
    // than spread-and-delete) means a sensitive field added to TripDetailDto
    // later can't silently leak through this non-member surface — it simply
    // won't be carried over until someone consciously adds it here. (Note
    // `folder_id` is intentionally NOT carried over — it's the owner's private
    // filing folder.)
    const detail = this.toDetail(trip, agg);
    const owner = detail.members.find((m) => m.role === 'owner');
    return {
      id: detail.id,
      owner_id: ownerIsPrivate ? null : detail.owner_id,
      owner_name: ownerIsPrivate ? null : (owner?.display_name ?? null),
      title: detail.title,
      region: detail.region,
      num_days: detail.num_days,
      status: detail.status,
      member_count: detail.member_count,
      created_at: detail.created_at,
      distance_km: detail.distance_km,
      quality_avg: detail.quality_avg,
      passes_count: detail.passes_count,
      daily_km_min: detail.daily_km_min,
      daily_km_max: detail.daily_km_max,
      min_quality: detail.min_quality,
      road_preference: detail.road_preference,
      days: detail.days,
    };
  }
}

function lineStringToLatLngs(
  geom: unknown,
): Array<{ lat: number; lng: number }> {
  if (!geom) return [];
  const coords = (geom as { coordinates?: unknown }).coordinates;
  if (!Array.isArray(coords)) return [];
  const out: Array<{ lat: number; lng: number }> = [];
  for (const c of coords) {
    if (
      Array.isArray(c) &&
      typeof c[0] === 'number' &&
      typeof c[1] === 'number'
    ) {
      out.push({ lat: c[1], lng: c[0] });
    }
  }
  return out;
}

function parseIntervalToMinutes(value: unknown): number {
  if (value == null) return 0;
  // pg's default interval parser returns an object like
  // { hours, minutes, seconds, days, milliseconds }. TypeORM types the
  // column as string but the runtime shape depends on pg-types config.
  if (typeof value === 'object') {
    const v = value as {
      days?: number;
      hours?: number;
      minutes?: number;
      seconds?: number;
    };
    const total =
      (v.days ?? 0) * 1440 +
      (v.hours ?? 0) * 60 +
      (v.minutes ?? 0) +
      (v.seconds ?? 0) / 60;
    return Math.round(total);
  }
  if (typeof value === 'string') {
    const m = /^(\d+):(\d+):(\d+(?:\.\d+)?)$/.exec(value);
    if (m) {
      return Math.round(Number(m[1]) * 60 + Number(m[2]) + Number(m[3]) / 60);
    }
  }
  return 0;
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === '23505'
  );
}

function emailDomain(email: string): string {
  const at = email.lastIndexOf('@');
  if (at === -1 || at === email.length - 1) return 'unknown';
  return email.slice(at + 1).toLowerCase();
}

function totalDistanceKm(points: Array<{ lat: number; lng: number }>): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const curr = points[i];
    if (!prev || !curr) continue;
    total += haversineKm(prev.lat, prev.lng, curr.lat, curr.lng);
  }
  return total;
}

// Single source of truth for the waypoint vocabulary the backend
// persists. `accommodation` is in here even though the GPX/KML
// `ImportTripDto` doesn't accept it from clients — the snapshot parser
// for `POST /trips/from-share` (#357) does, and a `BuiltWaypoint`
// reaching the persistence layer with an `accommodation` type must be
// representable in the type system. Pulling the constant out of a
// `const` tuple keeps `BuiltWaypoint['waypoint_type']` and the runtime
// `SNAPSHOT_WAYPOINT_TYPES` set in lockstep.
const BUILT_WAYPOINT_TYPES = [
  'start',
  'via',
  'end',
  'fuel',
  'rest',
  'photo',
  'accommodation',
] as const;
type BuiltWaypointType = (typeof BUILT_WAYPOINT_TYPES)[number];

interface BuiltWaypoint {
  lat: number;
  lng: number;
  name?: string | undefined;
  waypoint_type: BuiltWaypointType;
}

/**
 * The waypoint that finishes a snapshot day: its explicit `end`, or — for a
 * generated overnight day with no explicit end — its terminal `accommodation`.
 * Returns `undefined` when the day has no finish. Used by the from-share link
 * normalizer so a generated predecessor (accommodation-terminated) validates a
 * successor's `startLinked` instead of clearing it.
 */
function snapshotDayFinish(
  waypoints: BuiltWaypoint[],
): BuiltWaypoint | undefined {
  // A TERMINAL accommodation (a stay appended after an explicit end) is the
  // finish — mirror the companion's `dayFinishWaypoint`, else a snapshot shaped
  // [start, end, accommodation] validates startLinked against the stale end and
  // clears a valid overnight link on import.
  const last = waypoints[waypoints.length - 1];
  if (last?.waypoint_type === 'accommodation') return last;
  return waypoints.find((w) => w.waypoint_type === 'end');
}

/**
 * Snapshots carry companion-local stop vocabulary (`accommodation`, `rest`),
 * but persisted rows and `TripWaypointDto`/`tripFromDetail` speak the backend
 * vocabulary (`hotel`, `coffee`). Canonicalize stay/rest types on import so a
 * reloaded shared trip maps the overnight back to a stay (not `via`) — which
 * also keeps the `start_linked` boundary intact. Shared types pass through.
 */
function canonicalSnapshotWaypointType(type: BuiltWaypointType): string {
  if (type === 'accommodation') return 'hotel';
  if (type === 'rest') return 'coffee';
  return type;
}

const SAME_POINT_EPSILON = 1e-5;

function samePoint(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): boolean {
  return (
    Math.abs(a.lat - b.lat) < SAME_POINT_EPSILON &&
    Math.abs(a.lng - b.lng) < SAME_POINT_EPSILON
  );
}

// ── shared-trip snapshot parsing (#357) ──────────────────────────────
//
// The trip-share snapshot is opaque JSONB the companion writes verbatim
// (see `apps/companion/src/lib/types.ts` Trip + TripDay + Waypoint), so
// we can't trust the shape blindly. The helpers below narrow it into
// the minimal subset we need to reconstruct multi-day rows, skipping
// (rather than 400-ing) malformed individual fields. A snapshot with
// no usable days at all is rejected by the caller.

interface ParsedSnapshotDay {
  title: string | null;
  distance_km: number;
  duration_min: number | null;
  avg_quality: number | null;
  elevation_gain: number | null;
  geometry: Array<{ lat: number; lng: number }>;
  waypoints: BuiltWaypoint[];
  startLinked: boolean;
}

// Snapshot waypoints round-trip the same vocabulary the backend
// persists — including `accommodation`, which the legacy flat `/trips/
// import` path drops because its DTO doesn't accept the type. Derived
// from `BUILT_WAYPOINT_TYPES` so the runtime allow-list and the
// `BuiltWaypoint['waypoint_type']` union can't drift apart.
const SNAPSHOT_WAYPOINT_TYPES: ReadonlySet<BuiltWaypointType> = new Set(
  BUILT_WAYPOINT_TYPES,
);

function isBuiltWaypointType(value: unknown): value is BuiltWaypointType {
  return (
    typeof value === 'string' &&
    SNAPSHOT_WAYPOINT_TYPES.has(value as BuiltWaypointType)
  );
}

// Hard caps mirrored from `import-trip.dto.ts` so a malformed (or
// abusive) snapshot can't blow up DB write volume even though the
// snapshot itself was already capped at MAX_TRIP_SNAPSHOT_BYTES (1MB).
// Per-day rather than per-trip so a 5-day snapshot doesn't get a 5×
// concession on either dimension.
const SNAPSHOT_MAX_GEOMETRY_POINTS_PER_DAY = 50_000;
const SNAPSHOT_MAX_WAYPOINTS_PER_DAY = 5_000;

function parseSnapshotDays(snapshot: unknown): ParsedSnapshotDay[] {
  if (typeof snapshot !== 'object' || snapshot === null) return [];
  const rawDays = (snapshot as { days?: unknown }).days;
  if (!Array.isArray(rawDays)) return [];

  const out: ParsedSnapshotDay[] = [];
  for (const raw of rawDays) {
    const parsed = parseSnapshotDay(raw);
    // A day with neither geometry nor waypoints carries no information
    // the rider could ride. Drop it rather than persisting an empty row
    // — the renumbering in `allocateAndPersistSharedTrip` handles the
    // gap.
    if (parsed.geometry.length === 0 && parsed.waypoints.length === 0) {
      continue;
    }
    out.push(parsed);
  }
  return out;
}

function parseSnapshotDay(raw: unknown): ParsedSnapshotDay {
  const day = (raw ?? {}) as Record<string, unknown>;

  const title = typeof day.title === 'string' ? day.title : null;

  const rawDistance = day.distanceKm;
  const distance_km =
    typeof rawDistance === 'number' &&
    Number.isFinite(rawDistance) &&
    rawDistance >= 0
      ? rawDistance
      : 0;

  const rawDuration = day.durationMinutes;
  const duration_min =
    typeof rawDuration === 'number' &&
    Number.isFinite(rawDuration) &&
    rawDuration > 0
      ? rawDuration
      : null;

  const rawQuality = day.avgQuality;
  const avg_quality =
    typeof rawQuality === 'number' &&
    Number.isFinite(rawQuality) &&
    rawQuality > 0
      ? rawQuality
      : null;

  const rawElevation = day.elevationGain;
  const elevation_gain =
    typeof rawElevation === 'number' && Number.isFinite(rawElevation)
      ? rawElevation
      : null;

  const geometry = parseSnapshotGeometry(day.routeGeometry);
  const waypoints = parseSnapshotWaypoints(day.waypoints);
  // Companion snapshots carry the overnight link flag as `startLinked`.
  const startLinked = day.startLinked === true;

  // Recompute distance from geometry when the snapshot didn't carry it
  // (older shares predating the per-day distance field) — the trip-list
  // UI reads `distance_km` and a zero would surface as "0 km" next to a
  // route the rider just imported.
  const effectiveDistance =
    distance_km > 0 || geometry.length < 2
      ? distance_km
      : totalDistanceKm(geometry);

  return {
    title,
    distance_km: effectiveDistance,
    duration_min,
    avg_quality,
    elevation_gain,
    geometry,
    waypoints,
    startLinked,
  };
}

function parseSnapshotGeometry(
  raw: unknown,
): Array<{ lat: number; lng: number }> {
  if (typeof raw !== 'object' || raw === null) return [];
  const coords = (raw as { coordinates?: unknown }).coordinates;
  if (!Array.isArray(coords)) return [];

  const out: Array<{ lat: number; lng: number }> = [];
  for (const entry of coords) {
    if (out.length >= SNAPSHOT_MAX_GEOMETRY_POINTS_PER_DAY) break;
    if (!Array.isArray(entry) || entry.length < 2) continue;
    const [lng, lat] = entry as [unknown, unknown];
    if (
      typeof lat !== 'number' ||
      typeof lng !== 'number' ||
      !Number.isFinite(lat) ||
      !Number.isFinite(lng) ||
      lat < -90 ||
      lat > 90 ||
      lng < -180 ||
      lng > 180
    ) {
      continue;
    }
    out.push({ lat, lng });
  }
  return out;
}

function parseSnapshotWaypoints(raw: unknown): BuiltWaypoint[] {
  if (!Array.isArray(raw)) return [];

  const out: BuiltWaypoint[] = [];
  for (const entry of raw) {
    if (out.length >= SNAPSHOT_MAX_WAYPOINTS_PER_DAY) break;
    if (typeof entry !== 'object' || entry === null) continue;
    const e = entry as {
      location?: { lat?: unknown; lng?: unknown };
      name?: unknown;
      type?: unknown;
    };
    const lat = e.location?.lat;
    const lng = e.location?.lng;
    if (
      typeof lat !== 'number' ||
      typeof lng !== 'number' ||
      !Number.isFinite(lat) ||
      !Number.isFinite(lng) ||
      lat < -90 ||
      lat > 90 ||
      lng < -180 ||
      lng > 180
    ) {
      continue;
    }
    const type: BuiltWaypointType = isBuiltWaypointType(e.type)
      ? e.type
      : 'via';
    out.push({
      lat,
      lng,
      name: typeof e.name === 'string' ? e.name : undefined,
      waypoint_type: type,
    });
  }
  return out;
}

/**
 * Build the start/via/end waypoint sequence we persist for an imported
 * trip. Mirrors the companion's `deriveWaypoints` heuristic so the
 * imported trip has the same shape on every client:
 *  - the route's first/last polyline point are forced to be `start`/`end`
 *    (the DTO doesn't accept those types from the client — position wins)
 *  - imported waypoints co-located with start/end donate their `name`
 *  - all other imported waypoints honour the client-supplied `type`
 *    (`via` / `fuel` / `rest` / `photo`), defaulting to `via` when the
 *    client doesn't say (which is what the GPX/KML parsers emit, since
 *    the source files don't carry a Tarmoto-shaped type field)
 *  - waypoints outside the lat/lng range (already filtered by class
 *    validators) cannot reach this function
 */
function buildImportedWaypoints(dto: ImportTripDto): BuiltWaypoint[] {
  const first = dto.geometry[0];
  const last = dto.geometry[dto.geometry.length - 1];
  if (!first || !last) {
    throw new Error('buildImportedWaypoints: route geometry is empty');
  }
  const incoming = dto.waypoints ?? [];

  const startMatch = incoming.find((w) => samePoint(w, first));
  const endMatch = incoming.find((w) => samePoint(w, last));

  const start: BuiltWaypoint = {
    lat: first.lat,
    lng: first.lng,
    name: startMatch?.name,
    waypoint_type: 'start',
  };
  const end: BuiltWaypoint = {
    lat: last.lat,
    lng: last.lng,
    name: endMatch?.name,
    waypoint_type: 'end',
  };

  const vias: BuiltWaypoint[] = incoming
    .filter((w) => !samePoint(w, first) && !samePoint(w, last))
    .map((w) => ({
      lat: w.lat,
      lng: w.lng,
      name: w.name,
      waypoint_type: w.type ?? 'via',
    }));

  return [start, ...vias, end];
}

function nextCopyName(name: string): string {
  const base = name.replace(/\s+\(copy(?:\s+\d+)?\)$/i, '').trim() || 'Trip';
  const copy = `${base} (copy)`;
  // Truncate to 200 chars (trips.title is varchar(200)).
  return copy.length > 200 ? copy.slice(0, 197) + '...' : copy;
}
