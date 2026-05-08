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

/**
 * Single point of truth for "may we emit a product-analytics event for
 * this rider?" (#279 / #501). Wraps the toggle so every analytics call
 * site — companion, mobile, and any future web surface — gates on the
 * same predicate. Defaulting to `true` when the field is unexpectedly
 * absent would silently re-enable tracking for an opt-out rider whose
 * row failed to load; treat anything other than an explicit `true` as
 * a "no". Expressed as a literal-equality check (not `!== false`) so a
 * future tri-state (e.g. unknown / pending) has to opt in explicitly.
 */
export function canTrackAnalytics(prefs: PrivacyPreferences): boolean {
  return prefs.analytics_consent === true;
}

/**
 * Predicate guarding personalised-recommendation surfaces (#279 /
 * #501) — "for you" route suggestions, nearby-unridden segments, and
 * any future feed that ranks based on the caller's history. Sites that
 * also have a non-personalised fallback should fall back when this
 * returns `false`; sites that are inherently personal (no useful
 * fallback exists) should return an empty list. Same fail-closed
 * posture as `canTrackAnalytics`.
 */
export function canShowPersonalizedRecommendations(
  prefs: PrivacyPreferences,
): boolean {
  return prefs.personalized_recommendations_consent === true;
}

/**
 * Mobile-side gate (#279 / #501) for the road-quality contribution
 * pipeline. Called from the sensor uploader before any batch leaves
 * the device — when the rider has `road_data_contribution` off, we
 * suppress the upload entirely. The backend also drops the same
 * payload at `POST /sensor/upload` (belt-and-suspenders, see
 * `SensorService.processUpload`); the mobile gate is the bandwidth /
 * battery saver that keeps an opt-out rider from streaming readings
 * the server is going to discard anyway.
 */
export function shouldContributeRoadData(prefs: PrivacyPreferences): boolean {
  return prefs.road_data_contribution === true;
}
