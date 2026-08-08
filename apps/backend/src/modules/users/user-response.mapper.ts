import { pointToLatLng } from '@tarmoto/shared';
import { User } from '../../entities/user.entity.js';
import type { UserEntitlements } from '../features/feature-resolver.service.js';
import { UserResponseDto } from './dto/user-response.dto.js';

/**
 * Map a `User` entity to the rich `UserResponseDto` shape served by
 * `/users/me`, `/auth/login`, `/auth/register`, and `/auth/refresh`.
 *
 * Extracted as a free function so the auth + users surfaces can't drift
 * from each other's user shape — adding a column to `User` only needs
 * one update site to reach every endpoint that hands the client a user.
 *
 * `entitlements` (features + limits) is resolved by the caller (via
 * `FeatureResolver.resolveEntitlementsForLoadedUser`) because resolution
 * is async DB work the mapper deliberately stays free of.
 */
export function toUserResponse(
  user: User,
  entitlements: UserEntitlements,
): UserResponseDto {
  return {
    id: user.id,
    email: user.email,
    display_name: user.display_name,
    phone: user.phone,
    avatar_url: user.avatar_url,
    bio: user.bio,
    language: user.language,
    home_region: user.home_region,
    home_location: pointToLatLng(user.home_location),
    work_location: pointToLatLng(user.work_location),
    preferences: user.preferences,
    // DELIBERATELY the raw subscription column, not `resolveEntitledTier` (#1132).
    //
    // This field is a CONTRACT shared with `GET /account/subscription` and with
    // the companion's post-checkout poll, which waits until this value equals the
    // LIVE Stripe tier before it stops
    // (`settings/subscription/page.tsx`). Returning the resolved
    // `max(grant, subscription)` here breaks that equality for any rider whose
    // grant out-ranks what they just bought — a premium-granted rider buying pro
    // would poll to exhaustion and be told the purchase never landed.
    //
    // Entitlement (features and limits, resolved above) DOES come from the grant.
    // Changing what this field MEANS is a contract change that needs the billing
    // snapshot and the companion moved with it, or a separate entitled-tier
    // field — tracked on #1132 with step 3.
    subscription_tier: user.subscription_tier,
    features: entitlements.features,
    limits: entitlements.limits,
    created_at: user.created_at.toISOString(),
  };
}
