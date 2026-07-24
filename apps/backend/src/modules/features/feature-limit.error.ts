import { ForbiddenException } from '@nestjs/common';
import { FEATURE_LIMIT_EXCEEDED, type LimitFeatureKey } from '@tarmoto/shared';

/** Re-exported so existing importers of this module keep working. */
export { FEATURE_LIMIT_EXCEEDED };

/**
 * 403 for "you are at your numeric entitlement cap". The body carries
 * the feature key + numbers so clients can render upgrade prompts
 * without string-matching the message.
 */
export function featureLimitExceeded(
  feature: LimitFeatureKey,
  limit: number,
  current: number,
): ForbiddenException {
  return new ForbiddenException({
    statusCode: 403,
    error: 'Forbidden',
    message: `Feature limit exceeded: ${feature} (limit ${limit}, current ${current})`,
    code: FEATURE_LIMIT_EXCEEDED,
    feature,
    limit,
    current,
  });
}
