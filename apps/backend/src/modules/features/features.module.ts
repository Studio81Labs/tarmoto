import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { FeatureState } from '../../entities/feature-state.entity.js';
import { LimitState } from '../../entities/limit-state.entity.js';
import { UserFeature } from '../../entities/user-feature.entity.js';
import { UserLimit } from '../../entities/user-limit.entity.js';
import { User } from '../../entities/user.entity.js';
import { FeatureKillSwitchGuard } from './feature-kill-switch.guard.js';
import { FeatureResolver } from './feature-resolver.service.js';
import { FeatureGuard } from './feature.guard.js';
import { SystemSwitchGuard } from './system-switch.guard.js';

/**
 * Tier-aware feature entitlements. Exports `FeatureResolver` (live flag
 * and limit resolution), `FeatureGuard` (per-user entitlement enforcement
 * via `@RequireFeature`), `SystemSwitchGuard` (operator kill-switch
 * enforcement via `@RequireSystemSwitch`, rejecting before body parsing),
 * and `FeatureKillSwitchGuard` (global free-toggle kill-switch enforcement
 * via `@RequireFeatureKillSwitch` on public routes, no auth required).
 * Feature-gated modules import this module and pair the guard with
 * `AuthGuard` on the routes they protect.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      User,
      UserFeature,
      FeatureState,
      UserLimit,
      LimitState,
    ]),
  ],
  providers: [
    FeatureResolver,
    FeatureGuard,
    SystemSwitchGuard,
    FeatureKillSwitchGuard,
  ],
  exports: [
    FeatureResolver,
    FeatureGuard,
    SystemSwitchGuard,
    FeatureKillSwitchGuard,
  ],
})
export class FeaturesModule {}
