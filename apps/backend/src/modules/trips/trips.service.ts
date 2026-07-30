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
import {
  DEFAULT_LOCALE,
  haversineKm,
  isWithinLimit,
  latLngToPoint,
  pointToLatLng,
  type PlannerPoiCategory,
  type SupportedLocale,
} from '@tarmoto/shared';
import { Trip } from '../../entities/trip.entity.js';
import { TripDay } from '../../entities/trip-day.entity.js';
import { TripFolder } from '../../entities/trip-folder.entity.js';
import { TripMember } from '../../entities/trip-member.entity.js';
import { TripInvite } from '../../entities/trip-invite.entity.js';
import { TripSuggestion } from '../../entities/trip-suggestion.entity.js';
import { TripWaypoint } from '../../entities/trip-waypoint.entity.js';
import { User } from '../../entities/user.entity.js';
import { getCompanionUrl } from '../../common/companion-url.js';
import { EmailService } from '../email/email.service.js';
import { EventsGateway } from '../events/events.gateway.js';
import { featureLimitExceeded } from '../features/feature-limit.error.js';
import { FeatureResolver } from '../features/feature-resolver.service.js';
import {
  assertWithinCollaboratorLimit,
  tripCollaboratorLockKey,
} from '../features/collaborator-cap.js';
import { TripActivityService } from '../trip-activity/trip-activity.service.js';
import { TripSharesService } from '../trip-shares/trip-shares.service.js';
import {
  ROUTING_PROVIDER,
  type RoutingProvider,
} from '../commute/routing-provider.interface.js';
import { RouteEnrichmentService } from '../routing/route-enrichment.service.js';
import { CreateTripDto } from './dto/create-trip.dto.js';
import { ImportTripDto } from './dto/import-trip.dto.js';
import { InviteTripDto } from './dto/invite-trip.dto.js';
import { generateInviteCode } from './invite-code.js';
import type { TripCollaboratorsDto } from './dto/collaborators.dto.js';
import { ListTripsDto } from './dto/list-trips.dto.js';
import { SaveRouteDayDto, SaveRouteDto } from './dto/save-route.dto.js';
import type { RoutePreferenceOption } from '../routing/dto/route.dto.js';
import { UpdateTripDto } from './dto/update-trip.dto.js';
import { UpdateWaypointNamesDto } from './dto/update-waypoint-names.dto.js';
import {
  TripDayDto,
  TripDetailDto,
  TripInvitePreviewDto,
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

type TripCopyMessages = {
  fallbackTitle: string;
  copyLabel: string;
  copyTemplate: string;
};

// Backend-generated trip names are persisted rider-facing copy, so they use
// the duplicating rider's stored UI locale. Exhaustiveness is intentional:
// registering a product locale must also define the backend copy marker.
const TRIP_COPY_MESSAGES = {
  en: {
    fallbackTitle: 'Trip',
    copyLabel: 'copy',
    copyTemplate: '{name} (copy)',
  },
} satisfies Record<SupportedLocale, TripCopyMessages>;

// ~50 m at mid-latitudes — bounds the invite-preview geometry payload while
// keeping the overview polyline recognisable at typical zoom.
const INVITE_PREVIEW_SIMPLIFY_TOLERANCE_DEG = 0.0005;

// ~200 m — coarser than the invite preview because the trips-list card renders
// the outline at thumbnail size, so a handful of points per day is plenty and
// keeps the list payload small across many trips.
const LIST_OVERVIEW_SIMPLIFY_TOLERANCE_DEG = 0.002;

// Roles allowed to mutate trip-wide metadata. Keeping this in one place
// so role checks stay consistent if we ever grow the role vocabulary.
// `editor` replaced the old `admin`/`member` pair (migration 1793):
// editors co-plan the route; `viewer` is the read-and-comment tier that
// anonymous link-joiners start in.
const PRIVILEGED_ROLES = new Set(['owner', 'editor']);

/** Trip statuses that count against `max_active_trips` (owner only). */
const OPEN_TRIP_STATUSES = ['draft', 'planned', 'active'] as const;

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
    private readonly events: EventsGateway,
    private readonly activity: TripActivityService,
    private readonly tripShares: TripSharesService,
    private readonly email: EmailService,
    private readonly config: ConfigService,
    @Inject(ROUTING_PROVIDER)
    private readonly routingProvider: RoutingProvider,
    private readonly enrichment: RouteEnrichmentService,
    private readonly featureResolver: FeatureResolver,
  ) {}

  async create(userId: string, dto: CreateTripDto): Promise<TripDetailDto> {
    await this.assertCanMintOpenTrip(userId);

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

    // The duplicate is minted with `owner_id: userId` below (the caller
    // becomes the new trip's owner, even when duplicating a trip they
    // only co-collaborate on), so it's the CALLER's cap that governs
    // here — checked only after the 404 authorization above.
    await this.assertCanMintOpenTrip(userId);

    const duplicator = await this.userRepo.findOne({
      where: { id: userId },
      select: ['language'],
    });
    const duplicateLocale = duplicator?.language ?? DEFAULT_LOCALE;

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
          title: nextCopyName(source.title, duplicateLocale),
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
              poi_category: wp.poi_category,
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

  /**
   * `max_active_trips` gate — counts open trips the OWNER holds and
   * rejects minting another at the cap. Check-then-act: two concurrent
   * creates can each pass the count and briefly overshoot by one; the
   * next mint re-checks, so the cap self-corrects. Accepted for v1 —
   * serialising every trip create on a per-user lock isn't worth that
   * failure mode.
   *
   * Public so the other services that mint or promote a trip into an open
   * state route through the same single check: `SharingService.cloneRide`
   * (new draft) and `TripGeneratorService.generate` (promotes a completed
   * trip back to `planned`). Promotion callers must guard on the current
   * status themselves (only call when a `completed` trip is going open) —
   * the count already excludes `completed`, so calling it for an
   * already-open trip would wrongly block editing at the cap.
   */
  async assertCanMintOpenTrip(ownerId: string): Promise<void> {
    const limits = await this.featureResolver.resolveLimitsForUser(ownerId);
    const limit = limits.max_active_trips;
    if (limit === null) return; // unlimited — skip the count entirely
    const current = await this.tripRepo.count({
      where: { owner_id: ownerId, status: In([...OPEN_TRIP_STATUSES]) },
    });
    if (!isWithinLimit(limit, current)) {
      throw featureLimitExceeded('max_active_trips', limit, current);
    }
  }

  /**
   * Owner-scoped `max_trip_collaborators` cap for the invite endpoint. The
   * limit belongs to the trip OWNER (not the inviter — an editor can invite),
   * so it resolves the owner's entitlement and counts the trip's current
   * NON-OWNER collaborators (accepted members + pending invites) against it,
   * throwing before a NEW invitee is persisted. Callers must invoke this ONLY
   * when adding a new collaborator — a re-invite of an already-pending address
   * (role change / code rotation) adds nobody and must not be blocked.
   *
   * Resolved OUTSIDE the invite transaction: `FeatureResolver` reads the global
   * pool, so resolving it while the txn holds the per-trip advisory lock could
   * exhaust the pool under concurrent invites/joins and deadlock the
   * lock-holder. The count + enforcement then run inside the txn via
   * `assertWithinCollaboratorLimit`.
   */
  private async resolveCollaboratorLimit(
    ownerId: string,
  ): Promise<number | null> {
    const limits = await this.featureResolver.resolveLimitsForUser(ownerId);
    return limits.max_trip_collaborators;
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
    await this.assertCanMintOpenTrip(userId);

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

      // Replacing the route on a completed trip promotes it back to an
      // open (`planned`) state — a net-new open trip against the owner's
      // cap. Gate it exactly like the PATCH reopen. Already-open trips
      // don't change the count, so they're not gated (would block edits).
      if (locked.status === 'completed') {
        await this.assertCanMintOpenTrip(locked.owner_id);
      }

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

        // Reopening a completed trip mints a new open slot. The trip's
        // own row is still `completed` at this point (the UPDATE below
        // hasn't run yet), so the upcoming count reflects the owner's
        // OTHER open trips — correct. Gate on the OWNER's cap, not the
        // caller's: a privileged editor can reopen a trip they don't own,
        // and it's the owner's slot budget that a reopen consumes.
        const reopening =
          dto.status !== undefined &&
          locked.status === 'completed' &&
          dto.status !== 'completed';
        if (reopening) {
          await this.assertCanMintOpenTrip(locked.owner_id);
        }

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

  async remove(
    userId: string,
    tripId: string,
    onlyIfDraft = false,
  ): Promise<void> {
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

    // `onlyIfDraft` folds the status predicate INTO the DELETE's WHERE clause so
    // it's atomic: a draft that finishes generating (marked `planned`) in the
    // window between the client's status check and this call won't match, so the
    // completed route + its days are never cascaded away. A non-draft simply
    // yields `affected: 0` → the same 404 the caller treats as "nothing to
    // clean" (see tripDraftCleanup). The unconditional path (normal delete-trip)
    // is unchanged.
    const result = onlyIfDraft
      ? await this.tripRepo.delete({ id: tripId, status: 'draft' })
      : await this.tripRepo.delete({ id: tripId });

    // Concurrent double-delete: two requests from the same owner can
    // both pass the membership check before either DELETE lands, and
    // the second one will find the row already gone. `affected: 0`
    // means another caller (or a racing manual delete) won that race —
    // fold into a 404 so the late caller gets a consistent response
    // and doesn't broadcast a duplicate `trip:deleted` to live
    // collaborators. (Also covers `onlyIfDraft` matching no draft row.)
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
    // The cap check and the invite write run inside ONE advisory-locked
    // transaction so concurrent invites (and the separately-triggered
    // group-link join) can't each observe the same roster, pass the cap, and
    // collectively overflow the owner's paid limit. Only a NEW invitee counts —
    // a re-invite of an already-pending address (the update branch) adds no
    // collaborator; the existing-MEMBER case already returned above.
    //
    // A unique violation rolls the txn back. Under the per-trip lock a
    // concurrent (trip, email) insert is serialised away, leaving only the rare
    // table-wide `invite_code` collision — so the outer loop retries with a
    // fresh code (re-acquiring the lock). What matters is that the code in the
    // email is ALWAYS the code that actually got persisted.
    const role = dto.role ?? 'editor';
    // Resolve the owner's cap OUTSIDE the transaction (pool-safety — see
    // resolveCollaboratorLimit). Harmless for a re-invite, which skips the
    // check inside the txn.
    const collaboratorLimit = await this.resolveCollaboratorLimit(
      trip.owner_id,
    );
    let personalCode = '';
    // The recipient's account id when they turn out to be a member (resolved
    // under the lock), else null → proceed with the invite.
    let alreadyMemberId: string | null;
    for (let attempt = 0; ; attempt++) {
      personalCode = generateInviteCode();
      try {
        alreadyMemberId = await this.tripRepo.manager.transaction(
          async (manager) => {
            await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
              tripCollaboratorLockKey(tripId),
            ]);
            // Re-resolve the recipient BY EMAIL under the lock, then recheck
            // membership. The pre-lock lookup can miss a rider who had no
            // account then but registered AND joined via the group link before
            // this transaction took the lock — so keying the recheck on the
            // pre-lock `existingUser.id` (possibly null) would let it slip
            // through. Creating/refreshing an invite for a current member would
            // 403 them at the cap and double-count them in later checks;
            // short-circuit to the no-op instead.
            const recipient = await manager.getRepository(User).findOne({
              where: { email: dto.email },
            });
            if (recipient) {
              const member = await manager.getRepository(TripMember).findOne({
                where: { trip_id: tripId, user_id: recipient.id },
              });
              if (member) return recipient.id;
            }
            const inviteRepo = manager.getRepository(TripInvite);
            const existingInvite = await inviteRepo.findOne({
              where: { trip_id: tripId, email: dto.email },
            });
            if (existingInvite) {
              await inviteRepo.update(
                { id: existingInvite.id },
                { role, invite_code: personalCode, invited_by: userId },
              );
            } else {
              await assertWithinCollaboratorLimit(
                manager,
                tripId,
                collaboratorLimit,
              );
              await inviteRepo.insert({
                trip_id: tripId,
                email: dto.email,
                role,
                invite_code: personalCode,
                invited_by: userId,
              });
            }
            return null;
          },
        );
        break;
      } catch (err: unknown) {
        // A ForbiddenException (cap exceeded) is not a unique violation, so it
        // propagates immediately rather than looping.
        if (!isUniqueViolation(err) || attempt >= 4) throw err;
      }
    }

    if (alreadyMemberId !== null) {
      // Same no-op as the pre-lock already-member branch, but for a recipient
      // who joined (e.g. via the group link) during this request: skip the
      // email + invite, log, and record the flagged activity.
      this.logger.log(
        `Skipped trip-invite email — recipient is already a member ` +
          `(trip=${tripId}, user=${alreadyMemberId})`,
      );
      await this.activity.recordSafe(tripId, userId, 'member_invited', {
        recipient_email_domain: emailDomain(dto.email),
        already_member: true,
      });
      return;
    }

    const joinUrl = this.buildInviteUrl(tripId, personalCode);

    // The recipient may not have a Tarmoto account yet — `existingUser`
    // (looked up above by `dto.email`) is the only source of a stored
    // language preference; an external invitee falls back to the
    // product default.
    await this.email.sendTripInvite(
      dto.email,
      {
        inviterDisplayName: inviterName,
        tripTitle: trip.title,
        joinUrl,
        inviteCode: personalCode,
        message: dto.message?.trim() ? dto.message.trim() : null,
      },
      existingUser?.language ?? DEFAULT_LOCALE,
    );

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

    const aggById = await this.computeTripAggregates(
      trips.map((t) => t.id),
      { withOverview: true },
    );
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
  private async computeTripAggregates(
    ids: string[],
    // Building the per-day simplified overview is PostGIS work + payload only
    // the trips-list card and the duplicate flow's detail actually render, so
    // it's opt-in: callers that read only the rollups (e.g. the invite
    // preview) skip it via a cheap `NULL::json` select.
    opts?: { withOverview?: boolean },
  ): Promise<
    Map<
      string,
      {
        distance_km: number | null;
        quality_avg: number | null;
        passes_count: number | null;
        overview_geometry: number[][][] | null;
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
      // A per-day simplified overview polyline for the trips-list card
      // thumbnail — one LineString per day, ordered, degenerate/null-geom days
      // filtered out. `::json` so json_agg embeds each geometry as an object,
      // not a re-encoded string. Skipped (cheap `NULL::json`) unless the caller
      // opts in, so rollup-only callers don't pay the simplify/serialize cost.
      // Tolerance inlined (a compile-time numeric constant, no injection risk).
      .addSelect(
        opts?.withOverview
          ? 'json_agg(ST_AsGeoJSON(ST_SimplifyPreserveTopology(d.route_geom, ' +
              `${LIST_OVERVIEW_SIMPLIFY_TOLERANCE_DEG}))::json ` +
              'ORDER BY d.day_number) FILTER (WHERE d.route_geom IS NOT NULL)'
          : 'NULL::json',
        'overview',
      )
      .where('d.trip_id IN (:...ids)', { ids })
      .groupBy('d.trip_id')
      .getRawMany<{
        trip_id: string;
        distance_km: string | null;
        quality_avg: string | null;
        passes_count: string | null;
        overview: unknown;
      }>();

    return new Map(
      aggRows.map((r) => [
        r.trip_id,
        {
          distance_km: r.distance_km != null ? parseFloat(r.distance_km) : null,
          quality_avg: r.quality_avg != null ? parseFloat(r.quality_avg) : null,
          passes_count:
            r.passes_count != null ? parseInt(r.passes_count, 10) : null,
          overview_geometry: parseOverviewGeometry(r.overview),
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
    signal?: AbortSignal,
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
    const routeLeg = (
      points: ReadonlyArray<{ lat: number; lng: number }>,
      routeOptions: typeof baseOptions,
    ) =>
      signal
        ? this.routingProvider.route(points, routeOptions, signal)
        : this.routingProvider.route(points, routeOptions);
    if (legPreferences && legPreferences.length > 0) {
      // Per-leg road characters (revision 3 §C): re-route the day with
      // the SAME leg requests the live preview used, or a custom leg
      // (e.g. one Maximum twisty stretch in a Direct trip) would persist
      // a different line than the rider approved.
      const legs = await Promise.all(
        legPreferences.map((preference, i) =>
          routeLeg(
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
      const whole = await routeLeg(
        routing.map((w) => ({ lat: w.lat, lng: w.lng })),
        baseOptions,
      );
      if (!whole) {
        throw new BadGatewayException(`No road route for day ${day.dayNumber}`);
      }
      route = whole;
    }
    signal?.throwIfAborted();
    const m = signal
      ? await this.enrichment.aggregate(route.geometry, signal)
      : await this.enrichment.aggregate(route.geometry);
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
    signal?: AbortSignal,
  ): Promise<TripDetailDto> {
    const startedAt = Date.now();
    // 1. Membership gate: fold "no such trip" and "not a member" into
    //    the same 404 so the endpoint can't enumerate trip ids. Viewers
    //    are read-and-comment only — route writes need editor access.
    const member = await this.memberRepo.findOne({
      where: { trip_id: tripId, user_id: userId },
    });
    if (!member) throw new NotFoundException('Trip not found');
    if (member.role === 'viewer') {
      throw new ForbiddenException(
        'Editing the route needs editor access — ask the trip owner to upgrade your role',
      );
    }

    // Renumber contiguously (defensive — client already drops empties).
    const days = dto.days.map((d, i) => ({ ...d, dayNumber: i + 1 }));

    // 2. Route + enrich each day up front so a routing failure (502) aborts
    //    the whole save before the transaction starts — no partial writes.
    const routingStartedAt = Date.now();
    const built = await Promise.all(
      days.map((d) => this.buildDayRoute(d, dto.options, signal)),
    );
    const routingMs = Date.now() - routingStartedAt;
    signal?.throwIfAborted();

    // 3. Replace ALL days + their waypoints in a single transaction.
    const persistenceStartedAt = Date.now();
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

      // Saving a manual route onto a completed trip promotes it back to an
      // open (`planned`) state — gate the net-new open trip against the
      // owner's cap, exactly like the PATCH reopen and the import path.
      if (locked.status === 'completed') {
        await this.assertCanMintOpenTrip(locked.owner_id);
      }

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
            poi_category: w.poi_category ?? null,
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
    const persistenceMs = Date.now() - persistenceStartedAt;

    // Fetch the persisted detail once and reuse it for both the broadcast
    // and the return value — mirrors replaceWithImportedRoute and update so
    // collaborators watching via WebSocket see the same state the caller
    // receives in the HTTP response.
    const detailStartedAt = Date.now();
    const detail = await this.getDetail(userId, tripId);
    const detailMs = Date.now() - detailStartedAt;
    this.events.emitToTrip(tripId, 'trip:updated', detail);
    // Audit trail — mirrors update/import/generate so the Activity tab shows
    // who changed the route on a collaborative trip.
    await this.activity.recordSafe(tripId, userId, 'trip_updated', {
      fields: ['manual_route'],
    });
    const totalMs = Date.now() - startedAt;
    if (totalMs >= 1_000) {
      const legCount = days.reduce(
        (sum, day) =>
          sum +
          Math.max(
            1,
            day.waypoints.filter((w) =>
              ['start', 'via', 'end'].includes(w.type),
            ).length - 1,
          ),
        0,
      );
      this.logger.warn(
        `Planner route save took ${totalMs}ms ` +
          `(routing=${routingMs}ms, persistence=${persistenceMs}ms, ` +
          `detail=${detailMs}ms, days=${days.length}, legs=${legCount})`,
      );
    }
    return detail;
  }

  /**
   * Rename waypoints WITHOUT re-routing. Updates only `trip_waypoints.name`
   * for the listed ids that belong to the trip; geometry, order, and type are
   * untouched and the router is not run. Lets a loaded trip persist late
   * reverse-geocoded pin names without `saveManualRoute`'s re-route replacing an
   * imported / manually-adjusted route (#911).
   */
  async updateWaypointNames(
    userId: string,
    tripId: string,
    dto: UpdateWaypointNamesDto,
  ): Promise<TripDetailDto> {
    // Same membership gate as saveManualRoute — names are route content, so
    // editors may change them; viewers are read-only.
    const member = await this.memberRepo.findOne({
      where: { trip_id: tripId, user_id: userId },
    });
    if (!member) throw new NotFoundException('Trip not found');
    if (member.role === 'viewer') {
      throw new ForbiddenException(
        'Editing the route needs editor access — ask the trip owner to upgrade your role',
      );
    }

    let changed = false;
    await this.tripRepo.manager.transaction(async (manager) => {
      // Scope by trip (trip_waypoints -> trip_days -> trip) so a caller can't
      // rename another trip's rows by guessing ids.
      const days = await manager.find(TripDay, {
        where: { trip_id: tripId },
        relations: ['waypoints'],
      });
      const owned = new Map<string, TripWaypoint>();
      for (const day of days) {
        for (const w of day.waypoints ?? []) owned.set(w.id, w);
      }
      for (const { id, name } of dto.waypoints) {
        const current = owned.get(id);
        if (!current) continue; // id not in this trip — ignore
        // PATCH semantics: an omitted `name` leaves the label unchanged; only
        // an explicit `null` clears it. Without this, a client that drops
        // `undefined` fields (or sends an id-only entry) would wipe the name.
        if (name === undefined) continue;
        if (current.name === name) continue; // unchanged — skip the write
        await manager.update(TripWaypoint, { id }, { name });
        changed = true;
      }
    });

    const detail = await this.getDetail(userId, tripId);
    // Only broadcast/audit a real change — an all-no-op call (the companion
    // sends only the ids it renamed, but a stale retry can still land) must not
    // spam collaborators or the Activity tab. When something did change, mirror
    // saveManualRoute so other open planners rehydrate the new names via
    // `trip:updated` (otherwise they keep stale names and could save over them).
    if (changed) {
      this.events.emitToTrip(tripId, 'trip:updated', detail);
      await this.activity.recordSafe(tripId, userId, 'trip_updated', {
        fields: ['waypoint_names'],
      });
    }
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
    // withOverview so the duplicate flow's detail-derived card carries the real
    // route outline immediately (the frontend adapter reads it).
    const aggById = await this.computeTripAggregates([trip.id], {
      withOverview: true,
    });
    return this.toDetail(trip, aggById.get(trip.id));
  }

  /**
   * Masked pre-join preview for an invited rider (`GET /trips/:tripId/invite/
   * :code/preview`). Authorized by a live personal invite code — NOT
   * membership — so a not-yet-member can see a raw route overview before
   * accepting. Unlike {@link join}, this is READ-ONLY: it never consumes the
   * invite. Folds "unknown trip" and "wrong/revoked code" into the same 404 so
   * the endpoint can't enumerate trip ids or probe which codes are live.
   */
  async getInvitePreview(
    userId: string,
    tripId: string,
    code: string,
  ): Promise<TripInvitePreviewDto> {
    const normalized = code.trim().toUpperCase();

    const trip = await this.tripRepo.findOne({
      where: { id: tripId },
      relations: ['owner'],
    });
    if (!trip) {
      throw new NotFoundException('Invite not found');
    }

    const invite = await this.inviteRepo.findOne({
      where: { trip_id: tripId, invite_code: normalized },
      relations: ['inviter'],
    });
    if (!invite) {
      throw new NotFoundException('Invite not found');
    }

    const alreadyMember =
      (await this.memberRepo.findOne({
        where: { trip_id: tripId, user_id: userId },
      })) != null;

    // Simplified per-day geometry (~50 m tolerance) so the preview payload
    // stays bounded; the client renders it as a single overview polyline.
    const geomRows = await this.tripRepo.manager.query<
      Array<{ geometry: string | null }>
    >(
      `SELECT ST_AsGeoJSON(ST_SimplifyPreserveTopology(route_geom, $1)) AS geometry
       FROM trip_days
       WHERE trip_id = $2 AND route_geom IS NOT NULL
       ORDER BY day_number`,
      [INVITE_PREVIEW_SIMPLIFY_TOLERANCE_DEG, tripId],
    );
    const lines: number[][][] = [];
    for (const row of geomRows) {
      const coords = parsePreviewLine(row.geometry);
      if (coords) lines.push(coords);
    }

    const aggById = await this.computeTripAggregates([trip.id]);
    const distance = aggById.get(trip.id)?.distance_km ?? null;

    return {
      trip_id: trip.id,
      title: trip.title,
      owner_name: trip.owner?.display_name ?? null,
      invited_by_name: invite.inviter?.display_name ?? null,
      role: invite.role as TripMemberRole,
      region: trip.region ?? null,
      num_days: trip.num_days,
      distance_km: distance != null ? Number(distance) : null,
      lines,
      already_member: alreadyMember,
    };
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
        // Take the shared per-trip collaborator advisory lock FIRST, so this
        // personal-code acceptance serialises with the group-link join
        // (`TripSharesService.joinByToken`). Both consume the same invite as
        // "net-zero"; without a common lock the group link's plain invite read
        // could see this invite still present while we consume it here, letting
        // a bearer-code holder and the invited email BOTH insert from one
        // invite and overflow the owner's cap.
        await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
          tripCollaboratorLockKey(tripId),
        ]);
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
      if (role === 'viewer') {
        // A demoted editor's group links and pending email invites
        // would otherwise stay live — owned by them and invisible to
        // the trip owner — while their new role can't create either.
        // Mirrors removeMember.
        await this.tripShares.revokeAllForTripMember(tripId, memberUserId);
        await this.inviteRepo.delete({
          trip_id: tripId,
          invited_by: memberUserId,
        });
      }
      await this.activity.recordSafe(tripId, userId, 'member_role_changed', {
        member_user_id: memberUserId,
        role,
      });
      // Live planners derive their write gates from the fetched trip
      // detail and refresh them on `trip:updated` — broadcast one so a
      // demoted editor's open planner locks (and a promoted viewer's
      // unlocks) without a reload.
      const detail = await this.getDetail(userId, tripId);
      this.events.emitToTrip(tripId, 'trip:updated', detail);
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

    await this.evictMember(tripId, target, {
      actorId: userId,
      action: 'member_removed',
    });
  }

  /**
   * Self-service exit for a collaborator (viewer/editor). The owner has
   * no leave path — deleting the trip is their only exit — so an owner
   * calling this gets a 400 pointing them there. Non-members 404.
   */
  async leaveTrip(userId: string, tripId: string): Promise<void> {
    const membership = await this.memberRepo.findOne({
      where: { trip_id: tripId, user_id: userId },
    });
    if (!membership) throw new NotFoundException('Trip not found');
    if (membership.role === 'owner') {
      throw new BadRequestException(
        'The owner cannot leave their own trip; delete it instead',
      );
    }
    await this.evictMember(tripId, membership, {
      actorId: userId,
      action: 'member_left',
    });
  }

  /**
   * Shared eviction path for both owner-driven removal and self-leave:
   * drops the membership row, cuts LIVE socket access, and revokes the
   * links/invites the departing rider owned so their codes stop admitting
   * riders. Past contributions (suggestions, votes, messages) stay — this
   * only revokes access from now on.
   */
  private async evictMember(
    tripId: string,
    member: TripMember,
    opts: { actorId: string; action: 'member_removed' | 'member_left' },
  ): Promise<void> {
    const memberUserId = member.user_id;
    await this.memberRepo.delete({ id: member.id });
    // Revoke LIVE access too: the socket room is only membership-checked
    // at subscribe time, so without eviction an open planner would keep
    // receiving trip broadcasts until the next reconnect.
    await this.events.evictFromTrip(tripId, memberUserId);
    // And revoke any group links the removed member created — they're
    // owned by that user, so the trip owner can't see or revoke them,
    // and they'd otherwise keep admitting new riders after removal.
    await this.tripShares.revokeAllForTripMember(tripId, memberUserId);
    // Same for pending email invites they sent: join() authorizes by
    // the invite row alone, so those codes would keep admitting riders
    // (at the role the ex-member picked) after their authority ended.
    await this.inviteRepo.delete({ trip_id: tripId, invited_by: memberUserId });
    await this.activity.recordSafe(tripId, opts.actorId, opts.action, {
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
      overview_geometry: number[][][] | null;
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
      // Per-day simplified outline for the card thumbnail; null when the trip
      // has no routed geometry yet (e.g. a draft).
      overview_geometry: agg?.overview_geometry ?? null,
    };
  }

  private toDetail(
    trip: Trip,
    agg?: {
      distance_km: number | null;
      quality_avg: number | null;
      passes_count: number | null;
      overview_geometry: number[][][] | null;
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
          poi_category: w.poi_category as PlannerPoiCategory | null,
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
}

/**
 * Parse a `ST_AsGeoJSON` LineString string into `[lng, lat]` pairs for the
 * invite preview. Returns `null` for missing/degenerate geometry (fewer than
 * two valid points) so a single-point simplify result doesn't render as a
 * malformed polyline.
 */
/**
 * Parse the trips-list overview aggregate — a JSON array of per-day simplified
 * LineString geometries (from `json_agg(ST_AsGeoJSON(...)::json)`) — into an
 * array of `[lng, lat]` polylines for the card thumbnail. Drops degenerate
 * lines (< 2 points); returns null when no day has usable geometry.
 */
function parseOverviewGeometry(raw: unknown): number[][][] | null {
  let value = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(value)) return null;
  const lines: number[][][] = [];
  for (const entry of value) {
    const coords = (entry as { coordinates?: unknown } | null)?.coordinates;
    if (!Array.isArray(coords)) continue;
    const line: number[][] = [];
    for (const c of coords) {
      if (
        Array.isArray(c) &&
        typeof c[0] === 'number' &&
        typeof c[1] === 'number'
      ) {
        line.push([c[0], c[1]]);
      }
    }
    if (line.length >= 2) lines.push(line);
  }
  return lines.length > 0 ? lines : null;
}

function parsePreviewLine(geometry: string | null): number[][] | null {
  if (!geometry) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(geometry);
  } catch {
    return null;
  }
  const coords = (parsed as { coordinates?: unknown }).coordinates;
  if (!Array.isArray(coords)) return null;
  const out: number[][] = [];
  for (const c of coords) {
    if (
      Array.isArray(c) &&
      typeof c[0] === 'number' &&
      typeof c[1] === 'number'
    ) {
      out.push([c[0], c[1]]);
    }
  }
  return out.length >= 2 ? out : null;
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

// The waypoint vocabulary a `BuiltWaypoint` can carry into the persistence
// layer. `accommodation` is representable even though the GPX/KML
// `ImportTripDto` doesn't accept it from clients — overnight stays are a
// persisted waypoint type.
type BuiltWaypointType =
  | 'start'
  | 'via'
  | 'end'
  | 'fuel'
  | 'rest'
  | 'photo'
  | 'accommodation';

interface BuiltWaypoint {
  lat: number;
  lng: number;
  name?: string | undefined;
  waypoint_type: BuiltWaypointType;
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

function nextCopyName(name: string, locale: SupportedLocale): string {
  const messages = TRIP_COPY_MESSAGES[locale] ?? TRIP_COPY_MESSAGES.en;
  const knownCopyLabels = Object.values(TRIP_COPY_MESSAGES)
    .map(({ copyLabel }) => copyLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
  const copySuffix = new RegExp(
    `\\s+\\((?:${knownCopyLabels})(?:\\s+\\d+)?\\)$`,
    'iu',
  );
  const base = name.replace(copySuffix, '').trim() || messages.fallbackTitle;
  const copy = messages.copyTemplate.replace('{name}', base);
  // Truncate to 200 chars (trips.title is varchar(200)).
  return copy.length > 200 ? copy.slice(0, 197) + '...' : copy;
}
