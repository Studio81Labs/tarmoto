import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  FEATURE_DEFINITIONS,
  FEATURE_KEYS,
  isFeatureKey,
  isGlobalFeatureState,
  resolveFeature,
  type FeatureKey,
} from '@tarmoto/shared';
import { FeatureState } from '../../entities/feature-state.entity.js';
import { UserFeature } from '../../entities/user-feature.entity.js';
import { User } from '../../entities/user.entity.js';
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

/**
 * Operator management for the tier-aware feature-flag system. The flag
 * set and tier policy are code-defined (`FEATURE_DEFINITIONS`), so the
 * admin surface manages only the two override layers:
 *   - global overrides (`feature_states`) — kill switch / force-on clamp
 *   - per-user overrides (`user_features`) — grant or revoke one user
 */
@Injectable()
export class AdminFlagsService {
  constructor(
    @InjectRepository(FeatureState)
    private readonly featureStates: Repository<FeatureState>,
    @InjectRepository(UserFeature)
    private readonly userFeatures: Repository<UserFeature>,
    @InjectRepository(User)
    private readonly users: Repository<User>,
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

    const flags = FEATURE_KEYS.map((feature): AdminFeatureFlagDto => {
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
    return this.flagDto(key);
  }

  /** Clearing an absent override is a no-op — the call is idempotent. */
  async clearGlobalState(feature: string): Promise<void> {
    const key = this.assertKnownFeature(feature);
    await this.featureStates.delete({ feature: key });
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

    const flags = FEATURE_KEYS.map((feature): AdminUserFeatureFlagDto => {
      const def = FEATURE_DEFINITIONS[feature];
      const override = overrideByFeature.get(feature);
      return {
        feature,
        description: def.description,
        default_value: def.default,
        resolved: resolveFeature(
          feature,
          user.subscription_tier,
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
    });

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
    return this.getUserFlags(user.id);
  }

  /** Removing an absent override is a no-op — the call is idempotent. */
  async removeOverride(userId: string, feature: string): Promise<void> {
    const key = this.assertKnownFeature(feature);
    const user = await this.findUser(userId);
    await this.userFeatures.delete({ user_id: user.id, feature: key });
  }

  private async flagDto(feature: FeatureKey): Promise<AdminFeatureFlagDto> {
    const { flags } = await this.listFlags();
    const flag = flags.find((f) => f.feature === feature);
    // The registry is static and `feature` passed the key guard, so the
    // entry always exists; the throw keeps the type checker honest.
    if (!flag) throw new NotFoundException('Flag not found');
    return flag;
  }

  private assertKnownFeature(feature: string): FeatureKey {
    if (!isFeatureKey(feature)) {
      throw new BadRequestException(`Unknown feature: ${feature}`);
    }
    return feature;
  }

  private async findUser(userId: string): Promise<User> {
    const user = await this.users.findOne({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');
    return user;
  }
}
