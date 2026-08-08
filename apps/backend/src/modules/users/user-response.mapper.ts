import { pointToLatLng } from '@tarmoto/shared';
import { User } from '../../entities/user.entity.js';
import type { UserEntitlements } from '../features/feature-resolver.service.js';
import { UserResponseDto } from './dto/user-response.dto.js';
import { resolveEntitledTier } from '../account/entitlement.js';

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
    // The RESOLVED tier — what the rider is actually entitled to, which is what
    // the client renders as their plan. Reading `subscription_tier` directly
    // would show `free` to a founder whose grant is their only entitlement, once
    // subscription writers stop maintaining that column.
    subscription_tier: resolveEntitledTier(user),
    features: entitlements.features,
    limits: entitlements.limits,
    created_at: user.created_at.toISOString(),
  };
}
