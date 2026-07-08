import { SetMetadata } from '@nestjs/common';

export const SHARED_THROTTLE_BUCKET = 'sharedThrottleBucket';

/**
 * Marks a controller (or handler) so {@link UserScopedThrottlerGuard} buckets
 * ALL of its handlers into one per-user budget, instead of the default
 * per-handler bucket.
 *
 * `@nestjs/throttler`'s default key includes `context.getHandler().name`, so a
 * class-level `@Throttle` otherwise gives each action its own quota — e.g. a
 * client could spend the full budget on `/geocode` AND again on
 * `/geocode/reverse`. Applying this makes the `@Throttle` limit apply to the
 * whole controller per user, which is what an upstream-facing proxy (public
 * Nominatim, #909) needs.
 */
export const SharedThrottleBucket = () =>
  SetMetadata(SHARED_THROTTLE_BUCKET, true);
