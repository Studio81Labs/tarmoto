import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { randomInt } from 'crypto';
import { GroupRide } from '../../entities/group-ride.entity.js';
import { GroupRideMember } from '../../entities/group-ride-member.entity.js';
import { User } from '../../entities/user.entity.js';
import { EventsGateway } from '../events/events.gateway.js';
import { CreateGroupRideDto } from './dto/create-group-ride.dto.js';
import {
  GroupRideDetailDto,
  GroupRideMemberDto,
} from './dto/group-ride-response.dto.js';

// Crockford-style alphabet minus ambiguous chars (0/O, 1/I/L, U). 30
// symbols × 6 chars = ~7.3e8 codes which is more than enough since
// codes only need to stay unique among ACTIVE rides (uniqueness scope
// is enforced by a partial index on `ended_at IS NULL`).
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
const CODE_LENGTH = 6;
const MAX_CODE_ALLOCATION_ATTEMPTS = 5;

// Matches the partial unique index name created in the migration. We
// disambiguate `23505` errors by constraint name so a unique-violation
// on `(group_ride_id, user_id)` doesn't get retried as if it were a
// code collision.
const CODE_INDEX = 'uq_group_rides_active_code';

@Injectable()
export class GroupRidesService {
  constructor(
    @InjectRepository(GroupRide)
    private readonly groupRideRepo: Repository<GroupRide>,
    @InjectRepository(GroupRideMember)
    private readonly memberRepo: Repository<GroupRideMember>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    private readonly events: EventsGateway,
  ) {}

  async create(
    userId: string,
    dto: CreateGroupRideDto,
  ): Promise<GroupRideDetailDto> {
    // Two writes (`group_rides` + creator's `group_ride_members`) in
    // one transaction so an aborted insert can never leave an orphan
    // ride that no one — not even the owner — can join. Code
    // allocation runs inside the retry loop so a partial-index
    // collision rolls back cleanly and re-rolls.
    const id = await this.allocateAndPersistGroupRide(userId, dto);
    return this.getDetailById(id);
  }

  private async allocateAndPersistGroupRide(
    userId: string,
    dto: CreateGroupRideDto,
  ): Promise<string> {
    let lastError: unknown;
    for (let attempt = 0; attempt < MAX_CODE_ALLOCATION_ATTEMPTS; attempt++) {
      const code = generateGroupRideCode();
      try {
        return await this.groupRideRepo.manager.transaction(async (manager) => {
          const ride = manager.create(GroupRide, {
            owner_id: userId,
            name: dto.name,
            code,
            ended_at: null,
          });
          const saved = await manager.save(ride);

          await manager.save(
            manager.create(GroupRideMember, {
              group_ride_id: saved.id,
              user_id: userId,
            }),
          );

          return saved.id;
        });
      } catch (err: unknown) {
        if (!isCodeViolation(err)) throw err;
        lastError = err;
      }
    }
    throw new Error(
      `Failed to allocate a unique group-ride code after ${MAX_CODE_ALLOCATION_ATTEMPTS} attempts` +
        (lastError instanceof Error ? `: ${lastError.message}` : ''),
    );
  }

  /**
   * Join an active group ride by its 6-char code. Idempotent for
   * existing members (returns the current detail without re-inserting)
   * so a flaky network retry can't trip the unique index. Folds "no
   * such code" and "ride has already ended" into the same 404 — the
   * code stops being a meaningful handle the moment the ride ends, and
   * we don't want to enumerate which codes were ever valid.
   */
  async join(userId: string, code: string): Promise<GroupRideDetailDto> {
    const normalized = code.trim().toUpperCase();
    const ride = await this.groupRideRepo.findOne({
      where: { code: normalized, ended_at: IsNull() },
    });
    if (!ride) {
      throw new NotFoundException('Group ride not found');
    }

    const existing = await this.memberRepo.findOne({
      where: { group_ride_id: ride.id, user_id: userId },
    });
    if (!existing) {
      const member = await this.memberRepo.save(
        this.memberRepo.create({
          group_ride_id: ride.id,
          user_id: userId,
        }),
      );
      const user = await this.userRepo.findOne({
        where: { id: userId },
        select: { id: true, display_name: true },
      });
      this.events.broadcastToGroupRide(ride.id, 'group:joined', {
        group_ride_id: ride.id,
        user_id: userId,
        display_name: user?.display_name ?? '',
        at: member.joined_at.toISOString(),
      });
    }

    return this.getDetailById(ride.id);
  }

  /**
   * Leave a group ride. Required AC: positions disappear immediately,
   * so we delete the membership row outright (rather than soft-deleting
   * with a `left_at`) — `GET /group-rides/:id` returns the live list
   * of dots and a soft-delete would force every read to filter. If the
   * leaver was the owner AND no members remain, end the ride too.
   */
  async leave(userId: string, groupRideId: string): Promise<void> {
    const ride = await this.groupRideRepo.findOne({
      where: { id: groupRideId },
    });
    if (!ride || ride.ended_at !== null) {
      // Folds "ride doesn't exist" and "ride already ended" into the
      // same 404. A non-member trying to leave also lands here via the
      // membership check below.
      throw new NotFoundException('Group ride not found');
    }

    const membership = await this.memberRepo.findOne({
      where: { group_ride_id: groupRideId, user_id: userId },
    });
    if (!membership) {
      throw new NotFoundException('Group ride not found');
    }

    await this.memberRepo.delete({ id: membership.id });

    const at = new Date().toISOString();
    this.events.broadcastToGroupRide(groupRideId, 'group:left', {
      group_ride_id: groupRideId,
      user_id: userId,
      at,
    });

    if (ride.owner_id === userId) {
      // Owner leaving ends the session for everyone — without this,
      // the code stays allocated and stragglers keep broadcasting to
      // an unowned room. Members can still create a fresh ride.
      await this.endRideInternal(ride.id);
      return;
    }

    const remaining = await this.memberRepo.count({
      where: { group_ride_id: groupRideId },
    });
    if (remaining === 0) {
      await this.endRideInternal(ride.id);
    }
  }

  /**
   * End an active group ride. Owner-only. Marking `ended_at` flips the
   * ride out of the partial unique index so the code can be reused,
   * and emits `group:ended` so connected clients can tear down their
   * map dots. Idempotent: ending an already-ended ride is a no-op.
   */
  async end(userId: string, groupRideId: string): Promise<void> {
    const ride = await this.groupRideRepo.findOne({
      where: { id: groupRideId },
    });
    if (!ride) {
      throw new NotFoundException('Group ride not found');
    }
    if (ride.owner_id !== userId) {
      throw new ForbiddenException('Only the owner can end the group ride');
    }
    if (ride.ended_at !== null) return;

    await this.endRideInternal(ride.id);
  }

  private async endRideInternal(groupRideId: string): Promise<void> {
    const at = new Date();
    await this.groupRideRepo.update({ id: groupRideId }, { ended_at: at });
    // Wipe each member's last-known position + breadcrumb buffer when the
    // ride ends (#752). Live location is operational only while the ride
    // is active (the weather sweep already reads it only for `ended_at IS
    // NULL` rides) — keeping it on an ended ride is a privacy hole, since
    // these fields are never otherwise aged out.
    await this.memberRepo.update(
      { group_ride_id: groupRideId },
      {
        last_lat: null,
        last_lng: null,
        last_speed: null,
        last_heading: null,
        last_position_at: null,
        recent_path: [],
      },
    );
    this.events.broadcastToGroupRide(groupRideId, 'group:ended', {
      group_ride_id: groupRideId,
      at: at.toISOString(),
    });
  }

  /**
   * Detail view used by `GET /group-rides/:id` and after every
   * mutation. Includes display names from the joined `users` table —
   * the WebSocket payload doesn't carry display names so the client
   * needs to refresh detail when an unknown user_id appears.
   */
  async getDetail(
    userId: string,
    groupRideId: string,
  ): Promise<GroupRideDetailDto> {
    await this.requireMembership(userId, groupRideId);
    return this.getDetailById(groupRideId);
  }

  /**
   * Membership check used by REST endpoints. Loads only the membership
   * row — caller fetches detail separately when needed.
   */
  async requireMembership(
    userId: string,
    groupRideId: string,
  ): Promise<GroupRideMember> {
    const membership = await this.memberRepo.findOne({
      where: { group_ride_id: groupRideId, user_id: userId },
    });
    if (!membership) {
      throw new NotFoundException('Group ride not found');
    }
    return membership;
  }

  private async getDetailById(
    groupRideId: string,
  ): Promise<GroupRideDetailDto> {
    const ride = await this.groupRideRepo.findOne({
      where: { id: groupRideId },
    });
    if (!ride) {
      throw new NotFoundException('Group ride not found');
    }

    // Pull memberships and corresponding users in two queries rather
    // than via TypeORM relations — the membership row carries the
    // last-known position fields, but `display_name` lives on `users`,
    // and joining via QueryBuilder keeps the row count predictable.
    const memberships = await this.memberRepo.find({
      where: { group_ride_id: groupRideId },
      order: { joined_at: 'ASC' },
    });
    const userIds = memberships.map((m) => m.user_id);
    const users =
      userIds.length === 0
        ? []
        : await this.userRepo
            .createQueryBuilder('u')
            .select(['u.id', 'u.display_name'])
            .whereInIds(userIds)
            .getMany();
    const namesById = new Map(users.map((u) => [u.id, u.display_name]));

    const members: GroupRideMemberDto[] = memberships.map((m) => ({
      user_id: m.user_id,
      display_name: namesById.get(m.user_id) ?? '',
      joined_at: m.joined_at.toISOString(),
      last_lat: m.last_lat,
      last_lng: m.last_lng,
      last_speed: m.last_speed,
      last_heading: m.last_heading,
      last_position_at: m.last_position_at?.toISOString() ?? null,
      recent_path: Array.isArray(m.recent_path) ? m.recent_path : [],
    }));

    return {
      id: ride.id,
      owner_id: ride.owner_id,
      name: ride.name,
      code: ride.code,
      started_at: ride.started_at.toISOString(),
      ended_at: ride.ended_at?.toISOString() ?? null,
      members,
    };
  }
}

function generateGroupRideCode(): string {
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    out += CODE_ALPHABET[randomInt(0, CODE_ALPHABET.length)];
  }
  return out;
}

function isCodeViolation(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: string; constraint?: string; message?: string };
  if (e.code !== '23505') return false;
  if (e.constraint === CODE_INDEX) return true;
  // PG sometimes surfaces the constraint name in the message rather
  // than the dedicated field, depending on the driver version.
  return typeof e.message === 'string' && e.message.includes(CODE_INDEX);
}
