/** Stable gamification identifiers shared by the backend and both clients. */
export const BADGE_KEYS = [
  "total_distance",
  "single_ride",
  "ride_count",
  "roads_discovered",
  "reviews_written",
  "hazards_reported",
  "rides_shared",
] as const;

export type BadgeKey = (typeof BADGE_KEYS)[number];

/**
 * Challenge rewards include permanent badges plus cataloged seasonal rewards.
 * Adding a reward requires client catalog copy before it can enter the wire
 * contract, so arbitrary backend identifiers never become display text.
 */
export const CHALLENGE_REWARD_KEYS = [
  ...BADGE_KEYS,
  "spring_explorer",
] as const;

export type ChallengeRewardKey = (typeof CHALLENGE_REWARD_KEYS)[number];

/**
 * Catalog-backed challenge templates. The database stores one of these keys;
 * clients turn it into localized title/description copy using the target and
 * metric values. This keeps authored English prose out of the wire contract.
 */
export const CHALLENGE_CONTENT_KEYS = [
  "total_distance",
  "single_ride",
  "ride_count",
  "roads_discovered",
  "reviews_written",
  "hazards_reported",
  "rides_shared",
  "generic",
] as const;

export type ChallengeContentKey = (typeof CHALLENGE_CONTENT_KEYS)[number];

export function isBadgeKey(value: string): value is BadgeKey {
  return (BADGE_KEYS as readonly string[]).includes(value);
}

export function isChallengeRewardKey(
  value: string,
): value is ChallengeRewardKey {
  return (CHALLENGE_REWARD_KEYS as readonly string[]).includes(value);
}

export function isChallengeContentKey(
  value: string,
): value is ChallengeContentKey {
  return (CHALLENGE_CONTENT_KEYS as readonly string[]).includes(value);
}
