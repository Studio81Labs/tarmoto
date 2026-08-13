import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  FEATURE_DEFINITIONS,
  TOGGLE_FEATURE_KEYS,
  isGlobalFeatureState,
  isToggleFeatureKey,
  resolveFeature,
  type ToggleFeatureKey,
} from '@tarmoto/shared';
import { FeatureState } from '../../entities/feature-state.entity.js';
import { UserFeature } from '../../entities/user-feature.entity.js';
import { User } from '../../entities/user.entity.js';
import { FeatureResolver } from '../features/feature-resolver.service.js';
import { EventsGateway } from '../events/events.gateway.js';
import {
  AdminFeatureFlagDto,
  AdminFeatureFlagUsersResponseDto,
  AdminFeatureFlagsResponseDto,
  AdminUserFeatureFlagDto,
  AdminUserFeatureFlagsResponseDto,
  ListFeatureFlagUsersQueryDto,
  SetFeatureGlobalStateDto,
  SetFeatureOverrideDto,
} from './dto/admin-flags.dto.js';
import {
  ENTITLEMENT_SELECT,
  resolveEntitledTier,
} from '../account/entitlement.js';

/**
 * Operator management for the tier-aware feature-flag system. The flag
 * set and tier policy are code-defined (`FEATURE_DEFINITIONS`), so the
 * admin surface manages only the two override layers:
 *   - global overrides (`feature_states`) — kill switch / force-on clamp
 *   - per-user overrides (`user_features`) — grant or revoke one user
 */
@Injectable()
export class AdminFlagsService {
  private readonly logger = new Logger(AdminFlagsService.name);

  constructor(
    @InjectRepository(FeatureState)
    private readonly featureStates: Repository<FeatureState>,
    @InjectRepository(UserFeature)
    private readonly userFeatures: Repository<UserFeature>,
    @InjectRepository(User)
    private readonly users: Repository<User>,
    private readonly featureResolver: FeatureResolver,
    private readonly eventsGateway: EventsGateway,
  ) {}

  async listFlags(): Promise<AdminFeatureFlagsResponseDto> {
    const [states, counts] = await Promise.all([
      this.featureStates.find(),
      this.userFeatures
        .createQueryBuilder('uf')
        .select('uf.feature', 'feature')
        .addSelect('COUNT(*)', 'count')
        .groupBy('uf.feature')
        .getRawMany<{ feature: string; count: string }>(),
    ]);

    const stateByFeature = new Map(states.map((s) => [s.feature, s]));
    const countByFeature = new Map(
      counts.map((c) => [c.feature, Number(c.count)]),
    );

    const flags = TOGGLE_FEATURE_KEYS.map((feature): AdminFeatureFlagDto => {
      const def = FEATURE_DEFINITIONS[feature];
      const state = stateByFeature.get(feature);
      const hasValidState =
        state !== undefined && isGlobalFeatureState(state.state);
      return {
        feature,
        description: def.description,
        default_value: def.default,
        tiers: [...def.tiers],
        global_state: hasValidState ? state.state : null,
        global_reason: hasValidState ? state.reason : null,
        global_updated_by: hasValidState ? state.updated_by : null,
        global_updated_at: hasValidState
          ? state.updated_at.toISOString()
          : null,
        overridden_user_count: countByFeature.get(feature) ?? 0,
      };
    });

    return { flags };
  }

  async setGlobalState(
    feature: string,
    dto: SetFeatureGlobalStateDto,
    adminUserId: string,
  ): Promise<AdminFeatureFlagDto> {
    const key = this.assertKnownFeature(feature);
    const existing = await this.featureStates.findOne({
      where: { feature: key },
    });
    const row = existing ?? this.featureStates.create({ feature: key });
    row.state = dto.state;
    row.reason = dto.reason ?? null;
    row.updated_by = adminUserId;
    await this.featureStates.save(row);
    // A group_rides kill switch must also cut passive listeners off the
    // live location fanout — the gateway's publisher-side re-checks
    // don't reach sockets that only receive.
    if (key === 'group_rides' && dto.state === 'force_off') {
      await this.evictFromGroupRideRooms();
    }
    return this.flagDto(key);
  }

  /** Clearing an absent override is a no-op — the call is idempotent. */
  async clearGlobalState(feature: string): Promise<void> {
    const key = this.assertKnownFeature(feature);
    await this.featureStates.delete({ feature: key });
    // Clearing a group_rides force_on is the "tier enforcement goes
    // live" switch: free/pro members lose the entitlement instantly, so
    // their passive listeners must leave the live location rooms too.
    // Selective — still-entitled premium riders stay connected.
    if (key === 'group_rides') {
      try {
        await this.eventsGateway.evictNonEntitledFromGroupRideRooms();
      } catch (err) {
        this.logger.warn(
          `Failed to evict non-entitled sockets from group-ride rooms: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }

  async listOverriddenUsers(
    feature: string,
    query: ListFeatureFlagUsersQueryDto,
  ): Promise<AdminFeatureFlagUsersResponseDto> {
    const key = this.assertKnownFeature(feature);
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 25;

    const qb = this.userFeatures
      .createQueryBuilder('uf')
      .innerJoinAndSelect('uf.user', 'u')
      .where('uf.feature = :key', { key })
      .andWhere('u.deleted_at IS NULL')
      .orderBy('uf.updated_at', 'DESC')
      .skip((page - 1) * pageSize)
      .take(pageSize);

    if (query.q) {
      qb.andWhere('(u.email ILIKE :q OR u.display_name ILIKE :q)', {
        q: `%${query.q}%`,
      });
    }
    if (query.override) {
      qb.andWhere('uf.enabled = :enabled', {
        enabled: query.override === 'force_on',
      });
    }

    const [rows, total] = await qb.getManyAndCount();
    return {
      rows: rows.map((row) => ({
        user_id: row.user_id,
        email: row.user.email,
        display_name: row.user.display_name,
        subscription_tier: row.user.subscription_tier,
        enabled: row.enabled,
        updated_at: row.updated_at.toISOString(),
      })),
      total,
      page,
      pageSize,
    };
  }

  async getUserFlags(
    userId: string,
  ): Promise<AdminUserFeatureFlagsResponseDto> {
    const user = await this.findUser(userId);
    const [overrides, states] = await Promise.all([
      this.userFeatures.find({ where: { user_id: user.id } }),
      this.featureStates.find(),
    ]);
    const overrideByFeature = new Map(
      overrides.map((o) => [o.feature, o.enabled]),
    );
    const stateByFeature = new Map(
      states
        .filter((s) => isGlobalFeatureState(s.state))
        .map((s) => [s.feature, s.state]),
    );

    const flags = TOGGLE_FEATURE_KEYS.map(
      (feature): AdminUserFeatureFlagDto => {
        const def = FEATURE_DEFINITIONS[feature];
        const override = overrideByFeature.get(feature);
        return {
          feature,
          description: def.description,
          default_value: def.default,
          resolved: resolveFeature(
            feature,
            // EFFECTIVE entitlement, same as enforcement. Reading the raw column
            // makes this preview disagree with what the rider actually gets: a
            // premium-granted rider on a pro subscription would be shown group
            // rides off while the backend lets them in.
            resolveEntitledTier(user),
            override,
            stateByFeature.get(feature),
          ),
          override_state:
            override === undefined
              ? 'default'
              : override
                ? 'force_on'
                : 'force_off',
        };
      },
    );

    return { user_id: user.id, flags };
  }

  async setOverride(
    userId: string,
    feature: string,
    dto: SetFeatureOverrideDto,
  ): Promise<AdminUserFeatureFlagsResponseDto> {
    const key = this.assertKnownFeature(feature);
    const user = await this.findUser(userId);
    const existing = await this.userFeatures.findOne({
      where: { user_id: user.id, feature: key },
    });
    const row =
      existing ?? this.userFeatures.create({ user_id: user.id, feature: key });
    row.enabled = dto.enabled;
    await this.userFeatures.save(row);
    if (key === 'group_rides') {
      await this.evictIfGroupRidesRevoked(user.id);
    }
    return this.getUserFlags(user.id);
  }

  /** Removing an absent override is a no-op — the call is idempotent. */
  async removeOverride(userId: string, feature: string): Promise<void> {
    const key = this.assertKnownFeature(feature);
    const user = await this.findUser(userId);
    await this.userFeatures.delete({ user_id: user.id, feature: key });
    // Removing a force_on override can revoke effective access (e.g. a
    // free-tier user who only had the feature via the override).
    if (key === 'group_rides') {
      await this.evictIfGroupRidesRevoked(user.id);
    }
  }

  /**
   * Kick the user's sockets out of the live group-ride rooms when the
   * mutation left them without the entitlement. Best-effort: the DB
   * state above is authoritative (publish attempts re-resolve against
   * it), so a socket-adapter hiccup logs rather than failing the admin
   * mutation that already persisted.
   */
  private async evictIfGroupRidesRevoked(userId: string): Promise<void> {
    try {
      const snapshot = await this.featureResolver.resolveForUser(userId);
      if (!snapshot.group_rides) {
        await this.eventsGateway.evictFromGroupRideRooms(userId);
      }
    } catch (err) {
      this.logger.warn(
        `Failed to evict user ${userId} from group-ride rooms: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /** Global variant of the eviction backstop — same best-effort rules. */
  private async evictFromGroupRideRooms(): Promise<void> {
    try {
      await this.eventsGateway.evictFromGroupRideRooms();
    } catch (err) {
      this.logger.warn(
        `Failed to evict sockets from group-ride rooms: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  private async flagDto(
    feature: ToggleFeatureKey,
  ): Promise<AdminFeatureFlagDto> {
    const { flags } = await this.listFlags();
    const flag = flags.find((f) => f.feature === feature);
    // The registry is static and `feature` passed the key guard, so the
    // entry always exists; the throw keeps the type checker honest.
    if (!flag) throw new NotFoundException('Flag not found');
    return flag;
  }

  private assertKnownFeature(feature: string): ToggleFeatureKey {
    if (!isToggleFeatureKey(feature)) {
      throw new BadRequestException(`Unknown feature: ${feature}`);
    }
    return feature;
  }

  private async findUser(userId: string): Promise<User> {
    // Narrowed to what the resolver reads. The rollup pair is `select: false` on
    // the entity — the defence against stale whole-entity saves clobbering it —
    // so a plain findOne returns neither column and this rider would resolve as
    // having no store side: a paying store subscriber shown the free-tier
    // preview while enforcement grants them Pro.
    const user = await this.users.findOne({
      where: { id: userId },
      select: ENTITLEMENT_SELECT,
    });
    if (!user) throw new NotFoundException('User not found');
    return user;
  }
}
