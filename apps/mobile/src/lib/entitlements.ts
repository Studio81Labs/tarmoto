import type { SubscriptionTier } from "@tarmoto/shared";
import type { EnglishMessageKey } from "@/i18n/locales";
import type { User } from "@/types";

/**
 * Overlay the entitlement slices (`subscription_tier` / `features` / `limits`)
 * from `current` onto an `incoming` full-profile response.
 *
 * Entitlements are server-controlled and single-writer: only the entitlement
 * refresh path (and the cold-start baseline) should mutate them in the store.
 * Any OTHER profile publisher — a preferences PATCH, an avatar upload — returns
 * a full profile whose entitlement snapshot was computed at request time and
 * can be STALE relative to a concurrent foreground refresh. Publishing it whole
 * would let an incidental profile write resurrect a just-revoked capability
 * (re-enabling GPX export or z22 quality) until the next refresh. Preserving the
 * store's current slices keeps entitlements owned by the refresh path alone.
 *
 * With no current user (first publish establishes the baseline) the incoming
 * profile is returned unchanged.
 */
export function withPreservedEntitlements(
  current: User | null,
  incoming: User,
): User {
  if (!current) return incoming;
  return {
    ...incoming,
    subscription_tier: current.subscription_tier,
    features: current.features,
    limits: current.limits,
  };
}

const TIER_LABELS: Record<SubscriptionTier, EnglishMessageKey> = {
  free: "Free",
  pro: "Pro",
  premium: "Premium",
};

export function tierLabel(
  tier: SubscriptionTier,
  t: (k: EnglishMessageKey) => string,
): string {
  return t(TIER_LABELS[tier]);
}
