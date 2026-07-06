import { randomBytes } from 'node:crypto';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { TripShare } from '../../entities/trip-share.entity.js';
import { Trip } from '../../entities/trip.entity.js';
import { TripMember } from '../../entities/trip-member.entity.js';
import { TripInvite } from '../../entities/trip-invite.entity.js';
import { User } from '../../entities/user.entity.js';
import { TripActivityService } from '../trip-activity/trip-activity.service.js';
import {
  CreateTripShareDto,
  TripShareJoinResponseDto,
  TripShareListResponseDto,
  TripSharePublicDto,
  TripShareResponseDto,
} from './dto/trip-share.dto.js';

const PRIVILEGED_ROLES = new Set(['owner', 'editor']);

@Injectable()
export class TripSharesService {
  constructor(
    @InjectRepository(TripShare)
    private readonly tripShareRepo: Repository<TripShare>,
    @InjectRepository(Trip)
    private readonly tripRepo: Repository<Trip>,
    @InjectRepository(TripMember)
    private readonly memberRepo: Repository<TripMember>,
    @InjectRepository(TripInvite)
    private readonly inviteRepo: Repository<TripInvite>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    private readonly activity: TripActivityService,
  ) {}

  async create(
    userId: string,
    dto: CreateTripShareDto,
  ): Promise<TripShareResponseDto> {
    const tripId = dto.trip_id ?? null;
    if (tripId) {
      await this.requireShareAuthority(userId, tripId);
    }

    const created = await this.tripShareRepo.save(
      this.tripShareRepo.create({
        owner_id: userId,
        trip_id: tripId,
        share_token: randomBytes(16).toString('hex'),
        title: dto.title,
        snapshot: dto.snapshot,
      }),
    );
    return this.toOwnerResponse(created);
  }

  async joinByToken(
    userId: string,
    token: string,
  ): Promise<TripShareJoinResponseDto> {
    const share = await this.findActiveByToken(token);
    if (!share.trip_id) {
      throw new BadRequestException(
        'This shared trip is a read-only preview and cannot be joined',
      );
    }

    const trip = await this.tripRepo.findOne({
      where: { id: share.trip_id },
      select: { id: true },
    });
    if (!trip) {
      throw new BadRequestException(
        'This shared trip is a read-only preview and cannot be joined',
      );
    }

    const existing = await this.memberRepo.findOne({
      where: { trip_id: share.trip_id, user_id: userId },
    });

    // A pending email invite for this user's address carries the role
    // the owner picked — honour it even when they arrive through the
    // group link instead of their personal invite link. Anonymous
    // link-joiners start as read-and-comment `viewer`s.
    let invite: TripInvite | null = null;
    const joiner = await this.userRepo.findOne({
      where: { id: userId },
      select: { id: true, email: true },
    });
    if (joiner?.email) {
      invite = await this.inviteRepo.findOne({
        where: { trip_id: share.trip_id, email: joiner.email.toLowerCase() },
      });
    }

    let inserted = false;
    if (!existing) {
      try {
        await this.memberRepo.save(
          this.memberRepo.create({
            trip_id: share.trip_id,
            user_id: userId,
            role: invite?.role ?? 'viewer',
          }),
        );
        inserted = true;
      } catch (err: unknown) {
        if (!isUniqueViolation(err)) throw err;
      }
    }

    if (invite) {
      await this.inviteRepo.delete({ id: invite.id });
    }

    if (inserted) {
      await this.activity.recordSafe(share.trip_id, userId, 'member_joined', {
        source: 'trip_share',
        role: invite?.role ?? 'viewer',
      });
    }

    return {
      trip_id: share.trip_id,
      planner_url: this.buildPlannerUrl(share.trip_id),
    };
  }

  async getByToken(token: string): Promise<TripSharePublicDto> {
    const share = await this.findActiveByToken(token);
    // Atomic UPDATE ... view_count = view_count + 1 so concurrent viewers
    // can't race each other into a lost-update on the counter. The loaded
    // row is stale by one after this, so we bump it in-memory for the
    // response rather than re-selecting.
    await this.tripShareRepo.increment({ id: share.id }, 'view_count', 1);
    share.view_count = (share.view_count ?? 0) + 1;

    return this.toPublicResponse(share);
  }

  /**
   * Look up an active share by token without bumping `view_count`.
   *
   * Used by `POST /trips/from-share` (#357) to materialise the snapshot
   * into a real multi-day trip. The view counter is meant to track
   * external link traffic (web preview opens) — counting an
   * authenticated server-side import would inflate that signal and
   * defeat its purpose. Soft-deleted owners (US-62) collapse to the
   * same 404 the public reader returns so an importing client can't
   * side-channel whether the owner deleted their account.
   */
  async findActiveByToken(token: string): Promise<TripShare> {
    const share = await this.tripShareRepo.findOne({
      where: { share_token: token },
      relations: ['owner'],
    });
    if (!share || share.owner?.deleted_at != null) {
      throw new NotFoundException('Trip share not found');
    }
    return share;
  }

  async listMine(userId: string): Promise<TripShareListResponseDto> {
    const [rows, total] = await this.tripShareRepo.findAndCount({
      where: { owner_id: userId },
      order: { created_at: 'DESC' },
    });
    return {
      items: rows.map((row) => this.toOwnerResponse(row)),
      total,
    };
  }

  async revoke(userId: string, id: string): Promise<void> {
    const share = await this.tripShareRepo.findOne({ where: { id } });
    if (!share) {
      throw new NotFoundException('Trip share not found');
    }
    if (share.owner_id !== userId) {
      // 403, not 404 — hiding the row's existence from non-owners isn't
      // worth the debugging friction when a client sends the wrong id.
      throw new ForbiddenException('Not the owner of this trip share');
    }
    await this.tripShareRepo.remove(share);
  }

  private toOwnerResponse(share: TripShare): TripShareResponseDto {
    return {
      id: share.id,
      share_token: share.share_token,
      share_url: this.buildShareUrl(share.share_token),
      trip_id: share.trip_id ?? null,
      title: share.title,
      view_count: share.view_count ?? 0,
      created_at: share.created_at.toISOString(),
      updated_at: share.updated_at.toISOString(),
    };
  }

  private toPublicResponse(share: TripShare): TripSharePublicDto {
    return {
      share_token: share.share_token,
      trip_id: share.trip_id ?? null,
      title: share.title,
      owner_name: share.owner?.display_name ?? 'Unknown',
      snapshot: share.snapshot,
      view_count: share.view_count ?? 0,
      created_at: share.created_at.toISOString(),
      updated_at: share.updated_at.toISOString(),
    };
  }

  private buildShareUrl(token: string): string {
    return `/trips/shared/${token}`;
  }

  private buildPlannerUrl(tripId: string): string {
    return `/trips/planner?tripId=${encodeURIComponent(tripId)}`;
  }

  private async requireShareAuthority(
    userId: string,
    tripId: string,
  ): Promise<void> {
    const membership = await this.memberRepo.findOne({
      where: { trip_id: tripId, user_id: userId },
    });
    if (!membership || !PRIVILEGED_ROLES.has(membership.role)) {
      throw new NotFoundException('Trip not found');
    }
  }
}

function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const candidate = err as { code?: unknown };
  return candidate.code === '23505';
}
