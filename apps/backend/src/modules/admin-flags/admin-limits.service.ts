import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  FEATURE_DEFINITIONS,
  LIMIT_FEATURE_KEYS,
  isLimitFeatureKey,
  resolveLimit,
  type LimitFeatureKey,
} from '@tarmoto/shared';
import { LimitState } from '../../entities/limit-state.entity.js';
import { UserLimit } from '../../entities/user-limit.entity.js';
import { User } from '../../entities/user.entity.js';
import {
  AdminFeatureLimitDto,
  AdminFeatureLimitsResponseDto,
  AdminUserFeatureLimitDto,
  AdminUserFeatureLimitsResponseDto,
  SetLimitGlobalValueDto,
  SetUserLimitOverrideDto,
} from './dto/admin-limits.dto.js';
import { resolveEntitledTier } from '../account/entitlement.js';

/**
 * Operator management for numeric limit entitlements — the numeric twin
 * of `AdminFlagsService`. The limit set and tier policy are code-defined
 * in `FEATURE_DEFINITIONS`, so the admin surface manages only the two
 * override layers:
 *   - global overrides (`limit_states`) — replace the tier value for
 *     everyone (`null` = unlimited; launch mode / promo raise)
 *   - per-user overrides (`user_limits`) — raise or restrict one user
 * No limit gates a live socket, so unlike the flag twin there is no
 * eviction side effect to run after a mutation.
 */
@Injectable()
export class AdminLimitsService {
  constructor(
    @InjectRepository(LimitState)
    private readonly limitStates: Repository<LimitState>,
    @InjectRepository(UserLimit)
    private readonly userLimits: Repository<UserLimit>,
    @InjectRepository(User)
    private readonly users: Repository<User>,
  ) {}

  async listLimits(): Promise<AdminFeatureLimitsResponseDto> {
    const [states, counts] = await Promise.all([
      this.limitStates.find(),
      this.userLimits
        .createQueryBuilder('ul')
        .select('ul.feature', 'feature')
        .addSelect('COUNT(*)', 'count')
        .groupBy('ul.feature')
        .getRawMany<{ feature: string; count: string }>(),
    ]);
    const stateByFeature = new Map(states.map((s) => [s.feature, s]));
    const countByFeature = new Map(
      counts.map((c) => [c.feature, Number(c.count)]),
    );

    const limits = LIMIT_FEATURE_KEYS.map((feature): AdminFeatureLimitDto => {
      const def = FEATURE_DEFINITIONS[feature];
      const state = stateByFeature.get(feature);
      return {
        feature,
        description: def.description,
        default_value: def.default,
        tier_values: { ...def.tiers },
        global_active: state !== undefined,
        global_value: state?.value ?? null,
        global_reason: state?.reason ?? null,
        global_updated_by: state?.updated_by ?? null,
        global_updated_at: state ? state.updated_at.toISOString() : null,
        overridden_user_count: countByFeature.get(feature) ?? 0,
      };
    });
    return { limits };
  }

  async setGlobalValue(
    feature: string,
    dto: SetLimitGlobalValueDto,
    adminUserId: string,
  ): Promise<AdminFeatureLimitDto> {
    const key = this.assertKnownLimit(feature);
    const existing = await this.limitStates.findOne({
      where: { feature: key },
    });
    const row = existing ?? this.limitStates.create({ feature: key });
    row.value = dto.value;
    row.reason = dto.reason;
    row.updated_by = adminUserId;
    await this.limitStates.save(row);
    return this.limitDto(key);
  }

  /** Clearing an absent override is a no-op — the call is idempotent. */
  async clearGlobalValue(feature: string): Promise<void> {
    const key = this.assertKnownLimit(feature);
    await this.limitStates.delete({ feature: key });
  }

  async getUserLimits(
    userId: string,
  ): Promise<AdminUserFeatureLimitsResponseDto> {
    const user = await this.findUser(userId);
    const [overrides, states] = await Promise.all([
      this.userLimits.find({ where: { user_id: user.id } }),
      this.limitStates.find(),
    ]);
    const overrideByFeature = new Map(
      overrides.map((o) => [o.feature, o.value]),
    );
    const stateByFeature = new Map(states.map((s) => [s.feature, s.value]));

    const limits = LIMIT_FEATURE_KEYS.map(
      (feature): AdminUserFeatureLimitDto => {
        const def = FEATURE_DEFINITIONS[feature];
        const hasOverride = overrideByFeature.has(feature);
        return {
          feature,
          description: def.description,
          resolved: resolveLimit(
            feature,
            // EFFECTIVE entitlement — see the same note in `AdminFlagsService`.
            // A grant-only pro rider would otherwise be shown the free trip cap
            // while the backend treats them as unlimited.
            resolveEntitledTier(user),
            hasOverride ? overrideByFeature.get(feature) : undefined,
            stateByFeature.has(feature)
              ? stateByFeature.get(feature)
              : undefined,
          ),
          override_active: hasOverride,
          override_value: hasOverride
            ? (overrideByFeature.get(feature) ?? null)
            : null,
        };
      },
    );
    return { user_id: user.id, limits };
  }

  async setOverride(
    userId: string,
    feature: string,
    dto: SetUserLimitOverrideDto,
  ): Promise<AdminUserFeatureLimitsResponseDto> {
    const key = this.assertKnownLimit(feature);
    const user = await this.findUser(userId);
    const existing = await this.userLimits.findOne({
      where: { user_id: user.id, feature: key },
    });
    const row =
      existing ?? this.userLimits.create({ user_id: user.id, feature: key });
    row.value = dto.value;
    await this.userLimits.save(row);
    return this.getUserLimits(user.id);
  }

  /** Removing an absent override is a no-op — the call is idempotent. */
  async removeOverride(userId: string, feature: string): Promise<void> {
    const key = this.assertKnownLimit(feature);
    const user = await this.findUser(userId);
    await this.userLimits.delete({ user_id: user.id, feature: key });
  }

  private async limitDto(
    feature: LimitFeatureKey,
  ): Promise<AdminFeatureLimitDto> {
    const { limits } = await this.listLimits();
    const limit = limits.find((l) => l.feature === feature);
    // The registry is static and `feature` passed the key guard, so the
    // entry always exists; the throw keeps the type checker honest.
    if (!limit) throw new NotFoundException('Limit not found');
    return limit;
  }

  private assertKnownLimit(feature: string): LimitFeatureKey {
    if (!isLimitFeatureKey(feature)) {
      throw new BadRequestException(`Unknown limit: ${feature}`);
    }
    return feature;
  }

  private async findUser(userId: string): Promise<User> {
    const user = await this.users.findOne({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');
    return user;
  }
}
