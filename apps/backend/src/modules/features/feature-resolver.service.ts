import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  buildFeatureSnapshot,
  buildLimitSnapshot,
  buildSystemSwitchSnapshot,
  isGlobalFeatureState,
  resolveSystemSwitch,
  type FeatureSnapshot,
  type GlobalFeatureState,
  type GlobalFeatureStates,
  type GlobalLimitOverrides,
  type LimitSnapshot,
  type SystemFeatureKey,
  type SystemSwitchSnapshot,
} from '@tarmoto/shared';
import { FeatureState } from '../../entities/feature-state.entity.js';
import { LimitState } from '../../entities/limit-state.entity.js';
import { UserFeature } from '../../entities/user-feature.entity.js';
import { UserLimit } from '../../entities/user-limit.entity.js';
import { User } from '../../entities/user.entity.js';
import {
  ENTITLEMENT_SELECT,
  resolveEntitledTier,
  type StoreRollup,
} from '../account/entitlement.js';

/** Combined tier-resolved entitlements — flags and limits — for one user. */
export interface UserEntitlements {
  features: FeatureSnapshot;
  limits: LimitSnapshot;
}

/**
 * Live tier-aware flag and limit resolution (sibling nexcue/tabletap pattern).
 *
 * The flag/limit vocabulary and tier policy are code-defined in
 * `FEATURE_DEFINITIONS` (`@tarmoto/shared`); this service only loads the
 * mutable state — the user's subscription tier, per-user overrides, and
 * global overrides — and folds them through the pure `resolveFeature` /
 * `resolveLimit` precedence. There is deliberately no in-memory cache: gated
 * endpoints re-resolve on every request (a handful of small indexed reads in
 * parallel) so an operator kill switch or a global limit change takes effect
 * immediately at the API.
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
    @InjectRepository(UserLimit)
    private readonly userLimits: Repository<UserLimit>,
    @InjectRepository(LimitState)
    private readonly limitStates: Repository<LimitState>,
  ) {}

  /** Resolve every registry flag for one user. */
  async resolveForUser(userId: string): Promise<FeatureSnapshot> {
    return (await this.resolveForUserWithStates(userId)).snapshot;
  }

  /**
   * Resolve the snapshot AND return the `feature_states` read that produced it.
   * A caller that must report WHY a flag resolved off (e.g. `FeatureGuard`
   * deriving the 403 `scope`) has to read the global states from the SAME
   * fetch — a second independent `getGlobalStates()` can disagree if an
   * operator clears a `force_off` between the two reads, mislabelling a
   * global kill as a per-user denial.
   */
  async resolveForUserWithStates(userId: string): Promise<{
    snapshot: FeatureSnapshot;
    globalStates: GlobalFeatureStates;
  }> {
    const [user, overrides, globalStates] = await Promise.all([
      this.users.findOne({
        where: { id: userId },
        // All THREE entitlement sources — see `resolveEntitledTier`. Selecting
        // only the subscription side would silently drop a rider's grant once
        // subscription writers stop maintaining `subscription_tier`, and
        // omitting the store rollup would resolve a paying store subscriber as
        // `free` at every feature guard while `/users/me` showed them as Pro.
        //
        // The rollup pair is `select: false` on the entity (it is clobbered by
        // stale whole-entity saves otherwise), so it is absent unless named
        // here — and absent reads as lapsed, which fails closed and silently.
        // That is why this select is the thing to check when a store
        // subscriber reports missing features.
        select: ENTITLEMENT_SELECT,
      }),
      this.loadOverrides(userId),
      this.getGlobalStates(),
    ]);
    if (!user) throw new NotFoundException('User not found');
    return {
      snapshot: buildFeatureSnapshot(
        resolveEntitledTier(user),
        overrides,
        globalStates,
      ),
      globalStates,
    };
  }

  /** Resolve every registry limit for one user (3 indexed reads). */
  async resolveLimitsForUser(userId: string): Promise<LimitSnapshot> {
    const [user, overrides, globalOverrides] = await Promise.all([
      this.users.findOne({
        where: { id: userId },
        select: ENTITLEMENT_SELECT,
      }),
      this.loadLimitOverrides(userId),
      this.getGlobalLimitOverrides(),
    ]);
    if (!user) throw new NotFoundException('User not found');
    return buildLimitSnapshot(
      resolveEntitledTier(user),
      overrides,
      globalOverrides,
    );
  }

  /**
   * Fetch-free combined variant for callers that already hold the user
   * row — `/users/me` and the auth responses resolve both snapshots with
   * four parallel indexed reads and no user query.
   */
  async resolveEntitlementsForLoadedUser(
    user: Pick<User, 'id' | 'subscription_tier' | 'grant_tier'>,
    // REQUIRED, and separate from `user`, so no call site can omit it by
    // accident: both rollup columns are `select: false`, so an entity that
    // never selected them type-checks and reads as no store side at runtime —
    // a paying store subscriber silently denied every paid feature. Folding
    // them into `user` would also invite selecting them onto an entity a
    // caller then saves, which is the stale write-back those columns are
    // hidden to prevent. Callers that load a whole user `addSelect` them;
    // callers that save one read them separately.
    rollup: StoreRollup,
  ): Promise<UserEntitlements> {
    const [overrides, globalStates, limitOverrides, globalLimits] =
      await Promise.all([
        this.loadOverrides(user.id),
        this.getGlobalStates(),
        this.loadLimitOverrides(user.id),
        this.getGlobalLimitOverrides(),
      ]);
    const sources = { ...user, ...rollup };
    const now = new Date();
    return {
      features: buildFeatureSnapshot(
        resolveEntitledTier(sources, now),
        overrides,
        globalStates,
      ),
      limits: buildLimitSnapshot(
        resolveEntitledTier(sources, now),
        limitOverrides,
        globalLimits,
      ),
    };
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

  /**
   * Global limit overrides currently in force. Rows with invalid values
   * (negative / non-integer) are dropped defensively — a bad row can
   * never widen an entitlement.
   */
  async getGlobalLimitOverrides(): Promise<GlobalLimitOverrides> {
    const rows = await this.limitStates.find({
      select: { feature: true, value: true },
    });
    const overrides: Partial<Record<string, number | null>> = {};
    for (const row of rows) {
      if (isValidLimitValue(row.value)) overrides[row.feature] = row.value;
    }
    return overrides;
  }

  /**
   * Resolved system switches (operator kill toggles, default ON). Reads the
   * same global `feature_states` rows as `getGlobalStates` and folds them
   * through the pure `buildSystemSwitchSnapshot`. For the backend's own use
   * (and future per-subsystem enforcement) — not gated by any guard yet.
   */
  async getSystemSwitches(): Promise<SystemSwitchSnapshot> {
    return buildSystemSwitchSnapshot(await this.getGlobalStates());
  }

  /**
   * Whether an operator kill switch is currently ON (default) — false only
   * when an operator has force_off'd it. One indexed read; no cache, so a
   * disable takes effect on the next request. Callable from public and
   * authed endpoints (system switches are global — no user).
   */
  async isSystemSwitchEnabled(key: SystemFeatureKey): Promise<boolean> {
    const states = await this.getGlobalStates();
    return resolveSystemSwitch(key, states[key]);
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

  private async loadLimitOverrides(
    userId: string,
  ): Promise<Partial<Record<string, number | null>>> {
    const rows = await this.userLimits.find({
      where: { user_id: userId },
      select: { feature: true, value: true },
    });
    const overrides: Partial<Record<string, number | null>> = {};
    for (const row of rows) {
      if (isValidLimitValue(row.value)) overrides[row.feature] = row.value;
    }
    return overrides;
  }
}

/**
 * True for a well-formed limit value: `null` (unlimited) or a non-negative
 * integer. Guards both override layers against a corrupted row widening
 * (or nonsensically shaping) an entitlement.
 */
function isValidLimitValue(value: number | null): boolean {
  return value === null || (Number.isInteger(value) && value >= 0);
}
