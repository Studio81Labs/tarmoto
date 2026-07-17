import type { SubscriptionTier } from "./constants.js";
import { SUBSCRIPTION_TIERS } from "./constants.js";

/**
 * Tier-aware feature entitlements (mirrors the nexcue/tabletap sibling
 * pattern): the flag set and its tier policy are code-defined here — the
 * single source of truth shared by backend, mobile, and companion.
 * Operators cannot invent keys at runtime; they can only set per-user
 * overrides (`user_features`) and global overrides (`feature_states`).
 *
 * Registry entries are a discriminated union by `kind`: `toggle` (a
 * boolean gate, resolved below) or `limit` (a numeric per-tier
 * entitlement where `null` means unlimited — resolution lands in a later
 * task).
 *
 * Resolution precedence (low → high), implemented in `resolveFeature`:
 *   1. registry default
 *   2. subscription-tier grant (allowlist — only ever flips a flag ON)
 *   3. per-user override (grant or revoke)
 *   4. global override clamp — `force_off` is absolute (kill switch);
 *      `force_on` enables for everyone except an explicit per-user
 *      force-off.
 */

export interface ToggleFeatureDefinition {
  kind: "toggle";
  /** Operator-facing description shown in the admin console. */
  description: string;
  /** Baseline value before tier grants and overrides apply. */
  default: boolean;
  /** Tiers granted the feature (allowlist — only ever flips a flag ON). */
  tiers: readonly SubscriptionTier[];
}

export interface LimitFeatureDefinition {
  kind: "limit";
  description: string;
  /** Value applied when the tier is unknown/invalid. `null` = unlimited. */
  default: number | null;
  /** Explicit per-tier values — no allowlist ambiguity for numbers. */
  tiers: Readonly<Record<SubscriptionTier, number | null>>;
}

export type FeatureDefinition =
  | ToggleFeatureDefinition
  | LimitFeatureDefinition;

const ALL_TIERS = ["free", "pro", "premium"] as const;
const PRO_AND_UP = ["pro", "premium"] as const;
const PREMIUM_ONLY = ["premium"] as const;

export const FEATURE_DEFINITIONS = {
  // ── Free (granted to every tier) ──
  basic_navigation: {
    kind: "toggle",
    description: "Basic turn-by-turn navigation.",
    default: false,
    tiers: ALL_TIERS,
  },
  road_quality_overlay: {
    kind: "toggle",
    description: "Road quality overlay (limited zoom on the free tier).",
    default: false,
    tiers: ALL_TIERS,
  },
  hazard_alerts: {
    kind: "toggle",
    description: "Community hazard alerts.",
    default: false,
    tiers: ALL_TIERS,
  },
  // ── Pro (€29.99/yr) ──
  unlimited_trip_planning: {
    kind: "toggle",
    description:
      "Unlimited trip planning (the free tier is capped at 1 active trip).",
    default: false,
    tiers: PRO_AND_UP,
  },
  full_road_quality_zoom: {
    kind: "toggle",
    description: "Full-depth road quality zoom.",
    default: false,
    tiers: PRO_AND_UP,
  },
  offline_maps: {
    kind: "toggle",
    description: "Offline map downloads.",
    default: false,
    tiers: PRO_AND_UP,
  },
  gpx_export: {
    kind: "toggle",
    description: "GPX export of recorded rides.",
    default: false,
    tiers: PRO_AND_UP,
  },
  commuter_mode: {
    kind: "toggle",
    description:
      "Commuter mode — saved commute routes, status and alternatives.",
    default: false,
    tiers: PRO_AND_UP,
  },
  // ── Premium (€49.99/yr) ──
  group_rides: {
    kind: "toggle",
    description: "Real-time group rides (unlimited).",
    default: false,
    tiers: PREMIUM_ONLY,
  },
  priority_hazard_alerts: {
    kind: "toggle",
    description: "Priority hazard alert delivery.",
    default: false,
    tiers: PREMIUM_ONLY,
  },
  advanced_analytics: {
    kind: "toggle",
    description: "Advanced riding analytics dashboard.",
    default: false,
    tiers: PREMIUM_ONLY,
  },
  // ── Limits (numeric entitlements; null = unlimited) ──
  max_active_trips: {
    kind: "limit",
    description: "Maximum open (draft/planned/active) trips a user may own.",
    default: 1,
    tiers: { free: 1, pro: null, premium: null },
  },
} as const satisfies Record<string, FeatureDefinition>;

export type FeatureKey = keyof typeof FEATURE_DEFINITIONS;

export type ToggleFeatureKey = {
  [K in FeatureKey]: (typeof FEATURE_DEFINITIONS)[K]["kind"] extends "toggle"
    ? K
    : never;
}[FeatureKey];

export type LimitFeatureKey = Exclude<FeatureKey, ToggleFeatureKey>;

export const FEATURE_KEYS = Object.keys(
  FEATURE_DEFINITIONS,
) as readonly FeatureKey[];

export const TOGGLE_FEATURE_KEYS = FEATURE_KEYS.filter(
  (key): key is ToggleFeatureKey => FEATURE_DEFINITIONS[key].kind === "toggle",
);

export const LIMIT_FEATURE_KEYS = FEATURE_KEYS.filter(
  (key): key is LimitFeatureKey => FEATURE_DEFINITIONS[key].kind === "limit",
);

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
export type FeatureSnapshot = Record<ToggleFeatureKey, boolean>;

/** Fully-resolved limit values for one user. `null` = unlimited. */
export type LimitSnapshot = Record<LimitFeatureKey, number | null>;

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

export function isToggleFeatureKey(value: unknown): value is ToggleFeatureKey {
  return isFeatureKey(value) && FEATURE_DEFINITIONS[value].kind === "toggle";
}

export function isLimitFeatureKey(value: unknown): value is LimitFeatureKey {
  return isFeatureKey(value) && FEATURE_DEFINITIONS[value].kind === "limit";
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
  key: ToggleFeatureKey,
  tier: string | null,
  override: boolean | undefined,
  globalState: GlobalFeatureState | undefined,
): boolean {
  const def = FEATURE_DEFINITIONS[key];
  // Widened the same way as `grantTiers` below: every toggle entry in the
  // registry currently hardcodes `default: false`, so `def.default` infers
  // as the literal `false` (not `boolean`) under `as const satisfies` —
  // without this annotation, the `true`/`override` assignments below
  // wouldn't type-check.
  let value: boolean = def.default;
  const grantTiers: readonly SubscriptionTier[] = def.tiers;
  if (isSubscriptionTier(tier) && grantTiers.includes(tier)) {
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
  for (const key of TOGGLE_FEATURE_KEYS) {
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

/**
 * Global limit overrides currently in force, keyed by feature — the
 * response of `GET /api/v1/config/limits`. `null` = unlimited. Clients
 * may apply a value from this map only as a DOWNWARD clamp
 * (`effective = min(snapshot, global)`, null = ∞); raising is resolved
 * only by the authenticated `/users/me` snapshot.
 */
export type GlobalLimitOverrides = Partial<Record<string, number | null>>;

/** min() with `null` = unlimited (∞). */
function minLimit(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.min(a, b);
}

/**
 * Resolve one numeric limit for one user. Pure. Precedence:
 *   1. registry tier value (or `default` for unknown tiers)
 *   2. per-user override — replaces (support can raise or restrict)
 *   3. global override — replaces the tier layer; where a per-user
 *      override also exists, the more restrictive of the two wins.
 * `undefined` = no override; `null` = unlimited.
 */
export function resolveLimit(
  key: LimitFeatureKey,
  tier: string | null,
  override: number | null | undefined,
  globalOverride: number | null | undefined,
): number | null {
  const def = FEATURE_DEFINITIONS[key];
  let value: number | null = isSubscriptionTier(tier)
    ? def.tiers[tier]
    : def.default;
  if (override !== undefined) {
    value = override;
  }
  if (globalOverride !== undefined) {
    value =
      override !== undefined
        ? minLimit(override, globalOverride)
        : globalOverride;
  }
  return value;
}

/** Resolve every registry limit into a snapshot. Unknown keys in the
 * override maps are ignored — stale DB rows can never widen the set. */
export function buildLimitSnapshot(
  tier: string | null,
  overrides: Readonly<Partial<Record<string, number | null>>>,
  globalOverrides: Readonly<Partial<Record<string, number | null>>>,
): LimitSnapshot {
  const snapshot = {} as LimitSnapshot;
  for (const key of LIMIT_FEATURE_KEYS) {
    snapshot[key] = resolveLimit(
      key,
      tier,
      overrides[key],
      globalOverrides[key],
    );
  }
  return snapshot;
}

/**
 * Read a resolved limit safely from an untyped map (e.g. a cached
 * snapshot). Missing keys return `fallback` (default 0 — the most
 * restrictive value), never unlimited. Own-property guarded so
 * inherited prototype keys can't leak a value.
 */
export function getFeatureLimit(
  limits: Readonly<Partial<Record<string, number | null>>>,
  key: string,
  fallback: number | null = 0,
): number | null {
  if (!Object.hasOwn(limits, key)) return fallback;
  const value = limits[key];
  return value === undefined ? fallback : value;
}

/** True when `currentCount` leaves room for one more (`null` = unlimited). */
export function isWithinLimit(
  limit: number | null,
  currentCount: number,
): boolean {
  return limit === null || currentCount < limit;
}
