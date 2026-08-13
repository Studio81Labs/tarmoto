import { pointToLatLng } from '@tarmoto/shared';
import { User } from '../../entities/user.entity.js';
import type { UserEntitlements } from '../features/feature-resolver.service.js';
import { resolveBilledTier, type StoreRollup } from '../account/entitlement.js';
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
  /**
   * The rider's store rollup, passed separately because it cannot be read off
   * `user`: both columns are `select: false`, so an entity that never selected
   * them is indistinguishable from a rider with no store side — and one of the
   * callers hands this an entity it has just saved, which must never carry them.
   */
  storeRollup: StoreRollup,
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
    // The BILLED tier — `max(subscription, live store chains)`, grant EXCLUDED.
    // The rollup arrives as its own argument because it cannot be read off
    // `user`: both columns are `select: false`, so an entity that never
    // selected them looks identical to a rider with no store side. Still
    // deliberately NOT
    // `resolveEntitledTier` (#1132), for the reason below; the only thing that
    // changed is that "billed" now spans every billing source rather than the
    // Stripe column alone. A store claim writes only a chain row, so reading the
    // raw column here would leave the mobile activation poll timing out on a
    // purchase the backend had already honoured.
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
    //
    // KNOWN AND BOUNDED MISMATCH while that is true. The clients' upsell logic
    // treats this field as the rider's current tier
    // (`useEntitlements.ts` in both mobile and companion, feeding
    // `upgradeTierForFeature`/`upgradeTierForLimit`), so a rider whose GRANT
    // out-ranks their subscription can be offered an upgrade that would not help
    // — buying the tier they are already granted cannot lift a per-user or
    // global override. Reachable today only for a founder who converted to paid
    // AND hit an override, because registration writes both columns equal and
    // nothing else creates a divergence.
    //
    // The fix is a separate ENTITLED-TIER field with the upsell moved onto it,
    // not a redefinition of this one — this field has to stay billed for the
    // post-checkout poll. Tracked on #1132 as step 2b, alongside the
    // founder-conversion decision that determines whether the divergence should
    // exist at all.
    subscription_tier: resolveBilledTier({ ...user, ...storeRollup }),
    features: entitlements.features,
    limits: entitlements.limits,
    created_at: user.created_at.toISOString(),
  };
}
