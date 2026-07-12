import { pointToLatLng, type FeatureSnapshot } from '@tarmoto/shared';
import { User } from '../../entities/user.entity.js';
import { UserResponseDto } from './dto/user-response.dto.js';

/**
 * Map a `User` entity to the rich `UserResponseDto` shape served by
 * `/users/me`, `/auth/login`, `/auth/register`, and `/auth/refresh`.
 *
 * Extracted as a free function so the auth + users surfaces can't drift
 * from each other's user shape — adding a column to `User` only needs
 * one update site to reach every endpoint that hands the client a user.
 *
 * `features` is resolved by the caller (via
 * `FeatureResolver.resolveForLoadedUser`) because resolution is async DB
 * work the mapper deliberately stays free of.
 */
export function toUserResponse(
  user: User,
  features: FeatureSnapshot,
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
    subscription_tier: user.subscription_tier,
    features,
    created_at: user.created_at.toISOString(),
  };
}
