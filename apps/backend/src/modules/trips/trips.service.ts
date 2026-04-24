import { randomBytes } from 'crypto';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Trip } from '../../entities/trip.entity.js';
import { TripMember } from '../../entities/trip-member.entity.js';
import { CreateTripDto } from './dto/create-trip.dto.js';
import { ListTripsDto } from './dto/list-trips.dto.js';
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

@Injectable()
export class TripsService {
  constructor(
    @InjectRepository(Trip)
    private readonly tripRepo: Repository<Trip>,
    @InjectRepository(TripMember)
    private readonly memberRepo: Repository<TripMember>,
  ) {}

  async create(userId: string, dto: CreateTripDto): Promise<TripDetailDto> {
    if (
      dto.daily_km_min !== undefined &&
      dto.daily_km_max !== undefined &&
      dto.daily_km_min > dto.daily_km_max
    ) {
      throw new BadRequestException(
        'daily_km_min must be less than or equal to daily_km_max',
      );
    }

    const inviteCode = await this.allocateInviteCode();
    const trip = this.tripRepo.create({
      owner_id: userId,
      title: dto.title,
      region: dto.region ?? null,
      num_days: dto.num_days,
      daily_km_min: dto.daily_km_min ?? 150,
      daily_km_max: dto.daily_km_max ?? 350,
      min_quality: dto.min_quality ?? 3.0,
      road_preference: dto.road_preference ?? 'curvy',
      status: 'draft',
      invite_code: inviteCode,
    });

    const saved = await this.tripRepo.save(trip);

    // Record the owner as a member so the same `members` join powers
    // both authorization (am I in this trip?) and the roster shown to
    // collaborators.
    await this.memberRepo.save(
      this.memberRepo.create({
        trip_id: saved.id,
        user_id: userId,
        role: 'owner',
      }),
    );

    return this.getDetail(userId, saved.id);
  }

  async list(userId: string, query: ListTripsDto): Promise<TripSummaryDto[]> {
    // Trips visible to the caller = trips where they appear in
    // `trip_members` (the `create` flow inserts the owner as a member,
    // so a single membership join covers both owners and joiners).
    const qb = this.tripRepo
      .createQueryBuilder('trip')
      .innerJoin(
        TripMember,
        'm',
        'm.trip_id = trip.id AND m.user_id = :userId',
        { userId },
      )
      .leftJoinAndSelect('trip.members', 'allMembers')
      .orderBy('trip.created_at', 'DESC');

    if (query.status) {
      qb.andWhere('trip.status = :status', { status: query.status });
    }

    const trips = await qb.getMany();
    return trips.map((t) => this.toSummary(t));
  }

  async getDetail(userId: string, tripId: string): Promise<TripDetailDto> {
    const trip = await this.tripRepo.findOne({
      where: { id: tripId },
      relations: {
        members: { user: true },
        days: { waypoints: true },
      },
      order: {
        days: { day_number: 'ASC', waypoints: { sequence: 'ASC' } },
      },
    });

    if (!trip) {
      throw new NotFoundException('Trip not found');
    }

    if (!trip.members.some((m) => m.user_id === userId)) {
      // Don't leak existence to non-members — same response as a missing
      // trip.
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

    if (!existing) {
      try {
        await this.memberRepo.save(
          this.memberRepo.create({
            trip_id: tripId,
            user_id: userId,
            role: 'member',
          }),
        );
      } catch (err: unknown) {
        // Concurrent join race — the unique (trip_id, user_id) index
        // rejected the duplicate. Desired post-state still holds.
        if (!isUniqueViolation(err)) throw err;
      }
    }

    return this.getDetail(userId, tripId);
  }

  private async allocateInviteCode(): Promise<string> {
    for (let attempt = 0; attempt < MAX_INVITE_ALLOCATION_ATTEMPTS; attempt++) {
      const candidate = generateInviteCode();
      const collision = await this.tripRepo.findOne({
        where: { invite_code: candidate },
        select: { id: true },
      });
      if (!collision) return candidate;
    }
    throw new Error('Failed to allocate a unique trip invite code');
  }

  private toSummary(trip: Trip): TripSummaryDto {
    return {
      id: trip.id,
      title: trip.title,
      region: trip.region,
      num_days: trip.num_days,
      status: trip.status,
      member_count: trip.members?.length ?? 0,
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
      estimated_time_min: parseIntervalToMinutes(d.estimated_time),
      route_geometry: lineStringToLatLngs(d.route_geom),
      waypoints: (d.waypoints ?? []).map(
        (w): TripWaypointDto => ({
          id: w.id,
          sequence: w.sequence,
          ...pointToLatLng(w.location),
          name: w.name,
          waypoint_type: w.waypoint_type,
          road_segment_id: w.road_segment_id,
          notes: w.notes,
          duration_min: w.duration_min,
        }),
      ),
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

function pointToLatLng(geom: unknown): { lat: number; lng: number } {
  const coords = (geom as { coordinates?: unknown })?.coordinates;
  if (
    Array.isArray(coords) &&
    typeof coords[0] === 'number' &&
    typeof coords[1] === 'number'
  ) {
    return { lat: coords[1], lng: coords[0] };
  }
  return { lat: 0, lng: 0 };
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
