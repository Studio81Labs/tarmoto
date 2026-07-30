import { randomBytes } from 'node:crypto';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { isFeatureEnabled } from '@tarmoto/shared';
import { DataSource, Repository } from 'typeorm';
import { TripShare } from '../../entities/trip-share.entity.js';
import { Trip } from '../../entities/trip.entity.js';
import { TripMember } from '../../entities/trip-member.entity.js';
import { TripInvite } from '../../entities/trip-invite.entity.js';
import { User } from '../../entities/user.entity.js';
import { TripActivityService } from '../trip-activity/trip-activity.service.js';
import { FeatureResolver } from '../features/feature-resolver.service.js';
import {
  assertWithinCollaboratorLimit,
  tripCollaboratorLockKey,
} from '../features/collaborator-cap.js';
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
    private readonly featureResolver: FeatureResolver,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * The OWNER's `max_trip_collaborators` value (`null` = unlimited). Resolved
   * OUTSIDE the join transaction: `FeatureResolver` reads the global pool, so
   * resolving it while the txn holds the per-trip advisory lock could exhaust
   * the pool under concurrent joins and deadlock the lock-holder. The count +
   * enforcement then run inside the txn via `assertWithinCollaboratorLimit`.
   */
  private async resolveCollaboratorLimit(
    ownerId: string,
  ): Promise<number | null> {
    const limits = await this.featureResolver.resolveLimitsForUser(ownerId);
    return limits.max_trip_collaborators;
  }

  async create(
    userId: string,
    dto: CreateTripShareDto,
  ): Promise<TripShareResponseDto> {
    const tripId = dto.trip_id ?? null;
    if (tripId) {
      // A share attached to a persisted trip is real collaboration → gate on
      // `collaborative_trips` (Pro). A snapshot-only share (no `trip_id`) is a
      // read-only preview that creates no collaboration, so it stays open to all
      // tiers — do NOT gate it (the old controller-wide guard wrongly did).
      if (
        !isFeatureEnabled(
          await this.featureResolver.resolveForUser(userId),
          'collaborative_trips',
        )
      ) {
        // Match the FeatureGuard envelope (incl. the machine-readable `feature`)
        // so this manual gate satisfies the FeatureForbiddenDto contract the
        // controller declares for its 403.
        throw new ForbiddenException({
          statusCode: 403,
          error: 'Forbidden',
          message: 'Feature unavailable: collaborative_trips',
          feature: 'collaborative_trips',
        });
      }
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
      select: { id: true, owner_id: true },
    });
    if (!trip) {
      throw new BadRequestException(
        'This shared trip is a read-only preview and cannot be joined',
      );
    }

    const tripId = share.trip_id;
    // Fast-path idempotency: an already-joined caller re-hitting the link needs
    // no work. This is only a hint — the authoritative membership re-check runs
    // INSIDE the lock below, so a concurrent same-user join can't slip through.
    const alreadyMember = await this.memberRepo.findOne({
      where: { trip_id: tripId, user_id: userId },
    });

    // The joiner's OWN email drives the pending-invite lookup (not racy); the
    // invite ROW itself is re-read inside the lock so a revoke can't be missed.
    const joiner = await this.userRepo.findOne({
      where: { id: userId },
      select: { id: true, email: true },
    });
    const joinerEmail = joiner?.email?.toLowerCase() ?? null;

    let inserted = false;
    let joinedRole = 'viewer';
    if (!alreadyMember) {
      // Resolve the owner's cap BEFORE the transaction (pool-safety — see
      // resolveCollaboratorLimit). Whether it's actually enforced is decided
      // INSIDE the lock, once we know if a still-valid invite makes this join
      // net-zero.
      const collaboratorLimit = await this.resolveCollaboratorLimit(
        trip.owner_id,
      );
      // The cap check and the member insert must be atomic. Unlike the owner
      // invite UI (single actor, proactive gate), the public group link can be
      // opened by many strangers at once: without serialisation each request
      // reads the same pre-insert count, passes the cap, and inserts a
      // different member — overflowing the owner's paid limit. Take a per-trip
      // advisory lock (auto-released at txn end) and do EVERYTHING that decides
      // the roster inside it: re-check membership, re-read the invite, enforce
      // the cap, insert, and consume the invite.
      const result = await this.dataSource.transaction(async (manager) => {
        await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
          tripCollaboratorLockKey(tripId),
        ]);
        const memberRepo = manager.getRepository(TripMember);
        const inviteRepo = manager.getRepository(TripInvite);

        // Re-check membership under the lock: a concurrent join for THIS user
        // may have committed. Treat that as the idempotent success it is —
        // never a cap 403.
        const member = await memberRepo.findOne({
          where: { trip_id: tripId, user_id: userId },
        });
        if (member) return { inserted: false, role: member.role };

        // Re-read the pending invite under the lock. A pending email invite for
        // this address carries the role the owner picked (honoured even via the
        // group link); anonymous joiners default to read-and-comment `viewer`.
        // Reading it here — not before the lock — means a revoke between the
        // pre-lock work and now can't let a stale invite bypass the cap.
        const invite = joinerEmail
          ? await inviteRepo.findOne({
              where: { trip_id: tripId, email: joinerEmail },
            })
          : null;
        const role = invite?.role ?? 'viewer';

        // A joiner consuming a still-valid invite was already counted (invite →
        // member is net-zero); only a NEW collaborator must pass the cap.
        if (!invite) {
          await assertWithinCollaboratorLimit(
            manager,
            tripId,
            collaboratorLimit,
          );
        }
        try {
          await memberRepo.save(
            memberRepo.create({ trip_id: tripId, user_id: userId, role }),
          );
        } catch (err: unknown) {
          if (!isUniqueViolation(err)) throw err;
          return { inserted: false, role };
        }
        // Consume the invite atomically with the insert it authorised.
        if (invite) await inviteRepo.delete({ id: invite.id });
        return { inserted: true, role };
      });
      inserted = result.inserted;
      joinedRole = result.role;
    }

    if (inserted) {
      await this.activity.recordSafe(tripId, userId, 'member_joined', {
        source: 'trip_share',
        role: joinedRole,
      });
    }

    return {
      trip_id: tripId,
      planner_url: this.buildPlannerUrl(tripId),
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
   * Shared internal lookup behind `getByToken` and the token join flow.
   * The view counter is meant to track external link traffic (web
   * preview opens), so internal reads that shouldn't count toward it use
   * this path instead. Soft-deleted owners (US-62) collapse to the same
   * 404 the public reader returns so a caller can't side-channel whether
   * the owner deleted their account.
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

  /**
   * Revoke every share of a trip created by one user. Called when the
   * owner removes that member: their `trip_shares` rows would otherwise
   * stay live — and invisible to the owner, who can only list/revoke
   * shares by `owner_id` — so a removed editor's group link would keep
   * admitting new riders after removal.
   */
  async revokeAllForTripMember(
    tripId: string,
    memberUserId: string,
  ): Promise<void> {
    await this.tripShareRepo.delete({
      trip_id: tripId,
      owner_id: memberUserId,
    });
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
