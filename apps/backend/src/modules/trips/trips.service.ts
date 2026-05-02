import { randomBytes } from 'crypto';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { haversineKm, latLngToPoint, pointToLatLng } from '@tarmoto/shared';
import { Trip } from '../../entities/trip.entity.js';
import { TripDay } from '../../entities/trip-day.entity.js';
import { TripMember } from '../../entities/trip-member.entity.js';
import { TripWaypoint } from '../../entities/trip-waypoint.entity.js';
import { EventsGateway } from '../events/events.gateway.js';
import { TripActivityService } from '../trip-activity/trip-activity.service.js';
import { TripSharesService } from '../trip-shares/trip-shares.service.js';
import { CreateTripDto } from './dto/create-trip.dto.js';
import { FromShareTripDto } from './dto/from-share-trip.dto.js';
import { ImportTripDto } from './dto/import-trip.dto.js';
import { ListTripsDto } from './dto/list-trips.dto.js';
import { UpdateTripDto } from './dto/update-trip.dto.js';
import {
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

// Crockford-style base32 minus ambiguous chars (0/O, 1/I/L, U). 30 symbols
// keep codes easy to dictate over the phone.
const INVITE_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
const INVITE_LENGTH = 8;
const MAX_INVITE_ALLOCATION_ATTEMPTS = 5;
// Must match the unique index name in
// `1714800000000-AddTripInviteCode.ts`. We disambiguate `23505` errors
// by constraint name so a unique-violation on, say, `trip_members
// (trip_id, user_id)` doesn't get silently retried as if it were an
// invite-code collision.
const INVITE_CODE_INDEX = 'idx_trips_invite_code';
const DEFAULT_DAILY_KM_MIN = 150;
const DEFAULT_DAILY_KM_MAX = 350;
const DEFAULT_MIN_QUALITY = 3.0;
const DEFAULT_ROAD_PREFERENCE = 'curvy';

// Roles allowed to mutate trip-wide metadata. Keeping this in one place
// so role checks stay consistent if we ever grow the role vocabulary.
const PRIVILEGED_ROLES = new Set(['owner', 'admin']);

@Injectable()
export class TripsService {
  constructor(
    @InjectRepository(Trip)
    private readonly tripRepo: Repository<Trip>,
    @InjectRepository(TripMember)
    private readonly memberRepo: Repository<TripMember>,
    private readonly events: EventsGateway,
    private readonly activity: TripActivityService,
    private readonly tripShares: TripSharesService,
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

  private async allocateAndPersistTrip(
    userId: string,
    dto: CreateTripDto,
    bounds: { dailyKmMin: number; dailyKmMax: number },
  ): Promise<string> {
    return this.withInviteCodeAllocation(async (manager, inviteCode) => {
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
        invite_code: inviteCode,
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
   * Run a transactional persist callback under the invite-code retry
   * loop. The callback runs inside a single transaction with a freshly
   * generated `inviteCode`; if the unique index on `trips.invite_code`
   * trips (PG `23505` against `idx_trips_invite_code`), we roll back,
   * regenerate, and try again up to `MAX_INVITE_ALLOCATION_ATTEMPTS`.
   *
   * Any other error — including a 23505 from a different constraint —
   * propagates so a real bug isn't papered over as a code collision.
   * Centralised here so the retry budget, the collision check, and the
   * "gave up" error message stay in lockstep across every persist path
   * (`POST /trips`, `POST /trips/import`, future variants).
   */
  private async withInviteCodeAllocation<T>(
    persist: (manager: EntityManager, inviteCode: string) => Promise<T>,
  ): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt < MAX_INVITE_ALLOCATION_ATTEMPTS; attempt++) {
      const inviteCode = generateInviteCode();
      try {
        return await this.tripRepo.manager.transaction((manager) =>
          persist(manager, inviteCode),
        );
      } catch (err: unknown) {
        if (!isInviteCodeViolation(err)) throw err;
        lastError = err;
      }
    }
    throw new Error(
      `Failed to allocate a unique trip invite code after ${MAX_INVITE_ALLOCATION_ATTEMPTS} attempts` +
        (lastError instanceof Error ? `: ${lastError.message}` : ''),
    );
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

  private async allocateAndPersistImportedTrip(
    userId: string,
    dto: ImportTripDto,
    bounds: { totalKm: number; dailyKmMin: number; dailyKmMax: number },
  ): Promise<string> {
    return this.withInviteCodeAllocation(async (manager, inviteCode) => {
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
        invite_code: inviteCode,
      });
      const savedTrip = await manager.save(trip);

      await manager.save(
        manager.create(TripMember, {
          trip_id: savedTrip.id,
          user_id: userId,
          role: 'owner',
        }),
      );

      const day = manager.create(TripDay, {
        trip_id: savedTrip.id,
        day_number: 1,
        title: dto.title,
        distance_km: Number(bounds.totalKm.toFixed(2)),
        // Rough estimate at 55 km/h — same heuristic the companion
        // uses for imported routes. Floor at 30 minutes so very
        // short test imports don't render as "0 min".
        estimated_time: `${Math.max(30, Math.round((bounds.totalKm / 55) * 60))} minutes`,
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

      return savedTrip.id;
    });
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
    return this.withInviteCodeAllocation(async (manager, inviteCode) => {
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
        invite_code: inviteCode,
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
        const dayNumber = i + 1;
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
        });
        const savedDay = await manager.save(day);

        if (parsed.waypoints.length > 0) {
          const rows = parsed.waypoints.map((w, idx) =>
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
    return trips.map((t) => this.toSummary(t));
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

    return this.toDetail(trip);
  }

  async join(
    userId: string,
    tripId: string,
    inviteCode: string,
  ): Promise<TripDetailDto> {
    const normalized = inviteCode.trim().toUpperCase();
    const trip = await this.tripRepo.findOne({ where: { id: tripId } });

    if (!trip || trip.invite_code !== normalized) {
      // Fold "wrong trip id" and "wrong code" into one response so the
      // endpoint can't be used to enumerate which trip ids exist.
      throw new ForbiddenException('Invalid trip or invite code');
    }

    const existing = await this.memberRepo.findOne({
      where: { trip_id: tripId, user_id: userId },
    });

    let inserted = false;
    if (!existing) {
      try {
        await this.memberRepo.save(
          this.memberRepo.create({
            trip_id: tripId,
            user_id: userId,
            role: 'member',
          }),
        );
        inserted = true;
      } catch (err: unknown) {
        // Concurrent join race — the unique (trip_id, user_id) index
        // rejected the duplicate. Desired post-state still holds, but
        // the first winner will have already written the activity row
        // for this membership so we leave that branch alone.
        if (!isUniqueViolation(err)) throw err;
      }
    }

    // Keep the activity entry OUTSIDE the unique-violation catch so a
    // non-23505 error from the activity path isn't misattributed to a
    // join race — `recordSafe` routes audit failures through a dedicated
    // Logger.warn instead. The member row is already durable by the
    // time we reach this line; a subsequent retry will short-circuit on
    // `existing` and skip the save.
    if (inserted) {
      await this.activity.recordSafe(tripId, userId, 'member_joined', {
        role: 'member',
      });
    }

    return this.getDetail(userId, tripId);
  }

  private toSummary(trip: Trip): TripSummaryDto {
    return {
      id: trip.id,
      title: trip.title,
      region: trip.region,
      num_days: trip.num_days,
      status: trip.status as TripStatus,
      // Prefer the COUNT mapped by `loadRelationCountAndMap` (set by
      // `list`), and fall back to the hydrated relation length when
      // `toSummary` is reached via `toDetail` (where we have the full
      // members[] from the QueryBuilder hydration in `getDetail`).
      member_count: trip.member_count ?? trip.members?.length ?? 0,
      created_at: trip.created_at.toISOString(),
    };
  }

  private toDetail(trip: Trip): TripDetailDto {
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
      ...this.toSummary(trip),
      member_count: members.length,
      daily_km_min: trip.daily_km_min,
      daily_km_max: trip.daily_km_max,
      min_quality: trip.min_quality,
      road_preference: trip.road_preference as TripRoadPreference,
      invite_code: trip.invite_code,
      members,
      days,
    };
  }
}

function generateInviteCode(): string {
  // randomBytes for entropy; reject the small biased tail at the top of
  // each byte so every code character is uniformly drawn from the
  // 30-char alphabet (240 = floor(256 / 30) * 30).
  const out: string[] = [];
  while (out.length < INVITE_LENGTH) {
    const buf = randomBytes(INVITE_LENGTH);
    for (const byte of buf) {
      if (byte >= 240) continue;
      out.push(INVITE_ALPHABET[byte % INVITE_ALPHABET.length]);
      if (out.length === INVITE_LENGTH) break;
    }
  }
  return out.join('');
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

function isInviteCodeViolation(err: unknown): boolean {
  if (!isUniqueViolation(err)) return false;
  const constraint = (err as { constraint?: unknown }).constraint;
  return constraint === INVITE_CODE_INDEX;
}

function totalDistanceKm(points: Array<{ lat: number; lng: number }>): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += haversineKm(
      points[i - 1].lat,
      points[i - 1].lng,
      points[i].lat,
      points[i].lng,
    );
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
  name?: string;
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
