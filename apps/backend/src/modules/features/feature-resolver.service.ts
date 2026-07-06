import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  buildFeatureSnapshot,
  isGlobalFeatureState,
  type FeatureSnapshot,
  type GlobalFeatureState,
  type GlobalFeatureStates,
} from '@tarmoto/shared';
import { FeatureState } from '../../entities/feature-state.entity.js';
import { UserFeature } from '../../entities/user-feature.entity.js';
import { User } from '../../entities/user.entity.js';

/**
 * Live tier-aware flag resolution (sibling nexcue/tabletap pattern).
 *
 * The flag vocabulary and tier policy are code-defined in
 * `FEATURE_DEFINITIONS` (`@tarmoto/shared`); this service only loads the
 * mutable state — the user's subscription tier, per-user overrides, and
 * global overrides — and folds them through the pure `resolveFeature`
 * precedence. There is deliberately no in-memory cache: gated endpoints
 * re-resolve on every request (three small indexed reads in parallel) so
 * an operator kill switch takes effect immediately at the API.
 */
@Injectable()
export class FeatureResolver {
  constructor(
    @InjectRepository(User)
    private readonly users: Repository<User>,
    @InjectRepository(UserFeature)
    private readonly userFeatures: Repository<UserFeature>,
    @InjectRepository(FeatureState)
    private readonly featureStates: Repository<FeatureState>,
  ) {}

  /** Resolve every registry flag for one user. */
  async resolveForUser(userId: string): Promise<FeatureSnapshot> {
    const [user, overrides, globalStates] = await Promise.all([
      this.users.findOne({
        where: { id: userId },
        select: { id: true, subscription_tier: true },
      }),
      this.loadOverrides(userId),
      this.getGlobalStates(),
    ]);
    if (!user) throw new NotFoundException('User not found');
    return buildFeatureSnapshot(
      user.subscription_tier,
      overrides,
      globalStates,
    );
  }

  /**
   * Fetch-free variant for callers that already hold the user row —
   * `/users/me` and the auth responses resolve with one fewer query.
   */
  async resolveForLoadedUser(
    user: Pick<User, 'id' | 'subscription_tier'>,
  ): Promise<FeatureSnapshot> {
    const [overrides, globalStates] = await Promise.all([
      this.loadOverrides(user.id),
      this.getGlobalStates(),
    ]);
    return buildFeatureSnapshot(
      user.subscription_tier,
      overrides,
      globalStates,
    );
  }

  /**
   * Global overrides currently in force, keyed by feature. Rows whose
   * state is outside the vocabulary are dropped defensively — a bad row
   * can never force a feature on.
   */
  async getGlobalStates(): Promise<GlobalFeatureStates> {
    const rows = await this.featureStates.find({
      select: { feature: true, state: true },
    });
    const states: Partial<Record<string, GlobalFeatureState>> = {};
    for (const row of rows) {
      if (isGlobalFeatureState(row.state)) states[row.feature] = row.state;
    }
    return states;
  }

  private async loadOverrides(
    userId: string,
  ): Promise<Partial<Record<string, boolean>>> {
    const rows = await this.userFeatures.find({
      where: { user_id: userId },
      select: { feature: true, enabled: true },
    });
    const overrides: Partial<Record<string, boolean>> = {};
    for (const row of rows) overrides[row.feature] = row.enabled;
    return overrides;
  }
}
