/**
 * A flat map of feature-flag key → enabled. Mirrors the response of
 * GET /api/v1/config/flags. Keys are free-form (created by operators at
 * runtime), so this is intentionally not a fixed union.
 */
export type FeatureFlagMap = Record<string, boolean>;

/**
 * Read a feature flag safely. Returns `fallback` (default false) when the
 * key is absent, so a missing/disabled flag never enables a feature.
 * Uses an own-property guard (Object.hasOwn) so inherited prototype keys
 * (e.g. "toString", "constructor") never accidentally return a truthy value.
 */
export function isFeatureEnabled(
  flags: FeatureFlagMap,
  key: string,
  fallback = false,
): boolean {
  return Object.hasOwn(flags, key) ? (flags[key] ?? fallback) : fallback;
}
