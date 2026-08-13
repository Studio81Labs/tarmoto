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
import { SharedRide } from '../../entities/shared-ride.entity.js';
import { User } from '../../entities/user.entity.js';
import { UserBadge } from '../../entities/user-badge.entity.js';
import { UserContact } from '../../entities/user-contact.entity.js';
import { UserFollow } from '../../entities/user-follow.entity.js';
import { OBJECT_STORAGE } from '../storage/storage.tokens.js';
import type { ObjectStorage } from '../storage/object-storage.interface.js';
import { PrivacyPreferencesService } from '../account/privacy-preferences.service.js';
import { BadgesService } from '../badges/badges.service.js';
import { FeatureResolver } from '../features/feature-resolver.service.js';
import { isFeatureEnabled } from '@tarmoto/shared';
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
import { ContributionStatsDto } from './dto/contribution-stats.dto.js';
import { AVATAR_KEY_PREFIX, avatarKeyFromUrl } from './avatar-storage-key.js';
import { toUserResponse } from './user-response.mapper.js';
import type { StoreRollup } from '../account/entitlement.js';

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
    @InjectRepository(SharedRide)
    private readonly sharedRideRepo: Repository<SharedRide>,
    @Inject(OBJECT_STORAGE)
    private readonly storage: ObjectStorage,
    private readonly privacy: PrivacyPreferencesService,
    private readonly badges: BadgesService,
    private readonly featureResolver: FeatureResolver,
  ) {}

  /** The rollup pair alone — kept off any entity that will be saved. */
  private async loadStoreRollup(userId: string): Promise<StoreRollup> {
    const row = await this.userRepo.findOne({
      where: { id: userId },
      select: {
        id: true,
        store_subscription_tier: true,
        store_subscription_tier_expires_at: true,
      },
    });
    return {
      store_subscription_tier: row?.store_subscription_tier ?? null,
      store_subscription_tier_expires_at:
        row?.store_subscription_tier_expires_at ?? null,
    };
  }

  async getProfile(userId: string): Promise<UserResponseDto> {
    const user = await this.userRepo.findOne({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('User not found');
    }
    // Its own read, the same shape as every other call site. The rollup columns
    // are `select: false`, so the entity above carries neither — and this
    // response serves the BILLED tier the mobile activation loop polls, so
    // without it a store purchase never appears here and the client polls to
    // timeout on a subscription the backend has already granted.
    const storeRollup = await this.loadStoreRollup(userId);
    return toUserResponse(
      user,
      await this.featureResolver.resolveEntitlementsForLoadedUser(
        user,
        storeRollup,
      ),
      storeRollup,
    );
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

    // Resolve the gamification kill switch first so the user_badges query is
    // SKIPPED entirely when off — an operator disabling sys_gamification is
    // often doing so BECAUSE that subsystem is degraded, so this endpoint must
    // not still block/500 on the badge count; the rest of the profile stays
    // live with badges_earned: 0. (computeStats reads only generic ride tables,
    // never user_badges, so it stays in the parallel batch.)
    const gamificationOn =
      await this.featureResolver.isSystemSwitchEnabled('sys_gamification');

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
        gamificationOn
          ? this.userBadgeRepo.count({ where: { user_id: userId } })
          : Promise.resolve(0),
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
        // Emit the bucket as a UTC 'YYYY-MM' string. Returning the raw
        // `date_trunc` timestamp (tz-naive) and parsing it in JS would shift
        // the month in a non-UTC server zone (e.g. June → May at UTC+2) and
        // mis-file current-month rides as previous-month.
        .select(
          "to_char(date_trunc('month', r.started_at AT TIME ZONE 'UTC'), 'YYYY-MM')",
          'month',
        )
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
        // Bound on `ended_at <= now()`, not `started_at`: a completed ride
        // that starts before now but ends in the future (clock-skewed GPX
        // whose last trackpoint is ahead of now) must not contribute its
        // full distance/hours before it has happened. `ended_at <= now()`
        // implies `started_at <= now()`, so it also keeps future buckets out
        // and lets `prev` only ever match last month.
        .andWhere(
          "(r.ended_at AT TIME ZONE 'UTC') <= (now() AT TIME ZONE 'UTC')",
        )
        .groupBy(
          "to_char(date_trunc('month', r.started_at AT TIME ZONE 'UTC'), 'YYYY-MM')",
        )
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
        // Only rides that have finished (ended_at <= now) — excludes a ride
        // that starts this month but ends in the future.
        .andWhere(
          "(r.ended_at AT TIME ZONE 'UTC') <= (now() AT TIME ZONE 'UTC')",
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
        // Only rides that have finished (ended_at <= now) — excludes a ride
        // that starts this month but ends in the future.
        .andWhere(
          "(r.ended_at AT TIME ZONE 'UTC') <= (now() AT TIME ZONE 'UTC')",
        )
        .andWhere('seg.road_segment_id IS NOT NULL')
        .getRawOne<{ roads: string }>(),
      this.rideRepo
        .createQueryBuilder('r')
        .select('MAX(r.created_at)', 'synced')
        .where('r.user_id = :userId', { userId })
        .getRawOne<{ synced: Date | null }>(),
    ]);

    // Match the SQL bucket as a UTC 'YYYY-MM' string — no Date parsing, so
    // the server's local timezone can't shift the month classification.
    const now = new Date();
    const thisMonthKey = `${now.getUTCFullYear()}-${String(
      now.getUTCMonth() + 1,
    ).padStart(2, '0')}`;

    const cur = months.find((m) => m.month === thisMonthKey);
    const prev = months.find((m) => m.month !== thisMonthKey);

    // The peak-lean stat is `advanced_ride_stats` (Pro) — gated on the same
    // footing as the ride list/detail/CSV strip so a non-entitled rider can't
    // read it through the monthly summary instead. Null the three lean fields
    // for a viewer without the entitlement.
    const advancedRideStats = isFeatureEnabled(
      await this.featureResolver.resolveForUser(userId),
      'advanced_ride_stats',
    );

    return {
      this_month_km: Math.round(parseFloat(cur?.km ?? '0')),
      prev_month_km: Math.round(parseFloat(prev?.km ?? '0')),
      ride_hours: Math.round(parseFloat(cur?.hours ?? '0') * 10) / 10,
      prev_ride_hours: Math.round(parseFloat(prev?.hours ?? '0') * 10) / 10,
      new_roads: parseInt(roadsRow?.roads ?? '0', 10),
      max_lean_deg:
        advancedRideStats && leanRow ? Math.round(leanRow.lean) : null,
      max_lean_ride_name: advancedRideStats ? (leanRow?.name ?? null) : null,
      max_lean_at:
        advancedRideStats && leanRow
          ? new Date(leanRow.started_at).toISOString()
          : null,
      last_synced_at: syncRow?.synced
        ? new Date(syncRow.synced).toISOString()
        : null,
    };
  }

  /**
   * "Your contribution" sidebar badge (`GET /users/me/contribution`).
   *
   * `km_mapped` / `segments_mapped` are the rider's road-quality
   * contribution: distinct road segments they've uploaded sensor readings
   * for (the `surface_readings` table; one row per ~100m segment per ride,
   * only persisted when `road_data_contribution` is on). De-duplicating by
   * `road_segment_id` means riding the same road twice doesn't inflate the
   * total — distinct from "distance ridden".
   *
   * The regional rank places the rider among other riders in their
   * `home_region` by the same metric, reusing the leaderboard eligibility
   * (excludes soft-deleted + `profile_visibility = 'private'`, except the
   * viewer). All rank fields are null when the rider has no region or hasn't
   * contributed anything.
   */
  async getContribution(userId: string): Promise<ContributionStatsDto> {
    // Per-rider totals. The inner DISTINCT collapses repeat readings of the
    // same segment to one row (length_m is functionally dependent on the
    // segment id), so SUM/COUNT count each contributed segment once.
    const totalsRows = await this.userRepo.query<
      { segments: string | null; km: string | null }[]
    >(
      `SELECT COUNT(*)::int AS segments,
              COALESCE(SUM(length_m), 0) / 1000.0 AS km
       FROM (
         SELECT DISTINCT sr.road_segment_id, rs.length_m
         FROM surface_readings sr
         JOIN road_segments rs ON rs.id = sr.road_segment_id
         WHERE sr.user_id = $1
       ) d`,
      [userId],
    );
    const segments_mapped = Number(totalsRows[0]?.segments ?? 0);
    const km_mapped = Math.round(Number(totalsRows[0]?.km ?? 0) * 10) / 10;

    const user = await this.userRepo.findOne({ where: { id: userId } });
    const home_region = user?.home_region ?? null;

    // No region, or nothing contributed → nothing to rank.
    if (!home_region || segments_mapped === 0) {
      return {
        km_mapped,
        segments_mapped,
        home_region,
        rank_in_region: null,
        region_rider_count: null,
        region_riders_behind: null,
        percentile: null,
      };
    }

    // Regional rank. `region_users` is scoped first (case-insensitive region
    // match, not deleted, not private — except the viewer) so the per-user
    // aggregation only touches that region's contributors.
    const rankRows = await this.userRepo.query<
      { rank: number | null; total: string | null; behind: string | null }[]
    >(
      `WITH region_users AS (
         SELECT u.id
         FROM users u
         LEFT JOIN privacy_preferences pp ON pp.user_id = u.id
         WHERE u.deleted_at IS NULL
           AND LOWER(TRIM(u.home_region)) = LOWER(TRIM($2))
           AND (
             pp.profile_visibility IS NULL
             OR pp.profile_visibility <> 'private'
             OR u.id = $1
           )
       ),
       per_user AS (
         SELECT d.user_id, SUM(d.length_m) AS m
         FROM (
           SELECT DISTINCT sr.user_id, sr.road_segment_id, rs.length_m
           FROM surface_readings sr
           JOIN road_segments rs ON rs.id = sr.road_segment_id
           WHERE sr.user_id IN (SELECT id FROM region_users)
         ) d
         GROUP BY d.user_id
       ),
       ranked AS (
         SELECT user_id, DENSE_RANK() OVER (ORDER BY m DESC) AS rank
         FROM per_user
         WHERE m > 0
       )
       SELECT (SELECT rank FROM ranked WHERE user_id = $1)::int AS rank,
              (SELECT COUNT(*) FROM ranked)::int AS total,
              -- Riders strictly below the viewer by km mapped. Tie-aware
              -- "ahead of someone" signal: with DENSE_RANK a tie above one
              -- last rider gives rank 2 / count 3, so rank<count would call
              -- the last rider non-last; a strict-less count never does.
              (SELECT COUNT(*) FROM per_user
                WHERE m > 0
                  AND m < (SELECT m FROM per_user WHERE user_id = $1))::int
                AS behind`,
      [userId, home_region],
    );

    const rank_in_region = rankRows[0]?.rank ?? null;
    const region_rider_count = Number(rankRows[0]?.total ?? 0) || null;
    const region_riders_behind = Number(rankRows[0]?.behind ?? 0);
    const percentile =
      rank_in_region != null && region_rider_count
        ? Math.max(1, Math.ceil((rank_in_region / region_rider_count) * 100))
        : null;

    return {
      km_mapped,
      segments_mapped,
      home_region,
      rank_in_region,
      region_rider_count,
      region_riders_behind,
      percentile,
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

    const [
      followerCount,
      followingCount,
      isFollowingRow,
      followsViewerRow,
      distanceRow,
      sharedRideCount,
    ] = await Promise.all([
      this.userFollowRepo.count({ where: { following_id: userId } }),
      this.userFollowRepo.count({ where: { follower_id: userId } }),
      isSelf
        ? Promise.resolve(null)
        : this.userFollowRepo.findOne({
            where: { follower_id: viewerId, following_id: userId },
            select: ['follower_id'],
          }),
      // Reverse edge: does the target follow the viewer back? Drives the
      // "Follows you" badge on the viewer's side.
      isSelf
        ? Promise.resolve(null)
        : this.userFollowRepo.findOne({
            where: { follower_id: userId, following_id: viewerId },
            select: ['follower_id'],
          }),
      // Lifetime distance over completed rides (the "Distance" hero tile).
      this.rideRepo
        .createQueryBuilder('r')
        .select('COALESCE(SUM(r.distance_km), 0)', 'km')
        .where('r.user_id = :userId', { userId })
        .andWhere("r.status = 'completed'")
        .getRawOne<{ km: string }>(),
      // Public-share count, viewer-independent so the tile is a stable public
      // metric even when the rider views their own profile.
      this.sharedRideRepo.count({
        where: { user_id: userId, is_public: true },
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
      total_distance_km: Math.round(parseFloat(distanceRow?.km ?? '0')),
      shared_ride_count: sharedRideCount,
      is_following: isSelf ? null : isFollowingRow != null,
      follows_you: isSelf ? null : followsViewerRow != null,
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
    // `!= null` (not `!== undefined`): `language` is a NOT NULL column, so a
    // `null` here — which should never pass DTO validation, but this guard
    // is defense-in-depth in case that's ever bypassed — must be skipped
    // rather than written, unlike the nullable sibling fields above.
    if (dto.language != null) {
      user.language = dto.language;
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
    let preferencesPatch: Record<string, unknown> | null = null;
    if (dto.preferences !== undefined) {
      // The backend compiles with ES2024 class fields (`useDefineForClassFields`
      // defaults to true at that target), so `plainToInstance` materializes
      // EVERY declared optional field of `UserPreferencesDto` as an own
      // `undefined` property — even the ones absent from the request body.
      // Strip those before building the patch so an untouched key never
      // clobbers a previously stored value.
      const patch = Object.fromEntries(
        Object.entries(dto.preferences).filter(
          ([, value]) => value !== undefined,
        ),
      );
      if (Object.keys(patch).length > 0) {
        preferencesPatch = patch;
      }
    }

    // Detach the preferences column from the entity before save(): save()
    // diffs entity values against a fresh internal reload and writes back
    // any column that differs — so a concurrent preference writer landing
    // between our findOne and this save would be silently overwritten by
    // this request's stale whole-object snapshot. An undefined property is
    // skipped by save() entirely; preferences are persisted ONLY via the
    // atomic key-wise JSONB merge below, which composes with concurrent
    // writers instead of racing them.
    const loadedPreferences = user.preferences;
    user.preferences = undefined as unknown as Record<string, unknown>;

    const saved = await this.userRepo.save(user);

    if (preferencesPatch) {
      // `||` is a shallow top-level merge — the same semantics as the
      // previous `{...stored, ...patch}` spread, minus the lost-update race:
      // each concurrent writer (units toggle, PreferencesSync reconciliation,
      // the format-prefs capture route) merges only its own keys atomically.
      await this.userRepo
        .createQueryBuilder()
        .update()
        .set({
          preferences: () => 'preferences || CAST(:prefsPatch AS jsonb)',
        })
        .where('id = :id', { id: userId })
        .setParameter('prefsPatch', JSON.stringify(preferencesPatch))
        .execute();
    }

    // Restore this request's merged view for the response mapping. Under a
    // concurrent writer the DB may hold additional keys already; echoing our
    // own read-plus-patch is the standard read-your-writes response.
    saved.preferences = { ...loadedPreferences, ...(preferencesPatch ?? {}) };
    if (
      dto.avatar_url !== undefined &&
      previousAvatarUrl !== saved.avatar_url
    ) {
      await this.cleanupPreviousAvatar(userId, previousAvatarUrl);
    }
    // Read separately, NEVER selected onto `saved`: that entity was just written
    // back, and carrying the rollup on it is precisely the stale whole-entity
    // save those columns are hidden to prevent.
    const storeRollup = await this.loadStoreRollup(userId);
    return toUserResponse(
      saved,
      await this.featureResolver.resolveEntitlementsForLoadedUser(
        saved,
        storeRollup,
      ),
      storeRollup,
    );
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
    // Read separately, NEVER selected onto `saved`: that entity was just written
    // back, and carrying the rollup on it is precisely the stale whole-entity
    // save those columns are hidden to prevent.
    const storeRollup = await this.loadStoreRollup(userId);
    return toUserResponse(
      saved,
      await this.featureResolver.resolveEntitlementsForLoadedUser(
        saved,
        storeRollup,
      ),
      storeRollup,
    );
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
