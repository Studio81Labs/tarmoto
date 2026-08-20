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

export interface SystemFeatureDefinition {
  kind: "system";
  description: string;
  /** System switches default ON; an operator force_off is the only way off. */
  default: true;
}

export type FeatureDefinition =
  ToggleFeatureDefinition | LimitFeatureDefinition | SystemFeatureDefinition;

const ALL_TIERS = ["free", "pro", "premium"] as const;
const PRO_AND_UP = ["pro", "premium"] as const;
const PREMIUM_ONLY = ["premium"] as const;

export const FEATURE_DEFINITIONS = {
  // ── Free flags (granted to every tier; exist for the kill switch) ──
  basic_navigation: {
    kind: "toggle",
    description: "Turn-by-turn navigation.",
    default: false,
    tiers: ALL_TIERS,
  },
  ride_tracking: {
    kind: "toggle",
    description: "Ride recording and basic stats.",
    default: false,
    tiers: ALL_TIERS,
  },
  road_quality_overlay: {
    kind: "toggle",
    description:
      "Quality-colored road overlay (zoom-limited on the free tier via road_quality_max_zoom).",
    default: false,
    tiers: ALL_TIERS,
  },
  hazard_alerts: {
    kind: "toggle",
    description: "Receiving community hazard alerts.",
    default: false,
    tiers: ALL_TIERS,
  },
  hazard_reporting: {
    kind: "toggle",
    description: "Submitting one-tap hazard reports.",
    default: false,
    tiers: ALL_TIERS,
  },
  crash_detection: {
    kind: "toggle",
    description: "Crash detection and emergency-contact SOS.",
    default: false,
    tiers: ALL_TIERS,
  },
  weather_alerts: {
    kind: "toggle",
    description: "Severe weather alerts along the route.",
    default: false,
    tiers: ALL_TIERS,
  },
  trip_planning: {
    kind: "toggle",
    description:
      "Trip planner (count-limited on the free tier via max_active_trips).",
    default: false,
    tiers: ALL_TIERS,
  },
  gpx_import: {
    kind: "toggle",
    description: "Import GPX from other platforms.",
    default: false,
    tiers: ALL_TIERS,
  },
  community_access: {
    kind: "toggle",
    description: "Browse published rides and collections.",
    default: false,
    tiers: ALL_TIERS,
  },
  carplay_android_auto: {
    kind: "toggle",
    description: "CarPlay / Android Auto projection.",
    default: false,
    tiers: ALL_TIERS,
  },
  // ── Pro flags (€29.99/yr) ──
  // NOTE: `road_quality_full_zoom` (a boolean toggle) was retired — the
  // `road_quality_max_zoom` limit (free = 12, pro/premium = null/unlimited)
  // is the single enforcement point for zoom depth, so the toggle was pure
  // duplication. Its override rows (`feature_states` / `user_features`) are
  // left in place as inert orphans, exactly like `unlimited_trip_planning`
  // (see migration 1814): the resolver ignores keys outside the registry, and
  // deleting the rows would irreversibly discard operator state a rollback
  // could not restore.
  offline_maps: {
    kind: "toggle",
    description: "Offline map region downloads.",
    default: false,
    tiers: PRO_AND_UP,
  },
  gpx_export: {
    kind: "toggle",
    description: "GPX export of rides and planned routes.",
    default: false,
    tiers: PRO_AND_UP,
  },
  commuter_mode: {
    kind: "toggle",
    description:
      "Commuter mode — saved commutes, one-tap commute nav, alternatives, weekly summary.",
    default: false,
    tiers: PRO_AND_UP,
  },
  advanced_ride_stats: {
    kind: "toggle",
    description:
      "Advanced ride stats — lean angles, elevation profile, detailed per-ride stats.",
    default: false,
    tiers: PRO_AND_UP,
  },
  collaborative_trips: {
    kind: "toggle",
    description:
      "Shared trip planning (collaborator count via max_trip_collaborators).",
    default: false,
    tiers: PRO_AND_UP,
  },
  // ── Premium flags (€49.99/yr) ──
  group_rides: {
    kind: "toggle",
    description: "Real-time group location sharing (US-26).",
    default: false,
    tiers: PREMIUM_ONLY,
  },
  // Roadmap — intentionally inert (decision #1111): no delivery-priority
  // logic exists in the hazard push path and nothing consumes this flag on
  // any surface. Gating ships WITH the feature when it is built, never ahead
  // of it. Recorded in docs/feature-flags.md §1.3.
  priority_hazard_alerts: {
    kind: "toggle",
    description: "Priority delivery of hazard alerts.",
    default: false,
    tiers: PREMIUM_ONLY,
  },
  advanced_analytics: {
    kind: "toggle",
    description: "Riding analytics dashboard.",
    default: false,
    tiers: PREMIUM_ONLY,
  },
  // Roadmap — intentionally inert (decision #1111): no personal-API-token
  // issuance surface exists and nothing consumes this flag on any surface.
  // Gating ships WITH the feature when it is built, never ahead of it.
  // Recorded in docs/feature-flags.md §1.3.
  api_access: {
    kind: "toggle",
    description: "Personal API token for ride/route data.",
    default: false,
    tiers: PREMIUM_ONLY,
  },
  // Roadmap — intentionally inert (decision #1111): no Garmin/TCX/FIT export
  // path exists (ride/trip export is plain GPX under `gpx_export`) and
  // nothing consumes this flag on any surface. Gating ships WITH the feature
  // when it is built, never ahead of it. Recorded in docs/feature-flags.md
  // §1.3.
  garmin_export: {
    kind: "toggle",
    description: "Direct route export to Garmin.",
    default: false,
    tiers: PREMIUM_ONLY,
  },
  // ── Limits (numeric entitlements; null = unlimited, 0 = kill switch) ──
  max_active_trips: {
    kind: "limit",
    description: "Maximum open (draft/planned/active) trips a user may own.",
    default: 1,
    tiers: { free: 1, pro: null, premium: null },
  },
  max_trip_collaborators: {
    kind: "limit",
    description: "Collaborators per trip, excluding the owner.",
    default: 0,
    tiers: { free: 0, pro: 5, premium: null },
  },
  max_group_ride_members: {
    kind: "limit",
    description: "Live group-ride size.",
    default: 0,
    tiers: { free: 0, pro: 0, premium: null },
  },
  road_quality_max_zoom: {
    kind: "limit",
    description:
      "Maximum zoom level at which the road quality overlay renders.",
    default: 12,
    tiers: { free: 12, pro: null, premium: null },
  },
  max_offline_regions: {
    kind: "limit",
    description: "Offline map regions a user may download.",
    default: 0,
    tiers: { free: 0, pro: null, premium: null },
  },
  hazard_reports_per_day: {
    kind: "limit",
    description: "Anti-abuse cap on hazard reports submitted per day.",
    default: 50,
    tiers: { free: 50, pro: 50, premium: 50 },
  },
  // ── System switches (operator-only, default ON, no tier) ──
  sys_accel_collection: {
    kind: "system",
    description: "Background accelerometer/gyro sampling (50Hz).",
    default: true,
  },
  sys_surface_upload: {
    kind: "system",
    description: "Batch upload of surface data to the backend.",
    default: true,
  },
  sys_surface_ml_classification: {
    kind: "system",
    description: "On-device TF Lite surface classification.",
    default: true,
  },
  sys_nap_conditions: {
    kind: "system",
    description: "NAP/DATEX II closure display (CONDITIONS tab + map).",
    default: true,
  },
  sys_nap_routing_avoidance: {
    kind: "system",
    description: "Closures injected as Valhalla exclude_polygons.",
    default: true,
  },
  sys_weather_provider: {
    kind: "system",
    description: "Weather-along-route data.",
    default: true,
  },
  sys_mapillary_previews: {
    kind: "system",
    description: "Mapillary imagery in Road Preview Cards.",
    default: true,
  },
  sys_aerial_basemap: {
    kind: "system",
    description: "ČÚZK orthophoto basemap toggle.",
    default: true,
  },
  sys_billing_checkout: {
    kind: "system",
    description:
      "New Stripe checkout sessions. Disabling stops NEW subscriptions " +
      "without touching existing ones — the billing portal stays open so " +
      "current subscribers can still manage or cancel.",
    default: true,
  },
  sys_booking_affiliate: {
    kind: "system",
    description: "Booking.com deep links on hotel POIs.",
    default: true,
  },
  sys_ride_publishing: {
    kind: "system",
    description: "Publishing rides (public/members).",
    default: true,
  },
  sys_community_collections: {
    kind: "system",
    description: "Community collections browsing.",
    default: true,
  },
  sys_poi_ratings: {
    kind: "system",
    description: "Rider ratings & stop reviews (US-25).",
    default: true,
  },
  sys_gamification: {
    kind: "system",
    description: "Badges, challenges, personal road map (Epic 7).",
    default: true,
  },
  sys_push_notifications: {
    kind: "system",
    description:
      "Non-critical push (marketing, engagement). Safety alerts are not behind this.",
    default: true,
  },
} as const satisfies Record<string, FeatureDefinition>;

export type FeatureKey = keyof typeof FEATURE_DEFINITIONS;

export type ToggleFeatureKey = {
  [K in FeatureKey]: (typeof FEATURE_DEFINITIONS)[K]["kind"] extends "toggle"
    ? K
    : never;
}[FeatureKey];

export type LimitFeatureKey = {
  [K in FeatureKey]: (typeof FEATURE_DEFINITIONS)[K]["kind"] extends "limit"
    ? K
    : never;
}[FeatureKey];

export const FEATURE_KEYS = Object.keys(
  FEATURE_DEFINITIONS,
) as readonly FeatureKey[];

export const TOGGLE_FEATURE_KEYS = FEATURE_KEYS.filter(
  (key): key is ToggleFeatureKey => FEATURE_DEFINITIONS[key].kind === "toggle",
);

/**
 * Toggle flags granted to the FREE tier (present on every tier). These are
 * "free for everyone" features that exist only so an operator can KILL them
 * globally during an incident — a colour on a bad tile build, a false-SOS
 * storm, an abusive report wave. Unlike paid toggles they are never a tier
 * gate, so the client enforces them as a fail-SAFE kill switch off the public
 * `/config/flags` map (default ON; only an operator `force_off` disables),
 * NOT via the fail-CLOSED per-user entitlement snapshot — the latter would
 * disable a free feature for a signed-out rider whose snapshot never loads.
 */
export type FreeToggleFeatureKey = {
  [
    K in ToggleFeatureKey
  ]: "free" extends (typeof FEATURE_DEFINITIONS)[K]["tiers"][number]
    ? K
    : never;
}[ToggleFeatureKey];

export const FREE_TOGGLE_FEATURE_KEYS = TOGGLE_FEATURE_KEYS.filter(
  (key): key is FreeToggleFeatureKey =>
    (FEATURE_DEFINITIONS[key].tiers as readonly string[]).includes("free"),
);

export const LIMIT_FEATURE_KEYS = FEATURE_KEYS.filter(
  (key): key is LimitFeatureKey => FEATURE_DEFINITIONS[key].kind === "limit",
);

export type SystemFeatureKey = {
  [K in FeatureKey]: (typeof FEATURE_DEFINITIONS)[K]["kind"] extends "system"
    ? K
    : never;
}[FeatureKey];

export const SYSTEM_FEATURE_KEYS = FEATURE_KEYS.filter(
  (key): key is SystemFeatureKey => FEATURE_DEFINITIONS[key].kind === "system",
);

export type SystemSwitchSnapshot = Record<SystemFeatureKey, boolean>;

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

export function isSystemFeatureKey(value: unknown): value is SystemFeatureKey {
  return isFeatureKey(value) && FEATURE_DEFINITIONS[value].kind === "system";
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
/** The more restrictive of two numeric limits (`null` = unlimited = least
 *  restrictive). Never raises: `minLimit(x, unlimited) === x`. */
export function minLimit(a: number | null, b: number | null): number | null {
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
 * Resolve one system switch. Pure. On by default; an operator `force_off`
 * is the only way off. `force_on`/absent resolve on.
 */
export function resolveSystemSwitch(
  key: SystemFeatureKey,
  globalState: GlobalFeatureState | undefined,
): boolean {
  void key; // key kept for signature symmetry; the default is always ON
  return globalState !== "force_off";
}

/**
 * Resolve one FREE-tier feature kill switch from the global `/config/flags`
 * override map. Pure. Fail SAFE: on by default, and only an operator
 * `force_off` disables it — `force_on` / absent resolve on. Identical rule to
 * {@link resolveSystemSwitch}, but typed to {@link FreeToggleFeatureKey} so it
 * can't be pointed at a PAID toggle (those gate fail-CLOSED via the per-user
 * snapshot; applying this fail-SAFE rule to one would hand a signed-out rider a
 * paid feature whenever the map hadn't loaded).
 */
export function resolveFeatureKillSwitch(
  key: FreeToggleFeatureKey,
  globalState: GlobalFeatureState | undefined,
): boolean {
  void key; // key kept for signature symmetry; the default is always ON
  return globalState !== "force_off";
}

/** Resolve every registry system switch. Unknown keys in the state map are
 * ignored — only registry keys are iterated. */
export function buildSystemSwitchSnapshot(
  globalStates: Readonly<Partial<Record<string, GlobalFeatureState>>>,
): SystemSwitchSnapshot {
  const snapshot = {} as SystemSwitchSnapshot;
  for (const key of SYSTEM_FEATURE_KEYS) {
    snapshot[key] = resolveSystemSwitch(key, globalStates[key]);
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

/** Machine-readable code carried on limit-rejection 403 bodies (see the
 *  backend `featureLimitExceeded`). Single source of truth for the wire code. */
export const FEATURE_LIMIT_EXCEEDED = "FEATURE_LIMIT_EXCEEDED";

/** Lowest tier ABOVE `currentTier` that grants a toggle feature, or null when
 *  no higher tier would grant it. Returns null when `currentTier` (or below)
 *  already grants the toggle: a granted toggle that resolved OFF is disabled by
 *  a global `force_off` or a per-user revoke, not by tier, so no upgrade
 *  restores it — offering "Upgrade to {currentTier}" (or a lower tier) would be
 *  a dead-end CTA. Symmetric with `upgradeTierForLimit`. */
export function upgradeTierForFeature(
  key: ToggleFeatureKey,
  currentTier: SubscriptionTier,
): SubscriptionTier | null {
  const def = FEATURE_DEFINITIONS[key];
  if (!def || def.kind !== "toggle") return null;
  // Widened the same way as `resolveFeature`'s `grantTiers`: per-key, `def.tiers`
  // infers as a narrow literal tuple (e.g. `readonly ["premium"]`) under
  // `as const satisfies`, which `Array.prototype.includes` can't accept a
  // broader `SubscriptionTier` argument against across the key union.
  const grantTiers: readonly SubscriptionTier[] = def.tiers;
  // Already granted at the current tier → off by override, not tier.
  if (grantTiers.includes(currentTier)) return null;
  const currentIdx = SUBSCRIPTION_TIERS.indexOf(currentTier);
  for (let i = currentIdx + 1; i < SUBSCRIPTION_TIERS.length; i++) {
    const tier = SUBSCRIPTION_TIERS[i]!;
    if (grantTiers.includes(tier)) return tier;
  }
  return null;
}

/** `null` = unlimited (most generous); otherwise a larger number is more
 *  generous. */
function isMoreGenerousLimit(
  current: number | null,
  candidate: number | null,
): boolean {
  if (candidate === null) return current !== null;
  if (current === null) return false;
  return candidate > current;
}

/** Lowest tier ABOVE `currentTier` whose `key` limit is strictly more generous
 *  than the current tier's default, or null when no higher tier improves it.
 *
 *  `resolvedLimit` is the rider's ACTUAL cap from `/users/me` (already through
 *  `resolveLimit`). When it differs from the current tier's static default, a
 *  per-user or global override REPLACED the tier value (see `resolveLimit`) —
 *  overrides are tier-independent, so a paid upgrade would not reliably lift
 *  the cap. In that case return null so the caller shows no dead-end upgrade
 *  CTA. (Residual: a global override numerically equal to the current tier's
 *  default is indistinguishable from "no override" client-side and is not
 *  caught here — it needs the operator override map, out of scope.) */
export function upgradeTierForLimit(
  key: LimitFeatureKey,
  currentTier: SubscriptionTier,
  resolvedLimit: number | null,
): SubscriptionTier | null {
  const def = FEATURE_DEFINITIONS[key];
  if (!def || def.kind !== "limit") return null;
  const tierDefault = def.tiers[currentTier];
  if (resolvedLimit !== tierDefault) return null;
  const currentIdx = SUBSCRIPTION_TIERS.indexOf(currentTier);
  for (let i = currentIdx + 1; i < SUBSCRIPTION_TIERS.length; i++) {
    const tier = SUBSCRIPTION_TIERS[i]!;
    if (isMoreGenerousLimit(tierDefault, def.tiers[tier])) return tier;
  }
  return null;
}
