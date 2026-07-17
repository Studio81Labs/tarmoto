import { SetMetadata } from '@nestjs/common';
import type { ToggleFeatureKey } from '@tarmoto/shared';

export const REQUIRED_FEATURE_KEY = 'required_feature';

/**
 * Declare that a route (or a whole controller) needs a feature from the
 * `FEATURE_DEFINITIONS` registry. Pair with `FeatureGuard`, after
 * `AuthGuard` so the request user is attached:
 *
 *   @UseGuards(AuthGuard, FeatureGuard)
 *   @RequireFeature('gpx_export')
 */
export const RequireFeature = (feature: ToggleFeatureKey) =>
  SetMetadata(REQUIRED_FEATURE_KEY, feature);
