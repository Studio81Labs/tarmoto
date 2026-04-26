import { randomBytes } from 'crypto';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { pointToLatLng } from '@tarmoto/shared';
import { Trip } from '../../entities/trip.entity.js';
import { TripMember } from '../../entities/trip-member.entity.js';
import { EventsGateway } from '../events/events.gateway.js';
import { TripActivityService } from '../trip-activity/trip-activity.service.js';
import { CreateTripDto } from './dto/create-trip.dto.js';
import { ListTripsDto } from './dto/list-trips.dto.js';
import { UpdateTripDto } from './dto/update-trip.dto.js';
import {
  TripDayDto,
  TripDetailDto,
  TripMemberDto,
  TripSummaryDto,
  TripWaypointDto,
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
    let lastError: unknown;
    for (let attempt = 0; attempt < MAX_INVITE_ALLOCATION_ATTEMPTS; attempt++) {
      const inviteCode = generateInviteCode();
      try {
        return await this.tripRepo.manager.transaction(async (manager) => {
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
      } catch (err: unknown) {
        // Only retry the specific 23505 we caused (invite_code unique
        // index). Any other failure — including a 23505 from an
        // unrelated constraint — propagates so we don't paper over a
        // real bug as a code collision.
        if (!isInviteCodeViolation(err)) throw err;
        lastError = err;
      }
    }
    throw new Error(
      `Failed to allocate a unique trip invite code after ${MAX_INVITE_ALLOCATION_ATTEMPTS} attempts` +
        (lastError instanceof Error ? `: ${lastError.message}` : ''),
    );
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
      status: trip.status,
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
      role: m.role,
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
          waypoint_type: w.waypoint_type,
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
      road_preference: trip.road_preference,
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
