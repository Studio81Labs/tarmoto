import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { FeatureState } from '../../entities/feature-state.entity.js';
import { UserFeature } from '../../entities/user-feature.entity.js';
import { User } from '../../entities/user.entity.js';
import { FeatureResolver } from './feature-resolver.service.js';
import { FeatureGuard } from './feature.guard.js';

/**
 * Tier-aware feature entitlements. Exports `FeatureResolver` (live flag
 * resolution) and `FeatureGuard` (endpoint enforcement via
 * `@RequireFeature`). Feature-gated modules import this module and pair
 * the guard with `AuthGuard` on the routes they protect.
 */
@Module({
  imports: [TypeOrmModule.forFeature([User, UserFeature, FeatureState])],
  providers: [FeatureResolver, FeatureGuard],
  exports: [FeatureResolver, FeatureGuard],
})
export class FeaturesModule {}
