import type { SubscriptionTier } from "./constants.js";
import { SUBSCRIPTION_TIERS } from "./constants.js";

/**
 * Tier-aware feature entitlements (mirrors the nexcue/tabletap sibling
 * pattern): the flag set and its tier policy are code-defined here — the
 * single source of truth shared by backend, mobile, and companion.
 * Operators cannot invent keys at runtime; they can only set per-user
 * overrides (`user_features`) and global overrides (`feature_states`).
 *
 * Resolution precedence (low → high), implemented in `resolveFeature`:
 *   1. registry default
 *   2. subscription-tier grant (allowlist — only ever flips a flag ON)
 *   3. per-user override (grant or revoke)
 *   4. global override clamp — `force_off` is absolute (kill switch);
 *      `force_on` enables for everyone except an explicit per-user
 *      force-off.
 */

export const FEATURE_KEYS = [
  // Free tier (granted to every tier — flagged so operators keep a kill
  // switch over each pricing-card line item)
  "basic_navigation",
  "road_quality_overlay",
  "hazard_alerts",
  // Pro tier (€29.99/yr mid tier)
  "unlimited_trip_planning",
  "full_road_quality_zoom",
  "offline_maps",
  "gpx_export",
  "commuter_mode",
  // Premium tier (€49.99/yr top tier)
  "group_rides",
  "priority_hazard_alerts",
  "advanced_analytics",
] as const;

export type FeatureKey = (typeof FEATURE_KEYS)[number];

export interface FeatureDefinition {
  /** Operator-facing description shown in the admin console. */
  description: string;
  /** Baseline value before tier grants and overrides apply. */
  default: boolean;
  /** Tiers that are granted the feature (see product spec §Monetization
   * and the marketing pricing card — one flag per card line item). */
  tiers: readonly SubscriptionTier[];
}

const ALL_TIERS = ["free", "pro", "premium"] as const;
const PRO_AND_UP = ["pro", "premium"] as const;
const PREMIUM_ONLY = ["premium"] as const;

export const FEATURE_DEFINITIONS: Record<FeatureKey, FeatureDefinition> = {
  // ── Free ──
  basic_navigation: {
    description: "Basic turn-by-turn navigation.",
    default: false,
    tiers: ALL_TIERS,
  },
  road_quality_overlay: {
    description: "Road quality overlay (limited zoom on the free tier).",
    default: false,
    tiers: ALL_TIERS,
  },
  hazard_alerts: {
    description: "Community hazard alerts.",
    default: false,
    tiers: ALL_TIERS,
  },
  // ── Pro (€29.99/yr) ──
  unlimited_trip_planning: {
    description:
      "Unlimited trip planning (the free tier is capped at 1 active trip).",
    default: false,
    tiers: PRO_AND_UP,
  },
  full_road_quality_zoom: {
    description: "Full-depth road quality zoom.",
    default: false,
    tiers: PRO_AND_UP,
  },
  offline_maps: {
    description: "Offline map downloads.",
    default: false,
    tiers: PRO_AND_UP,
  },
  gpx_export: {
    description: "GPX export of recorded rides.",
    default: false,
    tiers: PRO_AND_UP,
  },
  commuter_mode: {
    description:
      "Commuter mode — saved commute routes, status and alternatives.",
    default: false,
    tiers: PRO_AND_UP,
  },
  // ── Premium (€49.99/yr) ──
  group_rides: {
    description: "Real-time group rides (unlimited).",
    default: false,
    tiers: PREMIUM_ONLY,
  },
  priority_hazard_alerts: {
    description: "Priority hazard alert delivery.",
    default: false,
    tiers: PREMIUM_ONLY,
  },
  advanced_analytics: {
    description: "Advanced riding analytics dashboard.",
    default: false,
    tiers: PREMIUM_ONLY,
  },
};

/** Global override states stored in `feature_states` (absence = normal). */
export const GLOBAL_FEATURE_STATES = ["force_off", "force_on"] as const;

export type GlobalFeatureState = (typeof GLOBAL_FEATURE_STATES)[number];

/** Admin wire vocabulary for a per-user override ("default" = no row). */
export const FEATURE_OVERRIDE_STATES = [
  "force_on",
  "force_off",
  "default",
] as const;

export type FeatureOverrideState = (typeof FEATURE_OVERRIDE_STATES)[number];

/** Fully-resolved flag values for one user — the wire shape on `/users/me`. */
export type FeatureSnapshot = Record<FeatureKey, boolean>;

/**
 * Global overrides currently in force, keyed by feature. Mirrors the
 * response of `GET /api/v1/config/flags`. Clients use it for the
 * kill-switch fast path: `effective = snapshotValue && states[key] !== "force_off"`.
 * `force_on` must NOT be applied client-side from this map alone — only the
 * authenticated snapshot resolves it authoritatively.
 */
export type GlobalFeatureStates = Partial<Record<string, GlobalFeatureState>>;

export function isFeatureKey(value: unknown): value is FeatureKey {
  return (
    typeof value === "string" &&
    (FEATURE_KEYS as readonly string[]).includes(value)
  );
}

export function isSubscriptionTier(value: unknown): value is SubscriptionTier {
  return (
    typeof value === "string" &&
    (SUBSCRIPTION_TIERS as readonly string[]).includes(value)
  );
}

export function isGlobalFeatureState(
  value: unknown,
): value is GlobalFeatureState {
  return (
    typeof value === "string" &&
    (GLOBAL_FEATURE_STATES as readonly string[]).includes(value)
  );
}

/**
 * Resolve one flag for one user. Pure — the backend resolver and client
 * tests exercise this directly.
 *
 * @param tier        the user's subscription tier (unknown values are
 *                    treated as no tier grant, never a throw)
 * @param override    per-user override (`user_features.enabled`), or
 *                    undefined when the user has no override row
 * @param globalState global override (`feature_states.state`), or
 *                    undefined when no override is in force
 */
export function resolveFeature(
  key: FeatureKey,
  tier: string | null,
  override: boolean | undefined,
  globalState: GlobalFeatureState | undefined,
): boolean {
  const def = FEATURE_DEFINITIONS[key];
  let value = def.default;
  if (isSubscriptionTier(tier) && def.tiers.includes(tier)) {
    value = true;
  }
  if (override !== undefined) {
    value = override;
  }
  if (globalState === "force_off") {
    return false;
  }
  if (globalState === "force_on" && override !== false) {
    value = true;
  }
  return value;
}

/** Resolve every registry flag into a snapshot. Unknown keys in the
 * override/state maps are ignored — stale DB rows can never widen the
 * flag set. */
export function buildFeatureSnapshot(
  tier: string | null,
  overrides: Readonly<Partial<Record<string, boolean>>>,
  globalStates: Readonly<Partial<Record<string, GlobalFeatureState>>>,
): FeatureSnapshot {
  const snapshot = {} as FeatureSnapshot;
  for (const key of FEATURE_KEYS) {
    snapshot[key] = resolveFeature(
      key,
      tier,
      overrides[key],
      globalStates[key],
    );
  }
  return snapshot;
}

/**
 * Read a resolved flag safely from an untyped map (e.g. a cached
 * snapshot). Returns `fallback` (default false) when the key is absent,
 * so a missing flag never enables a feature. Uses an own-property guard
 * (Object.hasOwn) so inherited prototype keys (e.g. "toString") never
 * accidentally return a truthy value.
 */
export function isFeatureEnabled(
  flags: Readonly<Partial<Record<string, boolean>>>,
  key: string,
  fallback = false,
): boolean {
  return Object.hasOwn(flags, key) ? (flags[key] ?? fallback) : fallback;
}
