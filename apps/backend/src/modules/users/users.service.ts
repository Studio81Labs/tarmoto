import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { Ride } from '../../entities/ride.entity.js';
import { User } from '../../entities/user.entity.js';
import { UserBadge } from '../../entities/user-badge.entity.js';
import { UserContact } from '../../entities/user-contact.entity.js';
import { UserFollow } from '../../entities/user-follow.entity.js';
import { OBJECT_STORAGE } from '../storage/storage.tokens.js';
import type { ObjectStorage } from '../storage/object-storage.interface.js';
import { PrivacyPreferencesService } from '../account/privacy-preferences.service.js';
import { BadgesService } from '../badges/badges.service.js';
import { UpdateProfileDto } from './dto/update-profile.dto.js';
import { CreateContactDto } from './dto/create-contact.dto.js';
import { UpdateContactDto } from './dto/update-contact.dto.js';
import {
  UserResponseDto,
  ContactResponseDto,
} from './dto/user-response.dto.js';
import { PublicProfileDto } from './dto/public-profile.dto.js';
import { MeProfileDto } from './dto/me-profile.dto.js';
import { MonthlyStatsDto } from './dto/monthly-stats.dto.js';
import { AVATAR_KEY_PREFIX, avatarKeyFromUrl } from './avatar-storage-key.js';
import { toUserResponse } from './user-response.mapper.js';

const ALLOWED_AVATAR_TYPES = new Map<string, string>([
  ['image/jpeg', '.jpg'],
  ['image/png', '.png'],
  ['image/webp', '.webp'],
]);

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    @InjectRepository(UserContact)
    private readonly contactRepo: Repository<UserContact>,
    @InjectRepository(UserFollow)
    private readonly userFollowRepo: Repository<UserFollow>,
    @InjectRepository(UserBadge)
    private readonly userBadgeRepo: Repository<UserBadge>,
    @InjectRepository(Ride)
    private readonly rideRepo: Repository<Ride>,
    @Inject(OBJECT_STORAGE)
    private readonly storage: ObjectStorage,
    private readonly privacy: PrivacyPreferencesService,
    private readonly badges: BadgesService,
  ) {}

  async getProfile(userId: string): Promise<UserResponseDto> {
    const user = await this.userRepo.findOne({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('User not found');
    }
    return toUserResponse(user);
  }

  /**
   * Authenticated rider's own profile summary (issue #334). Surfaces the
   * fields the badges endpoint does not expose (`joined_at`, `total_hours`)
   * plus the basic counts the profile / gamification surfaces want without
   * making the client compose three separate calls. `total_hours` is the
   * one number we can't crib from `BadgesService.computeStats()` — it is
   * derived from `(ended_at - started_at)` on completed rides only so an
   * abandoned in-progress ride doesn't inflate the total.
   */
  async getMeProfile(userId: string): Promise<MeProfileDto> {
    const user = await this.userRepo.findOne({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('User not found');
    }

    const [stats, hoursRow, followerCount, followingCount, badgesEarned] =
      await Promise.all([
        this.badges.computeStats(userId),
        this.rideRepo
          .createQueryBuilder('r')
          .select(
            'COALESCE(SUM(EXTRACT(EPOCH FROM (r.ended_at - r.started_at)) / 3600.0), 0)',
            'hours',
          )
          .where('r.user_id = :userId', { userId })
          .andWhere("r.status = 'completed'")
          .andWhere('r.ended_at IS NOT NULL')
          .getRawOne<{ hours: string }>(),
        this.userFollowRepo.count({ where: { following_id: userId } }),
        this.userFollowRepo.count({ where: { follower_id: userId } }),
        this.userBadgeRepo.count({ where: { user_id: userId } }),
      ]);

    return {
      joined_at: user.created_at.toISOString(),
      total_hours: parseFloat(hoursRow?.hours ?? '0'),
      total_rides: stats.ride_count ?? 0,
      total_distance_km: stats.total_distance ?? 0,
      roads_discovered: stats.roads_discovered ?? 0,
      hazards_reported: stats.hazards_reported ?? 0,
      follower_count: followerCount,
      following_count: followingCount,
      badges_earned: badgesEarned,
    };
  }

  /**
   * Current calendar month KPI snapshot for the companion home dashboard
   * (Task B2). Aggregates the rider's completed rides — distance, ride
   * time, distinct roads, and max lean — for the current month, with the
   * previous month's distance/hours included so the client renders deltas
   * locally. All four reads run in parallel on `rideRepo`, joining
   * `ride_stats` / `ride_segments` by raw table string (the same pattern
   * `ExplorationService` uses) so no extra repos need injecting. No
   * schema migration: pure aggregation over existing tables.
   *
   * "This month" vs "last month" is split server-side via
   * `date_trunc('month', now())`; we re-bucket the grouped rows against
   * the current UTC month so the metric stays stable across requests.
   * `last_synced_at` uses `MAX(created_at)` across all rides (not just
   * this month) since it represents the most recent mobile upload.
   */
  async getMonthlyStats(userId: string): Promise<MonthlyStatsDto> {
    const [months, leanRow, roadsRow, syncRow] = await Promise.all([
      this.rideRepo
        .createQueryBuilder('r')
        .select("date_trunc('month', r.started_at AT TIME ZONE 'UTC')", 'month')
        .addSelect('COALESCE(SUM(r.distance_km), 0)', 'km')
        .addSelect(
          'COALESCE(SUM(EXTRACT(EPOCH FROM (r.ended_at - r.started_at)) / 3600.0), 0)',
          'hours',
        )
        .where('r.user_id = :userId', { userId })
        .andWhere("r.status = 'completed'")
        .andWhere('r.ended_at IS NOT NULL')
        .andWhere(
          "(r.started_at AT TIME ZONE 'UTC') >= date_trunc('month', now() AT TIME ZONE 'UTC') - interval '1 month'",
        )
        // Upper bound at the next month boundary so a future-dated ride
        // (GPX import, clock skew) can't leak into this/last month or make
        // `prev` below match a future bucket instead of last month.
        .andWhere(
          "(r.started_at AT TIME ZONE 'UTC') < date_trunc('month', now() AT TIME ZONE 'UTC') + interval '1 month'",
        )
        .groupBy("date_trunc('month', r.started_at AT TIME ZONE 'UTC')")
        .getRawMany<{ month: string; km: string; hours: string }>(),
      this.rideRepo
        .createQueryBuilder('r')
        .innerJoin('ride_stats', 's', 's.ride_id = r.id')
        .select('s.max_lean_angle', 'lean')
        .addSelect('r.name', 'name')
        .addSelect('r.started_at', 'started_at')
        .where('r.user_id = :userId', { userId })
        .andWhere("r.status = 'completed'")
        .andWhere(
          "(r.started_at AT TIME ZONE 'UTC') >= date_trunc('month', now() AT TIME ZONE 'UTC')",
        )
        .andWhere(
          "(r.started_at AT TIME ZONE 'UTC') < date_trunc('month', now() AT TIME ZONE 'UTC') + interval '1 month'",
        )
        .andWhere('s.max_lean_angle IS NOT NULL')
        .orderBy('s.max_lean_angle', 'DESC')
        .limit(1)
        .getRawOne<{ lean: number; name: string | null; started_at: Date }>(),
      this.rideRepo
        .createQueryBuilder('r')
        .innerJoin('ride_segments', 'seg', 'seg.ride_id = r.id')
        .select('COUNT(DISTINCT seg.road_segment_id)', 'roads')
        .where('r.user_id = :userId', { userId })
        .andWhere("r.status = 'completed'")
        .andWhere(
          "(r.started_at AT TIME ZONE 'UTC') >= date_trunc('month', now() AT TIME ZONE 'UTC')",
        )
        .andWhere(
          "(r.started_at AT TIME ZONE 'UTC') < date_trunc('month', now() AT TIME ZONE 'UTC') + interval '1 month'",
        )
        .andWhere('seg.road_segment_id IS NOT NULL')
        .getRawOne<{ roads: string }>(),
      this.rideRepo
        .createQueryBuilder('r')
        .select('MAX(r.created_at)', 'synced')
        .where('r.user_id = :userId', { userId })
        .getRawOne<{ synced: Date | null }>(),
    ]);

    const monthStart = startOfUtcMonth(new Date());
    const isThisMonth = (m: string): boolean => {
      const d = new Date(m);
      return (
        d.getUTCMonth() === monthStart.getUTCMonth() &&
        d.getUTCFullYear() === monthStart.getUTCFullYear()
      );
    };

    const cur = months.find((m) => isThisMonth(m.month));
    const prev = months.find((m) => !isThisMonth(m.month));

    return {
      this_month_km: Math.round(parseFloat(cur?.km ?? '0')),
      prev_month_km: Math.round(parseFloat(prev?.km ?? '0')),
      ride_hours: Math.round(parseFloat(cur?.hours ?? '0') * 10) / 10,
      prev_ride_hours: Math.round(parseFloat(prev?.hours ?? '0') * 10) / 10,
      new_roads: parseInt(roadsRow?.roads ?? '0', 10),
      max_lean_deg: leanRow ? Math.round(leanRow.lean) : null,
      max_lean_ride_name: leanRow?.name ?? null,
      max_lean_at: leanRow ? new Date(leanRow.started_at).toISOString() : null,
      last_synced_at: syncRow?.synced
        ? new Date(syncRow.synced).toISOString()
        : null,
    };
  }

  /**
   * Public-facing rider profile (US-27). Loads display fields, denormalised
   * follower/following counts, and the viewer's `is_following` flag in one
   * trip so the mobile screen doesn't need three round trips on render.
   *
   * `is_following` is `null` when `viewerId === userId` so the client can
   * hide the follow button instead of mistakenly defaulting it to "Follow".
   * 404 covers both a missing row and a soft-deleted user — public profiles
   * shouldn't leak the difference.
   */
  async getPublicProfile(
    viewerId: string,
    userId: string,
  ): Promise<PublicProfileDto> {
    const user = await this.userRepo.findOne({ where: { id: userId } });
    if (!user || user.deleted_at != null) {
      throw new NotFoundException('User not found');
    }

    const isSelf = viewerId === userId;

    // #279: enforce the target's privacy preference. `private` profiles
    // 404 to non-self viewers (don't leak the difference between
    // "doesn't exist" and "exists but hidden"). `riders-only` is a
    // signed-in-only audience — `getPublicProfile` already runs behind
    // `AuthGuard` so any caller reaching this point has a viewer id, and
    // the toggle has no additional effect here. The companion's
    // anonymous-feed surfaces (community ride list, shared ride detail)
    // gate `riders-only` and `private` separately at their own call
    // sites.
    if (!isSelf) {
      const targetPrefs = await this.privacy.loadPreferences(userId);
      if (targetPrefs.profile_visibility === 'private') {
        throw new NotFoundException('User not found');
      }
    }

    const [followerCount, followingCount, isFollowingRow] = await Promise.all([
      this.userFollowRepo.count({ where: { following_id: userId } }),
      this.userFollowRepo.count({ where: { follower_id: userId } }),
      isSelf
        ? Promise.resolve(null)
        : this.userFollowRepo.findOne({
            where: { follower_id: viewerId, following_id: userId },
            select: ['follower_id'],
          }),
    ]);

    return {
      id: user.id,
      display_name: user.display_name,
      avatar_url: user.avatar_url,
      bio: user.bio,
      home_region: user.home_region,
      created_at: user.created_at.toISOString(),
      follower_count: followerCount,
      following_count: followingCount,
      is_following: isSelf ? null : isFollowingRow != null,
      is_self: isSelf,
    };
  }

  async updateProfile(
    userId: string,
    dto: UpdateProfileDto,
  ): Promise<UserResponseDto> {
    const user = await this.userRepo.findOne({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('User not found');
    }
    const previousAvatarUrl = user.avatar_url;

    if (dto.display_name !== undefined) {
      user.display_name = dto.display_name;
    }
    if (dto.phone !== undefined) {
      user.phone = dto.phone;
    }
    if (dto.avatar_url !== undefined) {
      user.avatar_url = dto.avatar_url;
    }
    if (dto.bio !== undefined) {
      user.bio = dto.bio;
    }
    if (dto.home_region !== undefined) {
      user.home_region = dto.home_region;
    }
    if (dto.home_location !== undefined) {
      user.home_location = dto.home_location
        ? {
            type: 'Point',
            coordinates: [dto.home_location.lng, dto.home_location.lat],
          }
        : null;
    }
    if (dto.work_location !== undefined) {
      user.work_location = dto.work_location
        ? {
            type: 'Point',
            coordinates: [dto.work_location.lng, dto.work_location.lat],
          }
        : null;
    }
    if (dto.preferences !== undefined) {
      user.preferences = { ...user.preferences, ...dto.preferences };
    }

    const saved = await this.userRepo.save(user);
    if (
      dto.avatar_url !== undefined &&
      previousAvatarUrl !== saved.avatar_url
    ) {
      await this.cleanupPreviousAvatar(userId, previousAvatarUrl);
    }
    return toUserResponse(saved);
  }

  async uploadAvatar(
    userId: string,
    file: Express.Multer.File,
    publicBaseUrl: string,
  ): Promise<UserResponseDto> {
    const user = await this.userRepo.findOne({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('User not found');
    }

    const extension = ALLOWED_AVATAR_TYPES.get(file.mimetype);
    if (!extension) {
      throw new BadRequestException(
        'Avatar must be a PNG, JPEG, or WebP image',
      );
    }

    const filename = `${userId}-${Date.now()}-${randomUUID()}${extension}`;
    const key = `${AVATAR_KEY_PREFIX}${filename}`;
    const previousAvatarUrl = user.avatar_url;

    await this.storage.put({
      key,
      body: file.buffer,
      contentType: file.mimetype,
    });
    // Storage returns either a server-relative path (LocalStorage —
    // depends on the API host the client hits) or an absolute CDN
    // URL (S3 — already self-contained). Mobile / companion clients
    // pass the value straight to `<Image source={{ uri }} />`, which
    // does NOT auto-resolve relative URLs, so we lift the relative
    // form into an absolute one against the request's public base
    // URL before storing. Absolute URLs are preserved verbatim.
    const storageUrl = this.storage.publicUrl(key);
    const nextAvatarUrl = /^https?:\/\//.test(storageUrl)
      ? storageUrl
      : `${publicBaseUrl}${storageUrl}`;

    let saved: User;
    try {
      user.avatar_url = nextAvatarUrl;
      saved = await this.userRepo.save(user);
    } catch (error) {
      // Save failed after the new object landed: roll back the
      // upload so we don't accumulate orphaned avatars on every
      // failed DB write. Wrapped in a best-effort catch — the
      // original save error is what the caller cares about.
      await this.deleteManagedAvatar(nextAvatarUrl).catch(() => {});
      throw error;
    }

    await this.cleanupPreviousAvatar(userId, previousAvatarUrl);
    return toUserResponse(saved);
  }

  async listContacts(userId: string): Promise<ContactResponseDto[]> {
    const contacts = await this.contactRepo.find({
      where: { user_id: userId },
      order: { created_at: 'DESC' },
    });
    return contacts.map((c) => this.toContactResponse(c));
  }

  async addContact(
    userId: string,
    dto: CreateContactDto,
  ): Promise<ContactResponseDto> {
    const contact = this.contactRepo.create({
      user_id: userId,
      name: dto.name,
      phone: dto.phone,
      is_emergency: dto.is_emergency ?? true,
    });
    const saved = await this.contactRepo.save(contact);
    return this.toContactResponse(saved);
  }

  async updateContact(
    userId: string,
    contactId: string,
    dto: UpdateContactDto,
  ): Promise<ContactResponseDto> {
    const contact = await this.contactRepo.findOne({
      where: { id: contactId, user_id: userId },
    });
    if (!contact) {
      throw new NotFoundException('Contact not found');
    }
    if (dto.name !== undefined) {
      contact.name = dto.name;
    }
    if (dto.phone !== undefined) {
      contact.phone = dto.phone;
    }
    if (dto.is_emergency !== undefined) {
      contact.is_emergency = dto.is_emergency;
    }
    const saved = await this.contactRepo.save(contact);
    return this.toContactResponse(saved);
  }

  async deleteContact(userId: string, contactId: string): Promise<void> {
    const contact = await this.contactRepo.findOne({
      where: { id: contactId, user_id: userId },
    });
    if (!contact) {
      throw new NotFoundException('Contact not found');
    }
    await this.contactRepo.remove(contact);
  }

  private async deleteManagedAvatar(avatarUrl: string | null): Promise<void> {
    const key = avatarKeyFromUrl(avatarUrl);
    if (!key) return;
    await this.storage.delete(key);
  }

  /**
   * Best-effort cleanup of a now-orphaned avatar AFTER the DB save
   * has already succeeded. Both `uploadAvatar` and `updateProfile`
   * call this on the previous avatar; from the caller's perspective
   * the operation is already complete, so a transient storage error
   * here (S3 5xx, FS hiccup) must not turn into a 500. With S3 in
   * the mix transient failures are realistic, so swallowing-and-
   * logging is the right behaviour — the next upload (or a future
   * GC sweep) reclaims the orphan.
   */
  private async cleanupPreviousAvatar(
    userId: string,
    previousAvatarUrl: string | null,
  ): Promise<void> {
    try {
      await this.deleteManagedAvatar(previousAvatarUrl);
    } catch (error) {
      this.logger.warn(
        `Failed to clean up previous avatar for user ${userId}: ${
          (error as Error).message
        }`,
      );
    }
  }

  private toContactResponse(contact: UserContact): ContactResponseDto {
    return {
      id: contact.id,
      name: contact.name,
      phone: contact.phone,
      is_emergency: contact.is_emergency,
      created_at: contact.created_at.toISOString(),
    };
  }
}

/** First instant of the current UTC calendar month. */
function startOfUtcMonth(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}
