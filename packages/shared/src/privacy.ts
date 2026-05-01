/**
 * Privacy preferences shared by backend, companion, and mobile.
 *
 * The toggles model six independent dimensions of what Tarmoto can do
 * with a rider's data — viewing audience, default ride sharing,
 * road-quality contribution, raw location retention, product analytics,
 * and personalised recommendations. Each one is enforced server-side at
 * exactly one well-known site (see #279):
 *
 *   - `profile_visibility` → `GET /users/:userId/profile`
 *   - `default_ride_sharing` → applied on ride finish
 *   - `road_data_contribution` → `POST /sensor/upload` (202s without
 *     persisting when off)
 *   - `location_retention_days` → daily sweeper that drops raw GPS /
 *     sensor rows older than the chosen window
 *   - `analytics_consent` → guards every analytics emission
 *   - `personalized_recommendations_consent` → guards recommendation
 *     features
 *
 * The backend stores the canonical value as a number of days for
 * `location_retention_days` (with `null` meaning "forever") so the
 * sweeper can compare it against `recorded_at` without parsing labels.
 * The companion shows it as a labelled enum (`3months`, `6months`,
 * `1year`, `2years`, `forever`) which round-trips to the day count via
 * the helpers below.
 */

export const PROFILE_VISIBILITY_VALUES = [
  "public",
  "riders-only",
  "private",
] as const;
export type ProfileVisibility = (typeof PROFILE_VISIBILITY_VALUES)[number];

export const RIDE_SHARING_VALUES = ["public", "private"] as const;
export type RideSharingDefault = (typeof RIDE_SHARING_VALUES)[number];

export const LOCATION_RETENTION_VALUES = [
  "3months",
  "6months",
  "1year",
  "2years",
  "forever",
] as const;
export type LocationRetention = (typeof LOCATION_RETENTION_VALUES)[number];

export interface PrivacyPreferences {
  profile_visibility: ProfileVisibility;
  default_ride_sharing: RideSharingDefault;
  road_data_contribution: boolean;
  location_retention: LocationRetention;
  analytics_consent: boolean;
  personalized_recommendations_consent: boolean;
}

export const DEFAULT_PRIVACY_PREFERENCES: PrivacyPreferences = {
  profile_visibility: "riders-only",
  default_ride_sharing: "private",
  road_data_contribution: true,
  location_retention: "1year",
  analytics_consent: true,
  personalized_recommendations_consent: true,
};

/**
 * Maps the labelled enum to a concrete day count. `null` means
 * "retain indefinitely" — the sweeper skips users whose preference is
 * `forever`. Day boundaries follow calendar-month conventions (30 days
 * per month) rather than ISO 30.4375 because the privacy page exposes
 * round-number labels and shaving a few days off the window is harmless
 * but expanding it past the user's expectation isn't.
 */
export function locationRetentionToDays(
  value: LocationRetention,
): number | null {
  switch (value) {
    case "3months":
      return 90;
    case "6months":
      return 180;
    case "1year":
      return 365;
    case "2years":
      return 730;
    case "forever":
      return null;
  }
}

export function isProfileVisibility(v: unknown): v is ProfileVisibility {
  return (PROFILE_VISIBILITY_VALUES as readonly string[]).includes(v as string);
}

export function isRideSharingDefault(v: unknown): v is RideSharingDefault {
  return (RIDE_SHARING_VALUES as readonly string[]).includes(v as string);
}

export function isLocationRetention(v: unknown): v is LocationRetention {
  return (LOCATION_RETENTION_VALUES as readonly string[]).includes(v as string);
}
